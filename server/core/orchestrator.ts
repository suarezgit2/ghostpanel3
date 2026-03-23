/**
 * Orchestrator v2.1
 *
 * Mudanças em relação à v2:
 *   1. O job agora roda até atingir a QUANTIDADE DE SUCESSO solicitada,
 *      não apenas N tentativas. Se pediu 2 contas, só para quando tiver 2 com sucesso.
 *   2. Limite de segurança (maxAttempts) para evitar loop infinito:
 *      maxAttempts = quantity * 5 (ou seja, até 5x tentativas por conta solicitada).
 *   3. Backoff inteligente: após falhas consecutivas, aumenta o delay progressivamente.
 *   4. Se atingir o maxAttempts sem completar, finaliza com status parcial.
 *   5. Job Rápido suporta múltiplos jobs por destinatário, agrupados em pasta.
 *
 * v10.0 FIX: Proxy leak on cancellation
 *   - cancelJob() and forceAbort() now call proxyService.releaseAllForJob()
 *     to ensure ALL proxies allocated during the job (including extras from
 *     provider health-check and step-2 retries) are properly released.
 *   - executeJob early-return paths (DB status check for cancelled/deleted)
 *     now release the current proxy before returning.
 *   - The .finally() block in createJob also calls releaseAllForJob as a
 *     safety net to catch any remaining tracked proxies.
 */

import { eq, sql } from "drizzle-orm";
import { getDb } from "../db";
import { jobs, accounts, providers, jobFolders } from "../../drizzle/schema";
import { proxyService, getProxyRegion } from "../services/proxy";
import { fingerprintService } from "../services/fingerprint";
import { logger, generateEmailPrefix, generatePassword, STEP_DELAYS, sleep, extractInviteCode, checkAbort } from "../utils/helpers";
import { getSetting } from "../utils/settings";
import { manusProvider, type ManusProvider } from "../providers/manus";

type ProviderInstance = ManusProvider;

const PROVIDERS: Record<string, ProviderInstance> = {
  manus: manusProvider,
};

// Backoff config for consecutive failures (possible rate limiting)
// v9.0: Lowered threshold from 3 to 2 consecutive failures, increased initial backoff
// from 30s to 45s. This gives the FPJS rate limiter more time to cool down between
// orchestrator-level retries, working in tandem with the new FPJS cooldown system.
const BACKOFF_CONFIG = {
  maxConsecutiveFailures: 2,   // After 2 consecutive failures, start backing off
  initialBackoffMs: 45_000,    // 45 seconds
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
  /** ID da pasta de agrupamento (para múltiplos jobs do mesmo cliente) */
  folderId?: number;
}

export interface QuickJobRecipient {
  /** Código de convite ou link do destinatário */
  inviteCode: string;
  /** Quantidade de créditos a enviar */
  credits: number;
  /** Label opcional (nome do cliente) */
  label?: string;
  /** Quantidade de jobs a criar para este destinatário (padrão: 1) */
  jobCount?: number;
}

// ============================================================
// GLOBAL CONCURRENCY LIMITER (v10.1)
// ============================================================
//
// Limita o número máximo de jobs rodando SIMULTANEAMENTE em todo o sistema.
// Isso evita que um burst de resgates de keys (ex: 10 resgates em 1 segundo)
// crie 10 jobs ao mesmo tempo, esgotando proxies e saldo de SMS de uma vez.
//
// O limite é configurado via setting "max_concurrent_jobs" (padrão: 3).
// Quando o limite é atingido, novos jobs aguardam em fila (FIFO).
// Cada job libera um slot ao finalizar (sucesso, falha ou cancelamento).

const DEFAULT_MAX_CONCURRENT_JOBS = 3;

class GlobalJobLimiter {
  private activeCount = 0;
  private queue: Array<() => void> = [];
  private maxConcurrent = DEFAULT_MAX_CONCURRENT_JOBS;

  setMax(max: number): void {
    this.maxConcurrent = Math.max(1, max);
  }

  getMax(): number { return this.maxConcurrent; }
  getActive(): number { return this.activeCount; }
  getQueued(): number { return this.queue.length; }

