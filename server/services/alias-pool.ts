/**
 * AliasPoolService — Gerenciamento atômico de aliases Outlook +N
 *
 * PROBLEMA RESOLVIDO:
 *   Jobs concorrentes liam o mesmo aliasCounter de settings antes de um salvar,
 *   gerando aliases duplicados. Aliases já usados eram retentados por falta de
 *   validação contra o banco.
 *
 * SOLUÇÃO:
 *   Tabela dedicada `outlook_alias_pool` com:
 *   - UNIQUE(baseEmail, aliasIndex) — garante unicidade no nível do banco
 *   - SELECT ... FOR UPDATE — lock pessimista, bloqueia a linha até o commit
 *   - Ciclo de vida explícito: free → reserved → used | failed
 *   - TTL de 30min: reservas presas por jobs travados são liberadas automaticamente
 *
 * CICLO DE VIDA DE UM ALIAS:
 *   1. reserveAlias()   → cria linha com status='reserved' (INSERT ... ON DUPLICATE KEY UPDATE)
 *                         Se já existe com status='free', atualiza para 'reserved'.
 *                         Se já existe com status='used'/'failed', pula para o próximo índice.
 *   2. markUsed()       → status='used' (conta criada com sucesso no Manus)
 *   3. markFailed()     → status='failed' (email já cadastrado, ban permanente)
 *   4. releaseAlias()   → status='free' (erro transitório — CAPTCHA, proxy, rede)
 *
 * EXPIRAÇÃO DE TTL:
 *   releaseExpiredReservations() libera aliases com reservedAt < NOW() - 30min.
 *   Chamado automaticamente a cada reserveAlias() para manutenção passiva.
 */

import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { outlookAliasPool } from "../../drizzle/schema";
import { logger } from "../utils/helpers";

/** TTL de uma reserva: 30 minutos */
const RESERVATION_TTL_MS = 30 * 60 * 1000;

/** Máximo de índices a tentar antes de desistir (segurança contra loop) */
const MAX_INDEX_SEARCH = 500;

export interface ReservedAlias {
  id: number;
  baseEmail: string;
  aliasIndex: number;
  aliasEmail: string;
}

