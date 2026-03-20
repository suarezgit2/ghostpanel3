/**
 * SmsService - SMSBower Integration (v3.1 — Multi-Country Support)
 *
 * Melhorias v3.1:
 *   - Suporte a múltiplos países: cada país tem seu próprio countryCode (SMSBower),
 *     regionCode (ex: +55), maxPrice, providerIds e enabled.
 *   - Setting sms_countries: JSON array com a configuração de cada país.
 *   - O sistema tenta os países habilitados em ordem, rotacionando quando um falha.
 *   - onNumberRented recebe regionCode do país para enviar ao Manus corretamente.
 *   - RetryResult inclui regionCode para o provider usar no sendPhoneVerificationCode.
 *   - Compatibilidade retroativa: se sms_countries não estiver configurado,
 *     usa as settings legadas (sms_country, sms_provider_ids, etc.).
 *
 * Melhorias v3.0 (mantidas):
 *   1. Blacklist persistente (sms_blacklisted_providers)
 *   2. Sem segunda chance para provedores em cooldown
 *   3. Target-rejection tracking (permission_denied)
 *   4. Health persistido no banco (sms_provider_health)
 *   5. Limpeza automática da lista manual
 *   6. Auto-Discover como fallback
 *
 * Settings utilizados:
 *   smsbower_api_key, sms_service, sms_max_retries, sms_wait_time, sms_poll_interval,
 *   sms_retry_delay_min, sms_retry_delay_max, sms_cancel_wait, sms_auto_discover,
 *   sms_blacklisted_providers, sms_provider_health,
 *   sms_countries (novo — JSON array de CountryConfig)
 *   Legado (ainda suportado): sms_country, sms_max_price, sms_provider_ids
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
  sms_countries: "",
};

/**
 * Configuração de um país para SMS multi-país.
 * countryCode: código numérico do SMSBower (ex: "6" = Indonésia, "73" = Brasil)
 * regionCode: prefixo telefônico internacional (ex: "+62", "+55")
 * name: nome legível (ex: "Indonesia", "Brazil")
 * maxPrice: preço máximo por número neste país
 * providerIds: IDs dos provedores para este país (vazio = qualquer)
 * enabled: se este país está ativo na rotação
 */
export interface CountryConfig {
  countryCode: string;
  regionCode: string;
  name: string;
  maxPrice: string;
  providerIds: number[];
  enabled: boolean;
}

/** Mapa de códigos SMSBower para regionCode e nome */
export const KNOWN_COUNTRIES: Record<string, { regionCode: string; name: string }> = {
  "0":  { regionCode: "+7",   name: "Russia" },
  "6":  { regionCode: "+62",  name: "Indonesia" },
  "7":  { regionCode: "+1",   name: "USA" },
  "12": { regionCode: "+63",  name: "Philippines" },
  "22": { regionCode: "+66",  name: "Thailand" },
  "31": { regionCode: "+44",  name: "United Kingdom" },
  "73": { regionCode: "+55",  name: "Brazil" },
  "82": { regionCode: "+91",  name: "India" },
  "86": { regionCode: "+84",  name: "Vietnam" },
  "95": { regionCode: "+234", name: "Nigeria" },
  "33": { regionCode: "+57", name: "Colombia" },
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
  /** Lista de países configurados (multi-país). Vazio = usa country/providerIds legados. */
  countries: CountryConfig[];
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
  /** Callback chamado quando um número é alugado. Inclui regionCode do país para enviar ao Manus. */
  onNumberRented?: (data: { phoneNumber: string; activationId: string; attempt: number; regionCode: string }) => Promise<void>;
  jobId?: number;
}

interface RetryResult {
  code: string;
  phoneNumber: string;
  activationId: string;
  attempt: number;
  totalCost: number;
  /** Prefixo telefônico do país do número (ex: "+62", "+55"). Usado pelo provider para sendPhoneVerificationCode. */
  regionCode: string;
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

  // ============================================================
  // PHONE NUMBER QUALITY TRACKER
  // ============================================================
  
  class PhoneNumberQualityTracker {
    private rejectionCache = new Map<string, {
      rejectedAt: number;
      rejectionCount: number;
      lastProvider: number;
    }>();
    
    private readonly REJECTION_TTL = 7 * 24 * 60 * 60 * 1000; // 7 dias
    
