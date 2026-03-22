/**
 * ProxyService - Webshare Integration
 * Manages datacenter proxies with SINGLE-USE policy:
 * - Each proxy can only be used ONCE to create an account
 * - After use, the proxy is marked as "used" and queued for replacement
 * - A background worker replaces used proxies via Webshare API (one at a time)
 * - The pool of available proxies is continuously replenished
 */

import { eq, asc, sql, and, isNull } from "drizzle-orm";
import { getDb } from "../db";
import { proxies } from "../../drizzle/schema";
import { getSetting } from "../utils/settings";
import { logger, sleep } from "../utils/helpers";

const WEBSHARE_API_V2 = "https://proxy.webshare.io/api/v2";
const WEBSHARE_API_V3 = "https://proxy.webshare.io/api/v3";

export interface ProxyInfo {
  id: number;
  host: string;
  port: number;
  username: string | null;
  password: string | null;
  protocol: string;
}

class ProxyService {
  private apiKey = "";
  private isReplacing = false;
  private replaceQueue: string[] = []; // IPs waiting to be replaced
  private replaceWorkerRunning = false;

  async init(): Promise<void> {
    this.apiKey = (await getSetting("webshare_api_key")) || "";
  }

  /**
   * Recovery on boot: verifica o banco por proxies com enabled=false (usados)
   * que não estão na fila de replace e os coloca na fila automaticamente.
   * Chamado uma vez na inicialização do servidor.
   */
  async recoverUsedProxies(): Promise<void> {
    try {
      const db = await getDb();
      if (!db) return;

      // Busca todos os proxies marcados como usados (enabled=false)
      const usedProxies = await db
        .select({ host: proxies.host })
        .from(proxies)
        .where(eq(proxies.enabled, false));

      if (usedProxies.length === 0) return;

      const ipsToRecover = usedProxies
        .map(p => p.host)
        .filter(ip => !this.replaceQueue.includes(ip));

      if (ipsToRecover.length === 0) return;

      console.log(`[ProxyService] Recovery: ${ipsToRecover.length} proxy(ies) usados encontrados no banco, adicionando à fila de replace...`);

      this.replaceQueue.push(...ipsToRecover);

      // Inicia o worker se não estiver rodando
      if (!this.replaceWorkerRunning) {
        this.startReplaceWorker();
      }
    } catch (err) {
      console.warn("[ProxyService] Erro no recovery de proxies usados:", err);
    }
  }

  private async ensureApiKey(): Promise<void> {
    if (!this.apiKey) await this.init();
    if (!this.apiKey) throw new Error("Webshare API key não configurada");
  }

  /**
   * Sync all proxies from Webshare (initial load or full refresh).
   * Clears the local DB and imports fresh proxy list.
   */
  async syncFromWebshare(jobId?: number): Promise<number> {
    await this.ensureApiKey();

    await logger.info("proxy", "Sincronizando proxies da Webshare...", {}, jobId);

    const allProxies: Array<Record<string, unknown>> = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const resp = await fetch(`${WEBSHARE_API_V2}/proxy/list/?mode=direct&page=${page}&page_size=100`, {
        headers: { Authorization: `Token ${this.apiKey}` },
      });

      const data = (await resp.json()) as Record<string, unknown>;
      const results = data.results as Array<Record<string, unknown>> | undefined;

      if (results && results.length > 0) {
        allProxies.push(...results);
        hasMore = data.next !== null;
        page++;
      } else {
        hasMore = false;
      }
    }

    if (allProxies.length === 0) {
      await logger.warn("proxy", "Nenhum proxy encontrado na Webshare", {}, jobId);
      return 0;
    }

    const db = await getDb();
    if (!db) throw new Error("Database não disponível");

    // Clear old proxies
    await db.delete(proxies).where(sql`1=1`);

