/**
 * SMSPool Provider — Integração com a API SMSPool (api.smspool.net)
 *
 * Este módulo implementa a interface de SMS compatível com o fluxo do GhostPanel,
 * permitindo usar o SMSPool como segunda fonte de números SMS, somando ao SMSBower.
 *
 * Endpoints utilizados:
 *   - POST /purchase/sms       → Comprar número (Order SMS)
 *   - POST /sms/check          → Verificar status do SMS (Check SMS)
 *   - POST /sms/cancel         → Cancelar pedido (Cancel SMS)
 *   - POST /request/balance    → Consultar saldo
 *   - GET  /service/retrieve_all → Listar serviços disponíveis
 *   - GET  /country/retrieve_all → Listar países disponíveis
 *
 * Referência: https://documenter.getpostman.com/view/30155063/2s9YXmZ1JY
 */

import { logger } from "../utils/helpers";

const SMSPOOL_API = "https://api.smspool.net";

// ============================================================
// INTERFACES
// ============================================================

export interface SMSPoolConfig {
  apiKey: string;
  enabled: boolean;
  /** ID do serviço no SMSPool (ex: "1" para o serviço padrão). Vazio = usa o nome do serviço. */
  serviceId: string;
  /** ID do país no SMSPool (ex: "1" para USA). Vazio = usa mapeamento automático. */
  countryId: string;
  /** Preço máximo por número */
  maxPrice: string;
  /** Pool preferida (ex: "1" para Foxtrot). Vazio = automático. */
  pool: string;
  /** Prioridade na rotação: "primary" (tenta primeiro) ou "secondary" (tenta depois do SMSBower) */
  priority: "primary" | "secondary";
}

export interface SMSPoolNumberData {
  orderId: string;       // order_id retornado pelo SMSPool (equivale ao activationId)
  phoneNumber: string;   // Número de telefone
  country: string;       // País do número
  service: string;       // Serviço
  pool: number;          // Pool utilizada
  expiresIn: number;     // Tempo até expirar (segundos)
  cost: string;          // Custo do número
  rentedAt: number;      // Timestamp de quando foi alugado
}

export interface SMSPoolCheckResult {
  status: number;        // 1=pending, 3=completed (SMS recebido)
  sms?: string;          // Código SMS (quando status=3)
  fullSms?: string;      // SMS completo (quando status=3)
  resend?: number;       // Se resend está disponível
  expiration?: number;   // Timestamp de expiração
  timeLeft?: number;     // Tempo restante em segundos
}

// ============================================================
// MAPEAMENTO DE PAÍSES: SMSBower countryCode → SMSPool countryId
// ============================================================

/**
 * Mapeamento dos códigos de país do SMSBower para os IDs do SMSPool.
 * Os IDs do SMSPool são obtidos via /country/retrieve_all.
 * Este mapeamento cobre os países mais usados no GhostPanel.
 */
const SMSBOWER_TO_SMSPOOL_COUNTRY: Record<string, string> = {
  "0":  "40",   // Russia
  "6":  "5",    // Indonesia
  "7":  "1",    // USA
  "12": "15",   // Philippines
  "22": "17",   // Thailand
  "31": "2",    // United Kingdom
  "73": "36",   // Brazil
  "82": "6",    // India
  "86": "14",   // Vietnam
  "95": "19",   // Nigeria
  "33": "46",   // Colombia
  "46": "42",   // Sweden
  "48": "3",    // Netherlands
};

/**
 * Mapeamento de nomes de serviço do SMSBower para IDs do SMSPool.
 * O SMSBower usa códigos curtos (ex: "ot" para OTP genérico),
 * enquanto o SMSPool usa IDs numéricos.
 *
 * Este mapeamento será atualizado dinamicamente via /service/retrieve_all
 * quando possível, mas mantém defaults estáticos para os serviços mais comuns.
 */
const SMSBOWER_TO_SMSPOOL_SERVICE: Record<string, string> = {
  "ot": "1",     // OTP / Other (serviço genérico)
  "go": "9",     // Google
  "tg": "11",    // Telegram
  "wa": "2",     // WhatsApp
  "ig": "3",     // Instagram
  "fb": "4",     // Facebook
  "tw": "5",     // Twitter/X
  "ds": "8",     // Discord
  "am": "10",    // Amazon
  "mi": "15",    // Microsoft
};