  /**
   * Aguarda um slot livre e o reserva.
   * Retorna uma função `release` que deve ser chamada quando o job terminar.
   */
  async acquire(jobId: number): Promise<() => void> {
    return new Promise((resolve) => {
      const tryAcquire = () => {
        if (this.activeCount < this.maxConcurrent) {
          this.activeCount++;
          console.log(
            `[GlobalJobLimiter] Job ${jobId} iniciou. Ativos: ${this.activeCount}/${this.maxConcurrent}, ` +
            `Na fila: ${this.queue.length}`
          );
          const release = () => {
            this.activeCount = Math.max(0, this.activeCount - 1);
            console.log(
              `[GlobalJobLimiter] Job ${jobId} liberou slot. Ativos: ${this.activeCount}/${this.maxConcurrent}, ` +
              `Na fila: ${this.queue.length}`
            );
            // Acorda o próximo job na fila
            const next = this.queue.shift();
            if (next) next();
          };
          resolve(release);
        } else {
          // Sem slot livre — enfileira
          console.log(
            `[GlobalJobLimiter] Job ${jobId} aguardando slot. Ativos: ${this.activeCount}/${this.maxConcurrent}, ` +
            `Na fila: ${this.queue.length + 1}`
          );
          this.queue.push(tryAcquire);
        }
      };
      tryAcquire();
    });
  }
}

const globalJobLimiter = new GlobalJobLimiter();

class Orchestrator {
  /** Maps jobId -> AbortController for immediate cancellation signaling */
  private activeJobs = new Map<number, AbortController>();

