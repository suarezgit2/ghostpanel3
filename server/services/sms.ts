/**
 * SmsService - SMSBower Integration (v2.1 — Auto-Discover Fix)
 *
 * Sistema inteligente de SMS com:
 *   1. Rotação sequencial de provedores: cada tentativa usa o próximo provedor da lista
 *   2. Health tracking em memória: provedores que falham são penalizados com cooldown
 *   3. Auto-Discover: quando ativo, descobre provedores via getPricesV3 ANTES de tentar
 *      (substitui a lista manual). Quando inativo, usa a lista manual como fallback.
 *   4. Score dinâmico: provedores que entregam SMS rápido ganham prioridade
 *
 * Settings utilizados (todos com fallback padrão):
 *   smsbower_api_key, sms_country, sms_service, sms_max_price,
 *   sms_provider_ids, sms_max_retries, sms_wait_time, sms_poll_interval,
 *   sms_retry_delay_min, sms_retry_delay_max, sms_cancel_wait, sms_auto_discover
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
// PROVIDER HEALTH TRACKER
// ============================================================

interface ProviderHealth {
  providerId: number;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  totalResponseTimeMs: number;
  lastFailureAt: number;
  lastSuccessAt: number;
  cooldownUntil: number;
}

/**
 * ProviderHealthTracker - Rastreia a saúde de cada provedor SMS em memória.
 *
 * Funcionalidades:
 *   - Score dinâmico baseado em taxa de sucesso e velocidade de resposta
 *   - Cooldown progressivo: provedores com falhas consecutivas ficam em cooldown
 *   - Auto-recovery: cooldown expira e o provedor volta a ser elegível
 *   - Ranking: provedores são ordenados por score para priorização
 */
class ProviderHealthTracker {
  private health = new Map<number, ProviderHealth>();

  // Cooldown progressivo: 60s, 120s, 300s, 600s (máx 10min)
  private static COOLDOWN_STEPS = [60_000, 120_000, 300_000, 600_000];