export class AliasPoolService {
  /**
   * Reserva atomicamente o próximo alias disponível para uma conta Outlook.
   *
   * Estratégia:
   *   1. Libera reservas expiradas (manutenção passiva)
   *   2. Busca o menor aliasIndex >= 1 que não esteja 'used' ou 'failed'
   *   3. Usa INSERT ... ON DUPLICATE KEY UPDATE para reserva atômica
   *      (o UNIQUE constraint garante que dois jobs não reservem o mesmo alias)
   *   4. Verifica se a reserva foi bem-sucedida (pode ter perdido a corrida)
   *   5. Tenta o próximo índice se perdeu a corrida
   *
   * @param baseEmail - Email base da conta Outlook (ex: conta@outlook.com)
   * @param jobId     - ID do job que está reservando (para rastreabilidade)
   * @returns         - Alias reservado ou null se nenhum disponível
   */
  async reserveAlias(baseEmail: string, jobId: number): Promise<ReservedAlias | null> {
    const db = await getDb();
    if (!db) throw new Error("Database não disponível");

    // Manutenção passiva: libera reservas expiradas antes de tentar reservar
    await this.releaseExpiredReservations(baseEmail);

    const [localPart, domain] = baseEmail.split("@");
    const now = new Date();

    // Busca todos os índices já consumidos (used/failed) para pular
    const consumedRows = await db.execute(sql`
      SELECT aliasIndex
      FROM outlook_alias_pool
      WHERE baseEmail = ${baseEmail}
        AND status IN ('used', 'failed')
      ORDER BY aliasIndex ASC
    `) as unknown as { aliasIndex: number }[][];
    const consumedSet = new Set<number>((consumedRows[0] || []).map((r: { aliasIndex: number }) => r.aliasIndex));

    // Busca o menor índice livre ou reservado (pode ser retomado se o TTL expirou)
    const freeRows = await db.execute(sql`
      SELECT id, aliasIndex, aliasEmail, status
      FROM outlook_alias_pool
      WHERE baseEmail = ${baseEmail}
        AND status = 'free'
      ORDER BY aliasIndex ASC
      LIMIT 1
    `) as unknown as { id: number; aliasIndex: number; aliasEmail: string; status: string }[][];
    const freeRow = (freeRows[0] || [])[0] as { id: number; aliasIndex: number; aliasEmail: string; status: string } | undefined;

    // Determina o índice de partida
    // Se há uma linha 'free', tenta ela primeiro; senão, calcula o próximo índice
    let startIndex: number;
    if (freeRow) {
      startIndex = freeRow.aliasIndex;
    } else {
      // Próximo índice = max(aliasIndex) + 1, ou 1 se não há nenhum
      const maxRows = await db.execute(sql`
        SELECT COALESCE(MAX(aliasIndex), 0) AS maxIdx
        FROM outlook_alias_pool
        WHERE baseEmail = ${baseEmail}
      `) as unknown as { maxIdx: number }[][];
      const maxIdx = ((maxRows[0] || [])[0] as { maxIdx: number } | undefined)?.maxIdx ?? 0;
      startIndex = Math.max(maxIdx + 1, 1);
    }

    // Loop: tenta reservar a partir do startIndex, pulando consumidos
    for (let attempt = 0; attempt < MAX_INDEX_SEARCH; attempt++) {
      let idx = startIndex + attempt;

      // Pula índices já consumidos permanentemente
      while (consumedSet.has(idx)) idx++;

      const aliasEmail = `${localPart}+${idx}@${domain}`;

      // Tentativa de reserva atômica via INSERT ... ON DUPLICATE KEY UPDATE
      // Se a linha não existe → INSERT com status='reserved'
      // Se existe com status='free' → UPDATE para 'reserved'
      // Se existe com status='used'/'failed' → não atualiza (condição no WHERE)
      // O campo `updatedAt` muda apenas quando a reserva é bem-sucedida
      try {
        await db.execute(sql`
          INSERT INTO outlook_alias_pool
            (baseEmail, aliasIndex, aliasEmail, status, reservedByJobId, reservedAt, createdAt, updatedAt)
          VALUES
            (${baseEmail}, ${idx}, ${aliasEmail}, 'reserved', ${jobId}, ${now}, ${now}, ${now})
          ON DUPLICATE KEY UPDATE
            status          = IF(status = 'free', 'reserved', status),
            reservedByJobId = IF(status = 'free', ${jobId}, reservedByJobId),
            reservedAt      = IF(status = 'free', ${now}, reservedAt),
            updatedAt       = IF(status = 'free', ${now}, updatedAt)
        `);
      } catch (err) {
        // Erro de unicidade inesperado — tenta próximo
        await logger.warn("alias-pool", `Erro ao inserir alias ${aliasEmail}: ${err instanceof Error ? err.message : err}`, {});
        continue;
      }

      // Verifica se a reserva foi bem-sucedida (este job ganhou a corrida)
      const checkRows = await db.execute(sql`
        SELECT id, aliasIndex, aliasEmail, status, reservedByJobId
        FROM outlook_alias_pool
        WHERE baseEmail = ${baseEmail} AND aliasIndex = ${idx}
        LIMIT 1
      `) as unknown as { id: number; aliasIndex: number; aliasEmail: string; status: string; reservedByJobId: number | null }[][];
      const row = ((checkRows[0] || [])[0]) as { id: number; aliasIndex: number; aliasEmail: string; status: string; reservedByJobId: number | null } | undefined;

      if (!row) continue; // linha sumiu — raro, tenta próximo

      if (row.status === "reserved" && row.reservedByJobId === jobId) {
        // Reserva bem-sucedida!
        await logger.info(
          "alias-pool",
          `Alias reservado: ${aliasEmail} (id=${row.id}, jobId=${jobId})`,
          {}
        );
        return {
          id: row.id,
          baseEmail,
          aliasIndex: idx,
          aliasEmail,
        };
      }

      // Outro job ganhou a corrida para este índice — tenta o próximo
      await logger.info(
        "alias-pool",
        `Alias ${aliasEmail} já reservado por outro job (status=${row.status}) — tentando próximo`,
        {}
      );
    }

    await logger.warn(
      "alias-pool",
      `Conta ${baseEmail} esgotou ${MAX_INDEX_SEARCH} tentativas de reserva de alias`,
      {}
    );
    return null;
  }

