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

import { eq, sql, and } from "drizzle-orm";
import { getDb } from "../db";
import { jobs, accounts, providers, jobFolders } from "../../drizzle/schema";
import { proxyService, getProxyRegion } from "../services/proxy";
import { fingerprintService } from "../services/fingerprint";
import { logger, generateEmailPrefix, generatePassword, STEP_DELAYS, sleep, extractInviteCode, checkAbort } from "../utils/helpers";
import { getSetting } from "../utils/settings";
import { emailService } from "../services/email";
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

/**
 * Opções para criação de jobs via resgate de key.
 * Cada cliente recebe uma pasta com N jobs, onde N é determinado pela
 * divisão inteligente dos créditos (máx 5 jobs por cliente).
 */
export interface CreateClientJobsOptions {
  /** Provider a usar (ex: "manus") */
  provider: string;
  /** Invite code do cliente */
  inviteCode: string;
  /** Nome do cliente para a pasta (ex: "João (P3MUJV1Q)") */
  clientName: string;
  /** Código da key resgatada (para label) */
  keyCode: string;
  /** Array com a quantidade de contas de cada job (ex: [2, 2, 1] para 5 créditos) */
  jobQuantities: number[];
}

// ============================================================
// CLIENT QUEUE LIMITER (v10.2)
// ============================================================
//
// Controla a concorrência em dois níveis:
//
//   1. Nível CLIENTE: máximo de MAX_CONCURRENT_CLIENTS clientes sendo
//      processados simultaneamente (padrão: 3). Um "cliente" é o conjunto
//      de jobs criados por um único resgate de key. Quando o limite é
//      atingido, novos clientes aguardam em fila FIFO.
//
//   2. Nível JOB: dentro de um cliente, os jobs rodam em sequência (um
//      por vez), com stagger de 30s entre eles. Isso evita que 5 jobs do
//      mesmo cliente compitam pelos mesmos recursos ao mesmo tempo.
//
// Configuração via settings do banco:
//   max_concurrent_clients: número máximo de clientes simultâneos (padrão: 3)
//
// Exemplo de fluxo com 5 clientes:
//   Clientes 1, 2, 3 → iniciam imediatamente
//   Clientes 4, 5   → aguardam na fila
//   Quando cliente 1 termina todos os seus jobs → cliente 4 inicia
//   Quando cliente 2 termina → cliente 5 inicia

const DEFAULT_MAX_CONCURRENT_CLIENTS = 3;
const DEFAULT_MAX_CONCURRENT_JOBS = 3; // Mantido para compatibilidade com getLimiterStatus

class ClientQueueLimiter {
  private activeClients = 0;
  private queue: Array<() => void> = [];
  private maxClients = DEFAULT_MAX_CONCURRENT_CLIENTS;

  setMax(max: number): void {
    this.maxClients = Math.max(1, max);
  }

  getMax(): number { return this.maxClients; }
  getActive(): number { return this.activeClients; }
  getQueued(): number { return this.queue.length; }

  /**
   * Aguarda um slot de cliente livre e o reserva.
   * Retorna uma função `release` que deve ser chamada quando TODOS os
   * jobs do cliente terminarem.
   */
  async acquire(clientName: string): Promise<() => void> {
    return new Promise((resolve) => {
      const tryAcquire = () => {
        if (this.activeClients < this.maxClients) {
          this.activeClients++;
          console.log(
            `[ClientQueue] Cliente "${clientName}" iniciou. ` +
            `Ativos: ${this.activeClients}/${this.maxClients}, Na fila: ${this.queue.length}`
          );
          const release = () => {
            this.activeClients = Math.max(0, this.activeClients - 1);
            console.log(
              `[ClientQueue] Cliente "${clientName}" concluíd. ` +
              `Ativos: ${this.activeClients}/${this.maxClients}, Na fila: ${this.queue.length}`
            );
            const next = this.queue.shift();
            if (next) next();
          };
          resolve(release);
        } else {
          console.log(
            `[ClientQueue] Cliente "${clientName}" aguardando slot. ` +
            `Ativos: ${this.activeClients}/${this.maxClients}, Na fila: ${this.queue.length + 1}`
          );
          this.queue.push(tryAcquire);
        }
      };
      tryAcquire();
    });
  }
}

const clientQueueLimiter = new ClientQueueLimiter();