  async createJob(options: CreateJobOptions): Promise<number> {
    const { provider: providerSlug, quantity } = options;

    const provider = PROVIDERS[providerSlug];
    if (!provider) {
      throw new Error(`Provider '${providerSlug}' não encontrado. Disponíveis: ${Object.keys(PROVIDERS).join(", ")}`);
    }

    const db = await getDb();
    if (!db) throw new Error("Database não disponível");

    // v10.1: Atualiza o limite de concorrência global a partir da setting do banco.
    const maxConcurrentRaw = await getSetting("max_concurrent_jobs");
    const maxConcurrent = parseInt(maxConcurrentRaw || "") || DEFAULT_MAX_CONCURRENT_JOBS;
    globalJobLimiter.setMax(maxConcurrent);

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
      folderId: options.folderId || null,
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

    // Execute in background with AbortController for immediate cancellation
    const abortController = new AbortController();
    this.activeJobs.set(jobId, abortController);

    // v10.1: Controle de concorrência global.
    // O job aguarda um slot livre antes de iniciar o trabalho real.
    // Isso evita que bursts de resgates de keys criem dezenas de jobs simultâneos.
    const _runWithLimiter = async () => {
      const releaseSlot = await globalJobLimiter.acquire(jobId);
      try {
        // Verifica se o job ainda está válido (pode ter sido cancelado enquanto aguardava na fila)
        const currentJob = await db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, jobId)).limit(1);
        const currentStatus = currentJob[0]?.status;
        if (!currentStatus || currentStatus === "cancelled") {
          await logger.info("orchestrator",
            `Job ${jobId} cancelado enquanto aguardava slot de concorrência. Ignorando.`,
            {}, jobId
          );
          return;
        }
        if (globalJobLimiter.getQueued() > 0 || globalJobLimiter.getActive() > 1) {
          await logger.info("orchestrator",
            `Job ${jobId} iniciando execução (ativos: ${globalJobLimiter.getActive()}/${globalJobLimiter.getMax()}, ` +
            `na fila: ${globalJobLimiter.getQueued()})`,
            {}, jobId
          );
        }
        await this.executeJob(jobId, provider, providerId, options, abortController.signal);
      } finally {
        releaseSlot();
      }
    };

    _runWithLimiter().catch(async (err) => {
      if (err instanceof Error && err.name === "AbortError") {
        // Job was aborted — status already set by cancelJob/deleteJob
        return;
      }
      await logger.error("orchestrator", `Job ${jobId} falhou: ${err}`, {}, jobId);
      const db2 = await getDb();
      if (db2) await db2.update(jobs).set({ status: "failed" }).where(eq(jobs.id, jobId));
    }).finally(async () => {
      this.activeJobs.delete(jobId);
      // v10.0: Safety net — release any remaining tracked proxies for this job.
      try {
        await proxyService.releaseAllForJob(jobId);
      } catch (err) {
        console.warn(`[Orchestrator] Erro ao liberar proxies residuais do job ${jobId}:`, err);
      }
    });

    return jobId;
  }

  /**
   * Cria múltiplos jobs em paralelo para o Job Rápido (envio de créditos).
   * Cada destinatário recebe um ou mais jobs com seu próprio invite code.
   * Créditos / 500 = número de contas por job.
   * Se jobCount > 1, cria uma pasta com o nome do cliente e os jobs dentro dela.
   */
  async createQuickJobs(recipients: QuickJobRecipient[]): Promise<{ jobIds: number[]; folderIds: number[]; summary: string }> {
    const CREDITS_PER_ACCOUNT = 500;
    const allJobIds: number[] = [];
    const allFolderIds: number[] = [];
    const summaryLines: string[] = [];

    for (const recipient of recipients) {
      const quantity = Math.max(1, Math.floor(recipient.credits / CREDITS_PER_ACCOUNT));
      const jobCount = Math.max(1, recipient.jobCount || 1);
      const clientName = recipient.label || `${recipient.inviteCode.substring(0, 10)}...`;

      if (jobCount > 1) {
        // Criar pasta para agrupar os jobs deste cliente
        const db = await getDb();
        if (!db) throw new Error("Database não disponível");

        const folderResult = await db.insert(jobFolders).values({
          clientName,
          inviteCode: recipient.inviteCode,
          totalJobs: jobCount,
        });

        const folderId = folderResult[0].insertId;
        allFolderIds.push(folderId);

        const instanceJobIds: number[] = [];
        // v9.0: Increased stagger from 15s to 30s to avoid FPJS rate limiting.
        // With 10 jobs, the old 15s stagger meant all jobs were active within 2.5min,
        // causing cascading 429s. 30s gives FPJS more breathing room.
        const STAGGER_DELAY_MS = 30_000; // 30s between each job start
        for (let i = 0; i < jobCount; i++) {
          if (i > 0) {
            await logger.info("orchestrator", `Aguardando ${STAGGER_DELAY_MS / 1000}s antes de iniciar instância ${i + 1}/${jobCount}...`);
            await sleep(STAGGER_DELAY_MS);
          }
          const label = `${clientName} — Instância ${i + 1}/${jobCount}`;
          const jobId = await this.createJob({
            provider: "manus",
            quantity,
            inviteCode: recipient.inviteCode,
            label,
            folderId,
          });
          instanceJobIds.push(jobId);
          allJobIds.push(jobId);
        }

        summaryLines.push(
          `📁 Pasta "${clientName}" (ID: ${folderId}): ${jobCount} jobs × ${quantity} contas = ${jobCount * quantity} contas totais\n` +
          `   Jobs: ${instanceJobIds.map(id => `#${id}`).join(", ")}`
        );
      } else {
        // Job único — comportamento anterior
        const label = recipient.label || `${recipient.credits} créditos → ${recipient.inviteCode.substring(0, 10)}...`;
        const jobId = await this.createJob({
          provider: "manus",
          quantity,
          inviteCode: recipient.inviteCode,
          label,
        });

        allJobIds.push(jobId);
        summaryLines.push(`Job #${jobId}: ${quantity} contas para "${label}" (${recipient.credits} créditos)`);
      }
    }

    return {
      jobIds: allJobIds,
      folderIds: allFolderIds,
      summary: summaryLines.join("\n"),
    };
  }

  /**
   * executeJob v2.1 — Retry até atingir a quantidade de sucesso solicitada.
   *
   * Lógica:
   *   - O loop roda enquanto successCount < quantity E totalAttempts < maxAttempts
   *   - Cada iteração tenta criar UMA conta
   *   - Se a conta falha, o loop NÃO avança o contador de sucesso — tenta de novo
   *   - O failedAccounts no banco rastreia quantas tentativas falharam (para visibilidade)
   *   - Limite de segurança: maxAttempts = quantity * 5 (evita loop infinito)
   *   - Se atingir maxAttempts sem completar, finaliza com o que conseguiu
   *
   * v10.0: All early-return paths now release the current proxy before returning.
   */
  private async executeJob(jobId: number, provider: ProviderInstance, providerId: number, options: CreateJobOptions, signal?: AbortSignal): Promise<void> {
    // Multi-domain rotation: email_domain can be a comma-separated list
    // e.g. "lojasmesh.com, outrodominio.com, terceiro.com"
    // Each account gets a randomly chosen domain to avoid batch-ban by domain
    const emailDomainRaw = (await getSetting("email_domain")) || "lojasmesh.com";
    const emailDomains = emailDomainRaw
      .split(",")
      .map((d) => d.trim())
      .filter((d) => d.length > 0);
    const region = options.region || "default";
    const db = await getDb();
    if (!db) throw new Error("Database não disponível");

    // Resolve invite code for this job ONCE at start (no global setting mutation)
    const globalInviteRaw = await getSetting("invite_code");
    const globalInviteCode = globalInviteRaw ? extractInviteCode(globalInviteRaw) : "";
    const jobInviteCode = options.inviteCode ? extractInviteCode(options.inviteCode) : globalInviteCode;

    let consecutiveFailures = 0;
    let currentBackoffMs = BACKOFF_CONFIG.initialBackoffMs;

    let successCount = 0;
    let inviteConfirmedCount = 0; // contas criadas com convite confirmado
    let totalAttempts = 0;
    const maxAttempts = options.quantity * MAX_ATTEMPTS_MULTIPLIER;

    await logger.info("orchestrator", `Job ${jobId}: meta=${options.quantity} contas, maxTentativas=${maxAttempts}`, {}, jobId);

    while (successCount < options.quantity && totalAttempts < maxAttempts) {
      // Check AbortSignal first (immediate cancellation from cancelJob/deleteJob)
      if (signal?.aborted) {
        await logger.info("orchestrator", `Job ${jobId} abortado imediatamente (sinal de cancelamento)`, {}, jobId);
        const abortErr = new Error(`Job ${jobId} abortado`);
        abortErr.name = "AbortError";
        throw abortErr;
      }

      // Check DB status (handles cancelled/paused/deleted)
      const currentJob = await db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, jobId)).limit(1);
      const currentStatus = currentJob[0]?.status;

      // Job deletado do banco (currentStatus === undefined) ou cancelado
      if (!currentStatus || currentStatus === "cancelled") {
        await logger.info("orchestrator",
          `Job ${jobId} ${!currentStatus ? "deletado" : "cancelado"} — parando execução`,
          {}, jobId
        );
        // v10.0: releaseAllForJob will be called by the .finally() in createJob
        // No proxy is allocated at this point in the loop (before getProxy), so just return.
        return;
      }

      if (currentStatus === "paused") {
        await logger.info("orchestrator", `Job ${jobId} pausado, aguardando...`, {}, jobId);
        while (true) {
          await sleep(5000, signal);
          const check = await db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, jobId)).limit(1);
          const checkStatus = check[0]?.status;
          if (!checkStatus || checkStatus === "cancelled") {
            await logger.info("orchestrator", `Job ${jobId} ${!checkStatus ? "deletado" : "cancelado"} durante pausa`, {}, jobId);
            // v10.0: releaseAllForJob will be called by the .finally() in createJob
            return;
          }
          if (checkStatus === "running") break;
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
        await sleep(currentBackoffMs, signal);
        currentBackoffMs = Math.min(currentBackoffMs * BACKOFF_CONFIG.multiplier, BACKOFF_CONFIG.maxBackoffMs);
      }

      totalAttempts++;

      // Pick a random domain from the list for each account
      const emailDomain = emailDomains[Math.floor(Math.random() * emailDomains.length)];
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

      // v9.1: Moved proxy/proxyReleased outside try block so the catch block can access them.
      // Before: catch referenced proxy/proxyReleased which were scoped inside try → ReferenceError crash.
      let proxy: Awaited<ReturnType<typeof proxyService.getProxy>> | null = null;
      let proxyReleased = false;
      try {
        proxy = await proxyService.getProxy(jobId);
        // Resolve geo-coherent region from proxy IP (falls back to job region or "default")
        const proxyRegion = proxy ? await getProxyRegion(proxy.host) : (region as Parameters<typeof fingerprintService.generateProfile>[0]);

        // FPJS real ID agora é gerado por chamada RPC dentro de rpc.ts (v5.4)
        const fingerprint = fingerprintService.generateProfile(proxyRegion);

        await logger.info("orchestrator",
          `Tentativa ${totalAttempts}/${maxAttempts} (sucesso: ${successCount}/${options.quantity}): ${email}`,
          {
            proxy: `${proxy.host}:${proxy.port}`,
            clientId: fingerprint.clientId,
            locale: fingerprint.locale,
            timezone: fingerprint.timezone,
          }, jobId
        );

        // Pass invite code directly to createAccount (no global setting mutation = no race condition)
        const result = await provider.createAccount({ email, password, proxy, fingerprint, jobId, inviteCode: jobInviteCode, signal });

        await db.update(accounts).set({
          status: result.status,
          token: result.token || null,
          phone: (result.metadata?.phoneNumber as string) || null,
          metadata: result.metadata || {},
        }).where(eq(accounts.id, accountId));

        if (result.status === "active") {
          successCount++;
          if (result.inviteAccepted) {
            inviteConfirmedCount++;
          }
          await db.update(jobs).set({
            completedAccounts: sql`${jobs.completedAccounts} + 1`,
          }).where(eq(jobs.id, jobId));
          await logger.info("orchestrator",
            `SUCESSO! Conta ${successCount}/${options.quantity} criada (tentativa ${totalAttempts})` +
            (result.inviteAccepted === false ? " [convite NÃO confirmado]" : ""),
            { email }, jobId
          );

          // Release proxy for replacement now that the attempt is done
          if (!proxyReleased) { proxyService.releaseProxy(proxy.host, jobId); proxyReleased = true; }

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

          // Release proxy for replacement now that the attempt is done
          if (!proxyReleased) { proxyService.releaseProxy(proxy.host, jobId); proxyReleased = true; }

          consecutiveFailures++;

          if (result.error?.includes("resource_exhausted") || result.error?.includes("rate limit")) {
            await logger.warn("orchestrator", "Rate limiting detectado! Aumentando backoff...", {}, jobId);
            consecutiveFailures = BACKOFF_CONFIG.maxConsecutiveFailures;
          }
        }

      } catch (err) {
        // AbortError = job cancelled — bail out immediately
        if (err instanceof DOMException && err.name === "AbortError") {
          await logger.info("orchestrator", `Job ${jobId} abortado durante createAccount`, {}, jobId);
          await db.update(accounts).set({ status: "failed", metadata: { error: "Job cancelado" } }).where(eq(accounts.id, accountId));
          // v9.8: Smart proxy handling on cancellation.
          // Check if the account was actually registered (has a token in DB).
          // If NOT registered, the proxy IP was never associated with a real account
          // on the target platform, so it can be safely recycled back to the pool
          // instead of being wasted on a replacement.
          if (proxy && !proxyReleased) {
            const acct = await db.select({ token: accounts.token }).from(accounts).where(eq(accounts.id, accountId)).limit(1);
            const wasRegistered = !!(acct[0]?.token);
            if (wasRegistered) {
              // Account was registered — proxy IP is burned, send for replacement
              await logger.info("orchestrator", `Job ${jobId} cancelado APÓS registro — proxy ${proxy.host} queimado, enviando para replacement`, {}, jobId);
              proxyService.releaseProxy(proxy.host, jobId);
            } else {
              // Account was NOT registered — proxy IP is clean, recycle it
              await logger.info("orchestrator", `Job ${jobId} cancelado ANTES do registro — proxy ${proxy.host} não foi queimado, reciclando`, {}, jobId);
              await proxyService.recycleProxy(proxy.host, jobId);
            }
            proxyReleased = true;
          }
          // v10.0: Any remaining proxies (from provider internal swaps) will be
          // released by the .finally() block in createJob via releaseAllForJob()
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        await db.update(accounts).set({
          status: "failed",
          metadata: { error: msg },
        }).where(eq(accounts.id, accountId));

        await db.update(jobs).set({
          failedAccounts: sql`${jobs.failedAccounts} + 1`,
        }).where(eq(jobs.id, jobId));

        await logger.error("orchestrator",
          `ERRO na tentativa ${totalAttempts}: ${msg} (sucesso: ${successCount}/${options.quantity}, restam ${maxAttempts - totalAttempts} tentativas)`,
          { email }, jobId
        );
        // v9.1: Safe proxy release — proxy may be null if getProxy() itself threw
        if (proxy && !proxyReleased) { proxyService.releaseProxy(proxy.host, jobId); proxyReleased = true; }
        consecutiveFailures++;
      }

      // Delay between attempts (only if we need more)
      if (successCount < options.quantity && totalAttempts < maxAttempts) {
        await STEP_DELAYS.betweenAccounts(signal);
      }
    }

    // Finalize job
    const finalJob = await db.select({
      completed: jobs.completedAccounts,
      failed: jobs.failedAccounts,
      total: jobs.totalAccounts,
    }).from(jobs).where(eq(jobs.id, jobId)).limit(1);

    const fj = finalJob[0];

    let finalStatus: "completed" | "partial" | "failed";
    if (fj && fj.completed >= fj.total) {
      // Todas as contas foram criadas — mas verifica se o convite foi confirmado em todas
      if (jobInviteCode && inviteConfirmedCount < successCount) {
        finalStatus = "partial";
        await logger.warn("orchestrator",
          `Job ${jobId}: contas criadas mas convite não confirmado em todas ` +
          `(${inviteConfirmedCount}/${successCount} com convite confirmado). Status: partial`,
          {}, jobId
        );
      } else {
        finalStatus = "completed";
      }
    } else if (totalAttempts >= maxAttempts && successCount < options.quantity) {
      // Atingiu o limite de tentativas sem completar a meta
      finalStatus = successCount > 0 ? "partial" : "failed";
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

  /**
   * v10.0: cancelJob now also releases all tracked proxies for the job.
   */
  async cancelJob(jobId: number): Promise<void> {
    const db = await getDb();
    if (!db) throw new Error("Database não disponível");

    // Signal abort immediately so the running loop stops ASAP
    const controller = this.activeJobs.get(jobId);
    if (controller) {
      controller.abort();
    }

    await db.update(jobs).set({ status: "cancelled" }).where(eq(jobs.id, jobId));
    await logger.info("orchestrator", `Job ${jobId} cancelado (sinal de abort enviado)`, {}, jobId);

    // v10.0: Release any tracked proxies that the job was holding.
    // The executeJob loop will also try to release via the catch/finally blocks,
    // but this ensures proxies are freed even if executeJob is stuck in an
    // HTTP call that doesn't respect AbortSignal.
    // Note: releaseAllForJob is idempotent — double-releasing is safe because
    // releaseProxy/recycleProxy already handle the case where the proxy was
    // already processed (it just won't be in the queue twice).
    try {
      await proxyService.releaseAllForJob(jobId);
    } catch (err) {
      console.warn(`[Orchestrator] Erro ao liberar proxies do job ${jobId} no cancelamento:`, err);
    }
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

  /**
   * v10.1: Retorna o estado atual do limitador global de concorrência.
   * Útil para monitoramento e debug via logs.
   */
  getLimiterStatus(): { active: number; queued: number; max: number } {
    return {
      active: globalJobLimiter.getActive(),
      queued: globalJobLimiter.getQueued(),
      max: globalJobLimiter.getMax(),
    };
  }

  /**
   * Force-cancels a job immediately by aborting its signal.
   * Used by the delete endpoint to stop a running job before removing it from DB.
   *
   * v10.0: Now also releases all tracked proxies for the job before removing
   * from activeJobs. This prevents proxy leaks when jobs are deleted while running.
   */
  async forceAbort(jobId: number): Promise<void> {
    const controller = this.activeJobs.get(jobId);
    if (controller) {
      controller.abort();
    }

    // v10.0: Release all tracked proxies BEFORE removing from activeJobs.
    // This ensures proxies are freed even if the executeJob loop hasn't
    // reached its catch/finally blocks yet.
    try {
      await proxyService.releaseAllForJob(jobId);
    } catch (err) {
      console.warn(`[Orchestrator] Erro ao liberar proxies do job ${jobId} no forceAbort:`, err);
    }

    this.activeJobs.delete(jobId);
  }
}

export const orchestrator = new Orchestrator();