    // Insert new ones — all marked as available (lastUsedAt = null)
    const proxyRows = allProxies.map((p) => ({
      host: p.proxy_address as string,
      port: p.port as number,
      username: (p.username as string) || null,
      password: (p.password as string) || null,
      protocol: "http" as const,
      country: (p.country_code as string) || null,
      enabled: true,
      failCount: 0,
    }));

    // Insert in batches of 50
    for (let i = 0; i < proxyRows.length; i += 50) {
      const batch = proxyRows.slice(i, i + 50);
      await db.insert(proxies).values(batch);
    }

    // Clear replace queue since we have fresh proxies
    this.replaceQueue = [];

    await logger.info("proxy", `${proxyRows.length} proxies sincronizados (todos disponíveis)`, {}, jobId);
    return proxyRows.length;
  }

  /**
   * Replace ALL proxies via Webshare API v3 (manual full replacement).
   */
  async replaceAllProxies(jobId?: number): Promise<number> {
    if (this.isReplacing) {
      await logger.warn("proxy", "Substituição já em andamento, aguardando...", {}, jobId);
      while (this.isReplacing) {
        await sleep(3000);
      }
      return await this.getAvailableCount();
    }

    this.isReplacing = true;

    try {
      await this.ensureApiKey();

      await logger.info("proxy", "Iniciando substituição de TODOS os proxies via Webshare...", {}, jobId);

      const db = await getDb();
      if (!db) throw new Error("Database não disponível");

      const currentProxies = await db.select({ host: proxies.host }).from(proxies);
      const ipAddresses = currentProxies.map(p => p.host);

      if (ipAddresses.length === 0) {
        await logger.warn("proxy", "Nenhum proxy atual para substituir, sincronizando...", {}, jobId);
        return await this.syncFromWebshare(jobId);
      }

      const replacePayload = {
        to_replace: { type: "ip_address", ip_addresses: ipAddresses },
        replace_with: [{ type: "any", count: ipAddresses.length }],
        dry_run: false,
      };

      const resp = await fetch(`${WEBSHARE_API_V3}/proxy/replace/`, {
        method: "POST",
        headers: {
          Authorization: `Token ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(replacePayload),
      });

      if (!resp.ok) {
        const errorText = await resp.text();
        throw new Error(`Webshare replace API error (${resp.status}): ${errorText}`);
      }

      const replaceResult = (await resp.json()) as Record<string, unknown>;
      const replacementId = replaceResult.id as number;

      await logger.info("proxy", `Substituição criada (ID: ${replacementId}), aguardando conclusão...`, {}, jobId);

      // Poll until replacement is complete
      let state = replaceResult.state as string;
      let pollAttempts = 0;
      const maxPollAttempts = 60;

      while (state !== "completed" && state !== "failed" && pollAttempts < maxPollAttempts) {
        await sleep(5000);
        pollAttempts++;

        const statusResp = await fetch(`${WEBSHARE_API_V3}/proxy/replace/${replacementId}/`, {
          headers: { Authorization: `Token ${this.apiKey}` },
        });

        if (!statusResp.ok) continue;

        const statusData = (await statusResp.json()) as Record<string, unknown>;
        state = statusData.state as string;

        if (pollAttempts % 6 === 0) {
          await logger.info("proxy", `Substituição em andamento... (estado: ${state}, tentativa ${pollAttempts})`, {}, jobId);
        }
      }

      if (state === "failed") {
        throw new Error("Substituição falhou na Webshare");
      }

      if (state !== "completed") {
        throw new Error(`Substituição timeout após ${pollAttempts * 5}s (estado: ${state})`);
      }

      await logger.info("proxy", "Substituição concluída! Re-sincronizando proxies...", {}, jobId);

      const newCount = await this.syncFromWebshare(jobId);
      await logger.info("proxy", `Proxies substituídos com sucesso! ${newCount} novos proxies disponíveis.`, {}, jobId);

      return newCount;

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logger.error("proxy", `Erro na substituição de proxies: ${msg}`, {}, jobId);
      throw err;
    } finally {
      this.isReplacing = false;
    }
  }

  /**
   * Get a proxy for use. SINGLE-USE POLICY:
   * - Only returns proxies that have NEVER been used (lastUsedAt IS NULL)
   * - Marks the proxy as used immediately (sets lastUsedAt)
   * - Disables the proxy (enabled = false) so it can't be picked again
   * - Queues the proxy IP for background replacement
   */
  async getProxy(jobId?: number): Promise<ProxyInfo> {
    const db = await getDb();
    if (!db) throw new Error("Database não disponível");

    // Obter a blacklist de países bloqueados (ex: "ID,BR,US")
    const blockedCountriesStr = await getSetting("proxy_blocked_countries") || "";
    const blockedCountries = blockedCountriesStr
      .split(",")
      .map(c => c.trim().toUpperCase())
      .filter(c => c.length > 0);

    // v9.5.4: Use atomic claim with retry limit to prevent infinite loop.
    // Instead of SELECT then UPDATE (race condition), we:
    // 1. SELECT a batch of candidates
    // 2. Try to UPDATE each one atomically until one succeeds
    const MAX_RETRIES = 5;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      // Build conditions: enabled=true (available proxies)
      let conditions = eq(proxies.enabled, true);

      if (blockedCountries.length > 0) {
        const blockedList = blockedCountries.map(c => `'${c}'`).join(",");
        conditions = and(
          conditions,
          sql`(${proxies.country} IS NULL OR ${proxies.country} NOT IN (${sql.raw(blockedList)}))`
        )!;
      }

      // Fetch a batch of candidates (not just 1) to avoid all jobs fighting over the same proxy
      const candidates = await db
        .select()
        .from(proxies)
        .where(conditions)
        .orderBy(asc(proxies.failCount), asc(proxies.id))
        .limit(10);

      if (candidates.length === 0) {
        // No proxies available at all
        const totalCount = await db
          .select({ count: sql<number>`count(*)` })
          .from(proxies);
        const usedCount = await db
          .select({ count: sql<number>`count(*)` })
          .from(proxies)
          .where(eq(proxies.enabled, false));

        const total = totalCount[0]?.count || 0;
        const used = usedCount[0]?.count || 0;

        if (total > 0 && used > 0) {
          throw new Error(
            `Nenhum proxy disponível. ${used}/${total} proxies já foram usados e estão aguardando substituição. ` +
            `Aguarde a substituição automática ou clique em "Replace Proxies" manualmente.`
          );
        }

        throw new Error("Nenhum proxy disponível. Execute a sincronização primeiro.");
      }

      // Try to atomically claim one of the candidates
      for (const proxy of candidates) {
        const updateResult = await db
          .update(proxies)
          .set({
            lastUsedAt: new Date(),
            enabled: false,
          })
          .where(
            and(
              eq(proxies.id, proxy.id),
              eq(proxies.enabled, true) // Only update if still available (atomic guard)
            )
          );

        if ((updateResult as any)[0]?.affectedRows > 0) {
          // Successfully claimed this proxy
          await logger.info("proxy", `Proxy ${proxy.host}:${proxy.port} alocado (uso único) — será substituído após o job terminar`, {}, jobId);

          return {
            id: proxy.id,
            host: proxy.host,
            port: proxy.port,
            username: proxy.username,
            password: proxy.password,
            protocol: proxy.protocol,
          };
        }
        // This candidate was already claimed by another job, try next candidate
      }

      // All 10 candidates were claimed by other jobs, retry with fresh query
      await logger.info("proxy", `Todos os ${candidates.length} candidatos já foram alocados, tentando novamente (${attempt + 1}/${MAX_RETRIES})...`, {}, jobId);
      // Small delay to reduce contention
      await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
    }

    throw new Error(
      `Não foi possível alocar proxy após ${MAX_RETRIES} tentativas. ` +
      `Muitos jobs concorrentes disputando poucos proxies disponíveis.`
    );
  }

  /**
   * Release a proxy after the job is done. Queues it for background replacement.
   * Called by the orchestrator when a job attempt finishes (success or failure).
   */
  releaseProxy(ip: string, jobId?: number): void {
    this.queueForReplacement(ip, jobId);
  }

  /**
   * Queue a used proxy IP for background replacement.
   * The background worker will replace it via Webshare API.
   */
  private queueForReplacement(ip: string, jobId?: number): void {
    if (!this.replaceQueue.includes(ip)) {
      this.replaceQueue.push(ip);
    }

    // Start the background worker if not already running
    if (!this.replaceWorkerRunning) {
      this.startReplaceWorker(jobId);
    }
  }

  /**
   * Background worker that processes the replace queue.
   * v9.7.3: Refatorado para ser mais resiliente:
   * - Delay reduzido de 10s para 3s (acumula batch rápido)
   * - Re-enfileira IPs quando replacement falha (com limite de 3 retries)
   * - Trata erro not_enough_replacements_in_subscription
   * - Log claro de cada etapa
   */
  private failedReplacements = new Map<string, number>(); // IP -> retry count
  private readonly MAX_REPLACE_RETRIES = 3;

  private async startReplaceWorker(jobId?: number): Promise<void> {
    if (this.replaceWorkerRunning) return;
    this.replaceWorkerRunning = true;

    try {
      await this.ensureApiKey();

      while (this.replaceQueue.length > 0) {
        // Delay curto para acumular batch (Webshare só permite 1 replacement ativo)
        await sleep(3000);

        if (this.replaceQueue.length === 0) break;

        // Grab all IPs currently in the queue
        const ipsToReplace = [...this.replaceQueue];
        this.replaceQueue = [];

        await logger.info("proxy",
          `[Replace Worker] Substituindo ${ipsToReplace.length} proxy(ies): ${ipsToReplace.join(", ")}`,
          {}, jobId
        );

        try {
          // Wait if another replacement (manual) is in progress
          let waitCount = 0;
          while (this.isReplacing) {
            if (waitCount % 5 === 0) {
              await logger.info("proxy", `[Replace Worker] Aguardando replacement anterior finalizar...`, {}, jobId);
            }
            await sleep(3000);
            waitCount++;
            // Safety: se esperou mais de 5 minutos, força reset do mutex
            if (waitCount > 100) {
              await logger.warn("proxy", `[Replace Worker] Timeout aguardando replacement anterior. Resetando mutex.`, {}, jobId);
              this.isReplacing = false;
              break;
            }
          }

          this.isReplacing = true;

          const replacePayload = {
            to_replace: { type: "ip_address", ip_addresses: ipsToReplace },
            replace_with: [{ type: "any", count: ipsToReplace.length }],
            dry_run: false,
          };

          const resp = await fetch(`${WEBSHARE_API_V3}/proxy/replace/`, {
            method: "POST",
            headers: {
              Authorization: `Token ${this.apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(replacePayload),
          });

          if (!resp.ok) {
            const errorText = await resp.text();

            // active_replacement: outro replacement em andamento na Webshare
            if (errorText.includes("active_replacement")) {
              await logger.warn("proxy",
                `[Replace Worker] Webshare já tem replacement ativo. Re-enfileirando ${ipsToReplace.length} IPs, retry em 15s...`,
                {}, jobId
              );
              this.replaceQueue.push(...ipsToReplace);
              this.isReplacing = false;
              await sleep(15000);
              continue;
            }

            // not_enough_replacements_in_subscription: limite de replacements atingido
            if (errorText.includes("not_enough_replacements")) {
              await logger.error("proxy",
                `[Replace Worker] LIMITE DE REPLACEMENTS DA ASSINATURA ATINGIDO! ` +
                `${ipsToReplace.length} proxies não podem ser substituídos. ` +
                `Faça upgrade da assinatura Webshare ou aguarde o reset mensal.`,
                {}, jobId
              );
              // Re-enfileira para tentar novamente mais tarde (pode resetar)
              this.replaceQueue.push(...ipsToReplace);
              this.isReplacing = false;
              // Espera 5 minutos antes de tentar de novo
              await sleep(300_000);
              continue;
            }

            throw new Error(`Webshare replace error (${resp.status}): ${errorText}`);
          }

          const replaceResult = (await resp.json()) as Record<string, unknown>;
          const replacementId = replaceResult.id as number;

          await logger.info("proxy",
            `[Replace Worker] Replacement criado (ID: ${replacementId}), polling status...`,
            {}, jobId
          );

          // Poll until complete
          let state = replaceResult.state as string;
          let pollAttempts = 0;
          const maxPollAttempts = 60; // 60 * 5s = 5 minutos max

          while (state !== "completed" && state !== "failed" && pollAttempts < maxPollAttempts) {
            await sleep(5000);
            pollAttempts++;

            try {
              const statusResp = await fetch(`${WEBSHARE_API_V3}/proxy/replace/${replacementId}/`, {
                headers: { Authorization: `Token ${this.apiKey}` },
              });

              if (!statusResp.ok) continue;

              const statusData = (await statusResp.json()) as Record<string, unknown>;
              state = statusData.state as string;

              if (pollAttempts % 6 === 0) {
                await logger.info("proxy",
                  `[Replace Worker] Replacement ${replacementId} em andamento... (estado: ${state}, ${pollAttempts * 5}s)`,
                  {}, jobId
                );
              }
            } catch {
              // Erro de rede no polling — continua tentando
            }
          }

          if (state === "completed") {
            // Fetch new proxies from Webshare and add only the NEW ones
            await this.syncNewProxies(ipsToReplace, jobId);
            await logger.info("proxy",
              `[Replace Worker] ${ipsToReplace.length} proxy(ies) substituídos com sucesso!`,
              {}, jobId
            );
            // Limpa contadores de retry dos IPs que foram substituídos
            for (const ip of ipsToReplace) {
              this.failedReplacements.delete(ip);
            }
          } else {
            // FALHOU: re-enfileira com limite de retries
            await logger.error("proxy",
              `[Replace Worker] Replacement ${replacementId} falhou (estado: ${state}). Re-enfileirando...`,
              {}, jobId
            );
            for (const ip of ipsToReplace) {
              const retries = (this.failedReplacements.get(ip) || 0) + 1;
              if (retries <= this.MAX_REPLACE_RETRIES) {
                this.failedReplacements.set(ip, retries);
                this.replaceQueue.push(ip);
                await logger.info("proxy",
                  `[Replace Worker] IP ${ip} re-enfileirado (tentativa ${retries}/${this.MAX_REPLACE_RETRIES})`,
                  {}, jobId
                );
              } else {
                await logger.error("proxy",
                  `[Replace Worker] IP ${ip} falhou ${this.MAX_REPLACE_RETRIES}x. Desistindo — faça Replace manual.`,
                  {}, jobId
                );
                this.failedReplacements.delete(ip);
              }
            }
            // Delay antes de retentar
            await sleep(10000);
          }

        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await logger.error("proxy", `[Replace Worker] Erro: ${msg}`, {}, jobId);
          // Re-enfileira os IPs que falharam por erro inesperado
          for (const ip of ipsToReplace) {
            const retries = (this.failedReplacements.get(ip) || 0) + 1;
            if (retries <= this.MAX_REPLACE_RETRIES) {
              this.failedReplacements.set(ip, retries);
              if (!this.replaceQueue.includes(ip)) {
                this.replaceQueue.push(ip);
              }
            } else {
              this.failedReplacements.delete(ip);
            }
          }
          await sleep(10000);
        } finally {
          this.isReplacing = false;
        }
      }
    } finally {
      this.replaceWorkerRunning = false;
    }
  }

  /**
   * After a replacement completes, sync the proxy list from Webshare.
   * Removes old used proxies and adds new ones.
   */
  private async syncNewProxies(replacedIps: string[], jobId?: number): Promise<void> {
    await this.ensureApiKey();

    const db = await getDb();
    if (!db) return;

    // Fetch current proxy list from Webshare
    const allProxies: Array<Record<string, unknown>> = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const resp = await fetch(`${WEBSHARE_API_V2}/proxy/list/?mode=direct&page=${page}&page_size=100`, {
        headers: { Authorization: `Token ${this.apiKey}` },
      });

      const data = (await resp.json()) as Record<string, unknown>;
      const results = data.results as Array<Record<string, unknown>> | undefined;

      if (results && results.length > 0) {
        allProxies.push(...results);
        hasMore = data.next !== null;
        page++;
      } else {
        hasMore = false;
      }
    }

    // Get current DB proxies
    const dbProxies = await db.select({ id: proxies.id, host: proxies.host }).from(proxies);
    const dbHosts = new Set(dbProxies.map(p => p.host));

    // Delete the old used proxies from DB
    for (const ip of replacedIps) {
      await db.delete(proxies).where(eq(proxies.host, ip));
    }

    // Find new proxies from Webshare that aren't in our DB
    const newProxies = allProxies.filter(p => {
      const host = p.proxy_address as string;
      return !dbHosts.has(host) || replacedIps.includes(host);
    });

    if (newProxies.length > 0) {
      const proxyRows = newProxies.map((p) => ({
        host: p.proxy_address as string,
        port: p.port as number,
        username: (p.username as string) || null,
        password: (p.password as string) || null,
        protocol: "http" as const,
        country: (p.country_code as string) || null,
        enabled: true,
        failCount: 0,
      }));

      for (let i = 0; i < proxyRows.length; i += 50) {
        const batch = proxyRows.slice(i, i + 50);
        await db.insert(proxies).values(batch);
      }

      await logger.info("proxy", `${newProxies.length} novos proxies adicionados ao pool`, {}, jobId);
    }
  }

  async reportBad(proxyId: number, jobId?: number): Promise<void> {
    await logger.warn("proxy", `Proxy ${proxyId} marcado como ruim`, {}, jobId);

    const db = await getDb();
    if (!db) return;

    await db
      .update(proxies)
      .set({ failCount: sql`${proxies.failCount} + 1` })
      .where(eq(proxies.id, proxyId));
  }

  formatProxyUrl(proxy: ProxyInfo): string {
    return `${proxy.protocol}://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}`;
  }

  /**
   * Get count of AVAILABLE proxies (enabled AND never used).
   */
  async getAvailableCount(): Promise<number> {
    const db = await getDb();
    if (!db) return 0;

    const result = await db
      .select({ count: sql<number>`count(*)` })
      .from(proxies)
      .where(
        and(
          eq(proxies.enabled, true),
          isNull(proxies.lastUsedAt)
        )
      );

    return result[0]?.count || 0;
  }

  async listAll(): Promise<Array<typeof proxies.$inferSelect>> {
    const db = await getDb();
    if (!db) return [];

    return await db.select().from(proxies).orderBy(asc(proxies.id));
  }

  /** Get current replacement status */
  isReplacingProxies(): boolean {
    return this.isReplacing;
  }

  /** Get usage stats */
  getUsageStats(): { used: number; total: number; available: number; isReplacing: boolean; queueLength: number } {
    return {
      used: 0, // Will be calculated from DB
      total: 0,
      available: 0,
      isReplacing: this.isReplacing,
      queueLength: this.replaceQueue.length,
    };
  }

  /**
   * Get detailed stats from DB.
   */
  async getDetailedStats(): Promise<{
    total: number;
    available: number;
    used: number;
    isReplacing: boolean;
    queueLength: number;
  }> {
    const db = await getDb();
    if (!db) return { total: 0, available: 0, used: 0, isReplacing: this.isReplacing, queueLength: this.replaceQueue.length };

    const totalResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(proxies);

    const availableResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(proxies)
      .where(and(eq(proxies.enabled, true), isNull(proxies.lastUsedAt)));

    const usedResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(proxies)
      .where(eq(proxies.enabled, false));

    return {
      total: totalResult[0]?.count || 0,
      available: availableResult[0]?.count || 0,
      used: usedResult[0]?.count || 0,
      isReplacing: this.isReplacing,
      queueLength: this.replaceQueue.length,
    };
  }
}