// Alias para compatibilidade com getLimiterStatus
const globalJobLimiter = {
  getActive: () => clientQueueLimiter.getActive(),
  getQueued: () => clientQueueLimiter.getQueued(),
  getMax: () => clientQueueLimiter.getMax(),
};

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

    // Find provider in DB
    const providerRows = await db.select().from(providers).where(eq(providers.slug, providerSlug)).limit(1);
    if (providerRows.length === 0) throw new Error(`Provider '${providerSlug}' não encontrado no banco`);
    const providerId = providerRows[0].id;

    // Create job record
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

    this._runJob(jobId, provider, providerId, options, abortController);

    return jobId;
  }

  /**
   * Executa um job em background (sem aguardar na fila de clientes).
   * Usado internamente pelo createJob e pelo createClientJobs.
   * O controle de concorrência por cliente é feito no createClientJobs.
   */
  private _runJob(
    jobId: number,
    provider: ProviderInstance,
    providerId: number,
    options: CreateJobOptions,
    abortController: AbortController
  ): void {
    const run = async () => {
      await this.executeJob(jobId, provider, providerId, options, abortController.signal);
    };

    run().catch(async (err) => {
      if (err instanceof Error && err.name === "AbortError") return;
      await logger.error("orchestrator", `Job ${jobId} falhou: ${err}`, {}, jobId);
      const db2 = await getDb();
      if (db2) await db2.update(jobs).set({ status: "failed" }).where(eq(jobs.id, jobId));
    }).finally(async () => {
      this.activeJobs.delete(jobId);
      try {
        await proxyService.releaseAllForJob(jobId);
      } catch (err) {
        console.warn(`[Orchestrator] Erro ao liberar proxies residuais do job ${jobId}:`, err);
      }
    });
  }

  /**
   * v10.3: Cria jobs para um cliente via resgate de key ou QuickJob.
   *
   * Fluxo:
   *   1. Aguarda um slot de cliente livre (máx MAX_CONCURRENT_CLIENTS simultâneos)
   *   2. Cria a pasta do cliente no banco
   *   3. Dispara TODOS os jobs do cliente em PARALELO (Promise.all)
   *   4. Libera o slot do cliente quando todos os jobs terminarem
   *
   * Limite de concorrência:
   *   - Até 5 jobs por cliente (definido em MAX_JOBS_PER_CLIENT no router)
   *   - Até 3 clientes simultâneos (ClientQueueLimiter)
   *   - Total máximo: 15 jobs ativos simultâneos
   */
  async createClientJobs(options: CreateClientJobsOptions): Promise<{ folderId: number; jobIds: number[] }> {
    const { provider: providerSlug, inviteCode, clientName, keyCode, jobQuantities } = options;

    const provider = PROVIDERS[providerSlug];
    if (!provider) throw new Error(`Provider '${providerSlug}' não encontrado`);

    const db = await getDb();
    if (!db) throw new Error("Database não disponível");

    // Atualiza o limite de clientes simultâneos a partir da setting do banco
    const maxClientsRaw = await getSetting("max_concurrent_clients");
    const maxClients = parseInt(maxClientsRaw || "") || DEFAULT_MAX_CONCURRENT_CLIENTS;
    clientQueueLimiter.setMax(maxClients);

    // Find provider in DB
    const providerRows = await db.select().from(providers).where(eq(providers.slug, providerSlug)).limit(1);
    if (providerRows.length === 0) throw new Error(`Provider '${providerSlug}' não encontrado no banco`);
    const providerId = providerRows[0].id;

    const jobCount = jobQuantities.length;
    const totalAccounts = jobQuantities.reduce((a, b) => a + b, 0);

    await logger.info("orchestrator",
      `Cliente "${clientName}" (Key ${keyCode}): ${jobCount} job(s) em paralelo, ${totalAccounts} conta(s) total. ` +
      `Fila: ${clientQueueLimiter.getQueued()} aguardando, ${clientQueueLimiter.getActive()}/${clientQueueLimiter.getMax()} ativos.`
    );

    // Cria a pasta ANTES de aguardar na fila, para que o ID já exista no banco
    const folderResult = await db.insert(jobFolders).values({
      clientName,
      inviteCode,
      totalJobs: jobCount,
    });
    const folderId = folderResult[0].insertId;

    // Cria os jobs no banco com status "pending" (aguardando slot de cliente)
    const pendingJobIds: number[] = [];
    for (let i = 0; i < jobCount; i++) {
      const quantity = jobQuantities[i];
      const label = jobCount > 1
        ? `${clientName} — Job ${i + 1}/${jobCount}`
        : clientName;

      const result = await db.insert(jobs).values({
        providerId,
        status: "pending",
        totalAccounts: quantity,
        completedAccounts: 0,
        failedAccounts: 0,
        concurrency: 1,
        folderId,
        config: {
          password: "auto",
          delayMin: 3000,
          delayMax: 10000,
          region: "default",
          inviteCode,
          label,
        },
        startedAt: null,
      });
      pendingJobIds.push(result[0].insertId);
      await logger.info("orchestrator",
        `Job ${result[0].insertId} criado (pending): ${quantity} conta(s) para "${label}"`,
        {}, result[0].insertId
      );
    }

    // Executa os jobs em background, aguardando slot de cliente
    const _runAllJobs = async () => {
      // Aguarda slot de cliente livre (máx MAX_CONCURRENT_CLIENTS clientes ao mesmo tempo)
      const releaseClient = await clientQueueLimiter.acquire(clientName);

      try {
        await logger.info("orchestrator",
          `Cliente "${clientName}" iniciando (${clientQueueLimiter.getActive()}/${clientQueueLimiter.getMax()} ativos, ` +
          `${clientQueueLimiter.getQueued()} na fila). Pasta #${folderId}, ${jobCount} job(s) em sequência.`
        );

        // v10.5: Alterado de paralelo (Promise.all) para SEQUENCIAL (for...of)
        // Isso evita que múltiplos jobs esgotem o pool de proxies simultaneamente.
        for (let i = 0; i < pendingJobIds.length; i++) {
          const jobId = pendingJobIds[i];
          const quantity = jobQuantities[i];
          const label = jobCount > 1
            ? `${clientName} — Job ${i + 1}/${jobCount}`
            : clientName;

          // Verifica se o job foi cancelado enquanto aguardava na fila de clientes
          const currentJob = await db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, jobId)).limit(1);
          if (!currentJob[0] || currentJob[0].status === "cancelled") {
            await logger.info("orchestrator",
              `Job ${jobId} cancelado antes de iniciar. Pulando.`,
              {}, jobId
            );
            continue;
          }

          // Marca como running e inicia
          await db.update(jobs).set({ status: "running", startedAt: new Date() }).where(eq(jobs.id, jobId));

          const abortController = new AbortController();
          this.activeJobs.set(jobId, abortController);

          const jobOptions: CreateJobOptions = {
            provider: providerSlug,
            quantity,
            inviteCode,
            label,
            folderId,
          };

          await logger.info("orchestrator",
            `Job ${jobId} iniciando (${i + 1}/${jobCount} do cliente "${clientName}")`,
            {}, jobId
          );

          try {
            await this.executeJob(jobId, provider, providerId, jobOptions, abortController.signal);
          } catch (err) {
            if (err instanceof Error && err.name === "AbortError") continue;
            await logger.error("orchestrator", `Job ${jobId} falhou: ${err}`, {}, jobId);
            const db2 = await getDb();
            if (db2) await db2.update(jobs).set({ status: "failed" }).where(eq(jobs.id, jobId));
          } finally {
            this.activeJobs.delete(jobId);
            try { await proxyService.releaseAllForJob(jobId); } catch {}
          }

          // Pequeno delay entre jobs do mesmo cliente para dar tempo ao pool de respirar
          if (i < pendingJobIds.length - 1) {
            await sleep(5000);
          }
        }

        await logger.info("orchestrator",
          `Cliente "${clientName}" concluído. Todos os ${jobCount} job(s) finalizados.`
        );

      } finally {
        releaseClient();
      }
    };

    // Dispara em background — não bloqueia o endpoint de resgate
    _runAllJobs().catch(async (err) => {
      await logger.error("orchestrator",
        `Erro no processamento do cliente "${clientName}": ${err instanceof Error ? err.message : String(err)}`
      );
    });

    return { folderId, jobIds: pendingJobIds };
  }

  /**
   * v10.2: Cria jobs para múltiplos destinatários via Job Rápido.
   *
   * Aplica a mesma lógica inteligente do resgate de keys:
   *   - Cada cliente recebe até 5 jobs (divisão automática dos créditos)
   *   - Jobs rodam em sequência com stagger de 30s (via createClientJobs)
   *   - Fila de clientes: máx 3 simultâneos (ClientQueueLimiter)
   *   - Sempre cria pasta para agrupar os jobs do cliente
   *
   * O campo `jobCount` do input é ignorado — a divisão é calculada
   * automaticamente a partir dos créditos.
   *
   * Tabela de divisão (CREDITS_PER_ACCOUNT = 500, MAX_JOBS = 5):
   *   500cr   → 1 job  × 1 conta
   *   1000cr  → 2 jobs × 1 conta
   *   2500cr  → 5 jobs × 1 conta
   *   5000cr  → 5 jobs × 2 contas
   *   7500cr  → 5 jobs × 3 contas
   *   10000cr → 5 jobs × 4 contas
   */
  async createQuickJobs(recipients: QuickJobRecipient[]): Promise<{ jobIds: number[]; folderIds: number[]; summary: string }> {
    const CREDITS_PER_ACCOUNT = 500;
    const MAX_JOBS_PER_CLIENT = 5;

    const allJobIds: number[] = [];
    const allFolderIds: number[] = [];
    const summaryLines: string[] = [];

    for (const recipient of recipients) {
      const totalAccounts = Math.max(1, Math.floor(recipient.credits / CREDITS_PER_ACCOUNT));
      const jobCount = Math.min(totalAccounts, MAX_JOBS_PER_CLIENT);
      const clientName = recipient.label || recipient.inviteCode.substring(0, 12);

      // Distribui as contas uniformemente entre os jobs.
      // Os últimos `extraAccounts` jobs recebem 1 conta a mais.
      const baseAccountsPerJob = Math.floor(totalAccounts / jobCount);
      const extraAccounts = totalAccounts % jobCount;
      const jobQuantities: number[] = Array.from({ length: jobCount }, (_, i) => {
        const isLastGroup = i >= jobCount - extraAccounts;
        return baseAccountsPerJob + (isLastGroup && extraAccounts > 0 ? 1 : 0);
      });

      const { folderId, jobIds } = await this.createClientJobs({
        provider: "manus",
        inviteCode: recipient.inviteCode,
        clientName,
        keyCode: "QuickJob",
        jobQuantities,
      });

      allFolderIds.push(folderId);
      allJobIds.push(...jobIds);

      summaryLines.push(
        `📁 Pasta "${clientName}" (ID: ${folderId}): ` +
        `${jobCount} job(s) × [${jobQuantities.join(", ")}] contas = ${totalAccounts} total\n` +
        `   Jobs: ${jobIds.map(id => `#${id}`).join(", ")}`
      );
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

      // v11.0: reserveNextAlias e db.insert movidos para dentro do try-catch interno.
      // Antes estavam fora, então erros de reserva escapavam para o catch externo
      // do createClientJobs e matavam o job inteiro sem retry.
      // v11.1: email/aliasId/accountId inicializados como undefined — só recebem valor
      // quando o passo correspondente é concluído com sucesso.
      let email: string | undefined = undefined;
      let aliasId: number | undefined = undefined;
      let accountId: number | undefined = undefined;

      // v9.1: Moved proxy/proxyReleased outside try block so the catch block can access them.
      // Before: catch referenced proxy/proxyReleased which were scoped inside try → ReferenceError crash.
      let proxy: Awaited<ReturnType<typeof proxyService.getProxy>> | null = null;
      let proxyReleased = false;
      try {
        // Reserva atomicamente o próximo alias disponível via AliasPoolService
        // (UNIQUE constraint + INSERT ON DUPLICATE KEY UPDATE garante sem race condition)
        const reservedAlias = await emailService.reserveNextAlias(jobId);
        email = reservedAlias.aliasEmail;
        aliasId = reservedAlias.id;
        const password = options.password === "auto" || !options.password ? generatePassword(16) : options.password;

        // v11.1: NÃO inserimos o account no banco antes de tentar.
        // O registro só é criado quando há resultado definitivo (active ou failed).
        // Isso elimina o uso ambíguo de 'unverified' como status de tentativa em andamento.

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

        if (result.status === "active") {
          // Insere o account no banco somente quando criado com sucesso
          const accountResult = await db.insert(accounts).values({
            jobId,
            providerId,
            email,
            password,
            status: "active",
            token: result.token || null,
            phone: (result.metadata?.phoneNumber as string) || null,
            metadata: result.metadata || {},
          });
          accountId = accountResult[0].insertId;

          successCount++;
          if (result.inviteAccepted) {
            inviteConfirmedCount++;
          }
          await db.update(jobs).set({
            completedAccounts: sql`${jobs.completedAccounts} + 1`,
          }).where(eq(jobs.id, jobId));
          // Marca alias como usado com sucesso no pool
          try { await emailService.markAliasUsed(aliasId); } catch (_) { /* ignora */ }
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

        } else if (result.status === "retry") {
          // Erro transitório (CAPTCHA, proxy, rede) — libera o alias de volta para 'free'.
          // NÃO insere nenhum registro no banco: tentativas transitórias não geram lixo.
          try { await emailService.releaseAlias(aliasId); } catch (_) { /* ignora */ }
          await logger.warn("orchestrator",
            `Tentativa ${totalAttempts}: erro transitório (${result.error}) — alias liberado para retentativa. ` +
            `(sucesso: ${successCount}/${options.quantity}, restam ${maxAttempts - totalAttempts} tentativas)`,
            { email }, jobId
          );
          // Release proxy for replacement
          if (!proxyReleased) { proxyService.releaseProxy(proxy.host, jobId); proxyReleased = true; }
          // Não incrementa consecutiveFailures nem failedAccounts — não é falha permanente

        } else {
          // status === "failed" — falha permanente
          // Insere o account no banco como failed para rastreabilidade
          const accountResult = await db.insert(accounts).values({
            jobId,
            providerId,
            email,
            password,
            status: "failed",
            metadata: { error: result.error || "falha permanente" },
          });
          accountId = accountResult[0].insertId;

          // Marca alias como falho no pool (nunca mais será tentado)
          try { await emailService.markAliasFailed(aliasId, result.error || "falha permanente"); } catch (_) { /* ignora */ }
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
          // v11.1: accountId só existe se o insert definitivo já ocorreu (active ou failed)
          if (accountId) await db.update(accounts).set({ status: "failed", metadata: { error: "Job cancelado" } }).where(eq(accounts.id, accountId));
          // Libera o alias no pool (job cancelado — alias pode ser reutilizado)
          if (aliasId) try { await emailService.releaseAlias(aliasId); } catch (_) { /* ignora */ }
          // v9.8: Smart proxy handling on cancellation.
          // Se accountId existe, a conta foi registrada no Manus — proxy queimado.
          // Se não existe, a tentativa ainda estava em andamento — proxy reciclado.
          if (proxy && !proxyReleased) {
            if (accountId) {
              await logger.info("orchestrator", `Job ${jobId} cancelado APÓS registro — proxy ${proxy.host} queimado, enviando para replacement`, {}, jobId);
              proxyService.releaseProxy(proxy.host, jobId);
            } else {
              await logger.info("orchestrator", `Job ${jobId} cancelado ANTES do registro — proxy ${proxy.host} não foi queimado, reciclando`, {}, jobId);
              await proxyService.recycleProxy(proxy.host, jobId);
            }
            proxyReleased = true;
          }
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);

        // Se aliasId não existe, o erro ocorreu antes mesmo de reservar o alias
        // (banco indisponível, todas as contas esgotadas, etc) — retenta sem inserir nada
        if (!aliasId) {
          await logger.error("orchestrator",
            `ERRO na tentativa ${totalAttempts}: falha ao reservar alias — ${msg} ` +
            `(sucesso: ${successCount}/${options.quantity}, restam ${maxAttempts - totalAttempts} tentativas)`,
            {}, jobId
          );
          if (proxy && !proxyReleased) { proxyService.releaseProxy(proxy.host, jobId); proxyReleased = true; }
          consecutiveFailures++;
          continue; // retenta na próxima iteração
        }

        // INVITE_INVALID_CODE: código inválido/expirado — abortar o job inteiro
        if (msg.startsWith("INVITE_INVALID_CODE:")) {
          // Insere como failed para rastreabilidade (se ainda não foi inserido)
          if (!accountId) {
            const r = await db.insert(accounts).values({ jobId, providerId, email: email!, password: "", status: "failed", metadata: { error: msg } });
            accountId = r[0].insertId;
          } else {
            await db.update(accounts).set({ status: "failed", metadata: { error: msg } }).where(eq(accounts.id, accountId));
          }
          await db.update(jobs).set({ failedAccounts: sql`${jobs.failedAccounts} + 1` }).where(eq(jobs.id, jobId));
          try { await emailService.markAliasFailed(aliasId, msg); } catch (_) { /* ignora */ }
          await logger.error("orchestrator", `Job ${jobId} abortado: ${msg}`, { email: email! }, jobId);
          if (proxy && !proxyReleased) { proxyService.releaseProxy(proxy.host, jobId); proxyReleased = true; }
          break;
        }

        // INVITE_NOT_CONFIRMED: conta recebeu créditos insuficientes — descarta e retenta
        if (msg.startsWith("INVITE_NOT_CONFIRMED:")) {
          if (!accountId) {
            const r = await db.insert(accounts).values({ jobId, providerId, email: email!, password: "", status: "failed", metadata: { error: msg } });
            accountId = r[0].insertId;
          } else {
            await db.update(accounts).set({ status: "failed", metadata: { error: msg } }).where(eq(accounts.id, accountId));
          }
          try { await emailService.markAliasFailed(aliasId, msg); } catch (_) { /* ignora */ }
          await logger.warn("orchestrator",
            `Tentativa ${totalAttempts}: conta descartada (${msg}). Retentando com nova conta. ` +
            `(sucesso: ${successCount}/${options.quantity}, restam ${maxAttempts - totalAttempts} tentativas)`,
            { email: email! }, jobId
          );
          if (proxy && !proxyReleased) { proxyService.releaseProxy(proxy.host, jobId); proxyReleased = true; }
          continue;
        }

        // Erro genérico de infra (rede, proxy, timeout) — não insere registro, libera alias para retentativa
        // Não é uma falha permanente da conta — o alias pode ser reutilizado
        if (!accountId) {
          try { await emailService.releaseAlias(aliasId); } catch (_) { /* ignora */ }
          await logger.error("orchestrator",
            `ERRO transitório na tentativa ${totalAttempts}: ${msg} — alias liberado para retentativa ` +
            `(sucesso: ${successCount}/${options.quantity}, restam ${maxAttempts - totalAttempts} tentativas)`,
            { email: email! }, jobId
          );
          if (proxy && !proxyReleased) { proxyService.releaseProxy(proxy.host, jobId); proxyReleased = true; }
          consecutiveFailures++;
          continue;
        }

        // accountId já existe (insert definitivo já ocorreu) — atualiza para failed
        await db.update(accounts).set({
          status: "failed",
          metadata: { error: msg },
        }).where(eq(accounts.id, accountId));

        await db.update(jobs).set({
          failedAccounts: sql`${jobs.failedAccounts} + 1`,
        }).where(eq(jobs.id, jobId));

        try { await emailService.markAliasFailed(aliasId, msg); } catch (_) { /* ignora */ }

        await logger.error("orchestrator",
          `ERRO na tentativa ${totalAttempts}: ${msg} (sucesso: ${successCount}/${options.quantity}, restam ${maxAttempts - totalAttempts} tentativas)`,
          { email: email! }, jobId
        );
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
   * v10.2: Retorna o estado atual da fila de clientes.
   * Útil para monitoramento e debug via logs.
   */
  getLimiterStatus(): { active: number; queued: number; max: number; label: string } {
    return {
      active: clientQueueLimiter.getActive(),
      queued: clientQueueLimiter.getQueued(),
      max: clientQueueLimiter.getMax(),
      label: "clientes",
    };
  }

  /**
   * v10.4: Recovery de jobs interrompidos por restart do servidor.
   *
   * Chamado no startup ANTES do StaleJobsMonitor.
   * Busca todos os jobs com status "running" ou "pending" no banco que
   * não estão na memória ativa (pois o processo morreu).
   *
   * Para cada job interrompido:
   *   - Se já tem contas completas (completedAccounts > 0): retoma do ponto onde parou
   *     (successCount parte de completedAccounts, quantity é o restante)
   *   - Se não tem nada completo: reinicia do zero
   *   - Jobs "pending" que estavam na fila: reiniciados como se fossem novos
   *
   * A raiz do problema anterior era que jobs interrompidos ficavam presos em
   * status "running" por até 30 minutos (threshold do StaleJobsMonitor) sem
   * serem retomados. Agora são recuperados imediatamente no startup.
   */
  async recoverInterruptedJobs(): Promise<void> {
    const db = await getDb();
    if (!db) return;

    try {
      // Busca o provider manus (necessário para retomar)
      const providerRows = await db.select().from(providers).where(eq(providers.slug, "manus")).limit(1);
      if (providerRows.length === 0) {
        console.warn("[JobRecovery] Provider 'manus' não encontrado. Não é possível retomar jobs.");
        return;
      }
      const providerId = providerRows[0].id;
      const provider = PROVIDERS["manus"];

      // Busca candidatos a recovery (running ou pending)
      const candidates = await db
        .select()
        .from(jobs)
        .where(sql`${jobs.status} IN ('running', 'pending')`);

      if (candidates.length === 0) {
        console.log("[JobRecovery] Nenhum job interrompido encontrado.");
        return;
      }

      console.log(`[JobRecovery] ${candidates.length} candidato(s) encontrado(s). Verificando lock atômico...`);

      let recovered = 0;
      let skipped = 0;

      for (const job of candidates) {
        try {
          const alreadyCompleted = job.completedAccounts || 0;
          const totalRequired = job.totalAccounts || 1;
          const remaining = totalRequired - alreadyCompleted;

          if (remaining <= 0) {
            // Já estava completo mas não foi finalizado
            await db.update(jobs)
              .set({ status: "completed", completedAt: new Date(), error: null })
              .where(and(
                eq(jobs.id, job.id),
                sql`${jobs.status} IN ('running', 'pending')`
              ));
            console.log(`[JobRecovery] Job ${job.id} já estava completo. Marcado como completed.`);
            continue;
          }

          // LOCK ATÔMICO: muda status de 'running'/'pending' para 'recovering' em uma única operação.
          // Se outra instância já fez isso, affectedRows será 0 e pulamos este job.
          // Isso garante que apenas UMA instância retome cada job, mesmo com múltiplos
          // restarts simultâneos durante um deploy.
          const lockResult = await db.update(jobs)
            .set({ status: "recovering" as typeof jobs.status._.data, updatedAt: new Date() })
            .where(and(
              eq(jobs.id, job.id),
              sql`${jobs.status} IN ('running', 'pending')`
            ));

          // drizzle-orm/mysql2 retorna [ResultSetHeader, ...] — affectedRows fica no índice 0
          const affectedRows = (lockResult as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 1;

          if (affectedRows === 0) {
            // Outra instância já adquiriu o lock — pular
            console.log(`[JobRecovery] Job ${job.id} já está sendo retomado por outra instância. Pulando.`);
            skipped++;
            continue;
          }

          // Lock adquirido com sucesso — agora retomar
          const config = (job.config || {}) as Record<string, unknown>;
          const options: CreateJobOptions = {
            provider: "manus",
            quantity: remaining,
            password: String(config.password || "auto"),
            delayMin: Number(config.delayMin || 3000),
            delayMax: Number(config.delayMax || 10000),
            region: String(config.region || "default"),
            inviteCode: config.inviteCode ? String(config.inviteCode) : undefined,
            label: config.label ? String(config.label) : undefined,
            folderId: job.folderId || undefined,
          };

          // Marca como running definitivo (saindo do estado 'recovering')
          await db.update(jobs)
            .set({ status: "running", startedAt: job.startedAt || new Date(), error: null })
            .where(eq(jobs.id, job.id));

          const abortController = new AbortController();
          this.activeJobs.set(job.id, abortController);

          const logSuffix = alreadyCompleted > 0
            ? ` (retomando: ${alreadyCompleted}/${totalRequired} já completas, faltam ${remaining})`
            : " (reiniciando do zero)";
          console.log(`[JobRecovery] Retomando job ${job.id}${logSuffix}`);
          await logger.info("orchestrator",
            `Job ${job.id} retomado após restart do servidor${logSuffix}`,
            {}, job.id
          );

          this._runJob(job.id, provider, providerId, options, abortController);
          recovered++;

        } catch (err) {
          console.warn(`[JobRecovery] Erro ao retomar job ${job.id}:`, err);
          await db.update(jobs).set({
            status: "failed",
            error: `Não foi possível retomar após restart: ${err instanceof Error ? err.message : String(err)}`,
            completedAt: new Date(),
          }).where(eq(jobs.id, job.id));
        }
      }

      console.log(`[JobRecovery] Recovery concluído. Retomados: ${recovered}, ignorados (outra instância): ${skipped}.`);
    } catch (err) {
      console.warn("[JobRecovery] Erro durante recovery de jobs:", err);
    }
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
