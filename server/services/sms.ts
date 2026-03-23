/**
 * SmsService - SMSBower Integration (v3.2 — Multi-Country Priority Fix)
 *
 * v9.6 Fix:
 *   - Multi-país (sms_countries) agora tem PRIORIDADE sobre sms_provider_ids legado.
 *   - Antes, sms_provider_ids no banco (mesmo vindo do autoSeed ou de outro branch)
 *     forçava modo legado, ignorando a configuração multi-país.
 *   - Agora: se sms_countries tem países habilitados, usa multi-país.
 *   - sms_provider_ids legado só é usado quando sms_countries está vazio.
 *   - discoverAndUpdateProviderList não sobrescreve mais sms_provider_ids
 *     quando multi-país está configurado.
 *
 * Melhorias v3.1:
 *   - Suporte a múltiplos países: cada país tem seu próprio countryCode (SMSBower),
 *     regionCode (ex: +55), maxPrice, providerIds e enabled.
 *   - Setting sms_countries: JSON array com a configuração de cada país.
 *   - O sistema tenta os países habilitados em ordem, rotacionando quando um falha.
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
 *   sms_countries (PRIORIDADE — JSON array de CountryConfig)
 *   Legado (fallback): sms_country, sms_max_price, sms_provider_ids
 */

import { getSetting, setSetting, clearSettingsCache } from "../utils/settings";
import { sleep, logger, checkAbort } from "../utils/helpers";
import { smsPoolProvider } from "./smspool";
import type { SMSPoolConfig } from "./smspool";

const SMSBOWER_API = "https://smsbower.app/stubs/handler_api.php";