    isNumberRejected(phoneNumber: string): boolean {
      const rejection = this.rejectionCache.get(phoneNumber);
      if (!rejection) return false;
      
      // Se expirou, remove do cache e permite tentar de novo
      if (Date.now() - rejection.rejectedAt > this.REJECTION_TTL) {
        this.rejectionCache.delete(phoneNumber);
        return false;
      }
      
      return true;
    }
    
    recordRejection(phoneNumber: string, providerId: number) {
      const existing = this.rejectionCache.get(phoneNumber);
      this.rejectionCache.set(phoneNumber, {
        rejectedAt: Date.now(),
        rejectionCount: (existing?.rejectionCount || 0) + 1,
        lastProvider: providerId
      });
    }
    
    // Serialização para persistência
    serialize(): Record<string, any> {
      const now = Date.now();
      const data: Record<string, any> = {};
      
      for (const [number, info] of this.rejectionCache.entries()) {
        if (now - info.rejectedAt <= this.REJECTION_TTL) {
          data[number] = info;
        }
      }
      return data;
    }
    
    restore(data: Record<string, any>) {
      const now = Date.now();
      for (const [number, info] of Object.entries(data)) {
        if (now - info.rejectedAt <= this.REJECTION_TTL) {
          this.rejectionCache.set(number, info);
        }
      }
    }
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

  // Cooldown para target rejections: 600s, 1800s, 3600s (muito mais agressivo para evitar bloqueios do Manus)
  private static TARGET_REJECTION_COOLDOWN_STEPS = [600_000, 1800_000, 3600_000];

  // Threshold para blacklist automática
  private static BLACKLIST_CONSECUTIVE_FAILURES = 8;
  private static BLACKLIST_MIN_ATTEMPTS = 5;
  private static BLACKLIST_MAX_SUCCESS_RATE = 0.15; // < 15% de sucesso

  // Threshold para cooldown por target rejection (reduzido para punir mais rápido)
  private static TARGET_REJECTION_CONSECUTIVE_THRESHOLD = 2; // Punir após apenas 2 rejeições consecutivas

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
    const successRate = h.successes / total; // 0.0 - 1.0
    const avgResponseTime = h.successes > 0 ? h.totalResponseTimeMs / h.successes : 120_000;

    // Score de velocidade: 0-1 (120s+ = 0, 10s = 1)
    const speedScore = Math.max(0, Math.min(1, (120_000 - avgResponseTime) / 110_000));

    // Score de recência: 0 ou 1 (sucesso nos últimos 10min = 1)
    const recencyScore = h.lastSuccessAt > 0 && (Date.now() - h.lastSuccessAt) < 600_000 ? 1 : 0;

    // Penalidade por target rejections: 0.0 - 1.0
    const totalAttempts = total + h.targetRejections;
    const targetRejectionRate = totalAttempts > 0 ? h.targetRejections / totalAttempts : 0;

    // Pesos: sucesso=60%, velocidade=20%, recência=20%, penalidade target=-20% máx
    const raw = (successRate * 0.60) + (speedScore * 0.20) + (recencyScore * 0.20) - (targetRejectionRate * 0.20);
    return Math.round(Math.max(0, Math.min(1, raw)) * 100);
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
   * Retorna a lista de provedores com ordem embaralhada por job.
   * O melhor provedor (maior score) fica na primeira posição.
   * Os demais são embaralhados aleatoriamente, garantindo que jobs concorrentes
   * não tentem os mesmos provedores na mesma ordem.
   *
   * Isso evita que todos os jobs falhem pelo mesmo provedor ruim ao mesmo tempo.
   */
  shuffleForJob(providerIds: number[]): number[] {
    const ranked = this.rankAvailableProviders(providerIds);
    if (ranked.length <= 1) return ranked;

    // Mantém o melhor provedor na frente
    const [best, ...rest] = ranked;

    // Embaralha o restante (Fisher-Yates)
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }

    return [best, ...rest];
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
  readonly numberQuality = new PhoneNumberQualityTracker();
  private healthPersistTimer: ReturnType<typeof setTimeout> | null = null;
  private initialized = false;

  /**
   * Fila de cancelamentos assíncronos (Refatorada para evitar memory leaks e race conditions).
   * Usa um Map para deduplicação e processamento em batch controlado.
   */
  private cancelQueue = new Map<string, {
    rentedAt: number;
    minWait: number;
    jobId?: number;
    attempts: number;
    nextRetry: number;
  }>();
  