// ============================================================
// SMSPOOL PROVIDER CLASS
// ============================================================

class SMSPoolProvider {
  private config: SMSPoolConfig = {
    apiKey: "",
    enabled: false,
    serviceId: "",
    countryId: "",
    maxPrice: "0.50",
    pool: "",
    priority: "secondary",
  };

  private serviceCache: Map<string, string> | null = null;
  private countryCache: Map<string, string> | null = null;
  private serviceCacheExpiry = 0;
  private countryCacheExpiry = 0;
  private static CACHE_TTL = 30 * 60_000; // 30 minutos

  // ============================================================
  // CONFIGURAÇÃO
  // ============================================================

  configure(config: Partial<SMSPoolConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): SMSPoolConfig {
    return { ...this.config };
  }

  isEnabled(): boolean {
    return this.config.enabled && this.config.apiKey.length > 0;
  }

  getPriority(): "primary" | "secondary" {
    return this.config.priority;
  }

  // ============================================================
  // MÉTODOS DE API — INFORMATIVOS
  // ============================================================

  /**
   * Consulta o saldo da conta SMSPool.
   */
  async getBalance(): Promise<number> {
    const formData = new URLSearchParams({ key: this.config.apiKey });
    const resp = await fetch(`${SMSPOOL_API}/request/balance`, {
      method: "POST",
      body: formData,
    });

    const data = await resp.json() as Record<string, unknown>;
    if (data.balance !== undefined) {
      return parseFloat(String(data.balance));
    }
    throw new Error(`SMSPool getBalance: resposta inesperada: ${JSON.stringify(data)}`);
  }

  /**
   * Lista todos os serviços disponíveis no SMSPool.
   * Resultado é cacheado por 30 minutos.
   */
  async getServices(): Promise<Array<{ id: string; name: string }>> {
    const resp = await fetch(`${SMSPOOL_API}/service/retrieve_all`);
    const data = await resp.json() as Array<{ ID: string; name: string }>;
    return data.map(s => ({ id: s.ID, name: s.name }));
  }

  /**
   * Lista todos os países disponíveis no SMSPool.
   * Resultado é cacheado por 30 minutos.
   */
  async getCountries(): Promise<Array<{ id: string; name: string; region: string }>> {
    const resp = await fetch(`${SMSPOOL_API}/country/retrieve_all`);
    const data = await resp.json() as Array<{ ID: string; name: string; region: string }>;
    return data.map(c => ({ id: c.ID, name: c.name, region: c.region }));
  }

  // ============================================================
  // RESOLUÇÃO DE IDs (SMSBower → SMSPool)
  // ============================================================