export const proxyService = new ProxyService();

// ============================================================
// Geo-coherent fingerprint region lookup
// ============================================================

export type ProxyRegion = "us" | "br" | "id" | "sg" | "eu" | "asia";

// Country code → region bucket mapping
const COUNTRY_TO_REGION: Record<string, ProxyRegion> = {
  // Indonesia
  ID: "id",
  // Brazil
  BR: "br",
  // USA / Canada
  US: "us", CA: "us",
  // Singapore / Malaysia
  SG: "sg", MY: "sg",
  // Europe
  DE: "eu", FR: "eu", NL: "eu", GB: "eu", ES: "eu", IT: "eu",
  PL: "eu", SE: "eu", NO: "eu", FI: "eu", DK: "eu", CH: "eu",
  AT: "eu", BE: "eu", PT: "eu", CZ: "eu", RO: "eu", HU: "eu",
  // Asia
  JP: "asia", CN: "asia", KR: "asia", IN: "asia", TH: "asia",
  VN: "asia", PH: "asia", TW: "asia", HK: "asia",
  // Australia / New Zealand → treat as "us" (English-speaking, similar profile)
  AU: "us", NZ: "us",
  // Additional Europe (countries that were falling through to "us")
  GR: "eu", IE: "eu", BG: "eu", HR: "eu", SK: "eu", SI: "eu",
  LT: "eu", LV: "eu", EE: "eu", LU: "eu", MT: "eu", CY: "eu",
  IS: "eu", UA: "eu", RS: "eu", BA: "eu", MK: "eu", AL: "eu",
  MD: "eu", ME: "eu", RU: "eu", BY: "eu", GE: "eu",
  // Latin America → treat as "br" (Portuguese/Spanish, similar timezones)
  AR: "br", CL: "br", CO: "br", MX: "br", PE: "br",
  UY: "br", PY: "br", EC: "br", VE: "br", BO: "br",
  // Middle East → treat as "eu" (closer timezone-wise)
  TR: "eu", IL: "eu", AE: "eu", SA: "eu",
};