  private getOrCreate(providerId: number): ProviderHealth {
    if (!this.health.has(providerId)) {
      this.health.set(providerId, {
        providerId,
        successes: 0,
        failures: 0,
        consecutiveFailures: 0,
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
    h.totalResponseTimeMs += responseTimeMs;
    h.lastSuccessAt = Date.now();
    h.cooldownUntil = 0; // Limpa cooldown ao ter sucesso
  }

  recordFailure(providerId: number): void {
    const h = this.getOrCreate(providerId);
    h.failures++;
    h.consecutiveFailures++;
    h.lastFailureAt = Date.now();

    // Cooldown progressivo baseado em falhas consecutivas
    const stepIndex = Math.min(h.consecutiveFailures - 1, ProviderHealthTracker.COOLDOWN_STEPS.length - 1);
    h.cooldownUntil = Date.now() + ProviderHealthTracker.COOLDOWN_STEPS[stepIndex];
  }

  isAvailable(providerId: number): boolean {
    const h = this.health.get(providerId);
    if (!h) return true; // Nunca usado = disponível
    return Date.now() >= h.cooldownUntil;
  }

  /**
   * Calcula um score de 0 a 100 para o provedor.
   * Fatores: taxa de sucesso (60%), velocidade média (20%), recência de sucesso (20%)
   */
  getScore(providerId: number): number {
    const h = this.health.get(providerId);
    if (!h || (h.successes + h.failures) === 0) return 50; // Score neutro para desconhecidos

    const total = h.successes + h.failures;
    const successRate = h.successes / total;
    const avgResponseTime = h.successes > 0 ? h.totalResponseTimeMs / h.successes : 120_000;

    // Score de velocidade: 0-100 (120s+ = 0, 10s = 100)
    const speedScore = Math.max(0, Math.min(100, (120_000 - avgResponseTime) / 1100));

    // Score de recência: bonus se teve sucesso recente (últimos 10min)
    const recencyScore = h.lastSuccessAt > 0 && (Date.now() - h.lastSuccessAt) < 600_000 ? 100 : 0;

    return (successRate * 60) + (speedScore * 0.2) + (recencyScore * 0.2);
  }

  /**
   * Ordena provedores por score (melhor primeiro), filtrando os que estão em cooldown.
   */
  rankProviders(providerIds: number[]): number[] {
    const now = Date.now();
    const available = providerIds.filter(id => {
      const h = this.health.get(id);
      return !h || now >= h.cooldownUntil;
    });

    return available.sort((a, b) => this.getScore(b) - this.getScore(a));
  }

  /**
   * Retorna um resumo legível do estado de todos os provedores.
   */
  getSummary(): Record<string, unknown>[] {
    const result: Record<string, unknown>[] = [];
    for (const [id, h] of this.health.entries()) {
      const total = h.successes + h.failures;
      result.push({
        providerId: id,
        successRate: total > 0 ? `${Math.round((h.successes / total) * 100)}%` : "N/A",
        successes: h.successes,
        failures: h.failures,
        consecutiveFailures: h.consecutiveFailures,
        avgResponseMs: h.successes > 0 ? Math.round(h.totalResponseTimeMs / h.successes) : null,
        inCooldown: Date.now() < h.cooldownUntil,
        cooldownRemainingS: Math.max(0, Math.round((h.cooldownUntil - Date.now()) / 1000)),
        score: Math.round(this.getScore(id)),
      });
    }
    return result.sort((a, b) => (b.score as number) - (a.score as number));
  }

  /**
   * Verifica se um provedor deve ser removido da lista por performance muito ruim.
   * Threshold: 5+ falhas consecutivas E taxa de sucesso < 20% com pelo menos 5 tentativas.
   */
  shouldRemove(providerId: number): boolean {
    const h = this.health.get(providerId);
    if (!h) return false;
    const total = h.successes + h.failures;
    if (total < 5) return false; // Dados insuficientes para decidir
    const successRate = h.successes / total;
    return h.consecutiveFailures >= 5 && successRate < 0.20;
  }

  /**
   * Retorna lista de provedores que devem ser removidos da lista configurada.
   */
  getProvidersToRemove(providerIds: number[]): number[] {
    return providerIds.filter(id => this.shouldRemove(id));
  }

  /**
   * Reseta o estado de saúde de todos os provedores.
   */
  reset(): void {
    this.health.clear();
  }
}

// ============================================================
// SMS SERVICE
// ============================================================

class SmsService {
  private apiKey = "";
  private config: SmsConfig | null = null;
  readonly providerHealth = new ProviderHealthTracker();

  async init(): Promise<void> {
    this.apiKey = (await getSetting("smsbower_api_key")) || "";
    await this.loadConfig();
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
    await this.loadConfig();
  }

  async getConfig(): Promise<SmsConfig> {
    if (!this.config) await this.init();
    return { ...this.config! };
  }

  async discoverProviders(country: string, service: string, maxPrice: string): Promise<number[]> {
    if (!this.apiKey) await this.init();

    const priceLimit = parseFloat(maxPrice);
    const data = await this.getProviders(country, service);

    // getPricesV3 response structure: { [country]: { [service]: { [providerId]: { price, count, provider_id } } } }
    // NOTE: The field is "price" (number), NOT "cost" (string) — this was the original bug.
    const providers: Array<{ id: number; cost: number; count: number }> = [];
    const countryData = data?.[country] as Record<string, Record<string, { price: number; cost?: string; count: number; provider_id?: number }>> | undefined;
    if (!countryData) {
      await logger.warn("sms", `Auto-Discover: país "${country}" não encontrado na resposta do getPricesV3`, {});
      return [];
    }

    const serviceData = countryData[service];
    if (!serviceData) {
      await logger.warn("sms", `Auto-Discover: serviço "${service}" não encontrado para o país "${country}" na resposta do getPricesV3`, {});
      return [];
    }

    for (const [providerId, info] of Object.entries(serviceData)) {
      // getPricesV3 uses "price" (number), getPricesV2 uses "cost" (string) — support both
      const cost = typeof info.price === "number" ? info.price : parseFloat(info.cost || "999");
      const count = typeof info.count === "number" ? info.count : (parseInt(String(info.count)) || 0);
      if (cost <= priceLimit && count > 0) {
        providers.push({ id: parseInt(providerId), cost, count });
      }
    }

    providers.sort((a, b) => a.cost - b.cost || b.count - a.count);
    return providers.map(p => p.id);
  }

  /**
   * Aluga um número de um provedor específico (ou da lista geral).
   * Agora aceita um providerId único para rotação inteligente.
   */
  async getNumber(overrides: GetNumberOverrides = {}): Promise<NumberData> {
    if (!this.apiKey) await this.init();
    if (!this.config) throw new Error("SMS config not loaded");

    const country = overrides.country || this.config.country;
    const service = overrides.service || this.config.service;
    const maxPrice = overrides.maxPrice || this.config.maxPrice;
    const jobId = overrides.jobId;

    const providerIds = overrides.providerIds || this.config.providerIds;

    await logger.info("sms", `Alugando número (país: ${country}, serviço: ${service}, maxPrice: $${maxPrice}, providers: [${providerIds.join(",")}])`, {}, jobId);

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
        await logger.info("sms", `Número alugado: +${result.phoneNumber} (ID: ${result.activationId}, custo: $${result.activationCost}, provider: ${providerIds.length === 1 ? providerIds[0] : "pool"})`, {}, jobId);
        return result;
      }
    } catch {
      // Not JSON — treat as error text
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
        await logger.info("sms", `Aguardando ${Math.ceil(waitTime / 1000)}s antes de cancelar (${Math.round(elapsed / 1000)}s já decorridos)`, {}, jobId);
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
        await logger.info("sms", `Aguardando SMS... ${elapsed}s/${timeout / 1000}s (restam ${remaining}s)`, { activationId }, jobId);
        lastProgressLog = now;
      }

      await sleep(pollInterval);
    }

    await logger.warn("sms", `Timeout: SMS não recebido em ${timeout / 1000}s — cancelando número e tentando outro`, { activationId }, jobId);
    return null;
  }