  private isProcessingQueue = false;
  private readonly MAX_QUEUE_SIZE = 500;
  private readonly PROCESSING_CONCURRENCY = 3; // Limita requisições simultâneas à API
  private readonly ITEM_TTL = 24 * 60 * 60 * 1000; // 24h

  /**
   * Enfileira um cancelamento assíncrono. Retorna imediatamente sem bloquear.
   * O cancelamento real acontece em background após o tempo mínimo.
   */
  enqueueCancelAsync(activationId: string, rentedAt: number, jobId?: number): void {
    // Deduplicação: se já está na fila, não adiciona novamente
    if (this.cancelQueue.has(activationId)) {
      return;
    }

    // Proteção contra memory leak
    if (this.cancelQueue.size >= this.MAX_QUEUE_SIZE) {
      logger.warn("sms", `[Fila] Fila de cancelamento cheia (${this.MAX_QUEUE_SIZE}). Forçando processamento...`, {}, jobId).catch(() => {});
      this.processCancelQueue().catch(() => {});
    }

    const minWait = this.config?.cancelWaitMs ?? 125_000; // fallback: 125s (padrão SMSBower)
    
    this.cancelQueue.set(activationId, {
      rentedAt,
      minWait,
      jobId,
      attempts: 0,
      nextRetry: rentedAt + minWait // Só processa após o tempo mínimo
    });

    // Inicia o loop de processamento se não estiver rodando
    this.startQueueProcessor();
  }

  private startQueueProcessor() {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;
    
    // Roda em background
    (async () => {
      while (this.cancelQueue.size > 0) {
        await this.processCancelQueue();
        await sleep(5000); // Intervalo entre batches
      }
      this.isProcessingQueue = false;
    })();
  }

  private async processCancelQueue(): Promise<void> {
    const now = Date.now();
    const toProcess: string[] = [];

    for (const [activationId, item] of this.cancelQueue.entries()) {
      // Remove itens expirados (proteção contra memory leak)
      if (now - item.rentedAt > this.ITEM_TTL) {
        this.cancelQueue.delete(activationId);
        continue;
      }

      // Seleciona itens prontos para processamento
      if (item.nextRetry <= now) {
        toProcess.push(activationId);
      }
    }

    // Processa em batches para não sobrecarregar a API
    for (let i = 0; i < toProcess.length; i += this.PROCESSING_CONCURRENCY) {
      const batch = toProcess.slice(i, i + this.PROCESSING_CONCURRENCY);
      await Promise.all(batch.map(id => this.executeCancelation(id)));
    }
  }

  private async executeCancelation(activationId: string): Promise<void> {
    const item = this.cancelQueue.get(activationId);
    if (!item) return;

    try {
      const result = await this.setStatus(activationId, 8);
      
      if (result === "ACCESS_CANCEL") {
        await logger.info("sms", `[Fila] Número ${activationId} cancelado em background — saldo devolvido`, {}, item.jobId);
        this.cancelQueue.delete(activationId);
      } else if (result === "ALREADY_FINISH" || result === "NO_ACTIVATION") {
        await logger.info("sms", `[Fila] Cancelamento ${activationId}: ${result} (já finalizado, saldo não perdido)`, {}, item.jobId);
        this.cancelQueue.delete(activationId);
      } else {
        throw new Error(`Resposta inesperada: ${result}`);
      }
    } catch (err) {
      item.attempts++;
      if (item.attempts >= 3) {
        await logger.warn("sms", `[Fila] Falha ao cancelar ${activationId} após 3 tentativas. Desistindo.`, {}, item.jobId);
        this.cancelQueue.delete(activationId);
      } else {
        // Backoff exponencial: 10s, 20s, 40s
        const backoff = 10000 * Math.pow(2, item.attempts - 1);
        item.nextRetry = Date.now() + backoff;
      }
    }
  }

  /** Retorna quantos cancelamentos estão pendentes na fila */
  getPendingCancellations(): number {
    return this.cancelQueue.size;
  }

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