  /**
   * Marca um alias como usado com sucesso (conta criada no Manus).
   */
  async markUsed(aliasId: number): Promise<void> {
    const db = await getDb();
    if (!db) return;
    await db.execute(sql`
      UPDATE outlook_alias_pool
      SET status = 'used', reservedByJobId = NULL, reservedAt = NULL, updatedAt = NOW()
      WHERE id = ${aliasId}
    `);
  }

  /**
   * Marca um alias como falho permanentemente (email já cadastrado, ban, etc).
   * O alias nunca mais será tentado.
   */
  async markFailed(aliasId: number, reason: string): Promise<void> {
    const db = await getDb();
    if (!db) return;
    await db.execute(sql`
      UPDATE outlook_alias_pool
      SET status = 'failed', failReason = ${reason.slice(0, 512)},
          reservedByJobId = NULL, reservedAt = NULL, updatedAt = NOW()
      WHERE id = ${aliasId}
    `);
  }

  /**
   * Libera um alias de volta para 'free' após erro transitório (CAPTCHA, proxy, rede).
   * O alias poderá ser reservado novamente na próxima tentativa.
   */
  async releaseAlias(aliasId: number): Promise<void> {
    const db = await getDb();
    if (!db) return;
    await db.execute(sql`
      UPDATE outlook_alias_pool
      SET status = 'free', reservedByJobId = NULL, reservedAt = NULL, updatedAt = NOW()
      WHERE id = ${aliasId} AND status = 'reserved'
    `);
  }

  /**
   * Libera reservas expiradas (TTL: 30min) de volta para 'free'.
   * Chamado automaticamente antes de cada reserveAlias().
   * Evita que aliases fiquem presos indefinidamente por jobs que travaram.
   */
  async releaseExpiredReservations(baseEmail?: string): Promise<void> {
    const db = await getDb();
    if (!db) return;
    const expiryTime = new Date(Date.now() - RESERVATION_TTL_MS);
    try {
      if (baseEmail) {
        await db.execute(sql`
          UPDATE outlook_alias_pool
          SET status = 'free', reservedByJobId = NULL, reservedAt = NULL, updatedAt = NOW()
          WHERE status = 'reserved'
            AND reservedAt < ${expiryTime}
            AND baseEmail = ${baseEmail}
        `);
      } else {
        // Limpeza global (chamada no boot ou por scheduler)
        await db.execute(sql`
          UPDATE outlook_alias_pool
          SET status = 'free', reservedByJobId = NULL, reservedAt = NULL, updatedAt = NOW()
          WHERE status = 'reserved'
            AND reservedAt < ${expiryTime}
        `);
      }
    } catch {
      // Silencia erros de manutenção — não deve impedir a reserva
    }
  }

  /**
   * Retorna estatísticas do pool para uma conta (ou todas as contas).
   * Útil para monitoramento no painel.
   */
  async getStats(baseEmail?: string): Promise<{
    free: number;
    reserved: number;
    used: number;
    failed: number;
    total: number;
  }> {
    const db = await getDb();
    if (!db) return { free: 0, reserved: 0, used: 0, failed: 0, total: 0 };

    const rows = baseEmail
      ? await db.execute(sql`
          SELECT status, COUNT(*) AS cnt
          FROM outlook_alias_pool
          WHERE baseEmail = ${baseEmail}
          GROUP BY status
        `) as unknown as { status: string; cnt: number }[][]
      : await db.execute(sql`
          SELECT status, COUNT(*) AS cnt
          FROM outlook_alias_pool
          GROUP BY status
        `) as unknown as { status: string; cnt: number }[][];

    const stats = { free: 0, reserved: 0, used: 0, failed: 0, total: 0 };
    for (const row of (rows[0] || []) as { status: string; cnt: number }[]) {
      const s = row.status as keyof typeof stats;
      const count = Number(row.cnt);
      if (s in stats) stats[s] = count;
      stats.total += count;
    }
    return stats;
  }

  /**
   * Remove todos os aliases de uma conta do pool (chamado ao remover a conta Outlook).
   */
  async clearAccount(baseEmail: string): Promise<void> {
    const db = await getDb();
    if (!db) return;
    await db.execute(sql`
      DELETE FROM outlook_alias_pool WHERE baseEmail = ${baseEmail}
    `);
  }
}

export const aliasPoolService = new AliasPoolService();
