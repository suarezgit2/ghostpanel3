/**
 * Keys Router - Geração e gerenciamento de chaves de acesso
 */

import { z } from "zod";
import { eq, desc, sql, and } from "drizzle-orm";
import { router, protectedProcedure, publicProcedure } from "../_core/trpc";
import { getDb } from "../db";
import { keys } from "../../drizzle/schema";
import crypto from "crypto";
import { extractInviteCode } from "../utils/helpers";
import { getSetting, setSetting } from "../utils/settings";

function generateKeyCode(): string {
  // Format: GHOST-XXXX-XXXX-XXXX (uppercase alphanumeric, no ambiguous chars)
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const segment = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return `GHOST-${segment()}-${segment()}-${segment()}`;
}

export const keysRouter = router({
  list: protectedProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    return await db.select().from(keys).orderBy(desc(keys.createdAt)).limit(500);
  }),

  stats: protectedProcedure.query(async () => {
    const db = await getDb();
    if (!db) return { total: 0, active: 0, redeemed: 0, expired: 0 };

    const [result] = await db.select({
      total: sql<number>`count(*)`,
      active: sql<number>`sum(case when status = 'active' then 1 else 0 end)`,
      redeemed: sql<number>`sum(case when status = 'redeemed' then 1 else 0 end)`,
      expired: sql<number>`sum(case when status = 'expired' then 1 else 0 end)`,
      totalCreditsActive: sql<number>`sum(case when status = 'active' then credits else 0 end)`,
      totalCreditsRedeemed: sql<number>`sum(case when status = 'redeemed' then credits else 0 end)`,
    }).from(keys);

    return {
      total: result?.total || 0,
      active: result?.active || 0,
      redeemed: result?.redeemed || 0,
      expired: result?.expired || 0,
      totalCreditsActive: result?.totalCreditsActive || 0,
      totalCreditsRedeemed: result?.totalCreditsRedeemed || 0,
    };
  }),

  generate: protectedProcedure
    .input(z.object({
      credits: z.number().min(500).max(1000000),
      quantity: z.number().min(1).max(100).default(1),
      label: z.string().max(256).optional(),
      expiresInDays: z.number().min(1).max(365).optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database não disponível");

      const expiresAt = input.expiresInDays
        ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000)
        : null;

      const newKeys: Array<{ code: string; credits: number; label?: string | null; expiresAt?: Date | null }> = [];

      for (let i = 0; i < input.quantity; i++) {
        // Ensure unique code
        let code: string;
        let attempts = 0;
        do {
          code = generateKeyCode();
          attempts++;
          if (attempts > 10) throw new Error("Não foi possível gerar código único");
          const existing = await db.select({ id: keys.id }).from(keys).where(eq(keys.code, code)).limit(1);
          if (existing.length === 0) break;
        } while (true);

        newKeys.push({
          code,
          credits: input.credits,
          label: input.label || null,
          expiresAt,
        });
      }

      await db.insert(keys).values(newKeys);

      return { codes: newKeys.map(k => k.code), count: newKeys.length };
    }),

  revoke: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database não disponível");

      await db.update(keys).set({ status: "cancelled" }).where(eq(keys.id, input.id));
      return { success: true };
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database não disponível");

      await db.delete(keys).where(eq(keys.id, input.id));
      return { success: true };
    }),

  /**
   * Endpoint público para verificar uma key (sem autenticação)
   * Retorna mensagens genéricas para não permitir enumeração de chaves
   */
  check: publicProcedure
    .input(z.object({ code: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { valid: false, error: "Serviço indisponível" };

      const result = await db.select().from(keys).where(eq(keys.code, input.code.toUpperCase())).limit(1);

      if (result.length === 0) {
        return { valid: false, error: "Chave inválida ou não encontrada" };
      }

      const key = result[0];

      if (key.status === "redeemed") {
        return { valid: false, error: "Esta chave já foi utilizada" };
      }

      if (key.status === "cancelled" || key.status === "expired" || (key.expiresAt && new Date(key.expiresAt) < new Date())) {
        return { valid: false, error: "Chave inválida ou expirada" };
      }

      return {
        valid: true,
        credits: key.credits,
        label: key.label ?? null,
        expiresAt: key.expiresAt ? key.expiresAt.toISOString() : null,
      };
    }),

  /**
   * Endpoint público para resgatar uma key.
   *
   * FIX: Race condition eliminada com UPDATE atômico.
   * O padrão anterior (SELECT → verificar → UPDATE) permitia que dois resgates
   * simultâneos da mesma chave passassem pela verificação antes de qualquer um
   * marcar como "redeemed", gerando múltiplos jobs para a mesma chave.
   *
   * A correção usa um único UPDATE WHERE status = 'active', que é atômico no
   * MySQL/TiDB. Se affectedRows === 0, a chave já foi resgatada ou não existe
   * com status ativo — garantindo que apenas um resgate seja processado.
   */
  redeem: publicProcedure
    .input(z.object({
      code: z.string(),
      inviteCode: z.string().min(1, "Código de convite obrigatório"),
      name: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Serviço indisponível");

      // ── MODO MANUTENÇÃO: bloquear novos resgates enquanto ativo ──
      const maintenance = await getSetting("maintenance_mode");
      if (maintenance === "true") {
        throw new Error(
          "Sistema em manutenção. Novos resgates estão temporariamente suspensos. Tente novamente em alguns minutos."
        );
      }

      const normalizedCode = input.code.toUpperCase().trim();
      const now = new Date();

      // ── ETAPA 1: Verificar se a chave existe (para dar mensagem de erro adequada) ──
      const existing = await db
        .select()
        .from(keys)
        .where(eq(keys.code, normalizedCode))
        .limit(1);

      if (existing.length === 0) {
        throw new Error("Chave não encontrada");
      }

      const key = existing[0];

      // Verificar expiração antes do UPDATE atômico
      if (key.expiresAt && new Date(key.expiresAt) < now) {
        // Marcar como expirada se ainda não foi
        if (key.status === "active") {
          await db.update(keys).set({ status: "expired" }).where(eq(keys.id, key.id));
        }
        throw new Error("Chave expirada");
      }

      // Dar mensagens de erro específicas para estados não-active
      if (key.status === "redeemed") throw new Error("Chave já foi resgatada");
      if (key.status === "cancelled") throw new Error("Chave cancelada");
      if (key.status === "expired") throw new Error("Chave expirada");
      if (key.status !== "active") throw new Error("Chave inválida");

      // ── ETAPA 2: UPDATE atômico — apenas uma requisição concurrent vence ──
      // WHERE status = 'active' garante que se duas requisições chegarem ao mesmo tempo,
      // somente a primeira que executar o UPDATE terá affectedRows > 0.
      const updateResult = await db
        .update(keys)
        .set({
          status: "redeemed",
          redeemedAt: now,
          redeemedBy: input.name
            ? `${input.name} (${input.inviteCode})`
            : input.inviteCode,
        })
        .where(
          and(
            eq(keys.code, normalizedCode),
            eq(keys.status, "active")
          )
        );

      // affectedRows === 0 significa que outra requisição concurrent já resgatou
      const affectedRows = (updateResult as unknown as { affectedRows?: number }[])[0]?.affectedRows ?? 0;
      if (affectedRows === 0) {
        throw new Error("Chave já foi resgatada");
      }

      // ── ETAPA 3: Criar os jobs de entrega com divisão inteligente ──
      //
      // Regras:
      //   - Cada job entrega exatamente 1 conta (500 créditos)
      //   - Máximo de 5 jobs por cliente
      //   - Os créditos são distribuídos igualmente entre os jobs
      //   - Se sobrar créditos (resto da divisão), o último job recebe a conta extra
      //   - Sempre cria uma pasta para agrupar os jobs do cliente
      //   - Exemplos:
      //       500 cr  → 1 job  × 1 conta  (pasta com 1 job)
      //       1000 cr → 2 jobs × 1 conta  (pasta com 2 jobs)
      //       2500 cr → 5 jobs × 1 conta  (pasta com 5 jobs)
      //       5000 cr → 5 jobs × 2 contas (pasta com 5 jobs)
      //       7500 cr → 5 jobs × 3 contas (pasta com 5 jobs)
      //
      const { orchestrator } = await import("../core/orchestrator");

      const CREDITS_PER_ACCOUNT = 500;
      const MAX_JOBS_PER_CLIENT = 5;

      const totalAccounts = Math.max(1, Math.floor(key.credits / CREDITS_PER_ACCOUNT));

      // Calcula o número de jobs: mínimo 1, máximo MAX_JOBS_PER_CLIENT
      const jobCount = Math.min(totalAccounts, MAX_JOBS_PER_CLIENT);

      // Distribui as contas entre os jobs
      // base = contas por job (arredondado para baixo)
      // extra = contas que sobram (distribuídas nos últimos jobs)
      const baseAccountsPerJob = Math.floor(totalAccounts / jobCount);
      const extraAccounts = totalAccounts % jobCount;

      // Monta o array de quantidades por job
      // Os últimos `extraAccounts` jobs recebem 1 conta a mais
      const jobQuantities: number[] = Array.from({ length: jobCount }, (_, i) => {
        const isLastGroup = i >= jobCount - extraAccounts;
        return baseAccountsPerJob + (isLastGroup && extraAccounts > 0 ? 1 : 0);
      });

      const cleanInviteCode = extractInviteCode(input.inviteCode);

      // Nome da pasta e dos jobs: usa o nome enviado pela API se disponível,
      // caso contrário usa os primeiros 12 caracteres do invite code.
      // O invite code já fica registrado no campo redeemedBy da key.
      const clientName = input.name?.trim()
        ? input.name.trim()
        : cleanInviteCode.substring(0, 12);

      await orchestrator.createClientJobs({
        provider: "manus",
        inviteCode: cleanInviteCode,
        clientName,
        keyCode: key.code,
        jobQuantities,
      });

      return {
        success: true,
        credits: key.credits,
        jobCount,
        totalAccounts,
      };
    }),
});