// 24h in-memory cache: ip → { region, expiresAt }
const geoCache = new Map<string, { region: ProxyRegion; expiresAt: number }>();
const GEO_CACHE_TTL_MS = 24 * 60 * 60_000;

/**
 * Resolve the geographic region of a proxy IP via ipinfo.io.
 * Uses a 24h in-memory cache to avoid repeated lookups.
 * Falls back to "us" if lookup fails or country is unknown.
 *
 * The region is used to generate a geo-coherent fingerprint:
 * locale, timezone, and tzOffset will match the proxy's country.
 */
export async function getProxyRegion(host: string): Promise<ProxyRegion> {
  const cached = geoCache.get(host);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.region;
  }

  try {
    const res = await fetch(`https://ipinfo.io/${host}/json`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json() as { country?: string };
      const country = (data.country || "").toUpperCase();
      const region: ProxyRegion = COUNTRY_TO_REGION[country] ?? "us";
      geoCache.set(host, { region, expiresAt: Date.now() + GEO_CACHE_TTL_MS });
      return region;
    }
  } catch {
    // Lookup failed — use fallback silently
  }

  // Fallback: cache as "us" for 1h to avoid hammering on failures
  geoCache.set(host, { region: "us", expiresAt: Date.now() + 60 * 60_000 });
  return "us";
}