const DEFAULTS: Record<string, string> = {
  sms_country: "6",
  sms_service: "ot",
  sms_max_price: "0.01",
  // v9.4: Changed from hardcoded list to empty string.
  // The old default "2295,3291,..." was forcing legacy mode even when
  // multi-country (sms_countries) was configured, because legacyHasProviders
  // was always true. Now multi-country activates correctly when the user
  // hasn't explicitly set sms_provider_ids in the database.
  sms_provider_ids: "",
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
  // SMSPool settings (segunda API de SMS — aditiva, não substitui SMSBower)
  smspool_enabled: "false",
  smspool_api_key: "",
  smspool_service_id: "",
  smspool_country_id: "",
  smspool_max_price: "0.50",
  smspool_pool: "",
  smspool_priority: "secondary",
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
  "46": { regionCode: "+46", name: "Sweden" },
  "48": { regionCode: "+31", name: "Netherlands" },
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
  /** AbortSignal for cooperative cancellation */
  signal?: AbortSignal;
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
    
    reset(): void {
      this.rejectionCache.clear();
    }

    // Serialização para persistência
    serialize(): Record<string, any> {
      const now = Date.now();
      const data: Record<string, any> = {};
      
      for (const [number, info] of Array.from(this.rejectionCache.entries())) {
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

  // Cooldown progressivo para target rejections (números ruins do provedor):
  // Moderado: 60s, 120s, 300s — o provedor volta rápido para ser retestado
  // Se continuar falhando, o cooldown escala progressivamente
  private static TARGET_REJECTION_COOLDOWN_STEPS = [60_000, 120_000, 300_000];

  // Threshold para blacklist automática
  private static BLACKLIST_CONSECUTIVE_FAILURES = 8;
  private static BLACKLIST_MIN_ATTEMPTS = 5;
  private static BLACKLIST_MAX_SUCCESS_RATE = 0.15; // < 15% de sucesso

  // Threshold para cooldown por target rejection:
  // Após 3 rejeições consecutivas, o provedor está claramente com números ruins.
  // Colocar em cooldown para focar nos provedores que estão performando.
  private static TARGET_REJECTION_CONSECUTIVE_THRESHOLD = 3;

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
   * Registra rejeição pelo alvo ("Failed to send the code" do Manus).
   * Indica que o número fornecido pelo provedor é ruim (reciclado, VoIP, bloqueado).
   * 
   * v9.7.2: Aplica cooldown MODERADO após 3 rejeições consecutivas.
   * O provedor está claramente com números ruins neste momento — melhor
   * focar nos provedores que estão performando e retestá-lo depois.
   * 
   * Cooldown progressivo: 60s → 120s → 300s (máx 5min)
   * Muito mais leve que o cooldown de falha de SMS (60s → 600s).
   * O provedor volta rápido para ser retestado.
   */
  recordTargetRejection(providerId: number): void {
    const h = this.getOrCreate(providerId);
    h.targetRejections++;
    h.consecutiveTargetRejections++;
    
    // Aplica cooldown após threshold de rejeições consecutivas
    if (h.consecutiveTargetRejections >= ProviderHealthTracker.TARGET_REJECTION_CONSECUTIVE_THRESHOLD) {
      // Calcula o step baseado em quantas vezes já entrou em cooldown por rejeição
      // (consecutiveTargetRejections - threshold) dá quantos cooldowns extras
      const cooldownIndex = Math.min(
        h.consecutiveTargetRejections - ProviderHealthTracker.TARGET_REJECTION_CONSECUTIVE_THRESHOLD,
        ProviderHealthTracker.TARGET_REJECTION_COOLDOWN_STEPS.length - 1
      );
      h.cooldownUntil = Date.now() + ProviderHealthTracker.TARGET_REJECTION_COOLDOWN_STEPS[cooldownIndex];
    }
  }

  /**
   * Retorna info rápida de um provedor para logging.
   */
  getProviderInfo(providerId: number): { consecutiveTargetRejections: number; inCooldown: boolean; cooldownRemainingS: number } {
    const h = this.health.get(providerId);
    if (!h) return { consecutiveTargetRejections: 0, inCooldown: false, cooldownRemainingS: 0 };
    const now = Date.now();
    return {
      consecutiveTargetRejections: h.consecutiveTargetRejections,
      inCooldown: now < h.cooldownUntil,
      cooldownRemainingS: Math.max(0, Math.round((h.cooldownUntil - now) / 1000)),
    };
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
   * v9.7.2: Peso maior para target rejections e penalidade por rejeições consecutivas.
   * 
   * Componentes:
   *   - Taxa de sucesso SMS (40%): sucesso / (sucesso + falhas)
   *   - Velocidade (15%): tempo médio de resposta
   *   - Recência (15%): sucesso nos últimos 10min
   *   - Penalidade rejeição (-30% máx): taxa de rejeição pelo alvo
   *   - Penalidade consecutiva (-30% máx): rejeições consecutivas recentes
   */
  getScore(providerId: number): number {
    const h = this.health.get(providerId);
    if (!h || (h.successes + h.failures + h.targetRejections) === 0) return 50;

    const total = h.successes + h.failures;
    const successRate = total > 0 ? h.successes / total : 0; // 0.0 - 1.0
    const avgResponseTime = h.successes > 0 ? h.totalResponseTimeMs / h.successes : 120_000;

    // Score de velocidade: 0-1 (120s+ = 0, 10s = 1)
    const speedScore = Math.max(0, Math.min(1, (120_000 - avgResponseTime) / 110_000));

    // Score de recência: 0 ou 1 (sucesso nos últimos 10min = 1)
    const recencyScore = h.lastSuccessAt > 0 && (Date.now() - h.lastSuccessAt) < 600_000 ? 1 : 0;

    // Penalidade por target rejections (taxa global): 0.0 - 1.0
    const totalAttempts = total + h.targetRejections;
    const targetRejectionRate = totalAttempts > 0 ? h.targetRejections / totalAttempts : 0;

    // Penalidade por rejeições CONSECUTIVAS recentes: 0.0 - 1.0
    // Provedores com muitas rejeições seguidas são fortemente penalizados
    // 3 consecutivas = 0.3, 5 = 0.5, 10+ = 1.0
    const consecutivePenalty = Math.min(1, h.consecutiveTargetRejections / 10);

    // Pesos: sucesso=40%, velocidade=15%, recência=15%
    // Penalidades: rejeição global=-30% máx, consecutiva=-30% máx
    const raw = (successRate * 0.40) + (speedScore * 0.15) + (recencyScore * 0.15)
      - (targetRejectionRate * 0.30)
      - (consecutivePenalty * 0.30);
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
        // v9.5.2: Reset consecutive counters on restore to prevent auto-blacklist
        // from historical data. Providers start fresh after restart but keep
        // cumulative stats (successes, failures) for score calculation.
        consecutiveFailures: 0,
        targetRejections: h.targetRejections || 0,
        consecutiveTargetRejections: 0,
        totalResponseTimeMs: h.totalResponseTimeMs || 0,
        lastFailureAt: h.lastFailureAt || 0,
        lastSuccessAt: h.lastSuccessAt || 0,
        cooldownUntil: 0, // Also clear cooldowns on restart
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
   * v9.5: Timestamp do último reset de blacklist.
   * Usado para impedir que jobs em execução re-blacklistem provedores
   * com base em falhas que ocorreram ANTES do reset.
   */
  private blacklistResetAt = 0;
  private static BLACKLIST_COOLDOWN_AFTER_RESET_MS = 120_000; // 2 minutos

  /**
   * Conjunto de IDs sendo cancelados (para deduplicação).
   */
  private cancellingIds = new Set<string>();

  /**
   * v9.7.3: Cancelamento imediato fire-and-forget.
   * Tenta cancelar NA HORA. Se a API recusar (número alugado há pouco tempo),
   * faz retry a cada 15s até conseguir (máx 5 tentativas).
   * 
   * Não bloqueia o job — roda em background como Promise independente.
   * Cada cancelamento é uma Promise isolada, não depende de fila central.
   */
  cancelFireAndForget(activationId: string, rentedAt: number, jobId?: number): void {
    // Deduplicação
    if (this.cancellingIds.has(activationId)) return;
    this.cancellingIds.add(activationId);

    // Dispara em background
    this._doCancelWithRetry(activationId, rentedAt, jobId).catch(() => {}).finally(() => {
      this.cancellingIds.delete(activationId);
    });
  }

  /**
   * Tenta cancelar imediatamente, com retry rápido se a API recusar.
   */
  private async _doCancelWithRetry(activationId: string, rentedAt: number, jobId?: number): Promise<void> {
    const MAX_ATTEMPTS = 5;
    const RETRY_INTERVAL = 15_000; // 15s entre tentativas

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        // SMSPool: cancelamento direto (sem tempo mínimo)
        if (activationId.startsWith("smspool:")) {
          const orderId = activationId.replace("smspool:", "");
          const success = await smsPoolProvider.cancelSMS(orderId, jobId);
          if (success) {
            await logger.info("sms", `Número ${activationId} cancelado imediatamente — saldo devolvido`, {}, jobId);
          } else {
            await logger.warn("sms", `[SMSPool] Cancelamento ${orderId} retornou falha (tentativa ${attempt})`, {}, jobId);
          }
          return; // SMSPool não tem restrição de tempo mínimo
        }

        // SMSBower: tenta cancelar direto
        const result = await this.setStatus(activationId, 8);

        if (result === "ACCESS_CANCEL") {
          await logger.info("sms", `Número ${activationId} cancelado imediatamente — saldo devolvido`, {}, jobId);
          return;
        } else if (result === "ALREADY_FINISH" || result === "NO_ACTIVATION") {
          await logger.info("sms", `Cancelamento ${activationId}: ${result} (já finalizado)`, {}, jobId);
          return;
        } else {
          // API recusou ou resposta inesperada — retry
          if (attempt < MAX_ATTEMPTS) {
            const elapsed = Math.round((Date.now() - rentedAt) / 1000);
            await logger.info("sms",
              `Cancelamento ${activationId} resposta: ${result} (${elapsed}s desde aluguel). Retry em ${RETRY_INTERVAL / 1000}s... (${attempt}/${MAX_ATTEMPTS})`,
              {}, jobId
            );
            await sleep(RETRY_INTERVAL);
          }
        }
      } catch (err) {
        // Erro de rede/API — tenta de novo
        if (attempt < MAX_ATTEMPTS) {
          await logger.warn("sms",
            `Erro ao cancelar ${activationId}: ${err instanceof Error ? err.message : String(err)}. Retry em ${RETRY_INTERVAL / 1000}s... (${attempt}/${MAX_ATTEMPTS})`,
            {}, jobId
          );
          await sleep(RETRY_INTERVAL);
        }
      }
    }

    // Esgotou tentativas
    await logger.error("sms",
      `FALHA ao cancelar ${activationId} após ${MAX_ATTEMPTS} tentativas. Saldo pode ter sido perdido!`,
      {}, jobId
    );
  }

  /** Retorna quantos cancelamentos estão em andamento */
  getPendingCancellations(): number {
    return this.cancellingIds.size;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    this.apiKey = (await getSetting("smsbower_api_key")) || "";
    await this.loadConfig();
    await this.restoreHealth();
    await this.loadSmsPoolConfig();
  }

  /**
   * Carrega a configuração do SMSPool a partir das settings do banco.
   * Chamado no init() e no reloadConfig().
   */
  private async loadSmsPoolConfig(): Promise<void> {
    const get = async (key: string): Promise<string> => {
      try {
        return (await getSetting(key)) || DEFAULTS[key] || "";
      } catch {
        return DEFAULTS[key] || "";
      }
    };

    const enabled = (await get("smspool_enabled")) === "true";
    const apiKey = await get("smspool_api_key");
    const serviceId = await get("smspool_service_id");
    const countryId = await get("smspool_country_id");
    const maxPrice = await get("smspool_max_price");
    const pool = await get("smspool_pool");
    const priority = (await get("smspool_priority")) as "primary" | "secondary";

    smsPoolProvider.configure({
      apiKey,
      enabled,
      serviceId,
      countryId,
      maxPrice,
      pool,
      priority: priority === "primary" ? "primary" : "secondary",
    });

    if (enabled && apiKey) {
      await logger.info("sms",
        `SMSPool habilitado: prioridade=${priority}, maxPrice=$${maxPrice}, ` +
        `serviceId=${serviceId || "auto"}, countryId=${countryId || "auto"}, pool=${pool || "auto"}`
      );
    } else {
      console.log("[SmsService] SMSPool desabilitado ou sem API key");
    }
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
        console.log("[SmsService] Países carregados do banco:", countries);
      } catch (err) {
        console.warn("[SmsService] sms_countries JSON inválido, ignorando:", err, "Raw:", countriesRaw);
      }
    } else {
      console.log("[SmsService] Nenhum país configurado no banco (sms_countries vazio ou não existe)");
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
    await this.loadSmsPoolConfig();
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
    const json = JSON.stringify(countries);
    await logger.info("sms", `Salvando ${countries.length} país(es): ${json}`, {}, undefined);
    await setSetting("sms_countries", json, "Configuração multi-país para SMS");
    await this.reloadConfig();
    await logger.info("sms", `Países salvos e config recarregada`, {}, undefined);
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
    // v9.5: Cancel any pending persist timer to prevent stale data from being written back
    if (this.healthPersistTimer) {
      clearTimeout(this.healthPersistTimer);
      this.healthPersistTimer = null;
    }

    // Clear blacklist in DB
    await setSetting("sms_blacklisted_providers", "", "Provedores banidos permanentemente por performance ruim");
    
    // Reset all in-memory trackers
    this.providerHealth.reset();
    this.numberQuality.reset();
    
    // Clear persisted health/quality in DB
    await setSetting("sms_provider_health", "{}");
    await setSetting("sms_number_quality", "{}");

    // v9.5: Set cooldown to prevent running jobs from re-blacklisting immediately
    this.blacklistResetAt = Date.now();

    // v9.5.2: Force-clear the settings cache so subsequent reads get fresh DB values
    clearSettingsCache();

    // v9.5.2: Verify the clear actually worked
    const verify = await getSetting("sms_blacklisted_providers");
    console.log(`[SmsService] clearBlacklist verify: sms_blacklisted_providers = "${verify || ""}"`);
    if (verify && verify.trim() !== "") {
      console.error(`[SmsService] ERRO: Blacklist não foi limpa! Valor no banco: "${verify}". Tentando novamente...`);
      await setSetting("sms_blacklisted_providers", "");
      clearSettingsCache();
    }

    console.log("[SmsService] Blacklist, health e quality resetados (cooldown de 2min para re-blacklist)");
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
      // v9.6: Só atualiza sms_provider_ids (legado) se NÃO houver multi-país configurado.
      // Quando multi-país está ativo, os providerIds são gerenciados por país
      // dentro de sms_countries, não pela setting legada.
      const hasMultiCountry = this.config!.countries.filter(c => c.enabled).length > 0;
      if (!hasMultiCountry && (!countryCodeOverride || countryCodeOverride === this.config!.country)) {
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
   * getCodeWithRetry v3.3 — Multi-Country + Smart Provider Management + SMSPool
   *
   * Estratégia (v9.7):
   *   1. Se SMSPool está habilitado com priority="primary", tenta SMSPool PRIMEIRO.
   *   2. Se sms_countries configurado com países habilitados: usa MULTI-PAÍS (SMSBower).
   *   3. Dentro de cada país: mesma lógica v3.0 (blacklist, cooldown, health).
   *   4. Se SMSBower falha e SMSPool está habilitado com priority="secondary", tenta SMSPool.
   *   5. RetryResult inclui regionCode para o provider usar no sendPhoneVerificationCode.
   *   6. Compatibilidade retroativa: se SMSPool desabilitado, comportamento idêntico ao v3.2.
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
    const signal = options.signal;
    const service = options.service || configSnapshot.service;

    // ============================================================
    // v9.7: SMSPool como API adicional (soma à pool, não substitui)
    // Se habilitado com priority="primary", tenta SMSPool ANTES do SMSBower.
    // Se habilitado com priority="secondary", tenta SMSPool DEPOIS do SMSBower.
    // Se desabilitado, comportamento idêntico ao v3.2.
    // ============================================================
    const smsPoolEnabled = smsPoolProvider.isEnabled();
    const smsPoolPriority = smsPoolProvider.getPriority();

    if (smsPoolEnabled) {
      await logger.info("sms",
        `SMSPool ativo (prioridade: ${smsPoolPriority}). Somando à pool de SMS.`,
        {}, jobId
      );
    }

    // --- SMSPool PRIMARY: tenta SMSPool primeiro ---
    if (smsPoolEnabled && smsPoolPriority === "primary") {
      try {
        checkAbort(signal);
        const smsPoolResult = await this._trySmsPool({
          configSnapshot,
          service,
          waitTimeMs,
          onNumberRented,
          jobId,
          signal,
        });
        if (smsPoolResult) return smsPoolResult;
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") throw err;
        // Erros fatais (account banned, etc.) — re-throw
        if (err instanceof Error && (
          err.message.includes("user is blocked") ||
          err.message.includes("USER_IS_BLOCKED") ||
          err.name === "AccountBannedError"
        )) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        await logger.warn("sms",
          `SMSPool (primary) falhou: ${msg}. Continuando com SMSBower...`,
          {}, jobId
        );
      }
    }

    // Determina a lista de países a tentar
    // v9.6: Multi-país tem PRIORIDADE quando sms_countries está configurado.
    // Antes, sms_provider_ids (legado) no banco forçava modo legado mesmo com
    // multi-país configurado. Agora: se sms_countries tem países habilitados,
    // usa multi-país (cada país já tem seus próprios providerIds).
    // O legado só é usado quando sms_countries está vazio/não configurado.
    const enabledCountries = configSnapshot.countries.filter(c => c.enabled);
    const legacyHasProviders = configSnapshot.providerIds.length > 0;
    const useMultiCountry = enabledCountries.length > 0 && !options.country && !options.providerIds;

    // v9.7: Diagnostic log for mode decision
    await logger.info("sms",
      `Decisão de modo: enabledCountries=${enabledCountries.length}, legacyProviders=${configSnapshot.providerIds.length}, ` +
      `optionsCountry=${!!options.country}, optionsProviders=${!!options.providerIds}, ` +
      `smsPool=${smsPoolEnabled ? smsPoolPriority : "off"} => ${useMultiCountry ? "MULTI-PAÍS" : "LEGADO"}`,
      {}, jobId
    );

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
          checkAbort(signal);
          const result = await this._getCodeForCountry({
            countryConfig,
            service,
            maxRetries,
            waitTimeMs,
            onNumberRented,
            jobId,
            signal,
          });
          return result;
        } catch (err) {
          // Re-throw AbortError immediately — don't try next country
          if (err instanceof DOMException && err.name === "AbortError") throw err;

          // v9.7.1: Re-throw ACCOUNT BANNED immediately — don't waste numbers on other countries.
          // When the account is blocked by Manus anti-bot, no SMS number from ANY country will work.
          // Continuing to try other countries only wastes money (renting numbers that can't be used).
          if (err instanceof Error && (
            err.message.includes("user is blocked") ||
            err.message.includes("USER_IS_BLOCKED") ||
            err.name === "AccountBannedError"
          )) {
            await logger.warn("sms",
              `País ${countryConfig.name}: conta banida pelo Manus. Abortando TODOS os países (não é problema do SMS).`,
              {}, jobId
            );
            throw err;
          }

          lastCountryError = err instanceof Error ? err : new Error(String(err));

          // v10.1: Circuit breaker de saldo — se o SMSBower reportar saldo insuficiente,
          // não adianta tentar outros países (todos usam a mesma conta SMSBower).
          // Propaga imediatamente para evitar tentativas desperdiçadas.
          if (
            lastCountryError.message.includes("Saldo insuficiente") ||
            lastCountryError.message.includes("NO_BALANCE") ||
            lastCountryError.message.includes("API key inválida") ||
            lastCountryError.message.includes("BAD_KEY")
          ) {
            await logger.error("sms",
              `CIRCUIT BREAKER: ${lastCountryError.message} — abortando todos os países (mesma conta SMSBower).`,
              {}, jobId
            );
            throw lastCountryError;
          }

          await logger.warn("sms",
            `País ${countryConfig.name} falhou completamente: ${lastCountryError.message}. Tentando próximo país...`,
            {}, jobId
          );
        }
      }

      // v9.7: SMSPool SECONDARY fallback — tenta SMSPool após todos os países SMSBower falharem
      if (smsPoolEnabled && smsPoolPriority === "secondary") {
        await logger.info("sms",
          `Todos os países SMSBower falharam. Tentando SMSPool (secondary fallback)...`,
          {}, jobId
        );
        try {
          const smsPoolResult = await this._trySmsPool({
            configSnapshot,
            service,
            waitTimeMs,
            onNumberRented,
            jobId,
            signal,
          });
          if (smsPoolResult) return smsPoolResult;
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") throw err;
          if (err instanceof Error && (
            err.message.includes("user is blocked") ||
            err.message.includes("USER_IS_BLOCKED") ||
            err.name === "AccountBannedError"
          )) throw err;
          const msg = err instanceof Error ? err.message : String(err);
          await logger.warn("sms",
            `SMSPool (secondary) também falhou: ${msg}`,
            {}, jobId
          );
        }
      }

      throw new Error(
        `SMS não recebido em nenhum dos ${enabledCountries.length} país(es) configurados` +
        `${smsPoolEnabled ? " + SMSPool" : ""}. ` +
        `Último erro: ${lastCountryError?.message || "timeout"}`
      );
    }

    // ============================================================
    // MODO LEGADO: um único país (usado quando sms_countries não está configurado)
    // ============================================================
    if (legacyHasProviders) {
      await logger.info("sms",
        `Modo legado: providers [${configSnapshot.providerIds.join(",")}] (sms_countries não configurado)`,
        {}, jobId
      );
    }
    const country = options.country || configSnapshot.country;
    const maxPrice = options.maxPrice || configSnapshot.maxPrice;
    const known = KNOWN_COUNTRIES[country];
    const regionCode = known?.regionCode || "+62";

    try {
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
        signal,
      });
      return result;
    } catch (err) {
      // Re-throw AbortError and fatal errors
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      if (err instanceof Error && (
        err.message.includes("user is blocked") ||
        err.message.includes("USER_IS_BLOCKED") ||
        err.name === "AccountBannedError"
      )) throw err;

      // v9.7: SMSPool SECONDARY fallback para modo legado
      if (smsPoolEnabled && smsPoolPriority === "secondary") {
        const legacyMsg = err instanceof Error ? err.message : String(err);
        await logger.warn("sms",
          `SMSBower (legado) falhou: ${legacyMsg}. Tentando SMSPool (secondary fallback)...`,
          {}, jobId
        );
        try {
          const smsPoolResult = await this._trySmsPool({
            configSnapshot,
            service,
            waitTimeMs,
            onNumberRented,
            jobId,
            signal,
          });
          if (smsPoolResult) return smsPoolResult;
        } catch (poolErr) {
          if (poolErr instanceof DOMException && poolErr.name === "AbortError") throw poolErr;
          if (poolErr instanceof Error && (
            poolErr.message.includes("user is blocked") ||
            poolErr.message.includes("USER_IS_BLOCKED") ||
            poolErr.name === "AccountBannedError"
          )) throw poolErr;
          const poolMsg = poolErr instanceof Error ? poolErr.message : String(poolErr);
          await logger.warn("sms",
            `SMSPool (secondary) também falhou: ${poolMsg}`,
            {}, jobId
          );
        }
      }

      // Re-throw o erro original do SMSBower
      throw err;
    }
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
    signal?: AbortSignal;
  }): Promise<RetryResult> {
    const { countryConfig, service, maxRetries, waitTimeMs, onNumberRented, jobId, signal } = opts;
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

    for (let queueIndex = 0; queueIndex < providerQueue.length && attempt < effectiveMaxRetries; queueIndex++) {
      checkAbort(signal);
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
        signal,
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
      // v9.5: Skip auto-blacklist during cooldown period after manual reset
      if (!result.wasProxyError) {
        const timeSinceReset = Date.now() - this.blacklistResetAt;
        if (timeSinceReset > SmsService.BLACKLIST_COOLDOWN_AFTER_RESET_MS) {
          const toBlacklist = this.providerHealth.getProvidersToBlacklist([currentProviderId]);
          if (toBlacklist.length > 0) {
            await this.addToBlacklist(toBlacklist, jobId);
          }
        }
      }

      lastError = result.error || null;

      // Erro de proxy/rede: não consome slot de provedor, não penaliza o provedor.
      // O mesmo provedor será tentado novamente na próxima iteração (com proxy diferente).
      if (result.wasProxyError) {
        consecutiveProxyErrors++;
        await logger.warn("sms",
          `[${name}] Erro de proxy na tentativa ${attempt} (provedor #${currentProviderId} não penalizado, proxy #${consecutiveProxyErrors}). Retentando com proxy diferente...`,
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
        await sleep(delay, signal);
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
      signal?: AbortSignal;
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
        
        // DISABLED: isNumberRejected check removed — recordRejection() is never called
        // in the current codebase, so the cache only contains stale data from DB persistence.
        // This caused valid numbers (with SMS already sent) to be wrongly cancelled.
        
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

      checkAbort(opts.signal);
      const code = await this.waitForCode(numberData.activationId, opts.waitTimeMs, opts.jobId, opts.signal);

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
      // Re-throw AbortError immediately — don't process as provider failure
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      const error = err instanceof Error ? err : new Error(String(err));

      // v9.3: Detect ACCOUNT BANNED — this is a FATAL error.
      // The account was suspended by Manus anti-bot. No SMS number will ever work.
      // Re-throw immediately so the job aborts without wasting more numbers.
      const isAccountBanned =
        error.message.includes("user is blocked") ||
        error.message.includes("USER_IS_BLOCKED") ||
        error.name === "AccountBannedError";

      if (isAccountBanned) {
        // Cancel the rented number in background (don't waste money)
        if (numberData) {
          this.cancelFireAndForget(numberData.activationId, numberData.rentedAt, opts.jobId);
        }
        // Re-throw as-is so the caller (manus/index.ts) handles it
        throw error;
      }

      // Detecta se é rejeição do NÚMERO pelo alvo (Manus) — conta está OK, número ruim
      // v9.7.1: Único erro conhecido de número rejeitado é "Failed to send the code".
      // Outros erros (se existirem) caem no genérico para investigação.
      const isNumberRejected =
        error.message.includes("Failed to send the code");

      // Detecta erro genérico de RPC (que não é ban nem rejeição de número)
      const isTargetApiError =
        error.message.includes("RPC ") ||
        error.message.includes("permission_denied") ||
        isNumberRejected;

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
          // Rejeição pelo alvo ou erro de proxy: cancela imediatamente em background.
          // O job continua imediatamente tentando o próximo provedor.
          this.cancelFireAndForget(numberData.activationId, numberData.rentedAt, opts.jobId);
          await logger.info("sms",
            `Número ${numberData.activationId} cancelamento disparado em background (job continua imediatamente)`,
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
      } else if (isNumberRejected) {
        // v9.7.2: NÚMERO REJEITADO — conta está OK, mas este número específico foi recusado.
        // Rastreia e aplica cooldown após 3 rejeições consecutivas.
        this.providerHealth.recordTargetRejection(providerId);
        const provInfo = this.providerHealth.getProviderInfo(providerId);
        
        if (provInfo.inCooldown) {
          await logger.warn("sms",
            `Provedor #${providerId}: [NÚMERO REJEITADO] ${provInfo.consecutiveTargetRejections}x consecutivas — COOLDOWN ${provInfo.cooldownRemainingS}s (números ruins, focando em outros provedores)`,
            {}, opts.jobId
          );
        } else {
          await logger.warn("sms",
            `Provedor #${providerId}: [NÚMERO REJEITADO] pelo Manus (conta OK, número ruim) [${provInfo.consecutiveTargetRejections}x consecutivas]: ${error.message}`,
            {}, opts.jobId
          );
        }
        return { success: false, cost: 0, error, wasTargetRejection: true };
      } else if (isTargetApiError) {
        // v9.3: Erro genérico de RPC do alvo (não é ban, não é rejeição de número).
        // Rastreia para monitoramento.
        this.providerHealth.recordTargetRejection(providerId);
        await logger.warn("sms",
          `Provedor #${providerId}: [ERRO RPC] do alvo (rastreado, não penalizado): ${error.message}`,
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
    // v9.7: Detecta se o activationId é do SMSPool (prefixo "smspool:")
    if (activationId.startsWith("smspool:")) {
      const orderId = activationId.replace("smspool:", "");
      await logger.info("sms", `[SMSPool] Completando pedido ${orderId}`, {}, jobId);
      // SMSPool não tem endpoint de "complete" — o SMS já foi recebido e o pedido é automaticamente finalizado.
      // Apenas logamos o sucesso.
      await logger.info("sms", `[SMSPool] Pedido ${orderId} completado (auto-finalizado pelo SMSPool)`, {}, jobId);
      return "SMSPOOL_COMPLETE";
    }

    await logger.info("sms", `Completando ativação ${activationId}`, {}, jobId);
    const result = await this.setStatus(activationId, 6);
    await logger.info("sms", `Ativação ${activationId} completada: ${result}`, {}, jobId);
    return result;
  }

  async cancel(activationId: string, rentedAt?: number, jobId?: number): Promise<string> {
    // v9.7: Detecta se o activationId é do SMSPool (prefixo "smspool:")
    if (activationId.startsWith("smspool:")) {
      const orderId = activationId.replace("smspool:", "");
      await logger.info("sms", `[SMSPool] Cancelando pedido ${orderId}`, {}, jobId);
      const success = await smsPoolProvider.cancelSMS(orderId, jobId);
      return success ? "SMSPOOL_CANCELLED" : "SMSPOOL_CANCEL_FAILED";
    }

    if (!this.config) await this.init();

    await logger.info("sms", `Cancelando número ${activationId} imediatamente...`, {}, jobId);

    const result = await this.setStatus(activationId, 8);
    if (result === "ACCESS_CANCEL") {
      await logger.info("sms", `Número ${activationId} cancelado — saldo devolvido`, {}, jobId);
    } else if (result === "ALREADY_FINISH" || result === "NO_ACTIVATION") {
      await logger.info("sms", `Cancelamento ${activationId}: ${result} (já finalizado)`, {}, jobId);
    } else {
      await logger.warn("sms", `Cancelamento ${activationId} retornou: ${result} (pode precisar de retry)`, { activationId }, jobId);
    }
    return result;
  }

  async waitForCode(activationId: string, timeoutMs?: number, jobId?: number, signal?: AbortSignal): Promise<string | null> {
    if (!this.config) await this.init();

    const timeout = timeoutMs || this.config!.waitTimeMs;
    const pollInterval = this.config!.pollIntervalMs;
    const progressLogInterval = 20_000;

    await logger.info("sms", `Aguardando SMS (ativação: ${activationId}, timeout: ${timeout / 1000}s)`, {}, jobId);

    const startTime = Date.now();
    let lastProgressLog = startTime;

    while (Date.now() - startTime < timeout) {
      checkAbort(signal);
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
        if (err instanceof DOMException && err.name === "AbortError") throw err;
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

      await sleep(pollInterval, signal);
    }

    await logger.warn("sms",
      `Timeout: SMS não recebido em ${timeout / 1000}s — cancelando número e tentando outro`,
      { activationId }, jobId
    );
    return null;
  }

  // ============================================================
  // v9.7: SMSPool — Método interno de tentativa
  // ============================================================

  /**
   * Tenta obter código SMS usando o SMSPool.
   * Retorna RetryResult se bem-sucedido, null se falhou (sem throw).
   * Throws apenas para erros fatais (AbortError, AccountBanned).
   *
   * v9.8: O regionCode agora é detectado automaticamente pelo SMSPool a partir
   * do número real comprado, em vez de usar o regionCode do SMSBower.
   * Isso corrige o bug onde números do Cazaquistão (+7) eram enviados com DDD do Brasil (+55).
   */
  private async _trySmsPool(opts: {
    configSnapshot: SmsConfig;
    service: string;
    waitTimeMs: number;
    onNumberRented: RetryOptions["onNumberRented"];
    jobId?: number;
    signal?: AbortSignal;
  }): Promise<RetryResult | null> {
    const { configSnapshot, service, waitTimeMs, onNumberRented, jobId, signal } = opts;
    const smsPoolConfig = smsPoolProvider.getConfig();

    // v9.8: O regionCode passado aqui é apenas um hint inicial.
    // O SMSPool detectará o regionCode REAL do número comprado e o usará
    // no callback onNumberRented (ver smspool.ts tryGetCode).
    const enabledCountries = configSnapshot.countries.filter(c => c.enabled);
    let hintRegionCode = "+62"; // default: Indonesia
    let countryCode = configSnapshot.country;

    if (enabledCountries.length > 0) {
      hintRegionCode = enabledCountries[0].regionCode;
      countryCode = enabledCountries[0].countryCode;
    } else {
      const known = KNOWN_COUNTRIES[configSnapshot.country];
      if (known) hintRegionCode = known.regionCode;
    }

    await logger.info("sms",
      `[SMSPool] Tentando obter código via SMSPool (país: ${countryCode}, regiãoHint: ${hintRegionCode}, serviço: ${service})`,
      {}, jobId
    );

    // v9.8: Captura o regionCode real que o SMSPool detectou do número comprado
    let detectedRegionCode = hintRegionCode;
    const wrappedOnNumberRented = onNumberRented
      ? async (data: { phoneNumber: string; activationId: string; attempt: number; regionCode: string }) => {
          // O regionCode aqui já foi corrigido pelo smspool.ts detectRegionCode()
          detectedRegionCode = data.regionCode;
          return onNumberRented(data);
        }
      : undefined;

    const result = await smsPoolProvider.tryGetCode({
      countryCode,
      service,
      maxPrice: smsPoolConfig.maxPrice,
      waitTimeMs,
      pollIntervalMs: configSnapshot.pollIntervalMs,
      regionCode: hintRegionCode,
      onNumberRented: wrappedOnNumberRented,
      jobId,
      attempt: 1,
      signal,
    });

    if (result.success && result.code && result.phoneNumber && result.activationId) {
      return {
        code: result.code,
        phoneNumber: result.phoneNumber,
        activationId: result.activationId, // Já vem com prefixo "smspool:"
        attempt: 1,
        totalCost: result.cost,
        regionCode: detectedRegionCode, // v9.8: Usa regionCode detectado do número real
      };
    }

    if (result.error) {
      await logger.warn("sms",
        `[SMSPool] Falhou: ${result.error.message}`,
        {}, jobId
      );
    }

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

  // ============================================================
  // v9.7: SMSPool — API pública para routers e UI
  // ============================================================

  /**
   * Retorna a configuração atual do SMSPool.
   * Usado pela UI de Settings para exibir e editar.
   */
  getSmsPoolConfig(): SMSPoolConfig {
    return smsPoolProvider.getConfig();
  }

  /**
   * Verifica se o SMSPool está habilitado.
   */
  isSmsPoolEnabled(): boolean {
    return smsPoolProvider.isEnabled();
  }

  /**
   * Consulta o saldo do SMSPool.
   */
  async getSmsPoolBalance(): Promise<number> {
    if (!smsPoolProvider.isEnabled()) {
      throw new Error("SMSPool não está habilitado");
    }
    return await smsPoolProvider.getBalance();
  }

  /**
   * Atualiza a configuração do SMSPool no banco e recarrega.
   */
  async updateSmsPoolConfig(config: Partial<SMSPoolConfig>): Promise<void> {
    if (config.enabled !== undefined) {
      await setSetting("smspool_enabled", config.enabled ? "true" : "false", "SMSPool: habilitado/desabilitado");
    }
    if (config.apiKey !== undefined) {
      await setSetting("smspool_api_key", config.apiKey, "SMSPool: API key");
    }
    if (config.serviceId !== undefined) {
      await setSetting("smspool_service_id", config.serviceId, "SMSPool: ID do serviço (vazio = auto)");
    }
    if (config.countryId !== undefined) {
      await setSetting("smspool_country_id", config.countryId, "SMSPool: ID do país (vazio = auto)");
    }
    if (config.maxPrice !== undefined) {
      await setSetting("smspool_max_price", config.maxPrice, "SMSPool: preço máximo por número");
    }
    if (config.pool !== undefined) {
      await setSetting("smspool_pool", config.pool, "SMSPool: pool preferida (vazio = auto)");
    }
    if (config.priority !== undefined) {
      await setSetting("smspool_priority", config.priority, "SMSPool: prioridade (primary/secondary)");
    }

    // Recarrega configuração
    await this.loadSmsPoolConfig();
  }
}

export const smsService = new SmsService();
