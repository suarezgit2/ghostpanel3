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
import { getSetting, setSetting } from "../utils/settings";

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
 * v9.8: Mapeamento reverso de SMSPool countryId para regionCode (prefixo telefônico).
 * Usado para derivar o regionCode correto do número comprado no SMSPool,
 * em vez de usar o regionCode do SMSBower (que pode ser de outro país).
 */
const SMSPOOL_COUNTRY_TO_REGION: Record<string, string> = {
  "1":  "+1",    // USA
  "2":  "+44",   // United Kingdom
  "3":  "+31",   // Netherlands
  "4":  "+33",   // France
  "5":  "+62",   // Indonesia
  "6":  "+91",   // India
  "7":  "+7",    // Kazakhstan
  "8":  "+254",  // Kenya
  "9":  "+60",   // Malaysia
  "10": "+86",   // China
  "11": "+234",  // Nigeria (alt)
  "12": "+52",   // Mexico
  "14": "+84",   // Vietnam
  "15": "+63",   // Philippines
  "17": "+66",   // Thailand
  "19": "+234",  // Nigeria
  "21": "+20",   // Egypt
  "22": "+972",  // Israel
  "23": "+380",  // Ukraine
  "24": "+48",   // Poland
  "25": "+1",    // Canada
  "29": "+212",  // Morocco
  "30": "+57",   // Colombia
  "32": "+92",   // Pakistan
  "34": "+880",  // Bangladesh
  "36": "+55",   // Brazil
  "37": "+358",  // Finland
  "38": "+351",  // Portugal
  "39": "+40",   // Romania
  "40": "+7",    // Russia
  "42": "+46",   // Sweden
  "43": "+34",   // Spain
  "44": "+90",   // Turkey
  "46": "+57",   // Colombia (alt)
  "47": "+56",   // Chile
  "49": "+49",   // Germany
  "50": "+54",   // Argentina
  "51": "+420",  // Czech Republic
  "52": "+39",   // Italy
  "53": "+27",   // South Africa
  "54": "+61",   // Australia
  "55": "+81",   // Japan
  "56": "+82",   // South Korea
  "57": "+852",  // Hong Kong
  "58": "+65",   // Singapore
  "59": "+353",  // Ireland
  "60": "+64",   // New Zealand
  "61": "+30",   // Greece
  "62": "+36",   // Hungary
  "63": "+43",   // Austria
  "64": "+45",   // Denmark
  "65": "+47",   // Norway
  "66": "+32",   // Belgium
  "67": "+41",   // Switzerland
  "68": "+372",  // Estonia
  "69": "+371",  // Latvia
  "70": "+370",  // Lithuania
  "72": "+51",   // Peru
};

/**
 * v9.8: Lista ordenada de prefixos telefônicos internacionais (do mais longo ao mais curto).
 * Usada para detectar o regionCode real a partir do número de telefone retornado pelo SMSPool.
 */
const PHONE_PREFIXES: Array<{ prefix: string; regionCode: string }> = [
  // 4 dígitos
  { prefix: "1684", regionCode: "+1684" },
  // 3 dígitos
  { prefix: "880", regionCode: "+880" },
  { prefix: "852", regionCode: "+852" },
  { prefix: "972", regionCode: "+972" },
  { prefix: "380", regionCode: "+380" },
  { prefix: "234", regionCode: "+234" },
  { prefix: "254", regionCode: "+254" },
  { prefix: "212", regionCode: "+212" },
  { prefix: "358", regionCode: "+358" },
  { prefix: "351", regionCode: "+351" },
  { prefix: "420", regionCode: "+420" },
  { prefix: "353", regionCode: "+353" },
  { prefix: "372", regionCode: "+372" },
  { prefix: "371", regionCode: "+371" },
  { prefix: "370", regionCode: "+370" },
  // 2 dígitos
  { prefix: "62", regionCode: "+62" },
  { prefix: "55", regionCode: "+55" },
  { prefix: "91", regionCode: "+91" },
  { prefix: "44", regionCode: "+44" },
  { prefix: "86", regionCode: "+86" },
  { prefix: "81", regionCode: "+81" },
  { prefix: "82", regionCode: "+82" },
  { prefix: "84", regionCode: "+84" },
  { prefix: "66", regionCode: "+66" },
  { prefix: "63", regionCode: "+63" },
  { prefix: "60", regionCode: "+60" },
  { prefix: "52", regionCode: "+52" },
  { prefix: "57", regionCode: "+57" },
  { prefix: "56", regionCode: "+56" },
  { prefix: "54", regionCode: "+54" },
  { prefix: "51", regionCode: "+51" },
  { prefix: "48", regionCode: "+48" },
  { prefix: "46", regionCode: "+46" },
  { prefix: "49", regionCode: "+49" },
  { prefix: "34", regionCode: "+34" },
  { prefix: "39", regionCode: "+39" },
  { prefix: "33", regionCode: "+33" },
  { prefix: "31", regionCode: "+31" },
  { prefix: "30", regionCode: "+30" },
  { prefix: "36", regionCode: "+36" },
  { prefix: "43", regionCode: "+43" },
  { prefix: "45", regionCode: "+45" },
  { prefix: "47", regionCode: "+47" },
  { prefix: "32", regionCode: "+32" },
  { prefix: "41", regionCode: "+41" },
  { prefix: "40", regionCode: "+40" },
  { prefix: "90", regionCode: "+90" },
  { prefix: "92", regionCode: "+92" },
  { prefix: "27", regionCode: "+27" },
  { prefix: "61", regionCode: "+61" },
  { prefix: "64", regionCode: "+64" },
  { prefix: "65", regionCode: "+65" },
  { prefix: "20", regionCode: "+20" },
  // 1 dígito
  { prefix: "7", regionCode: "+7" },
  { prefix: "1", regionCode: "+1" },
];

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

