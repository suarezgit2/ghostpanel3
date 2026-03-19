/**
 * SmsService - SMSBower Integration (v3.0 — Smart Provider Management)
 *
 * Melhorias v3.0:
 *   1. Blacklist persistente: provedores com 10+ falhas consecutivas e 0% de sucesso
 *      são banidos permanentemente no banco (setting: sms_blacklisted_providers).
 *      Sobrevivem a restarts do servidor.
 *   2. Sem "segunda chance" para provedores em cooldown: se está em cooldown, não entra
 *      na fila nessa rodada. Cooldown é cooldown.
 *   3. Detecção de rejeição pelo alvo (target-rejection): quando o Manus retorna
 *      permission_denied, o provedor recebe penalidade de "target rejection". Provedores
 *      com alta taxa de rejeição pelo alvo entram em cooldown pois seus números não funcionam.
 *   4. Health persistido no banco: estado de saúde dos provedores (successes, failures,
 *      consecutiveFailures, targetRejections) é salvo em sms_provider_health como JSON.
 *      Ao reiniciar, o histórico é restaurado.
 *   5. Limpeza automática da lista manual: ao iniciar, remove da sms_provider_ids qualquer
 *      ID que esteja na blacklist.
 *   6. Auto-Discover como fallback quando a lista manual esgota (comportamento mantido).
 *
 * Settings utilizados:
 *   smsbower_api_key, sms_country, sms_service, sms_max_price,
 *   sms_provider_ids, sms_max_retries, sms_wait_time, sms_poll_interval,
 *   sms_retry_delay_min, sms_retry_delay_max, sms_cancel_wait, sms_auto_discover,
 *   sms_blacklisted_providers (novo), sms_provider_health (novo)
 */

import { getSetting, setSetting } from "../utils/settings";
import { sleep, logger } from "../utils/helpers";

const SMSBOWER_API = "https://smsbower.app/stubs/handler_api.php";

const DEFAULTS: Record<string, string> = {
  sms_country: "6",
  sms_service: "ot",
  sms_max_price: "0.01",
  sms_provider_ids: "2295,3291,2482,1507,3250,3027,2413",
  sms_max_retries: "3",
  sms_wait_time: "120",
  sms_poll_interval: "5",
  sms_retry_delay_min: "3",
  sms_retry_delay_max: "8",
  sms_cancel_wait: "125",
  sms_auto_discover: "false",
  sms_blacklisted_providers: "",
  sms_provider_health: "{}",
};

interface SmsConfig {
  country: string;
  service: string;
  maxPrice: string;
  providerIds: number[];
  maxRetries: number;
  waitTimeMs: number;
  pollIntervalMs: number;
  retryDelayMin: number;
  retryDelayMax: number;
  cancelWaitMs: number;
  autoDiscover: boolean;
}

interface NumberData {
  activationId: string;
  phoneNumber: string;
  activationCost: string;
  rentedAt: number;
  providerId?: number;
}

interface GetNumberOverrides {
  country?: string;
  service?: string;
  maxPrice?: string;
  providerIds?: number[];
  jobId?: number;
}

interface RetryOptions {
  maxRetries?: number;
  waitTimeMs?: number;
  country?: string;
  service?: string;
  maxPrice?: string;
  providerIds?: number[];
  onNumberRented?: (data: { phoneNumber: string; activationId: string; attempt: number }) => Promise<void>;
  jobId?: number;
}

interface RetryResult {
  code: string;
  phoneNumber: string;
  activationId: string;
  attempt: number;
  totalCost: number;
}

// ============================================================
// PROVIDER HEALTH TRACKER (v3.0 — com persistência e target-rejection)
// ============================================================

interface ProviderHealth {
  providerId: number;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  targetRejections: number;       // Rejeições pelo alvo (permission_denied) — não é culpa do provedor, mas indica números ruins
  consecutiveTargetRejections: number;
  totalResponseTimeMs: number;
  lastFailureAt: number;
  lastSuccessAt: number;
  cooldownUntil: number;
}

// Serialized form for DB persistence (only what matters across restarts)
interface PersistedProviderHealth {
  [providerId: string]: {
    successes: number;
    failures: number;
    consecutiveFailures: number;
    targetRejections: number;
    consecutiveTargetRejections: number;
    totalResponseTimeMs: number;
    lastFailureAt: number;
    lastSuccessAt: number;
    cooldownUntil: number;
  };
}

/**
 * ProviderHealthTracker v3.0
 *
 * Novidades:
 *   - Rastreia target rejections separadamente de falhas de SMS
 *   - Provedores com muitas target rejections entram em cooldown (números ruins)
 *   - Sem "segunda chance" para provedores em cooldown (removido da fila)
 *   - Blacklist automática para provedores cronicamente ruins
 *   - Persistência no banco via sms_provider_health
 */
class ProviderHealthTracker {
  private health = new Map<number, ProviderHealth>();

  // Cooldown progressivo para falhas de SMS: 60s, 120s, 300s, 600s (máx 10min)
  private static COOLDOWN_STEPS = [60_000, 120_000, 300_000, 600_000];

  // Cooldown para target rejections: 120s, 300s, 600s (mais suave — pode ser azar)
  private static TARGET_REJECTION_COOLDOWN_STEPS = [120_000, 300_000, 600_000];

