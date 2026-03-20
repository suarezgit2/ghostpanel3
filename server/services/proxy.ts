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

    // Only get proxies that are enabled AND have never been used
    // AND are not from blocked countries
    let conditions = and(
      eq(proxies.enabled, true),
      isNull(proxies.lastUsedAt)
    );

    if (blockedCountries.length > 0) {
      // Drizzle não tem um "notInArray" nativo simples, então construímos a query com sql
      const blockedList = blockedCountries.map(c => `'${c}'`).join(",");
      conditions = and(
        conditions,
        sql`${proxies.country} IS NULL OR ${proxies.country} NOT IN (${sql.raw(blockedList)})`
      );
    }

    const result = await db
      .select()
      .from(proxies)
      .where(conditions)
      .orderBy(asc(proxies.failCount), asc(proxies.id))
      .limit(1);

    if (result.length === 0) {
      // Check if there are used proxies waiting for replacement
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

    const proxy = result[0];

    // Mark as USED and DISABLED immediately (single-use).
    // Use conditional UPDATE to prevent race condition: if two concurrent jobs
    // SELECT the same proxy, only the first UPDATE will match (enabled=true).
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

    // If another job already claimed this proxy, retry recursively
    if (updateResult[0]?.affectedRows === 0) {
      await logger.info("proxy", `Proxy ${proxy.host}:${proxy.port} já foi alocado por outro job, tentando próximo...`, {}, jobId);
      return this.getProxy(jobId);
    }

    await logger.info("proxy", `Proxy ${proxy.host}:${proxy.port} alocado (uso único) — será substituído automaticamente`, {}, jobId);

    // Queue this proxy IP for background replacement
    this.queueForReplacement(proxy.host, jobId);

    return {
      id: proxy.id,
      host: proxy.host,
      port: proxy.port,
      username: proxy.username,
      password: proxy.password,
      protocol: proxy.protocol,
    };
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
   * Batches used proxy IPs and replaces them via Webshare API.
   * Waits a short delay to accumulate IPs for batch efficiency.
   */
  private async startReplaceWorker(jobId?: number): Promise<void> {
    if (this.replaceWorkerRunning) return;
    this.replaceWorkerRunning = true;

    try {
      await this.ensureApiKey();

      while (this.replaceQueue.length > 0) {
        // Wait a bit to accumulate more IPs for batch replacement
        // (Webshare only allows 1 replacement at a time)
        await sleep(10000); // 10 seconds

        if (this.replaceQueue.length === 0) break;

        // Grab all IPs currently in the queue
        const ipsToReplace = [...this.replaceQueue];
        this.replaceQueue = [];

        await logger.info("proxy", `Substituindo ${ipsToReplace.length} proxy(ies) usados: ${ipsToReplace.join(", ")}`, {}, jobId);

        try {
          // Wait if another replacement (manual) is in progress
          while (this.isReplacing) {
            await sleep(3000);
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
            // If active_replacement error, put IPs back in queue and retry later
            if (errorText.includes("active_replacement")) {
              await logger.warn("proxy", "Substituição já em andamento na Webshare, reagendando...", {}, jobId);
              this.replaceQueue.push(...ipsToReplace);
              this.isReplacing = false;
              await sleep(15000);
              continue;
            }
            throw new Error(`Webshare replace error (${resp.status}): ${errorText}`);
          }

          const replaceResult = (await resp.json()) as Record<string, unknown>;
          const replacementId = replaceResult.id as number;

          await logger.info("proxy", `Substituição criada (ID: ${replacementId}), aguardando...`, {}, jobId);

          // Poll until complete
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
          }

          if (state === "completed") {
            // Fetch new proxies from Webshare and add only the NEW ones
            await this.syncNewProxies(ipsToReplace, jobId);
            await logger.info("proxy", `${ipsToReplace.length} proxy(ies) substituídos com sucesso!`, {}, jobId);
          } else {
            await logger.error("proxy", `Substituição falhou (estado: ${state}). IPs: ${ipsToReplace.join(", ")}`, {}, jobId);
            // Don't re-queue on failure to avoid infinite loop
          }

        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await logger.error("proxy", `Erro no replace automático: ${msg}`, {}, jobId);
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