  /**
   * getCodeWithRetry v2.1 — Auto-Discover corrigido
   *
   * Estratégia:
   *   1. Se autoDiscover=true: descobre provedores via getPricesV3 ANTES de tentar.
   *      A lista descoberta SUBSTITUI a lista manual (mais baratos primeiro).
   *   2. Se autoDiscover=false: usa a lista manual de provider IDs.
   *   3. Cada tentativa usa UM provedor específico (rotação sequencial).
   *   4. Se o provedor falha, registra no health tracker e avança.
   *   5. Se todos falharam e autoDiscover estava OFF, tenta descobrir como fallback.
   *   6. maxRetries limita tentativas, mas é expandido quando Auto-Discover
   *      encontra novos provedores (para dar chance aos descobertos).
   */
  async getCodeWithRetry(options: RetryOptions = {}): Promise<RetryResult> {
    // Reload config from DB and take a LOCAL SNAPSHOT to avoid cross-job interference.
    // Each concurrent job works with its own copy of the config.
    await this.reloadConfig();
    const configSnapshot = { ...this.config! };
    configSnapshot.providerIds = [...this.config!.providerIds]; // deep copy array

    const maxRetries = options.maxRetries ?? configSnapshot.maxRetries;
    const waitTimeMs = options.waitTimeMs ?? configSnapshot.waitTimeMs;
    const onNumberRented = options.onNumberRented || null;
    const jobId = options.jobId;

    const country = options.country || configSnapshot.country;
    const service = options.service || configSnapshot.service;
    const maxPrice = options.maxPrice || configSnapshot.maxPrice;

    // 1. Montar fila de provedores
    let configuredProviders = options.providerIds || [...configSnapshot.providerIds];

    // If Auto-Discover is ON, discover providers UPFRONT (replaces manual list)
    if (configSnapshot.autoDiscover && !options.providerIds) {
      await logger.info("sms", `Auto-Discover ATIVO — buscando provedores via getPricesV3 (país=${country}, serviço=${service}, maxPrice=$${maxPrice})...`, {}, jobId);
      try {
        const discovered = await this.discoverProviders(country, service, maxPrice);
        if (discovered.length > 0) {
          await logger.info("sms",
            `Auto-Discover encontrou ${discovered.length} provedores dentro de $${maxPrice}: [${discovered.join(", ")}]`,
            {}, jobId
          );
          configuredProviders = discovered;
        } else {
          await logger.warn("sms",
            `Auto-Discover não encontrou provedores dentro de $${maxPrice}. Usando lista manual como fallback: [${configuredProviders.join(", ")}]`,
            {}, jobId
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await logger.warn("sms", `Auto-Discover falhou: ${msg}. Usando lista manual como fallback.`, {}, jobId);
      }
    }

    // Auto-remove provedores com performance muito ruim (5+ falhas consecutivas, <20% sucesso)
    if (!options.providerIds) {
      const toRemove = this.providerHealth.getProvidersToRemove(configuredProviders);
      if (toRemove.length > 0) {
        configuredProviders = configuredProviders.filter(id => !toRemove.includes(id));
        // Only update saved list if NOT using auto-discover (otherwise the list is ephemeral)
        if (!configSnapshot.autoDiscover) {
          const newList = configuredProviders.join(",");
          await setSetting("sms_provider_ids", newList);
        }
        await logger.warn("sms",
          `Removendo ${toRemove.length} provedor(es) com performance ruim: [${toRemove.join(", ")}].`,
          { removed: toRemove }, jobId
        );
      }
    }

    const rankedProviders = this.providerHealth.rankProviders(configuredProviders);

    // Adicionar provedores em cooldown ao final (segunda chance se os bons acabarem)
    const cooldownProviders = configuredProviders.filter(id => !rankedProviders.includes(id));
    const providerQueue = [...rankedProviders, ...cooldownProviders];

    // Effective max retries: at least the queue size, capped at maxRetries * 2 for discovered providers
    const effectiveMaxRetries = Math.max(maxRetries, Math.min(providerQueue.length, maxRetries * 2));

    await logger.info("sms",
      `Fila de provedores: [${providerQueue.join(", ")}] (${rankedProviders.length} disponíveis, ${cooldownProviders.length} em cooldown). ` +
      `Max tentativas: ${effectiveMaxRetries}`,
      {}, jobId
    );

    let totalCost = 0;
    let lastError: Error | null = null;
    let attempt = 0;
    let usedFallbackDiscover = false;

    // 2. Tentar cada provedor da fila sequencialmente
    for (let queueIndex = 0; queueIndex < providerQueue.length && attempt < effectiveMaxRetries; queueIndex++) {
      attempt++;
      const currentProviderId = providerQueue[queueIndex];
      const isInCooldown = !this.providerHealth.isAvailable(currentProviderId);

      await logger.info("sms", `=== Tentativa ${attempt}/${effectiveMaxRetries} — Provedor #${currentProviderId}${isInCooldown ? " (saindo do cooldown)" : ""} ===`, {}, jobId);

      const result = await this._tryProvider(currentProviderId, {
        country, service, maxPrice, waitTimeMs, onNumberRented, jobId, attempt,
      });

      if (result.success) {
        totalCost += result.cost;

        // Se o provedor veio do Auto-Discover e não está na lista salva, auto-adicioná-lo.
        // Thread-safe: re-read current list from DB before modifying to avoid overwriting
        // changes made by other concurrent jobs.
        if (!options.providerIds) {
          const currentSavedList = ((await getSetting("sms_provider_ids")) || "")
            .split(",").map(id => parseInt(id.trim())).filter(id => !isNaN(id));
          if (!currentSavedList.includes(currentProviderId)) {
            const updatedList = [...currentSavedList, currentProviderId];
            const newListStr = updatedList.join(",");
            await setSetting("sms_provider_ids", newListStr);
            await logger.info("sms",
              `Provedor #${currentProviderId} teve SUCESSO — adicionado permanentemente à lista. ` +
              `Lista atualizada: [${newListStr}]`,
              { providerId: currentProviderId, newList: updatedList }, jobId
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

      // Falhou — custo já foi devolvido pelo cancel
      lastError = result.error || null;

      // Fallback: se Auto-Discover estava OFF, todos da lista falharam, e ainda temos tentativas
      if (queueIndex === providerQueue.length - 1 && attempt < effectiveMaxRetries && !usedFallbackDiscover && !configSnapshot.autoDiscover) {
        usedFallbackDiscover = true;
        await logger.info("sms", `Todos os ${providerQueue.length} provedores da lista falharam. Tentando Auto-Discover como fallback...`, {}, jobId);

        try {
          const discovered = await this.discoverProviders(country, service, maxPrice);
          const newProviders = discovered.filter(id => !providerQueue.includes(id));

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

    // 3. Se chegou aqui, todas as tentativas falharam
    const healthSummary = this.providerHealth.getSummary();
    await logger.error("sms", `SMS não recebido após ${attempt} tentativas. Health: ${JSON.stringify(healthSummary)}`, {}, jobId);

    throw new Error(`SMS não recebido após ${attempt} tentativas com rotação de provedores. Último erro: ${lastError?.message || "timeout"}`);
  }

  /**
   * Tenta obter um código SMS usando um provedor específico.
   * Registra sucesso/falha no health tracker.
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
  }> {
    let numberData: NumberData | null = null;
    const startTime = Date.now();

    try {
      // Alugar número deste provedor específico
      numberData = await this.getNumber({
        country: opts.country,
        service: opts.service,
        maxPrice: opts.maxPrice,
        providerIds: [providerId],
        jobId: opts.jobId,
      });

      const cost = parseFloat(numberData.activationCost || opts.maxPrice);

      // Callback: enviar SMS para o número alugado
      if (opts.onNumberRented) {
        await opts.onNumberRented({
          phoneNumber: numberData.phoneNumber,
          activationId: numberData.activationId,
          attempt: opts.attempt,
        });
      }

      // Aguardar código
      const code = await this.waitForCode(numberData.activationId, opts.waitTimeMs, opts.jobId);

      if (code) {
        const responseTime = Date.now() - startTime;
        this.providerHealth.recordSuccess(providerId, responseTime);
        await logger.info("sms", `SMS recebido na tentativa ${opts.attempt}! Código: ${code} (provedor #${providerId}, ${Math.round(responseTime / 1000)}s)`, {}, opts.jobId);
        return { success: true, code, phoneNumber: numberData.phoneNumber, activationId: numberData.activationId, cost };
      }

      // Timeout — cancelar e registrar falha
      await logger.warn("sms", `Provedor #${providerId}: SMS não recebido (timeout). Cancelando...`, {}, opts.jobId);
      await this.cancel(numberData.activationId, numberData.rentedAt, opts.jobId);
      this.providerHealth.recordFailure(providerId);
      return { success: false, cost: 0, error: new Error(`Timeout no provedor #${providerId}`) };

    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));

      // Cancelar número se foi alugado
      if (numberData) {
        try {
          await this.cancel(numberData.activationId, numberData.rentedAt, opts.jobId);
        } catch {
          // Ignore cancel errors
        }
      }

      // IMPORTANT: Distinguish between SMS provider errors and target API errors.
      // Errors from manus.im (permission_denied, invalid_argument, etc.) are NOT
      // the SMS provider's fault — the number was delivered correctly, but the
      // target rejected it. Don't penalize the provider for these.
      const isTargetApiError = error.message.includes("RPC ") ||
        error.message.includes("permission_denied") ||
        error.message.includes("invalid_argument") ||
        error.message.includes("Failed to send the code") ||
        error.message.includes("resource_exhausted");

      if (isTargetApiError) {
        await logger.warn("sms", `Provedor #${providerId}: número rejeitado pela API do alvo (NÃO penalizado): ${error.message}`, {}, opts.jobId);
        // Don't record failure — the provider did its job, the target rejected the number
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

  /**
   * Retorna o health summary dos provedores (para exposição via API/UI).
   */
  getProviderHealthSummary(): Record<string, unknown>[] {
    return this.providerHealth.getSummary();
  }

  /**
   * Reseta o health tracker (útil após mudança de configuração).
   */
  resetProviderHealth(): void {
    this.providerHealth.reset();
  }
}

export const smsService = new SmsService();