  // Threshold para blacklist automática
  private static BLACKLIST_CONSECUTIVE_FAILURES = 10;
  private static BLACKLIST_MIN_ATTEMPTS = 5;
  private static BLACKLIST_MAX_SUCCESS_RATE = 0.10; // < 10% de sucesso

  // Threshold para cooldown por target rejection
  private static TARGET_REJECTION_CONSECUTIVE_THRESHOLD = 5;

  private getOrCreate(providerId: number): ProviderHealth {
    if (!this.health.has(providerId)) {
      this.health.set(providerId, {
        providerId,
        successes: 0,
        failures: 0,
        consecutiveFailures: 0,
        targetRejections: 0,
        consecutiveTargetRejections: 0,
        totalResponseTimeMs: 0,
        lastFailureAt: 0,
        lastSuccessAt: 0,
        cooldownUntil: 0,
      });
    }
    return this.health.get(providerId)!;
  }

  recordSuccess(providerId: number, responseTimeMs: number): void {
    const h = this.getOrCreate(providerId);
    h.successes++;
    h.consecutiveFailures = 0;
    h.consecutiveTargetRejections = 0;
    h.totalResponseTimeMs += responseTimeMs;
    h.lastSuccessAt = Date.now();
    h.cooldownUntil = 0;
  }

  recordFailure(providerId: number): void {
    const h = this.getOrCreate(providerId);
    h.failures++;
    h.consecutiveFailures++;
    h.lastFailureAt = Date.now();

    const stepIndex = Math.min(h.consecutiveFailures - 1, ProviderHealthTracker.COOLDOWN_STEPS.length - 1);
    h.cooldownUntil = Date.now() + ProviderHealthTracker.COOLDOWN_STEPS[stepIndex];
  }

  /**
   * Registra rejeição pelo alvo (permission_denied do Manus).
   * Não é falha do provedor de SMS, mas indica que os números desse provedor
   * não são aceitos pelo Manus. Cooldown mais suave, mas ainda penaliza.
   */
  recordTargetRejection(providerId: number): void {
    const h = this.getOrCreate(providerId);
    h.targetRejections++;
    h.consecutiveTargetRejections++;

    // Só aplica cooldown se tiver muitas rejeições consecutivas
    if (h.consecutiveTargetRejections >= ProviderHealthTracker.TARGET_REJECTION_CONSECUTIVE_THRESHOLD) {
      const stepIndex = Math.min(
        Math.floor(h.consecutiveTargetRejections / ProviderHealthTracker.TARGET_REJECTION_CONSECUTIVE_THRESHOLD) - 1,
        ProviderHealthTracker.TARGET_REJECTION_COOLDOWN_STEPS.length - 1
      );
      const newCooldown = Date.now() + ProviderHealthTracker.TARGET_REJECTION_COOLDOWN_STEPS[stepIndex];
      // Só atualiza se o novo cooldown for maior que o atual
      if (newCooldown > h.cooldownUntil) {
        h.cooldownUntil = newCooldown;
      }
    }
  }

  /**
   * Reseta contador de target rejections consecutivas ao trocar de provedor com sucesso.
   */
  resetConsecutiveTargetRejections(providerId: number): void {
    const h = this.health.get(providerId);
    if (h) {
      h.consecutiveTargetRejections = 0;
    }
  }

  isAvailable(providerId: number): boolean {
    const h = this.health.get(providerId);
    if (!h) return true;
    return Date.now() >= h.cooldownUntil;
  }

  /**
   * Verifica se um provedor deve ser adicionado à blacklist.
   * Critério: 10+ falhas consecutivas E < 10% de sucesso com pelo menos 5 tentativas.
   */
  shouldBlacklist(providerId: number): boolean {
    const h = this.health.get(providerId);
    if (!h) return false;
    const total = h.successes + h.failures;
    if (total < ProviderHealthTracker.BLACKLIST_MIN_ATTEMPTS) return false;
    const successRate = h.successes / total;
    return (
      h.consecutiveFailures >= ProviderHealthTracker.BLACKLIST_CONSECUTIVE_FAILURES &&
      successRate < ProviderHealthTracker.BLACKLIST_MAX_SUCCESS_RATE
    );
  }

  /**
   * Retorna lista de provedores que devem ser blacklistados.
   */
  getProvidersToBlacklist(providerIds: number[]): number[] {
    return providerIds.filter(id => this.shouldBlacklist(id));
  }

  /**
   * Calcula score de 0 a 100 para o provedor.
   * Considera: taxa de sucesso (50%), velocidade (20%), recência (20%), target rejections (10%)
   */
  getScore(providerId: number): number {
    const h = this.health.get(providerId);
    if (!h || (h.successes + h.failures) === 0) return 50;

    const total = h.successes + h.failures;
    const successRate = h.successes / total;
    const avgResponseTime = h.successes > 0 ? h.totalResponseTimeMs / h.successes : 120_000;

    // Score de velocidade: 0-100 (120s+ = 0, 10s = 100)
    const speedScore = Math.max(0, Math.min(100, (120_000 - avgResponseTime) / 1100));

    // Score de recência: bonus se teve sucesso recente (últimos 10min)
    const recencyScore = h.lastSuccessAt > 0 && (Date.now() - h.lastSuccessAt) < 600_000 ? 100 : 0;

    // Penalidade por target rejections: reduz score se muitos números foram rejeitados pelo alvo
    const totalAttempts = total + h.targetRejections;
    const targetRejectionRate = totalAttempts > 0 ? h.targetRejections / totalAttempts : 0;
    const targetPenalty = targetRejectionRate * 100; // 0-100

    return Math.max(0, (successRate * 50) + (speedScore * 0.2) + (recencyScore * 0.2) - (targetPenalty * 0.1));
  }