  /**
   * Resolve o ID do serviço no SMSPool a partir do código SMSBower.
   * Tenta primeiro o mapeamento estático, depois busca na API.
   */
  async resolveServiceId(smsBowerService: string): Promise<string> {
    // Se o usuário configurou um serviceId fixo, usa ele
    if (this.config.serviceId && this.config.serviceId.trim() !== "") {
      return this.config.serviceId;
    }

    // Tenta mapeamento estático
    if (SMSBOWER_TO_SMSPOOL_SERVICE[smsBowerService]) {
      return SMSBOWER_TO_SMSPOOL_SERVICE[smsBowerService];
    }

    // Fallback: busca na API e tenta match por nome
    try {
      if (!this.serviceCache || Date.now() > this.serviceCacheExpiry) {
        const services = await this.getServices();
        this.serviceCache = new Map();
        for (const s of services) {
          this.serviceCache.set(s.name.toLowerCase(), s.id);
        }
        this.serviceCacheExpiry = Date.now() + SMSPoolProvider.CACHE_TTL;
      }

      // Tenta match parcial
      for (const [name, id] of Array.from(this.serviceCache.entries())) {
        if (name.includes(smsBowerService.toLowerCase())) {
          return id;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logger.warn("smspool", `Falha ao resolver serviço "${smsBowerService}": ${msg}`);
    }

    // Último fallback: serviço genérico "1" (Other)
    return "1";
  }

  /**
   * Resolve o ID do país no SMSPool a partir do countryCode do SMSBower.
   */
  async resolveCountryId(smsBowerCountryCode: string): Promise<string> {
    // Se o usuário configurou um countryId fixo, usa ele
    if (this.config.countryId && this.config.countryId.trim() !== "") {
      return this.config.countryId;
    }

    // Tenta mapeamento estático
    if (SMSBOWER_TO_SMSPOOL_COUNTRY[smsBowerCountryCode]) {
      return SMSBOWER_TO_SMSPOOL_COUNTRY[smsBowerCountryCode];
    }

    // Fallback: retorna "1" (USA) como padrão seguro
    await logger.warn("smspool",
      `País SMSBower "${smsBowerCountryCode}" sem mapeamento para SMSPool. Usando USA (1) como fallback.`
    );
    return "1";
  }

  // ============================================================
  // MÉTODOS DE API — OPERAÇÕES SMS
  // ============================================================

  /**
   * Compra um número SMS no SMSPool.
   * Equivalente ao getNumber/getNumberV2 do SMSBower.
   */
  async orderSMS(opts: {
    countryCode: string;  // Código do país no SMSBower (será convertido)
    service: string;      // Código do serviço no SMSBower (será convertido)
    maxPrice?: string;    // Preço máximo (usa config se não informado)
    jobId?: number;
  }): Promise<SMSPoolNumberData> {
    const countryId = await this.resolveCountryId(opts.countryCode);
    const serviceId = await this.resolveServiceId(opts.service);
    const maxPrice = opts.maxPrice || this.config.maxPrice;

    await logger.info("smspool",
      `Comprando número (país: ${countryId}, serviço: ${serviceId}, maxPrice: $${maxPrice})`,
      {}, opts.jobId
    );

    const formData = new URLSearchParams({
      key: this.config.apiKey,
      country: countryId,
      service: serviceId,
      max_price: maxPrice,
      pricing_option: "0", // 0 = mais barato
    });

    if (this.config.pool && this.config.pool.trim() !== "") {
      formData.set("pool", this.config.pool);
    }

    const resp = await fetch(`${SMSPOOL_API}/purchase/sms`, {
      method: "POST",
      body: formData,
    });

    const data = await resp.json() as Record<string, unknown>;

    // Verifica erros
    if (data.success === 0 || data.type === "error") {
      const message = String(data.message || "Erro desconhecido");
      if (message.toLowerCase().includes("no stock") || message.toLowerCase().includes("couldn't find")) {
        throw new Error("SMSPool: Sem números disponíveis nessa faixa de preço");
      }
      if (message.toLowerCase().includes("balance")) {
        throw new Error("SMSPool: Saldo insuficiente");
      }
      if (message.toLowerCase().includes("key") || message.toLowerCase().includes("auth")) {
        throw new Error("SMSPool: API key inválida");
      }
      throw new Error(`SMSPool orderSMS: ${message}`);
    }

    if (!data.order_id || !data.number) {
      throw new Error(`SMSPool orderSMS: resposta inválida: ${JSON.stringify(data)}`);
    }

    const result: SMSPoolNumberData = {
      orderId: String(data.order_id),
      phoneNumber: String(data.number),
      country: String(data.country || ""),
      service: String(data.service || ""),
      pool: Number(data.pool || 0),
      expiresIn: Number(data.expires_in || 600),
      cost: String(data.cost || maxPrice),
      rentedAt: Date.now(),
    };

    await logger.info("smspool",
      `Número comprado: ${result.phoneNumber} (orderId: ${result.orderId}, custo: $${result.cost}, pool: ${result.pool})`,
      {}, opts.jobId
    );

    return result;
  }

  /**
   * Verifica o status de um pedido SMS no SMSPool.
   * Equivalente ao getStatus do SMSBower.
   */
  async checkSMS(orderId: string, jobId?: number): Promise<SMSPoolCheckResult> {
    const formData = new URLSearchParams({
      key: this.config.apiKey,
      orderid: orderId,
    });

    const resp = await fetch(`${SMSPOOL_API}/sms/check`, {
      method: "POST",
      body: formData,
    });

    const data = await resp.json() as Record<string, unknown>;

    return {
      status: Number(data.status || 0),
      sms: data.sms ? String(data.sms) : undefined,
      fullSms: data.full_sms ? String(data.full_sms) : undefined,
      resend: data.resend !== undefined ? Number(data.resend) : undefined,
      expiration: data.expiration ? Number(data.expiration) : undefined,
      timeLeft: data.time_left ? Number(data.time_left) : undefined,
    };
  }

  /**
   * Cancela um pedido SMS no SMSPool.
   * Equivalente ao cancel/setStatus(8) do SMSBower.
   */
  async cancelSMS(orderId: string, jobId?: number): Promise<boolean> {
    await logger.info("smspool", `Cancelando pedido ${orderId}`, {}, jobId);

    const formData = new URLSearchParams({
      key: this.config.apiKey,
      orderid: orderId,
    });

    try {
      const resp = await fetch(`${SMSPOOL_API}/sms/cancel`, {
        method: "POST",
        body: formData,
      });

      const data = await resp.json() as Record<string, unknown>;

      if (data.success === 1 || data.success === "1") {
        await logger.info("smspool", `Pedido ${orderId} cancelado com sucesso`, {}, jobId);
        return true;
      }

      await logger.warn("smspool",
        `Cancelamento ${orderId}: ${JSON.stringify(data)}`,
        {}, jobId
      );
      return false;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logger.warn("smspool", `Erro ao cancelar ${orderId}: ${msg}`, {}, jobId);
      return false;
    }
  }

  /**
   * Aguarda o recebimento do SMS no SMSPool.
   * Equivalente ao waitForCode do SMSBower.
   *
   * Status do SMSPool:
   *   1 = pending (aguardando SMS)
   *   3 = completed (SMS recebido)
   *   6 = expired/cancelled
   */
  async waitForCode(
    orderId: string,
    timeoutMs: number,
    pollIntervalMs: number,
    jobId?: number,
    signal?: AbortSignal
  ): Promise<string | null> {
    await logger.info("smspool",
      `Aguardando SMS (orderId: ${orderId}, timeout: ${timeoutMs / 1000}s)`,
      {}, jobId
    );

    const startTime = Date.now();
    const progressLogInterval = 20_000;
    let lastProgressLog = startTime;

    while (Date.now() - startTime < timeoutMs) {
      // Verifica abort
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      try {
        const result = await this.checkSMS(orderId, jobId);

        // Status 3 = SMS recebido
        if (result.status === 3 && result.sms) {
          await logger.info("smspool",
            `Código SMS recebido: ${result.sms} (orderId: ${orderId})`,
            {}, jobId
          );
          return result.sms;
        }

        // Status 6 = expirado/cancelado
        if (result.status === 6) {
          await logger.warn("smspool",
            `Pedido ${orderId} expirado/cancelado pelo servidor`,
            {}, jobId
          );
          return null;
        }

        // Status 1 = ainda aguardando
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") throw err;
        const msg = err instanceof Error ? err.message : String(err);
        await logger.warn("smspool", `Erro ao verificar status: ${msg}`, { orderId }, jobId);
      }

      // Log de progresso
      const now = Date.now();
      if (now - lastProgressLog >= progressLogInterval) {
        const elapsed = Math.round((now - startTime) / 1000);
        const remaining = Math.round((timeoutMs - (now - startTime)) / 1000);
        await logger.info("smspool",
          `Aguardando SMS... ${elapsed}s/${timeoutMs / 1000}s (restam ${remaining}s)`,
          { orderId }, jobId
        );
        lastProgressLog = now;
      }

      // Aguarda intervalo
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, pollIntervalMs);
        if (signal) {
          const onAbort = () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          };
          signal.addEventListener("abort", onAbort, { once: true });
        }
      });
    }

    await logger.warn("smspool",
      `Timeout: SMS não recebido em ${timeoutMs / 1000}s (orderId: ${orderId})`,
      {}, jobId
    );
    return null;
  }

  // ============================================================
  // MÉTODO DE ALTO NÍVEL — Integração com o fluxo do SmsService
  // ============================================================

  /**
   * Tenta obter um código SMS usando o SMSPool.
   * Este método é chamado pelo SmsService como alternativa ao SMSBower.
   *
   * Retorna no mesmo formato que o _tryProvider do SMSBower para
   * manter compatibilidade com o fluxo existente.
   */
  async tryGetCode(opts: {
    countryCode: string;
    service: string;
    maxPrice: string;
    waitTimeMs: number;
    pollIntervalMs: number;
    regionCode: string;
    onNumberRented?: (data: {
      phoneNumber: string;
      activationId: string;
      attempt: number;
      regionCode: string;
    }) => Promise<void>;
    jobId?: number;
    attempt: number;
    signal?: AbortSignal;
  }): Promise<{
    success: boolean;
    code?: string;
    phoneNumber?: string;
    activationId?: string;
    cost: number;
    error?: Error;
    wasTargetRejection?: boolean;
    wasProxyError?: boolean;
    provider: "smspool";
  }> {
    let numberData: SMSPoolNumberData | null = null;

    try {
      // 1. Comprar número
      numberData = await this.orderSMS({
        countryCode: opts.countryCode,
        service: opts.service,
        maxPrice: opts.maxPrice,
        jobId: opts.jobId,
      });

      const cost = parseFloat(numberData.cost || opts.maxPrice);

      // 2. Notificar que o número foi alugado (para o provider Manus enviar o código)
      if (opts.onNumberRented) {
        await opts.onNumberRented({
          phoneNumber: numberData.phoneNumber,
          activationId: `smspool:${numberData.orderId}`, // Prefixo para identificar o provider
          attempt: opts.attempt,
          regionCode: opts.regionCode,
        });
      }

      // 3. Verificar abort
      if (opts.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      // 4. Aguardar SMS
      const code = await this.waitForCode(
        numberData.orderId,
        opts.waitTimeMs,
        opts.pollIntervalMs,
        opts.jobId,
        opts.signal
      );

      if (code) {
        await logger.info("smspool",
          `SMS recebido na tentativa ${opts.attempt}! Código: ${code} (orderId: ${numberData.orderId})`,
          {}, opts.jobId
        );
        return {
          success: true,
          code,
          phoneNumber: numberData.phoneNumber,
          activationId: `smspool:${numberData.orderId}`,
          cost,
          provider: "smspool",
        };
      }

      // 5. Timeout — cancelar
      await logger.warn("smspool",
        `SMS não recebido (timeout). Cancelando pedido ${numberData.orderId}...`,
        {}, opts.jobId
      );
      await this.cancelSMS(numberData.orderId, opts.jobId);
      return {
        success: false,
        cost: 0,
        error: new Error("SMSPool: Timeout aguardando SMS"),
        provider: "smspool",
      };

    } catch (err) {
      // Re-throw AbortError
      if (err instanceof DOMException && err.name === "AbortError") throw err;

      const error = err instanceof Error ? err : new Error(String(err));

      // Cancelar número se foi alugado
      if (numberData) {
        try {
          await this.cancelSMS(numberData.orderId, opts.jobId);
        } catch {
          // Ignora erros de cancelamento
        }
      }

      // Detecta erros fatais
      if (error.message.includes("Saldo insuficiente") || error.message.includes("API key inválida")) {
        throw error;
      }

      // Detecta erros de rede/proxy
      const isProxyError =
        error.message.includes("ECONNRESET") ||
        error.message.includes("ECONNREFUSED") ||
        error.message.includes("ETIMEDOUT") ||
        error.message.includes("fetch failed");

      // Detecta rejeição do número pelo alvo
      // v9.7.1: Único erro conhecido de número rejeitado é "Failed to send the code".
      const isTargetRejection =
        error.message.includes("Failed to send the code");

      // Account banned — re-throw
      if (error.message.includes("user is blocked") || error.message.includes("USER_IS_BLOCKED")) {
        throw error;
      }

      await logger.warn("smspool",
        `Tentativa ${opts.attempt} falhou: ${error.message}`,
        {}, opts.jobId
      );

      return {
        success: false,
        cost: 0,
        error,
        wasProxyError: isProxyError,
        wasTargetRejection: isTargetRejection,
        provider: "smspool",
      };
    }
  }
}

// ============================================================
// SINGLETON EXPORT
// ============================================================

export const smsPoolProvider = new SMSPoolProvider();
