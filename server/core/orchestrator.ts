/**
 * Orchestrator v2
 *
 * Mudanças em relação à v1:
 *   1. O job agora roda até atingir a QUANTIDADE DE SUCESSO solicitada,
 *      não apenas N tentativas. Se pediu 2 contas, só para quando tiver 2 com sucesso.
 *   2. Limite de segurança (maxAttempts) para evitar loop infinito:
 *      maxAttempts = quantity * 5 (ou seja, até 5x tentativas por conta solicitada).
 *   3. Backoff inteligente: após falhas consecutivas, aumenta o delay progressivamente.
 *   4. Se atingir o maxAttempts sem completar, finaliza com status parcial.
 */

import { eq, sql } from "drizzle-orm";
import { getDb } from "../db";
import { jobs, accounts, providers } from "../../drizzle/schema";
import { proxyService } from "../services/proxy";
import { fingerprintService } from "../services/fingerprint";
import { logger, generateEmailPrefix, generatePassword, STEP_DELAYS, sleep, extractInviteCode } from "../utils/helpers";
import { getSetting, setSetting } from "../utils/settings";
import { manusProvider, type ManusProvider } from "../providers/manus";

type ProviderInstance = ManusProvider;

const PROVIDERS: Record<string, ProviderInstance> = {
  manus: manusProvider,
};

// Backoff config for consecutive failures (possible rate limiting)
const BACKOFF_CONFIG = {
  maxConsecutiveFailures: 3,   // After 3 consecutive failures, start backing off
  initialBackoffMs: 30_000,    // 30 seconds
  maxBackoffMs: 300_000,       // 5 minutes max
  multiplier: 2,               // Double each time
};

// Safety limit: max attempts = quantity * this multiplier
const MAX_ATTEMPTS_MULTIPLIER = 5;

export interface CreateJobOptions {
  provider: string;
  quantity: number;
  password?: string;
  delayMin?: number;
  delayMax?: number;
  region?: string;
  concurrency?: number;
  /** Invite code override — se definido, substitui o invite_code do banco para este job */
  inviteCode?: string;
  /** Label para identificar o job (ex: "Usuário A - 5000 créditos") */
  label?: string;
}

export interface QuickJobRecipient {
  /** Código de convite ou link do destinatário */
  inviteCode: string;
  /** Quantidade de créditos a enviar */
  credits: number;
  /** Label opcional */
  label?: string;
}

class Orchestrator {
  private activeJobs = new Map<number, boolean>();

  async createJob(options: CreateJobOptions): Promise<number> {
    const { provider: providerSlug, quantity } = options;

    const provider = PROVIDERS[providerSlug];
    if (!provider) {
      throw new Error(`Provider '${providerSlug}' não encontrado. Disponíveis: ${Object.keys(PROVIDERS).join(", ")}`);
    }

    const db = await getDb();
    if (!db) throw new Error("Database não disponível");

    // Find provider in DB
    const providerRows = await db.select().from(providers).where(eq(providers.slug, providerSlug)).limit(1);
    if (providerRows.length === 0) throw new Error(`Provider '${providerSlug}' não encontrado no banco`);
    const providerId = providerRows[0].id;

    // Create job
    const result = await db.insert(jobs).values({
      providerId,
      status: "running",
      totalAccounts: quantity,
      completedAccounts: 0,
      failedAccounts: 0,
      concurrency: options.concurrency || 1,
      config: {
        password: options.password || "auto",
        delayMin: options.delayMin || 3000,
        delayMax: options.delayMax || 10000,
        region: options.region || "default",
        inviteCode: options.inviteCode || null,
        label: options.label || null,
      },
      startedAt: new Date(),
    });

    const jobId = result[0].insertId;
    const label = options.label ? ` [${options.label}]` : "";
    await logger.info("orchestrator", `Job ${jobId}${label} criado: ${quantity} contas via ${providerSlug}`, {}, jobId);

    // Execute in background
    this.activeJobs.set(jobId, true);
    this.executeJob(jobId, provider, providerId, options).catch(async (err) => {
      await logger.error("orchestrator", `Job ${jobId} falhou: ${err}`, {}, jobId);
      const db2 = await getDb();
      if (db2) await db2.update(jobs).set({ status: "failed" }).where(eq(jobs.id, jobId));
    }).finally(() => {
      this.activeJobs.delete(jobId);
    });

    return jobId;
  }

  /**
   * Cria múltiplos jobs em paralelo para o Job Rápido (envio de créditos).
   * Cada destinatário recebe um job independente com seu próprio invite code.
   * Créditos / 500 = número de contas a criar.
   */
  async createQuickJobs(recipients: QuickJobRecipient[]): Promise<{ jobIds: number[]; summary: string }> {
    const CREDITS_PER_ACCOUNT = 500;
    const jobIds: number[] = [];
    const summaryLines: string[] = [];

    for (const recipient of recipients) {
      const quantity = Math.max(1, Math.floor(recipient.credits / CREDITS_PER_ACCOUNT));
      const label = recipient.label || `${recipient.credits} créditos → ${recipient.inviteCode.substring(0, 10)}...`;

      const jobId = await this.createJob({
        provider: "manus",
        quantity,
        inviteCode: recipient.inviteCode,
        label,
      });

      jobIds.push(jobId);
      summaryLines.push(`Job #${jobId}: ${quantity} contas para "${label}" (${recipient.credits} créditos)`);
    }

    return {
      jobIds,
      summary: summaryLines.join("\n"),
    };
  }