  /**
   * Ordena provedores disponíveis (não em cooldown) por score.
   * v3.0: NÃO inclui provedores em cooldown como "segunda chance".
   */
  rankAvailableProviders(providerIds: number[]): number[] {
    const now = Date.now();
    const available = providerIds.filter(id => {
      const h = this.health.get(id);
      return !h || now >= h.cooldownUntil;
    });
    return available.sort((a, b) => this.getScore(b) - this.getScore(a));
  }

  /**
   * Retorna resumo legível do estado de todos os provedores.
   */
  getSummary(): Record<string, unknown>[] {
    const result: Record<string, unknown>[] = [];
    for (const [id, h] of Array.from(this.health.entries())) {
      const total = h.successes + h.failures;
      result.push({
        providerId: id,
        successRate: total > 0 ? `${Math.round((h.successes / total) * 100)}%` : "N/A",
        successes: h.successes,
        failures: h.failures,
        consecutiveFailures: h.consecutiveFailures,
        targetRejections: h.targetRejections,
        consecutiveTargetRejections: h.consecutiveTargetRejections,
        avgResponseMs: h.successes > 0 ? Math.round(h.totalResponseTimeMs / h.successes) : null,
        inCooldown: Date.now() < h.cooldownUntil,
        cooldownRemainingS: Math.max(0, Math.round((h.cooldownUntil - Date.now()) / 1000)),
        score: Math.round(this.getScore(id)),
      });
    }
    return result.sort((a, b) => (b.score as number) - (a.score as number));
  }

  /**
   * Serializa o estado para persistência no banco.
   */
  serialize(): PersistedProviderHealth {
    const result: PersistedProviderHealth = {};
    for (const [id, h] of Array.from(this.health.entries())) {
      result[String(id)] = {
        successes: h.successes,
        failures: h.failures,
        consecutiveFailures: h.consecutiveFailures,
        targetRejections: h.targetRejections,
        consecutiveTargetRejections: h.consecutiveTargetRejections,
        totalResponseTimeMs: h.totalResponseTimeMs,
        lastFailureAt: h.lastFailureAt,
        lastSuccessAt: h.lastSuccessAt,
        cooldownUntil: h.cooldownUntil,
      };
    }
    return result;
  }

  /**
   * Restaura o estado a partir de dados persistidos no banco.
   */
  restore(data: PersistedProviderHealth): void {
    for (const [idStr, h] of Object.entries(data)) {
      const id = parseInt(idStr);
      if (isNaN(id)) continue;
      this.health.set(id, {
        providerId: id,
        successes: h.successes || 0,
        failures: h.failures || 0,
        consecutiveFailures: h.consecutiveFailures || 0,
        targetRejections: h.targetRejections || 0,
        consecutiveTargetRejections: h.consecutiveTargetRejections || 0,
        totalResponseTimeMs: h.totalResponseTimeMs || 0,
        lastFailureAt: h.lastFailureAt || 0,
        lastSuccessAt: h.lastSuccessAt || 0,
        cooldownUntil: h.cooldownUntil || 0,
      });
    }
  }

  reset(): void {
    this.health.clear();
  }
}

// ============================================================
// SMS SERVICE (v3.0)
// ============================================================