    // Parse multi-country config
    let countries: CountryConfig[] = [];
    const countriesRaw = await get("sms_countries");
    if (countriesRaw && countriesRaw.trim() !== "") {
      try {
        countries = JSON.parse(countriesRaw) as CountryConfig[];
      } catch {
        console.warn("[SmsService] sms_countries JSON inválido, ignorando");
      }
    }

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
      countries,
    };

    const enabledCountries = this.config.countries.filter(c => c.enabled);
    await logger.info(
      "sms",
      `Configuração carregada: serviço=${this.config.service}, ` +
      (enabledCountries.length > 0
        ? `países=[${enabledCountries.map(c => `${c.name}($${c.maxPrice})`).join(", ")}], `
        : `país=${this.config.country}(legado), maxPrice=$${this.config.maxPrice}, providers=${this.config.providerIds.length}, `) +
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

  /**
   * Retorna a lista de países configurados.
   * Se sms_countries estiver vazio, retorna um país padrão baseado nas settings legadas.
   */
  async getCountries(): Promise<CountryConfig[]> {
    if (!this.config) await this.init();
    if (this.config!.countries.length > 0) return this.config!.countries;

    // Fallback legado: cria um país a partir das settings antigas
    const known = KNOWN_COUNTRIES[this.config!.country];
    return [{
      countryCode: this.config!.country,
      regionCode: known?.regionCode || "+62",
      name: known?.name || `País ${this.config!.country}`,
      maxPrice: this.config!.maxPrice,
      providerIds: this.config!.providerIds,
      enabled: true,
    }];
  }

  /**
   * Salva a lista de países no banco e recarrega a config.
   */
  async saveCountries(countries: CountryConfig[]): Promise<void> {
    await setSetting("sms_countries", JSON.stringify(countries), "Configuração multi-país para SMS");
    await this.reloadConfig();
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
      const rawHealth = await getSetting("sms_provider_health");
      if (rawHealth && rawHealth !== "{}" && rawHealth !== "") {
        const data = JSON.parse(rawHealth) as Record<string, unknown>;
        this.providerHealth.restore(data as any);
        console.log("[SmsService] Health dos provedores restaurado do banco");
      }
      
      const rawQuality = await getSetting("sms_number_quality");
      if (rawQuality && rawQuality !== "{}" && rawQuality !== "") {
        const data = JSON.parse(rawQuality) as Record<string, unknown>;
        this.numberQuality.restore(data);
        console.log("[SmsService] Qualidade dos números restaurada do banco");
      }
    } catch (err) {
      console.warn("[SmsService] Falha ao restaurar health/quality:", err);
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
        const healthData = this.providerHealth.serialize();
        await setSetting("sms_provider_health", JSON.stringify(healthData));
        
        const qualityData = this.numberQuality.serialize();
        await setSetting("sms_number_quality", JSON.stringify(qualityData));
      } catch (err) {
        console.warn("[SmsService] Falha ao persistir health/quality:", err);
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
   * Aceita countryCodeOverride e maxPriceOverride para descoberta por país específico.
   * Usado pelo botão "Descobrir Provedores Agora" na UI.
   */
  async discoverAndUpdateProviderList(
    countryCodeOverride?: string,
    maxPriceOverride?: string
  ): Promise<{ providers: number[]; updated: boolean }> {
    if (!this.config) await this.init();

    const country = countryCodeOverride || this.config!.country;
    const maxPrice = maxPriceOverride || this.config!.maxPrice;

    const discovered = await this.discoverProviders(
      country,
      this.config!.service,
      maxPrice,
      true // força refresh
    );

    if (discovered.length > 0) {
      // Se for o país padrão (legado), atualiza sms_provider_ids
      if (!countryCodeOverride || countryCodeOverride === this.config!.country) {
        await setSetting("sms_provider_ids", discovered.join(","), "IDs dos provedores SMS (atualizado via Auto-Discover)");
        await this.reloadConfig();
      }
      console.log(`[SmsService] Provedores descobertos para país ${country}: [${discovered.join(", ")}]`);
      return { providers: discovered, updated: true };
    }

    return { providers: [], updated: false };
  }

  // ============================================================
  // CORE: getCodeWithRetry v3.0
  // ============================================================

  /**
   * getCodeWithRetry v3.1 — Multi-Country + Smart Provider Management
   *
   * Estratégia:
   *   1. Se sms_countries configurado: tenta cada país habilitado em ordem.
   *      Cada país tem sua própria lista de provedores, maxPrice e regionCode.
   *   2. Dentro de cada país: mesma lógica v3.0 (blacklist, cooldown, health).
   *   3. Se um país falha completamente, passa para o próximo.
   *   4. RetryResult inclui regionCode para o provider usar no sendPhoneVerificationCode.
   *   5. Compatibilidade retroativa: se sms_countries vazio, usa config legada.
   */
  async getCodeWithRetry(options: RetryOptions = {}): Promise<RetryResult> {
    if (!this.initialized) await this.init();

    // Reload config e tira snapshot local
    await this.reloadConfig();
    const configSnapshot = { ...this.config! };
    configSnapshot.providerIds = [...this.config!.providerIds];
    configSnapshot.countries = [...this.config!.countries];

    const maxRetries = options.maxRetries ?? configSnapshot.maxRetries;
    const waitTimeMs = options.waitTimeMs ?? configSnapshot.waitTimeMs;
    const onNumberRented = options.onNumberRented || undefined;
    const jobId = options.jobId;
    const service = options.service || configSnapshot.service;

    // Determina a lista de países a tentar
    const enabledCountries = configSnapshot.countries.filter(c => c.enabled);
    const useMultiCountry = enabledCountries.length > 0 && !options.country && !options.providerIds;

    if (useMultiCountry) {
      // ============================================================
      // MODO MULTI-PAÍS: tenta cada país em ordem
      // ============================================================
      await logger.info("sms",
        `Modo multi-país: [${enabledCountries.map(c => `${c.name}($${c.maxPrice})`).join(", ")}]`,
        {}, jobId
      );

      let lastCountryError: Error | null = null;

      for (const countryConfig of enabledCountries) {
        await logger.info("sms",
          `--- Tentando país: ${countryConfig.name} (código ${countryConfig.countryCode}, ${countryConfig.regionCode}, max $${countryConfig.maxPrice}) ---`,
          {}, jobId
        );

        try {
          const result = await this._getCodeForCountry({
            countryConfig,
            service,
            maxRetries,
            waitTimeMs,
            onNumberRented,
            jobId,
          });
          return result;
        } catch (err) {
          lastCountryError = err instanceof Error ? err : new Error(String(err));
          await logger.warn("sms",
            `País ${countryConfig.name} falhou completamente: ${lastCountryError.message}. Tentando próximo país...`,
            {}, jobId
          );
        }
      }

      throw new Error(
        `SMS não recebido em nenhum dos ${enabledCountries.length} país(es) configurados. ` +
        `Último erro: ${lastCountryError?.message || "timeout"}`
      );
    }

    // ============================================================
    // MODO LEGADO: um único país (compatibilidade retroativa)
    // ============================================================
    const country = options.country || configSnapshot.country;
    const maxPrice = options.maxPrice || configSnapshot.maxPrice;
    const known = KNOWN_COUNTRIES[country];
    const regionCode = known?.regionCode || "+62";

    const result = await this._getCodeForCountry({
      countryConfig: {
        countryCode: country,
        regionCode,
        name: known?.name || `País ${country}`,
        maxPrice,
        providerIds: options.providerIds ? [...options.providerIds] : [...configSnapshot.providerIds],
        enabled: true,
      },
      service,
      maxRetries,
      waitTimeMs,
      onNumberRented,
      jobId,
    });
    return result;
  }

  /**
   * Tenta obter código SMS para um país específico.
   * Extrai toda a lógica de blacklist/cooldown/health/auto-discover do v3.0.
   */
  private async _getCodeForCountry(opts: {
    countryConfig: CountryConfig;
    service: string;
    maxRetries: number;
    waitTimeMs: number;
    onNumberRented: RetryOptions["onNumberRented"];
    jobId?: number;
  }): Promise<RetryResult> {
    const { countryConfig, service, maxRetries, waitTimeMs, onNumberRented, jobId } = opts;
    const { countryCode, regionCode, maxPrice, name } = countryConfig;
    const configSnapshot = this.config!;

    // 1. Montar lista base de provedores para este país
    let configuredProviders = countryConfig.providerIds.length > 0
      ? [...countryConfig.providerIds]
      : [...configSnapshot.providerIds];

    // 2. Filtrar blacklistados
    const blacklist = await this.getBlacklist();
    if (blacklist.length > 0) {
      const before = configuredProviders.length;
      configuredProviders = configuredProviders.filter(id => !blacklist.includes(id));
      if (configuredProviders.length < before) {
        await logger.info("sms",
          `[${name}] Blacklist: ${before - configuredProviders.length} provedor(es) excluído(s). Restam: [${configuredProviders.join(", ")}]`,
          {}, jobId
        );
      }
    }

    // 3. Ranquear provedores DISPONÍVEIS (sem cooldown) com embaralhamento por job.
    // O melhor provedor fica na frente; os demais são embaralhados aleatoriamente
    // para que jobs concorrentes não tentem os mesmos provedores na mesma ordem.
    const rankedProviders = this.providerHealth.shuffleForJob(configuredProviders);
    const cooldownCount = configuredProviders.length - rankedProviders.length;

    if (cooldownCount > 0) {
      await logger.info("sms",
        `[${name}] ${cooldownCount} provedor(es) em cooldown ignorado(s)`,
        {}, jobId
      );
    }

    const providerQueue = [...rankedProviders];
    const effectiveMaxRetries = Math.max(maxRetries, providerQueue.length);

    await logger.info("sms",
      `[${name}] Fila: [${providerQueue.join(", ")}] (${providerQueue.length} disponíveis, ${cooldownCount} em cooldown). Max: ${effectiveMaxRetries}`,
      {}, jobId
    );

    if (providerQueue.length === 0) {
      await logger.warn("sms",
        `[${name}] Nenhum provedor disponível. Tentando Auto-Discover...`,
        {}, jobId
      );
      try {
        const discovered = await this.discoverProviders(countryCode, service, maxPrice, true);
        const newProviders = discovered.filter(id => !blacklist.includes(id));
        if (newProviders.length > 0) {
          providerQueue.push(...newProviders);
          await logger.info("sms",
            `[${name}] Auto-Discover emergencial: ${newProviders.length} provedores: [${newProviders.join(", ")}]`,
            {}, jobId
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await logger.warn("sms", `[${name}] Auto-Discover emergencial falhou: ${msg}`, {}, jobId);
      }

      if (providerQueue.length === 0) {
        throw new Error(`[${name}] Nenhum provedor disponível (todos em cooldown ou blacklist)`);
      }
    }

    let totalCost = 0;
    let lastError: Error | null = null;
    let attempt = 0;
    let usedFallbackDiscover = false;
    let consecutiveProxyErrors = 0;
    // Após 3 erros de proxy consecutivos, algo estrutural está errado (sem proxies disponíveis, etc.)
    const MAX_CONSECUTIVE_PROXY_ERRORS = 3;

    for (let queueIndex = 0; queueIndex < providerQueue.length && attempt < effectiveMaxRetries; queueIndex++) {
      attempt++;
      const currentProviderId = providerQueue[queueIndex];

      await logger.info("sms",
        `[${name}] === Tentativa ${attempt}/${effectiveMaxRetries} — Provedor #${currentProviderId} ===`,
        {}, jobId
      );

      const result = await this._tryProvider(currentProviderId, {
        country: countryCode,
        service,
        maxPrice,
        waitTimeMs,
        onNumberRented,
        jobId,
        attempt,
        regionCode,
      });

      this.schedulePersistHealth();

      if (result.success) {
        totalCost += result.cost;

        // Auto-adiciona à lista do país se veio do Auto-Discover
        const currentList = countryConfig.providerIds;
        if (!currentList.includes(currentProviderId)) {
          countryConfig.providerIds.push(currentProviderId);
          // Persiste no banco se for multi-país
          if (configSnapshot.countries.length > 0) {
            const updatedCountries = configSnapshot.countries.map(c =>
              c.countryCode === countryCode ? { ...c, providerIds: countryConfig.providerIds } : c
            );
            await setSetting("sms_countries", JSON.stringify(updatedCountries));
          } else {
            // Legado
            const savedList = ((await getSetting("sms_provider_ids")) || "")
              .split(",").map(id => parseInt(id.trim())).filter(id => !isNaN(id));
            if (!savedList.includes(currentProviderId)) {
              await setSetting("sms_provider_ids", [...savedList, currentProviderId].join(","));
            }
          }
          await logger.info("sms",
            `[${name}] Provedor #${currentProviderId} adicionado à lista do país`,
            {}, jobId
          );
        }

        return {
          code: result.code!,
          phoneNumber: result.phoneNumber!,
          activationId: result.activationId!,
          attempt,
          totalCost,
          regionCode,
        };
      }

      // Falhou — verifica blacklist (apenas se não foi erro de proxy)
      if (!result.wasProxyError) {
        const toBlacklist = this.providerHealth.getProvidersToBlacklist([currentProviderId]);
        if (toBlacklist.length > 0) {
          await this.addToBlacklist(toBlacklist, jobId);
        }
      }

      lastError = result.error || null;

      // Erro de proxy/rede: não consome slot de provedor, não penaliza o provedor.
      // O mesmo provedor será tentado novamente na próxima iteração (com proxy diferente).
      if (result.wasProxyError) {
        consecutiveProxyErrors++;
        if (consecutiveProxyErrors >= MAX_CONSECUTIVE_PROXY_ERRORS) {
          await logger.warn("sms",
            `[${name}] ${consecutiveProxyErrors} erros de proxy consecutivos. Problema estrutural de rede — abortando país.`,
            {}, jobId
          );
          throw new Error(`[${name}] Abortado após ${consecutiveProxyErrors} erros de proxy consecutivos`);
        }
        await logger.warn("sms",
          `[${name}] Erro de proxy na tentativa ${attempt} (provedor #${currentProviderId} não penalizado, proxy #${consecutiveProxyErrors}/${MAX_CONSECUTIVE_PROXY_ERRORS}). Retentando...`,
          {}, jobId
        );
        // Não avança o queueIndex — o mesmo provedor será tentado de novo
        // (mas o proxy já foi substituído automaticamente pelo ProxyService)
        queueIndex--;
        continue;
      }
      // Reset contador de erros de proxy quando há sucesso ou outro tipo de erro
      consecutiveProxyErrors = 0;

      // Fallback Auto-Discover quando todos da lista falharam
      if (
        queueIndex === providerQueue.length - 1 &&
        attempt < effectiveMaxRetries &&
        !usedFallbackDiscover &&
        !configSnapshot.autoDiscover
      ) {
        usedFallbackDiscover = true;
        await logger.info("sms",
          `[${name}] Todos os ${providerQueue.length} provedores falharam. Tentando Auto-Discover...`,
          {}, jobId
        );
        try {
          const discovered = await this.discoverProviders(countryCode, service, maxPrice, true);
          const newProviders = discovered.filter(id => !providerQueue.includes(id) && !blacklist.includes(id));
          if (newProviders.length > 0) {
            await logger.info("sms",
              `[${name}] Auto-Discover (fallback): ${newProviders.length} novos provedores: [${newProviders.join(", ")}]`,
              {}, jobId
            );
            providerQueue.push(...newProviders);
          } else {
            await logger.warn("sms",
              `[${name}] Auto-Discover (fallback): nenhum provedor novo encontrado`,
              {}, jobId
            );
          }
        } catch (discoverErr) {
          const msg = discoverErr instanceof Error ? discoverErr.message : String(discoverErr);
          await logger.warn("sms", `[${name}] Auto-Discover (fallback) falhou: ${msg}`, {}, jobId);
        }
      }

      // Delay entre tentativas
      if (attempt < effectiveMaxRetries && queueIndex < providerQueue.length - 1) {
        const delay = configSnapshot.retryDelayMin + Math.random() * (configSnapshot.retryDelayMax - configSnapshot.retryDelayMin);
        await sleep(delay);
      }
    }

    const healthSummary = this.providerHealth.getSummary();
    await logger.error("sms",
      `[${name}] SMS não recebido após ${attempt} tentativas. Health: ${JSON.stringify(healthSummary)}`,
      {}, jobId
    );

    throw new Error(`[${name}] SMS não recebido após ${attempt} tentativas. Último erro: ${lastError?.message || "timeout"}`);
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
      regionCode?: string;
    }
  ): Promise<{
    success: boolean;
    code?: string;
    phoneNumber?: string;
    activationId?: string;
    cost: number;
    error?: Error;
    wasTargetRejection?: boolean;
    wasProxyError?: boolean;
  }> {
    let numberData: NumberData | null = null;
    const startTime = Date.now();

    try {
      // Tenta alugar um número de qualidade (que não foi rejeitado recentemente)
      let attempts = 0;
      const MAX_RENT_ATTEMPTS = 5;
      
      while (attempts < MAX_RENT_ATTEMPTS) {
        numberData = await this.getNumber({
          country: opts.country,
          service: opts.service,
          maxPrice: opts.maxPrice,
          providerIds: [providerId],
          jobId: opts.jobId,
        });
        
        // Verifica se o número já foi rejeitado antes
        if (this.numberQuality.isNumberRejected(numberData.phoneNumber)) {
          await logger.warn("sms", `Número ${numberData.phoneNumber} já foi rejeitado anteriormente. Cancelando e tentando outro...`, {}, opts.jobId);
          this.enqueueCancelAsync(numberData.activationId, numberData.rentedAt, opts.jobId);
          attempts++;
          continue;
        }
        
        // Número é bom, sai do loop
        break;
      }
      
      if (attempts >= MAX_RENT_ATTEMPTS || !numberData) {
        throw new Error(`Não foi possível alugar um número não-rejeitado após ${MAX_RENT_ATTEMPTS} tentativas`);
      }

      const cost = parseFloat(numberData.activationCost || opts.maxPrice);

      if (opts.onNumberRented) {
        await opts.onNumberRented({
          phoneNumber: numberData.phoneNumber,
          activationId: numberData.activationId,
          attempt: opts.attempt,
          regionCode: opts.regionCode || "+62",
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

      // Detecta se é rejeição pelo alvo (Manus)
      const isTargetApiError =
        error.message.includes("RPC ") ||
        error.message.includes("permission_denied") ||
        error.message.includes("invalid_argument") ||
        error.message.includes("Failed to send the code") ||
        error.message.includes("resource_exhausted");

      // Detecta erro de proxy/rede (curl code 28 = timeout, code 56 = recv error)
      // Esses erros NÃO são falha do provedor de SMS — o provedor nem chegou a ser testado.
      const isProxyNetworkError =
        error.message.includes("Transfer failed with code 28") ||
        error.message.includes("Transfer failed with code 56") ||
        error.message.includes("Transfer failed with code 7") ||
        error.message.includes("CURLE_") ||
        error.message.includes("ECONNRESET") ||
        error.message.includes("ECONNREFUSED") ||
        error.message.includes("ETIMEDOUT");

      if (numberData) {
        if (isTargetApiError || isProxyNetworkError) {
          // Se foi rejeição pelo alvo, registra a qualidade ruim do número
          if (isTargetApiError) {
            this.numberQuality.recordRejection(numberData.phoneNumber, providerId);
          }
          
          // Rejeição pelo alvo ou erro de proxy: enfileira cancelamento assíncrono.
          // O job continua imediatamente tentando o próximo provedor.
          this.enqueueCancelAsync(numberData.activationId, numberData.rentedAt, opts.jobId);
          await logger.info("sms",
            `Número ${numberData.activationId} enfileirado para cancelamento em background (job continua imediatamente)`,
            {}, opts.jobId
          );
        } else {
          // Falha do provedor SMS (timeout, erro de rede, etc.): cancela de forma síncrona
          // pois o job já esperou o waitForCode e não há pressa em continuar.
          try {
            await this.cancel(numberData.activationId, numberData.rentedAt, opts.jobId);
          } catch {
            // Ignore cancel errors
          }
        }
      }

      if (isProxyNetworkError) {
        // Erro de proxy/rede: NÃO penaliza o provedor de SMS.
        // O provedor não teve chance de funcionar — o problema foi no proxy.
        await logger.warn("sms",
          `Provedor #${providerId}: erro de proxy/rede (não penaliza provedor): ${error.message}`,
          {}, opts.jobId
        );
        return { success: false, cost: 0, error, wasProxyError: true };
      } else if (isTargetApiError) {
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
      // Respeita o cancelWaitMs completo (padrão: 125s) para garantir devolução do saldo.
      // A API SMSBower só aceita cancelamento e devolve saldo após 2 minutos do aluguel.
      const minCancelWait = this.config.cancelWaitMs;
      if (elapsed < minCancelWait) {
        const waitTime = minCancelWait - elapsed;
        await logger.info("sms",
          `Aguardando ${Math.ceil(waitTime / 1000)}s antes de cancelar (${Math.round(elapsed / 1000)}s já decorridos, mínimo: ${Math.round(minCancelWait / 1000)}s)`,
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