// ============================================================
// CHAVE DE SETTINGS PARA BLOQUEIO PERSISTENTE
// ============================================================

/**
 * Quando o SMSPool retorna "too many failed purchases", o bloqueio dura 6 horas.
 * Persistimos o timestamp de expiração no banco (via settings) para que o bloqueio
 * sobreviva a restarts do servidor — evitando chamadas desnecessárias à API.
 *
 * Chave: smspool_blocked_until
 * Valor: timestamp ISO 8601 de quando o bloqueio expira (ex: "2026-03-24T03:12:00.000Z")
 * Vazio/ausente = não bloqueado.
 */
const SMSPOOL_BLOCKED_UNTIL_KEY = "smspool_blocked_until";

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
   * v9.8: Detecta o regionCode real a partir do número de telefone retornado pelo SMSPool.
   * Primeiro tenta usar o mapeamento countryId → regionCode, depois faz detecção por prefixo.
   * Isso corrige o bug onde o DDD do SMSBower era usado em vez do DDD real do número SMSPool.
   */
  detectRegionCode(phoneNumber: string, smsPoolCountryId?: string): string {
    // 1. Tenta pelo mapeamento de countryId do SMSPool
    if (smsPoolCountryId) {
      const fromCountry = SMSPOOL_COUNTRY_TO_REGION[smsPoolCountryId];
      if (fromCountry) {
        return fromCountry;
      }
    }

    // 2. Remove "+" se presente
    const cleaned = phoneNumber.replace(/^\+/, "");

    // 3. Tenta detectar pelo prefixo do número (do mais longo ao mais curto)
    for (const { prefix, regionCode } of PHONE_PREFIXES) {
      if (cleaned.startsWith(prefix)) {
        return regionCode;
      }
    }

    // 4. Fallback: retorna o número sem detecção (não assume nenhum país)
    return "+" + cleaned.substring(0, 2);
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
   * Verifica se o SMSPool está bloqueado por excesso de falhas.
   * O bloqueio é persistido no banco para sobreviver a restarts.
   * Retorna o número de minutos restantes se bloqueado, 0 se livre.
   */
  async getBlockedMinutesRemaining(): Promise<number> {
    try {
      const blockedUntilStr = await getSetting(SMSPOOL_BLOCKED_UNTIL_KEY);
      if (!blockedUntilStr) return 0;
      const blockedUntil = new Date(blockedUntilStr).getTime();
      const remaining = blockedUntil - Date.now();
      if (remaining <= 0) {
        // Bloqueio expirou — limpa a chave
        await setSetting(SMSPOOL_BLOCKED_UNTIL_KEY, "");
        return 0;
      }
      return Math.ceil(remaining / 60_000);
    } catch {
      return 0;
    }
  }

  /**
   * Registra um bloqueio do SMSPool por N horas no banco.
   * Chamado quando o SMSPool retorna "too many failed purchases".
   */
  async registerBlock(hours: number, jobId?: number): Promise<void> {
    const blockedUntil = new Date(Date.now() + hours * 60 * 60_000);
    await setSetting(
      SMSPOOL_BLOCKED_UNTIL_KEY,
      blockedUntil.toISOString(),
      `SMSPool bloqueado por excesso de falhas — libera em ${blockedUntil.toLocaleString("pt-BR")}`
    );
    await logger.warn("smspool",
      `SMSPool bloqueado por ${hours}h (até ${blockedUntil.toISOString()}) — ` +
      `excesso de compras com falha. Próximas tentativas serão ignoradas até lá.`,
      {}, jobId
    );
  }

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
      // Bloqueio por excesso de falhas — persiste no banco para sobreviver a restarts
      if (message.toLowerCase().includes("too many failed purchases")) {
        // Extrai o número de horas da mensagem (ex: "try again in 6 hours")
        const hoursMatch = message.match(/(\d+)\s*hour/i);
        const blockHours = hoursMatch ? parseInt(hoursMatch[1]) : 6;
        await this.registerBlock(blockHours, opts.jobId);
        throw new Error(`SMSPool: Bloqueado por ${blockHours}h por excesso de falhas`);
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
   * Cancela um pedido SMS no SMSPool (tentativa única).
   * Retorna true se cancelou, false se falhou, ou a mensagem de erro.
   */
  private async _cancelOnce(orderId: string, jobId?: number): Promise<{ ok: boolean; retryable: boolean }> {
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
        return { ok: true, retryable: false };
      }

      const message = String(data.message || "");
      // SMSPool retorna "cannot be cancelled yet" quando o pedido é muito recente
      const isRetryable = message.toLowerCase().includes("cannot be cancelled yet") ||
                          message.toLowerCase().includes("try again later");

      return { ok: false, retryable: isRetryable };
    } catch {
      // Erros de rede são retryable
      return { ok: false, retryable: true };
    }
  }

  /**
   * Cancela um pedido SMS no SMSPool com retry automático.
   * O SMSPool tem um cooldown de ~40s após a compra onde o cancelamento
   * não é permitido ("Your order cannot be cancelled yet, please try again later.").
   * Este método aguarda o cooldown e faz até 2 tentativas para garantir o reembolso.
   */
  async cancelSMS(orderId: string, jobId?: number): Promise<boolean> {
    await logger.info("smspool", `Cancelando pedido ${orderId}`, {}, jobId);

    const MAX_RETRIES = 2;
    const DELAYS = [40_000, 15_000]; // 40s (cooldown), 15s (retry extra)

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const result = await this._cancelOnce(orderId, jobId);

      if (result.ok) {
        await logger.info("smspool",
          `Pedido ${orderId} cancelado com sucesso (reembolso confirmado)${attempt > 0 ? ` após ${attempt + 1} tentativas` : ""}`,
          {}, jobId
        );
        return true;
      }

      if (!result.retryable) {
        await logger.warn("smspool",
          `Cancelamento ${orderId} falhou definitivamente (não retryable) na tentativa ${attempt + 1}`,
          {}, jobId
        );
        return false;
      }

      // Se ainda há tentativas, aguardar antes de tentar novamente
      if (attempt < MAX_RETRIES - 1) {
        const delay = DELAYS[attempt];
        await logger.info("smspool",
          `Cancelamento ${orderId}: SMSPool ainda não permite cancelar. Aguardando ${delay / 1000}s antes de tentar novamente (tentativa ${attempt + 1}/${MAX_RETRIES})...`,
          {}, jobId
        );
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    await logger.warn("smspool",
      `Cancelamento ${orderId} falhou após ${MAX_RETRIES} tentativas. Pedido pode não ter sido reembolsado — verifique manualmente no painel SMSPool.`,
      {}, jobId
    );
    return false;
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
   *
   * v10.1: Retry automático quando o número comprado é VoIP/virtual (blacklist)
   * ou quando o Manus rejeita o número com "Failed to send the code".
   * Em vez de abortar toda a tentativa, cancela o número ruim e compra outro.
   * Máximo de MAX_NUMBER_RETRIES trocas de número por chamada.
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
    // v10.1: Máximo de trocas de número por chamada.
    // Cada troca ocorre quando o número comprado é VoIP (blacklist) ou
    // quando o Manus rejeita o número com "Failed to send the code".
    // Verificar bloqueio persistente ANTES de qualquer chamada à API.
    // O bloqueio é gravado no banco quando o SMSPool retorna "too many failed purchases",
    // e sobrevive a restarts do servidor — evitando chamadas desnecessárias durante o período de penalidade.
    const blockedMinutes = await this.getBlockedMinutesRemaining();
    if (blockedMinutes > 0) {
      await logger.warn("smspool",
        `SMSPool bloqueado por excesso de falhas anteriores. Libera em ~${blockedMinutes} minuto(s). Pulando SMSPool.`,
        {}, opts.jobId
      );
      return {
        success: false,
        cost: 0,
        error: new Error(`SMSPool bloqueado por excesso de falhas — libera em ~${blockedMinutes} min`),
        provider: "smspool",
      };
    }

    const MAX_NUMBER_RETRIES = 3;
    let numberData: SMSPoolNumberData | null = null;
    let totalCost = 0;

    for (let numberAttempt = 1; numberAttempt <= MAX_NUMBER_RETRIES; numberAttempt++) {
      numberData = null;

      try {
        // 1. Comprar número
        numberData = await this.orderSMS({
          countryCode: opts.countryCode,
          service: opts.service,
          maxPrice: opts.maxPrice,
          jobId: opts.jobId,
        });

        const cost = parseFloat(numberData.cost || opts.maxPrice);

        // v9.8: Detectar o regionCode REAL do número comprado no SMSPool.
        const resolvedCountryId = this.config.countryId || undefined;
        const detectedRegionCode = this.detectRegionCode(numberData.phoneNumber, resolvedCountryId);

        if (detectedRegionCode !== opts.regionCode) {
          await logger.info("smspool",
            `RegionCode corrigido: ${opts.regionCode} → ${detectedRegionCode} (detectado do número ${numberData.phoneNumber})`,
            {}, opts.jobId
          );
        }

        // 2. Notificar que o número foi alugado (para o provider Manus enviar o código)
        if (opts.onNumberRented) {
          await opts.onNumberRented({
            phoneNumber: numberData.phoneNumber,
            activationId: `smspool:${numberData.orderId}`,
            attempt: opts.attempt,
            regionCode: detectedRegionCode,
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
            cost: totalCost + cost,
            provider: "smspool",
          };
        }

        // 5. Timeout — cancelar e retornar falha (não tenta outro número em timeout)
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

        // Erros fatais — não tenta outro número, propaga imediatamente
        if (error.message.includes("Saldo insuficiente") || error.message.includes("API key inválida") ||
            error.message.includes("Bloqueado por") || error.message.includes("bloqueado por excesso")) {
          throw error;
        }

        // Account banned — cancela o número comprado (recupera saldo) e re-throw
        if (error.message.includes("user is blocked") || error.message.includes("USER_IS_BLOCKED")) {
          if (numberData) {
            await logger.info("smspool",
              `Conta banida — cancelando número ${numberData.phoneNumber} (orderId: ${numberData.orderId}) para recuperar saldo...`,
              {}, opts.jobId
            );
            this.cancelSMS(numberData.orderId, opts.jobId).catch(() => {});
          }
          throw error;
        }

        // v10.1: Rejeição de número pelo Manus ("Failed to send the code").
        // Em vez de abortar, cancela o número ruim e tenta comprar outro.
        const isTargetRejection = error.message.includes("Failed to send the code");
        if (isTargetRejection && numberAttempt < MAX_NUMBER_RETRIES) {
          await logger.warn("smspool",
            `Número ${numberData?.phoneNumber || "desconhecido"} rejeitado pelo Manus. ` +
            `Cancelando e tentando outro número (${numberAttempt}/${MAX_NUMBER_RETRIES})...`,
            {}, opts.jobId
          );
          if (numberData) {
            const oidRej = numberData.orderId;
            const jidRej = opts.jobId;
            this.cancelSMS(oidRej, jidRej).catch(() => {});
          }
          continue; // Tenta comprar outro número
        }

        // Outros erros (rede, estoque, etc.) — cancela e retorna falha
        if (numberData) {
          const oid = numberData.orderId;
          const jid = opts.jobId;
          this.cancelSMS(oid, jid).catch(() => {});
        }

        const isProxyError =
          error.message.includes("ECONNRESET") ||
          error.message.includes("ECONNREFUSED") ||
          error.message.includes("ETIMEDOUT") ||
          error.message.includes("fetch failed");

        await logger.warn("smspool",
          `Tentativa ${opts.attempt} falhou (número ${numberAttempt}/${MAX_NUMBER_RETRIES}): ${error.message}`,
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

    // Esgotou todas as trocas de número sem sucesso
    await logger.warn("smspool",
      `Esgotadas ${MAX_NUMBER_RETRIES} trocas de número sem sucesso (todos VoIP ou rejeitados).`,
      {}, opts.jobId
    );
    return {
      success: false,
      cost: 0,
      error: new Error(`SMSPool: Todos os ${MAX_NUMBER_RETRIES} números tentados foram VoIP ou rejeitados pelo Manus`),
      wasTargetRejection: true,
      provider: "smspool",
    };
  }
}

// ============================================================
// SINGLETON EXPORT
// ============================================================

export const smsPoolProvider = new SMSPoolProvider();