  /**
   * executeJob v2 — Retry até atingir a quantidade de sucesso solicitada.
   *
   * Lógica:
   *   - O loop roda enquanto successCount < quantity E totalAttempts < maxAttempts
   *   - Cada iteração tenta criar UMA conta
   *   - Se a conta falha, o loop NÃO avança o contador de sucesso — tenta de novo
   *   - O failedAccounts no banco rastreia quantas tentativas falharam (para visibilidade)
   *   - Limite de segurança: maxAttempts = quantity * 5 (evita loop infinito)
   *   - Se atingir maxAttempts sem completar, finaliza com o que conseguiu
   */
  private async executeJob(jobId: number, provider: ProviderInstance, providerId: number, options: CreateJobOptions): Promise<void> {
    const emailDomain = (await getSetting("email_domain")) || "lojasmesh.com";
    const region = options.region || "default";
    const db = await getDb();
    if (!db) throw new Error("Database não disponível");

    const rawOriginalInviteCode = await getSetting("invite_code");
    const originalInviteCode = rawOriginalInviteCode ? extractInviteCode(rawOriginalInviteCode) : "";
    const rawJobInviteCode = options.inviteCode ? extractInviteCode(options.inviteCode) : "";
    const jobInviteCode = rawJobInviteCode || originalInviteCode;
    const useCustomInvite = !!(options.inviteCode && options.inviteCode !== originalInviteCode);

    let consecutiveFailures = 0;
    let currentBackoffMs = BACKOFF_CONFIG.initialBackoffMs;

    let successCount = 0;
    let totalAttempts = 0;
    const maxAttempts = options.quantity * MAX_ATTEMPTS_MULTIPLIER;

    await logger.info("orchestrator", `Job ${jobId}: meta=${options.quantity} contas, maxTentativas=${maxAttempts}`, {}, jobId);

    while (successCount < options.quantity && totalAttempts < maxAttempts) {
      // Check for cancellation or pause
      const currentJob = await db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, jobId)).limit(1);
      if (currentJob[0]?.status === "cancelled") {
        await logger.info("orchestrator", `Job ${jobId} cancelado pelo usuário`, {}, jobId);
        break;
      }
      if (currentJob[0]?.status === "paused") {
        await logger.info("orchestrator", `Job ${jobId} pausado, aguardando...`, {}, jobId);
        while (true) {
          await sleep(5000);
          const check = await db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, jobId)).limit(1);
          if (check[0]?.status === "running") break;
          if (check[0]?.status === "cancelled") {
            await logger.info("orchestrator", `Job ${jobId} cancelado durante pausa`, {}, jobId);
            return;
          }
        }
      }

      // Exponential backoff after consecutive failures
      if (consecutiveFailures >= BACKOFF_CONFIG.maxConsecutiveFailures) {
        await logger.warn("orchestrator",
          `${consecutiveFailures} falhas consecutivas — possível rate limiting. ` +
          `Aguardando ${Math.round(currentBackoffMs / 1000)}s... ` +
          `(progresso: ${successCount}/${options.quantity} sucesso, ${totalAttempts} tentativas)`,
          {}, jobId
        );
        await sleep(currentBackoffMs);
        currentBackoffMs = Math.min(currentBackoffMs * BACKOFF_CONFIG.multiplier, BACKOFF_CONFIG.maxBackoffMs);
      }

      totalAttempts++;

      const email = `${generateEmailPrefix(12)}@${emailDomain}`;
      const password = options.password === "auto" || !options.password ? generatePassword(16) : options.password;

      // Create account record
      const accountResult = await db.insert(accounts).values({
        jobId,
        providerId,
        email,
        password,
        status: "unverified",
      });

      const accountId = accountResult[0].insertId;

      try {
        const proxy = await proxyService.getProxy(jobId);
        const fingerprint = fingerprintService.generateProfile(region);

        await logger.info("orchestrator",
          `Tentativa ${totalAttempts}/${maxAttempts} (sucesso: ${successCount}/${options.quantity}): ${email}`,
          {
            proxy: `${proxy.host}:${proxy.port}`,
            clientId: fingerprint.clientId,
            locale: fingerprint.locale,
            timezone: fingerprint.timezone,
          }, jobId
        );

        // Override invite code temporariamente se o job tem um próprio
        if (useCustomInvite && jobInviteCode) {
          await setSetting("invite_code", jobInviteCode);
        }

        const result = await provider.createAccount({ email, password, proxy, fingerprint, jobId });

        // Restaurar invite code original após uso
        if (useCustomInvite && originalInviteCode) {
          await setSetting("invite_code", originalInviteCode);
        }

        await db.update(accounts).set({
          status: result.status,
          token: result.token || null,
          phone: (result.metadata?.phoneNumber as string) || null,
          metadata: result.metadata || {},
        }).where(eq(accounts.id, accountId));

        if (result.status === "active") {
          successCount++;
          await db.update(jobs).set({
            completedAccounts: sql`${jobs.completedAccounts} + 1`,
          }).where(eq(jobs.id, jobId));
          await logger.info("orchestrator",
            `SUCESSO! Conta ${successCount}/${options.quantity} criada (tentativa ${totalAttempts})`,
            { email }, jobId
          );

          // Reset backoff on success
          consecutiveFailures = 0;
          currentBackoffMs = BACKOFF_CONFIG.initialBackoffMs;
        } else {
          await db.update(jobs).set({
            failedAccounts: sql`${jobs.failedAccounts} + 1`,
          }).where(eq(jobs.id, jobId));
          await logger.error("orchestrator",
            `FALHA na tentativa ${totalAttempts}: ${result.error} (sucesso: ${successCount}/${options.quantity}, restam ${maxAttempts - totalAttempts} tentativas)`,
            { email }, jobId
          );

          consecutiveFailures++;

          if (result.error?.includes("resource_exhausted") || result.error?.includes("rate limit")) {
            await logger.warn("orchestrator", "Rate limiting detectado! Aumentando backoff...", {}, jobId);
            consecutiveFailures = BACKOFF_CONFIG.maxConsecutiveFailures;
          }
        }

      } catch (err) {
        // Restaurar invite code em caso de erro
        if (useCustomInvite && originalInviteCode) {
          await setSetting("invite_code", originalInviteCode).catch(() => {});
        }

        const msg = err instanceof Error ? err.message : String(err);
        await db.update(accounts).set({
          status: "failed" as const,
          metadata: { error: msg },
        }).where(eq(accounts.id, accountId));

        await db.update(jobs).set({
          failedAccounts: sql`${jobs.failedAccounts} + 1`,
        }).where(eq(jobs.id, jobId));

        await logger.error("orchestrator",
          `ERRO na tentativa ${totalAttempts}: ${msg} (sucesso: ${successCount}/${options.quantity}, restam ${maxAttempts - totalAttempts} tentativas)`,
          { email }, jobId
        );
        consecutiveFailures++;
      }

      // Delay between attempts (only if we need more)
      if (successCount < options.quantity && totalAttempts < maxAttempts) {
        await STEP_DELAYS.betweenAccounts();
      }
    }

    // Finalize job
    const finalJob = await db.select({
      completed: jobs.completedAccounts,
      failed: jobs.failedAccounts,
      total: jobs.totalAccounts,
    }).from(jobs).where(eq(jobs.id, jobId)).limit(1);

    const fj = finalJob[0];

    let finalStatus: "completed" | "failed";
    if (fj && fj.completed >= fj.total) {
      finalStatus = "completed";
    } else if (totalAttempts >= maxAttempts && successCount < options.quantity) {
      // Atingiu o limite de tentativas sem completar a meta
      finalStatus = successCount > 0 ? "completed" : "failed";
      await logger.warn("orchestrator",
        `Job ${jobId} atingiu o limite de ${maxAttempts} tentativas. ` +
        `Conseguiu ${successCount}/${options.quantity} contas.`,
        {}, jobId
      );
    } else {
      finalStatus = "completed";
    }

    await db.update(jobs).set({
      status: finalStatus,
      completedAt: new Date(),
    }).where(eq(jobs.id, jobId));

    await logger.info("orchestrator",
      `Job ${jobId} finalizado [${finalStatus}]: ${fj?.completed}/${fj?.total} sucesso, ` +
      `${fj?.failed} falhas, ${totalAttempts} tentativas totais`,
      {}, jobId
    );
  }

  async cancelJob(jobId: number): Promise<void> {
    const db = await getDb();
    if (!db) throw new Error("Database não disponível");

    await db.update(jobs).set({ status: "cancelled" }).where(eq(jobs.id, jobId));
    await logger.info("orchestrator", `Job ${jobId} marcado para cancelamento`, {}, jobId);
  }

  async pauseJob(jobId: number): Promise<void> {
    const db = await getDb();
    if (!db) throw new Error("Database não disponível");

    await db.update(jobs).set({ status: "paused" }).where(eq(jobs.id, jobId));
    await logger.info("orchestrator", `Job ${jobId} pausado`, {}, jobId);
  }

  async resumeJob(jobId: number): Promise<void> {
    const db = await getDb();
    if (!db) throw new Error("Database não disponível");

    await db.update(jobs).set({ status: "running" }).where(eq(jobs.id, jobId));
    await logger.info("orchestrator", `Job ${jobId} retomado`, {}, jobId);
  }

  getActiveJobs(): number[] {
    return Array.from(this.activeJobs.keys());
  }

  isJobActive(jobId: number): boolean {
    return this.activeJobs.has(jobId);
  }
}

export const orchestrator = new Orchestrator();