class SmsService {
  private apiKey = "";
  private config: SmsConfig | null = null;
  readonly providerHealth = new ProviderHealthTracker();
  private healthPersistTimer: ReturnType<typeof setTimeout> | null = null;
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    this.apiKey = (await getSetting("smsbower_api_key")) || "";
    await this.loadConfig();
    await this.restoreHealth();
  }

  async loadConfig(): Promise<void> {
    const get = async (key: string): Promise<string> => {
      try {
        return (await getSetting(key)) || DEFAULTS[key] || "";
      } catch {
        return DEFAULTS[key] || "";
      }
    };

    this.config = {
      country: await get("sms_country"),
      service: await get("sms_service"),
      maxPrice: await get("sms_max_price"),
      providerIds: (await get("sms_provider_ids")).split(",").map(id => parseInt(id.trim())).filter(id => !isNaN(id)),
      maxRetries: parseInt(await get("sms_max_retries")) || 3,
      waitTimeMs: (parseInt(await get("sms_wait_time")) || 120) * 1000,
      pollIntervalMs: (parseInt(await get("sms_poll_interval")) || 5) * 1000,
      retryDelayMin: (parseInt(await get("sms_retry_delay_min")) || 3) * 1000,
      retryDelayMax: (parseInt(await get("sms_retry_delay_max")) || 8) * 1000,
      cancelWaitMs: (parseInt(await get("sms_cancel_wait")) || 125) * 1000,
      autoDiscover: (await get("sms_auto_discover")) === "true",
    };

    await logger.info(
      "sms",
      `Configuração carregada: país=${this.config.country}, serviço=${this.config.service}, ` +
      `maxPrice=$${this.config.maxPrice}, providers=${this.config.providerIds.length}, ` +
      `retries=${this.config.maxRetries}, wait=${this.config.waitTimeMs / 1000}s, ` +
      `autoDiscover=${this.config.autoDiscover}`
    );
  }

  async reloadConfig(): Promise<void> {
    this.config = null;
    this.apiKey = (await getSetting("smsbower_api_key")) || "";
    await this.loadConfig();
  }

  async getConfig(): Promise<SmsConfig> {
    if (!this.config) await this.init();
    return { ...this.config! };
  }

  // ============================================================
  // HEALTH PERSISTENCE
  // ============================================================

  /**
   * Restaura o health tracker a partir do banco.
   * Chamado no init() para sobreviver a restarts.
   */
  private async restoreHealth(): Promise<void> {
    try {
      const raw = await getSetting("sms_provider_health");
      if (raw && raw !== "{}" && raw !== "") {
        const data = JSON.parse(raw) as Record<string, unknown>;
        this.providerHealth.restore(data as any);
        console.log("[SmsService] Health dos provedores restaurado do banco");
      }
    } catch (err) {
      console.warn("[SmsService] Falha ao restaurar health:", err);
    }
  }

  /**
   * Persiste o health tracker no banco (debounced — máx 1x por 30s).
   */
  private schedulePersistHealth(): void {
    if (this.healthPersistTimer) return;
    this.healthPersistTimer = setTimeout(async () => {
      this.healthPersistTimer = null;
      try {
        const data = this.providerHealth.serialize();
        await setSetting("sms_provider_health", JSON.stringify(data));
      } catch (err) {
        console.warn("[SmsService] Falha ao persistir health:", err);
      }
    }, 30_000);
  }

  // ============================================================
  // BLACKLIST MANAGEMENT
  // ============================================================

  /**
   * Carrega a blacklist do banco.
   */
  async getBlacklist(): Promise<number[]> {
    const raw = await getSetting("sms_blacklisted_providers");
    if (!raw || raw.trim() === "") return [];
    return raw.split(",").map(id => parseInt(id.trim())).filter(id => !isNaN(id));
  }

  /**
   * Adiciona provedores à blacklist persistente.
   */
  async addToBlacklist(providerIds: number[], jobId?: number): Promise<void> {
    const current = await this.getBlacklist();
    const newIds = providerIds.filter(id => !current.includes(id));
    if (newIds.length === 0) return;

    const updated = [...current, ...newIds];
    await setSetting("sms_blacklisted_providers", updated.join(","), "Provedores banidos permanentemente por performance ruim");

    await logger.warn("sms",
      `Blacklist: ${newIds.length} provedor(es) banido(s) permanentemente: [${newIds.join(", ")}]. ` +
      `Total na blacklist: ${updated.length}`,
      { blacklisted: newIds, total: updated }, jobId
    );

    // Remove da lista manual também
    await this.removeFromProviderList(newIds, jobId);
  }

  /**
   * Remove provedores da lista manual (sms_provider_ids).
   */
  private async removeFromProviderList(idsToRemove: number[], jobId?: number): Promise<void> {
    const currentList = ((await getSetting("sms_provider_ids")) || "")
      .split(",").map(id => parseInt(id.trim())).filter(id => !isNaN(id));
    const filtered = currentList.filter(id => !idsToRemove.includes(id));
    if (filtered.length !== currentList.length) {
      await setSetting("sms_provider_ids", filtered.join(","));
      await logger.info("sms",
        `Lista de provedores atualizada (removidos ${currentList.length - filtered.length} IDs ruins): [${filtered.join(", ")}]`,
        {}, jobId
      );
    }
  }

  /**
   * Limpa a blacklist (para reabilitar provedores manualmente).
   */
  async clearBlacklist(): Promise<void> {
    await setSetting("sms_blacklisted_providers", "", "Provedores banidos permanentemente por performance ruim");
    this.providerHealth.reset();
    await setSetting("sms_provider_health", "{}");
    console.log("[SmsService] Blacklist e health resetados");
  }

  // ============================================================
  // PROVIDER DISCOVERY
  // ============================================================

  private discoverCache: { providers: number[]; expiresAt: number } | null = null;

  async discoverProviders(country: string, service: string, maxPrice: string, forceRefresh = false): Promise<number[]> {
    if (!this.apiKey) await this.init();

    // Cache de 5 minutos para não fazer requisição toda hora
    if (!forceRefresh && this.discoverCache && Date.now() < this.discoverCache.expiresAt) {
      return this.discoverCache.providers;
    }

    const priceLimit = parseFloat(maxPrice);
    const data = await this.getProviders(country, service);

    const providers: Array<{ id: number; cost: number; count: number }> = [];
    const countryData = data?.[country] as Record<string, Record<string, { price: number; cost?: string; count: number; provider_id?: number }>> | undefined;
    if (!countryData) {
      await logger.warn("sms", `Auto-Discover: país "${country}" não encontrado na resposta do getPricesV3`, {});
      return [];
    }

    const serviceData = countryData[service];
    if (!serviceData) {
      await logger.warn("sms", `Auto-Discover: serviço "${service}" não encontrado para o país "${country}"`, {});
      return [];
    }

    // Carrega blacklist para excluir provedores banidos
    const blacklist = await this.getBlacklist();

    for (const [providerId, info] of Object.entries(serviceData)) {
      const id = parseInt(providerId);
      if (blacklist.includes(id)) continue; // Pula blacklistados
      const cost = typeof info.price === "number" ? info.price : parseFloat(info.cost || "999");
      const count = typeof info.count === "number" ? info.count : (parseInt(String(info.count)) || 0);
      if (cost <= priceLimit && count > 0) {
        providers.push({ id, cost, count });
      }
    }

    providers.sort((a, b) => a.cost - b.cost || b.count - a.count);
    const result = providers.map(p => p.id);

    this.discoverCache = { providers: result, expiresAt: Date.now() + 5 * 60_000 };
    return result;
  }

  /**
   * Descobre provedores e atualiza a lista manual no banco.
   * Usado pelo botão "Descobrir Provedores Agora" na UI.
   */
  async discoverAndUpdateProviderList(): Promise<{ providers: number[]; updated: boolean }> {
    if (!this.config) await this.init();

    const discovered = await this.discoverProviders(
      this.config!.country,
      this.config!.service,
      this.config!.maxPrice,
      true // força refresh
    );

    if (discovered.length > 0) {
      await setSetting("sms_provider_ids", discovered.join(","), "IDs dos provedores SMS (atualizado via Auto-Discover)");
      // Recarrega config para refletir a nova lista
      await this.reloadConfig();
      console.log(`[SmsService] Lista de provedores atualizada via Auto-Discover: [${discovered.join(", ")}]`);
      return { providers: discovered, updated: true };
    }

    return { providers: [], updated: false };
  }

  // ============================================================
  // CORE: getCodeWithRetry v3.0
  // ============================================================

  /**
   * getCodeWithRetry v3.0 — Smart Provider Management
   *
   * Estratégia:
   *   1. Carrega snapshot local da config (evita interferência entre jobs concorrentes).
   *   2. Filtra provedores blacklistados da lista.
   *   3. Ranqueia apenas provedores DISPONÍVEIS (sem cooldown) por score.
   *      NÃO inclui provedores em cooldown como "segunda chance".
   *   4. Cada tentativa usa um provedor específico da fila.
   *   5. Falha de SMS → cooldown progressivo no provedor.
   *   6. Rejeição pelo alvo (permission_denied) → penalidade de target rejection.
   *      Se 5+ rejeições consecutivas → cooldown suave no provedor.
   *   7. Provedores que atingem threshold de blacklist → banidos permanentemente.
   *   8. Se todos da lista falharam e ainda há tentativas → Auto-Discover como fallback.
   *   9. Health é persistido no banco após cada tentativa (debounced 30s).
   */
  async getCodeWithRetry(options: RetryOptions = {}): Promise<RetryResult> {
    if (!this.initialized) await this.init();

    // Reload config e tira snapshot local
    await this.reloadConfig();
    const configSnapshot = { ...this.config! };
    configSnapshot.providerIds = [...this.config!.providerIds];

    const maxRetries = options.maxRetries ?? configSnapshot.maxRetries;
    const waitTimeMs = options.waitTimeMs ?? configSnapshot.waitTimeMs;
    const onNumberRented = options.onNumberRented || undefined;
    const jobId = options.jobId;

    const country = options.country || configSnapshot.country;
    const service = options.service || configSnapshot.service;
    const maxPrice = options.maxPrice || configSnapshot.maxPrice;

    // 1. Montar lista base de provedores
    let configuredProviders = options.providerIds ? [...options.providerIds] : [...configSnapshot.providerIds];

    // 2. Filtrar blacklistados
    const blacklist = await this.getBlacklist();
    if (blacklist.length > 0) {
      const before = configuredProviders.length;
      configuredProviders = configuredProviders.filter(id => !blacklist.includes(id));
      if (configuredProviders.length < before) {
        await logger.info("sms",
          `Blacklist: ${before - configuredProviders.length} provedor(es) excluído(s) da fila. Restam: [${configuredProviders.join(", ")}]`,
          {}, jobId
        );
      }
    }

    // 3. Ranquear apenas provedores DISPONÍVEIS (sem cooldown)
    const rankedProviders = this.providerHealth.rankAvailableProviders(configuredProviders);
    const cooldownCount = configuredProviders.length - rankedProviders.length;

    if (cooldownCount > 0) {
      await logger.info("sms",
        `${cooldownCount} provedor(es) em cooldown ignorado(s) nesta rodada`,
        {}, jobId
      );
    }

    // Fila final: apenas disponíveis
    const providerQueue = [...rankedProviders];

    // Effective max retries: pelo menos o tamanho da fila
    const effectiveMaxRetries = Math.max(maxRetries, providerQueue.length);

    await logger.info("sms",
      `Fila de provedores: [${providerQueue.join(", ")}] (${providerQueue.length} disponíveis, ${cooldownCount} em cooldown — ignorados). ` +
      `Max tentativas: ${effectiveMaxRetries}`,
      {}, jobId
    );

    if (providerQueue.length === 0) {
      // Todos em cooldown ou blacklist — tenta Auto-Discover imediatamente
      await logger.warn("sms",
        `Nenhum provedor disponível (todos em cooldown ou blacklist). Tentando Auto-Discover...`,
        {}, jobId
      );
      try {
        const discovered = await this.discoverProviders(country, service, maxPrice, true);
        const newProviders = discovered.filter(id => !blacklist.includes(id));
        if (newProviders.length > 0) {
          providerQueue.push(...newProviders);
          await logger.info("sms",
            `Auto-Discover encontrou ${newProviders.length} provedores como emergência: [${newProviders.join(", ")}]`,
            {}, jobId
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await logger.warn("sms", `Auto-Discover emergencial falhou: ${msg}`, {}, jobId);
      }

      if (providerQueue.length === 0) {
        throw new Error("SMS indisponível: todos os provedores estão em cooldown ou blacklist. Aguarde alguns minutos e tente novamente.");
      }
    }

    let totalCost = 0;
    let lastError: Error | null = null;
    let attempt = 0;
    let usedFallbackDiscover = false;

    // 4. Tentar cada provedor da fila sequencialmente
    for (let queueIndex = 0; queueIndex < providerQueue.length && attempt < effectiveMaxRetries; queueIndex++) {
      attempt++;
      const currentProviderId = providerQueue[queueIndex];

      await logger.info("sms", `=== Tentativa ${attempt}/${effectiveMaxRetries} — Provedor #${currentProviderId} ===`, {}, jobId);

      const result = await this._tryProvider(currentProviderId, {
        country, service, maxPrice, waitTimeMs, onNumberRented, jobId, attempt,
      });

      // Persiste health após cada tentativa (debounced)
      this.schedulePersistHealth();

      if (result.success) {
        totalCost += result.cost;

        // Auto-adiciona à lista se veio do Auto-Discover
        if (!options.providerIds) {
          const currentSavedList = ((await getSetting("sms_provider_ids")) || "")
            .split(",").map(id => parseInt(id.trim())).filter(id => !isNaN(id));
          if (!currentSavedList.includes(currentProviderId)) {
            const updatedList = [...currentSavedList, currentProviderId];
            await setSetting("sms_provider_ids", updatedList.join(","));
            await logger.info("sms",
              `Provedor #${currentProviderId} teve SUCESSO — adicionado à lista. Lista: [${updatedList.join(", ")}]`,
              { providerId: currentProviderId }, jobId
            );
          }
        }

        return {
          code: result.code!,
          phoneNumber: result.phoneNumber!,
          activationId: result.activationId!,
          attempt,
          totalCost,
        };
      }

      // Falhou — verifica se deve ir para blacklist
      if (!options.providerIds) {
        const toBlacklist = this.providerHealth.getProvidersToBlacklist([currentProviderId]);
        if (toBlacklist.length > 0) {
          await this.addToBlacklist(toBlacklist, jobId);
        }
      }

      lastError = result.error || null;

      // Fallback: se todos da lista falharam e ainda há tentativas
      if (
        queueIndex === providerQueue.length - 1 &&
        attempt < effectiveMaxRetries &&
        !usedFallbackDiscover &&
        !configSnapshot.autoDiscover
      ) {
        usedFallbackDiscover = true;
        await logger.info("sms",
          `Todos os ${providerQueue.length} provedores da lista falharam. Tentando Auto-Discover como fallback...`,
          {}, jobId
        );

        try {
          const discovered = await this.discoverProviders(country, service, maxPrice, true);
          const newProviders = discovered.filter(id => !providerQueue.includes(id) && !blacklist.includes(id));

          if (newProviders.length > 0) {
            await logger.info("sms",
              `Auto-Discover (fallback) encontrou ${newProviders.length} novos provedores: [${newProviders.join(", ")}]`,
              {}, jobId
            );
            providerQueue.push(...newProviders);
          } else {
            await logger.warn("sms",
              `Auto-Discover (fallback) não encontrou provedores novos além dos ${providerQueue.length} já tentados`,
              {}, jobId
            );
          }
        } catch (discoverErr) {
          const msg = discoverErr instanceof Error ? discoverErr.message : String(discoverErr);
          await logger.warn("sms", `Auto-Discover (fallback) falhou: ${msg}`, {}, jobId);
        }
      }

      // Delay entre tentativas
      if (attempt < effectiveMaxRetries && queueIndex < providerQueue.length - 1) {
        const delay = configSnapshot.retryDelayMin + Math.random() * (configSnapshot.retryDelayMax - configSnapshot.retryDelayMin);
        await sleep(delay);
      }
    }

    // 5. Todas as tentativas falharam
    const healthSummary = this.providerHealth.getSummary();
    await logger.error("sms",
      `SMS não recebido após ${attempt} tentativas. Health: ${JSON.stringify(healthSummary)}`,
      {}, jobId
    );

    throw new Error(`SMS não recebido após ${attempt} tentativas com rotação de provedores. Último erro: ${lastError?.message || "timeout"}`);
  }

  /**
   * Tenta obter código SMS de um provedor específico.
   * v3.0: Distingue falhas de SMS de rejeições pelo alvo.
   */
  private async _tryProvider(
    providerId: number,
    opts: {
      country: string;
      service: string;
      maxPrice: string;
      waitTimeMs: number;
      onNumberRented: RetryOptions["onNumberRented"];
      jobId?: number;
      attempt: number;
    }
  ): Promise<{
    success: boolean;
    code?: string;
    phoneNumber?: string;
    activationId?: string;
    cost: number;
    error?: Error;
    wasTargetRejection?: boolean;
  }> {
    let numberData: NumberData | null = null;
    const startTime = Date.now();

    try {
      numberData = await this.getNumber({
        country: opts.country,
        service: opts.service,
        maxPrice: opts.maxPrice,
        providerIds: [providerId],
        jobId: opts.jobId,
      });

      const cost = parseFloat(numberData.activationCost || opts.maxPrice);

      if (opts.onNumberRented) {
        await opts.onNumberRented({
          phoneNumber: numberData.phoneNumber,
          activationId: numberData.activationId,
          attempt: opts.attempt,
        });
      }

      const code = await this.waitForCode(numberData.activationId, opts.waitTimeMs, opts.jobId);

      if (code) {
        const responseTime = Date.now() - startTime;
        this.providerHealth.recordSuccess(providerId, responseTime);
        await logger.info("sms",
          `SMS recebido na tentativa ${opts.attempt}! Código: ${code} (provedor #${providerId}, ${Math.round(responseTime / 1000)}s)`,
          {}, opts.jobId
        );
        return { success: true, code, phoneNumber: numberData.phoneNumber, activationId: numberData.activationId, cost };
      }

      // Timeout
      await logger.warn("sms", `Provedor #${providerId}: SMS não recebido (timeout). Cancelando...`, {}, opts.jobId);
      await this.cancel(numberData.activationId, numberData.rentedAt, opts.jobId);
      this.providerHealth.recordFailure(providerId);
      return { success: false, cost: 0, error: new Error(`Timeout no provedor #${providerId}`) };

    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));

      if (numberData) {
        try {
          await this.cancel(numberData.activationId, numberData.rentedAt, opts.jobId);
        } catch {
          // Ignore cancel errors
        }
      }

      // Detecta se é rejeição pelo alvo (Manus) ou falha do provedor de SMS
      const isTargetApiError =
        error.message.includes("RPC ") ||
        error.message.includes("permission_denied") ||
        error.message.includes("invalid_argument") ||
        error.message.includes("Failed to send the code") ||
        error.message.includes("resource_exhausted");

      if (isTargetApiError) {
        // Rejeição pelo alvo: penaliza com target rejection (não com failure de SMS)
        this.providerHealth.recordTargetRejection(providerId);
        await logger.warn("sms",
          `Provedor #${providerId}: número rejeitado pelo alvo (target rejection #${
            (this.providerHealth.getSummary().find(h => h.providerId === providerId) as any)?.consecutiveTargetRejections || "?"
          }): ${error.message}`,
          {}, opts.jobId
        );
        return { success: false, cost: 0, error, wasTargetRejection: true };
      } else {
        await logger.error("sms", `Provedor #${providerId} falhou: ${error.message}`, {}, opts.jobId);
        this.providerHealth.recordFailure(providerId);
      }

      // Erros fatais: não adianta tentar outros provedores
      if (error.message.includes("Saldo insuficiente") || error.message.includes("API key inválida")) {
        throw error;
      }

      return { success: false, cost: 0, error };
    }
  }

  // ============================================================
  // API METHODS
  // ============================================================

  async getBalance(): Promise<number> {
    if (!this.apiKey) await this.init();

    const params = new URLSearchParams({
      api_key: this.apiKey,
      action: "getBalance",
    });

    const resp = await fetch(`${SMSBOWER_API}?${params.toString()}`);
    const text = await resp.text();

    if (text.startsWith("ACCESS_BALANCE:")) {
      return parseFloat(text.split(":")[1]);
    }
    return 0;
  }

  async getPrices(country?: string, service?: string): Promise<unknown> {
    if (!this.config) await this.init();

    const params = new URLSearchParams({
      api_key: this.apiKey,
      action: "getPricesV2",
      service: service || this.config!.service,
      country: country || this.config!.country,
    });

    const resp = await fetch(`${SMSBOWER_API}?${params.toString()}`);
    return await resp.json();
  }

  async getProviders(country?: string, service?: string): Promise<Record<string, unknown>> {
    if (!this.apiKey) await this.init();

    const params = new URLSearchParams({
      api_key: this.apiKey,
      action: "getPricesV3",
      service: service || this.config?.service || "ot",
      country: country || this.config?.country || "6",
    });

    const resp = await fetch(`${SMSBOWER_API}?${params.toString()}`);
    return (await resp.json()) as Record<string, unknown>;
  }

  async getNumber(overrides: GetNumberOverrides = {}): Promise<NumberData> {
    if (!this.apiKey) await this.init();
    if (!this.config) throw new Error("SMS config not loaded");

    const country = overrides.country || this.config.country;
    const service = overrides.service || this.config.service;
    const maxPrice = overrides.maxPrice || this.config.maxPrice;
    const jobId = overrides.jobId;
    const providerIds = overrides.providerIds || this.config.providerIds;

    await logger.info("sms",
      `Alugando número (país: ${country}, serviço: ${service}, maxPrice: $${maxPrice}, providers: [${providerIds.join(",")}])`,
      {}, jobId
    );

    const params = new URLSearchParams({
      api_key: this.apiKey,
      action: "getNumberV2",
      service,
      country,
      maxPrice,
    });

    if (providerIds.length > 0) {
      params.set("providerIds", providerIds.join(","));
    }

    const resp = await fetch(`${SMSBOWER_API}?${params.toString()}`);
    const text = await resp.text();

    try {
      const data = JSON.parse(text) as Record<string, unknown>;
      if (data.activationId && data.phoneNumber) {
        const result: NumberData = {
          activationId: String(data.activationId),
          phoneNumber: data.phoneNumber as string,
          activationCost: (data.activationCost as string) || maxPrice,
          rentedAt: Date.now(),
          providerId: providerIds.length === 1 ? providerIds[0] : undefined,
        };
        await logger.info("sms",
          `Número alugado: +${result.phoneNumber} (ID: ${result.activationId}, custo: $${result.activationCost}, provider: ${providerIds.length === 1 ? providerIds[0] : "pool"})`,
          {}, jobId
        );
        return result;
      }
    } catch {
      // Not JSON
    }

    if (text === "NO_NUMBERS") throw new Error("SMSBower: Sem números disponíveis nessa faixa de preço/provedores");
    if (text === "NO_BALANCE") throw new Error("SMSBower: Saldo insuficiente");
    if (text === "BAD_KEY") throw new Error("SMSBower: API key inválida");
    throw new Error(`SMSBower getNumberV2: ${text}`);
  }

  async getStatus(activationId: string): Promise<{ status: string; code?: string; lastCode?: string }> {
    if (!this.apiKey) await this.init();

    const params = new URLSearchParams({
      api_key: this.apiKey,
      action: "getStatus",
      id: activationId,
    });

    const resp = await fetch(`${SMSBOWER_API}?${params.toString()}`);
    const text = await resp.text();

    if (text.startsWith("STATUS_OK:")) {
      return { status: "STATUS_OK", code: text.split(":")[1] };
    }
    if (text.startsWith("STATUS_WAIT_RETRY:")) {
      return { status: "STATUS_WAIT_RETRY", lastCode: text.split(":")[1] };
    }
    return { status: text };
  }

  async setStatus(activationId: string, status: number): Promise<string> {
    if (!this.apiKey) await this.init();

    const params = new URLSearchParams({
      api_key: this.apiKey,
      action: "setStatus",
      id: activationId,
      status: status.toString(),
    });

    const resp = await fetch(`${SMSBOWER_API}?${params.toString()}`);
    return await resp.text();
  }

  async complete(activationId: string, jobId?: number): Promise<string> {
    await logger.info("sms", `Completando ativação ${activationId}`, {}, jobId);
    const result = await this.setStatus(activationId, 6);
    await logger.info("sms", `Ativação ${activationId} completada: ${result}`, {}, jobId);
    return result;
  }

  async cancel(activationId: string, rentedAt?: number, jobId?: number): Promise<string> {
    if (!this.config) await this.init();

    await logger.info("sms", `Cancelando número ${activationId} — aguardando devolução do saldo...`, {}, jobId);

    if (rentedAt && this.config) {
      const elapsed = Date.now() - rentedAt;
      const maxCancelWait = Math.min(this.config.cancelWaitMs, 30_000);
      if (elapsed < maxCancelWait) {
        const waitTime = maxCancelWait - elapsed;
        await logger.info("sms",
          `Aguardando ${Math.ceil(waitTime / 1000)}s antes de cancelar (${Math.round(elapsed / 1000)}s já decorridos)`,
          {}, jobId
        );
        await sleep(waitTime);
      }
    }

    const result = await this.setStatus(activationId, 8);
    if (result === "ACCESS_CANCEL") {
      await logger.info("sms", `Número ${activationId} cancelado — saldo devolvido`, {}, jobId);
    } else {
      await logger.warn("sms", `Cancelamento retornou: ${result} (pode não ter devolvido saldo)`, { activationId }, jobId);
    }
    return result;
  }

  async waitForCode(activationId: string, timeoutMs?: number, jobId?: number): Promise<string | null> {
    if (!this.config) await this.init();

    const timeout = timeoutMs || this.config!.waitTimeMs;
    const pollInterval = this.config!.pollIntervalMs;
    const progressLogInterval = 20_000;

    await logger.info("sms", `Aguardando SMS (ativação: ${activationId}, timeout: ${timeout / 1000}s)`, {}, jobId);

    const startTime = Date.now();
    let lastProgressLog = startTime;

    while (Date.now() - startTime < timeout) {
      try {
        const result = await this.getStatus(activationId);

        if (result.status === "STATUS_OK" && result.code) {
          await logger.info("sms", `Código SMS recebido: ${result.code}`, { activationId }, jobId);
          return result.code;
        }

        if (result.status === "STATUS_CANCEL") {
          await logger.warn("sms", `Ativação ${activationId} cancelada pelo servidor`, {}, jobId);
          return null;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await logger.warn("sms", `Erro ao consultar status: ${msg}`, { activationId }, jobId);
      }

      const now = Date.now();
      if (now - lastProgressLog >= progressLogInterval) {
        const elapsed = Math.round((now - startTime) / 1000);
        const remaining = Math.round((timeout - (now - startTime)) / 1000);
        await logger.info("sms",
          `Aguardando SMS... ${elapsed}s/${timeout / 1000}s (restam ${remaining}s)`,
          { activationId }, jobId
        );
        lastProgressLog = now;
      }

      await sleep(pollInterval);
    }

    await logger.warn("sms",
      `Timeout: SMS não recebido em ${timeout / 1000}s — cancelando número e tentando outro`,
      { activationId }, jobId
    );
    return null;
  }

  // ============================================================
  // PUBLIC API (para routers e UI)
  // ============================================================

  getProviderHealthSummary(): Record<string, unknown>[] {
    return this.providerHealth.getSummary();
  }

  resetProviderHealth(): void {
    this.providerHealth.reset();
    setSetting("sms_provider_health", "{}").catch(() => {});
  }
}

export const smsService = new SmsService();
