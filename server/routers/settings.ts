/**
 * Settings Router - Configurações dinâmicas do sistema
 * Valores sensíveis são mascarados na listagem
 */

import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { router, protectedProcedure } from "../_core/trpc";
import { getDb } from "../db";
import { settings, providers } from "../../drizzle/schema";
import { getAllSettings, setSetting, clearSettingsCache } from "../utils/settings";
import { smsService, CountryConfig, KNOWN_COUNTRIES } from "../services/sms";
// v6.0: FPJS Direct Client (HTTP POST) replaces Puppeteer-based fpjsService
// import { fpjsService } from "../services/fpjs";

// Keys que contêm dados sensíveis e devem ser mascaradas na listagem
const SENSITIVE_KEYS = new Set([
  "capsolver_api_key",
  "twocaptcha_api_key",
  "smsbower_api_key",
  "webshare_api_key",
  "zoho_client_id",
  "zoho_client_secret",
  "zoho_refresh_token",
  "admin_password_hash",
]);

/**
 * Mascara um valor sensível mostrando apenas os últimos 4 caracteres.
 * Retorna null para indicar ao frontend que o campo está mascarado.
 */
function maskSensitiveValue(key: string, value: string): string {
  if (!SENSITIVE_KEYS.has(key)) return value;
  if (!value || value.length <= 4) return "****";
  return "****" + value.slice(-4);
}

/**
 * Detecta se um valor é um valor mascarado (começa com "****").
 * Valores mascarados NÃO devem ser salvos no banco — eles são apenas para exibição.
 */
function isMaskedValue(value: string): boolean {
  return value.startsWith("****");
}

export const settingsRouter = router({
  list: protectedProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];

    const rows = await db.select().from(settings).orderBy(settings.key);

    // Mascarar valores sensíveis
    return rows.map((row) => ({
      ...row,
      value: maskSensitiveValue(row.key, row.value),
    }));
  }),

  getAll: protectedProcedure.query(async () => {
    const allSettings = await getAllSettings();

    // Mascarar valores sensíveis no mapa
    const masked: Record<string, string> = {};
    for (const [key, value] of Object.entries(allSettings)) {
      masked[key] = maskSensitiveValue(key, value as string);
    }
    return masked;
  }),

  set: protectedProcedure
    .input(z.object({
      key: z.string(),
      value: z.string(),
      description: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      // PROTEÇÃO: nunca salvar um valor mascarado — isso corromperia a credencial real
      if (SENSITIVE_KEYS.has(input.key) && isMaskedValue(input.value)) {
        return { success: true, skipped: true, reason: "Valor mascarado ignorado — credencial não alterada" };
      }
      await setSetting(input.key, input.value, input.description);
      return { success: true, skipped: false };
    }),

  setBulk: protectedProcedure
    .input(z.array(z.object({
      key: z.string(),
      value: z.string(),
      description: z.string().optional(),
    })))
    .mutation(async ({ input }) => {
      let saved = 0;
      let skipped = 0;

      // v9.5.2: Chaves gerenciadas por mutations específicas (blacklist, health, countries).
      // setBulk NÃO deve sobrescrever esses valores para evitar race conditions.
      const MANAGED_KEYS = new Set([
        "sms_blacklisted_providers",
        "sms_provider_health",
        "sms_number_quality",
        "sms_countries",
        "sms_provider_ids",
      ]);

      for (const item of input) {
        // PROTEÇÃO: pular valores mascarados para não sobrescrever credenciais reais
        if (SENSITIVE_KEYS.has(item.key) && isMaskedValue(item.value)) {
          skipped++;
          continue;
        }
        // v9.5.2: pular chaves gerenciadas automaticamente
        if (MANAGED_KEYS.has(item.key)) {
          skipped++;
          continue;
        }
        await setSetting(item.key, item.value, item.description);
        saved++;
      }

      return { success: true, count: saved, skipped };
    }),

  delete: protectedProcedure
    .input(z.object({ key: z.string() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database não disponível");

      await db.delete(settings).where(eq(settings.key, input.key));
      clearSettingsCache();
      return { success: true };
    }),

  // SMS-specific settings
  getSmsConfig: protectedProcedure.query(async () => {
    return await smsService.getConfig();
  }),

  reloadSmsConfig: protectedProcedure.mutation(async () => {
    await smsService.reloadConfig();
    return { success: true };
  }),

  /**
   * Retorna o health summary dos provedores SMS (scores, cooldowns, taxa de sucesso)
   */
  getSmsHealth: protectedProcedure.query(async () => {
    return smsService.getProviderHealthSummary();
  }),

  /**
   * Reseta o health tracker dos provedores SMS (útil após mudança de configuração)
   */
  resetSmsHealth: protectedProcedure.mutation(async () => {
    smsService.resetProviderHealth();
    return { success: true, message: "Health tracker dos provedores SMS resetado" };
  }),

  /**
   * Retorna a blacklist de provedores SMS banidos permanentemente
   */
  getSmsBlacklist: protectedProcedure.query(async () => {
    const blacklist = await smsService.getBlacklist();
    return { blacklist };
  }),

  /**
   * Limpa a blacklist de provedores SMS e reseta o health tracker
   */
  clearSmsBlacklist: protectedProcedure.mutation(async () => {
    await smsService.clearBlacklist();
    return { success: true, message: "Blacklist e health dos provedores SMS limpos" };
  }),

  /**
   * Descobre provedores disponíveis via getPricesV3 e atualiza a lista manual no banco
   */
  discoverAndUpdateSmsProviders: protectedProcedure.mutation(async () => {
    const result = await smsService.discoverAndUpdateProviderList();
    if (result.updated) {
      return {
        success: true,
        providers: result.providers,
        message: `Lista atualizada com ${result.providers.length} provedores: [${result.providers.join(", ")}]`,
      };
    }
    return {
      success: false,
      providers: [],
      message: "Nenhum provedor encontrado dentro do preço máximo configurado",
    };
  }),

  /**
   * Retorna a lista de países configurados para SMS
   */
  getSmsCountries: protectedProcedure.query(async () => {
    const countries = await smsService.getCountries();
    return { countries, knownCountries: KNOWN_COUNTRIES };
  }),

  /**
   * Salva a lista de países configurados para SMS
   */
  saveSmsCountries: protectedProcedure
    .input(z.object({
      countries: z.array(z.object({
        countryCode: z.string(),
        regionCode: z.string(),
        name: z.string(),
        maxPrice: z.string(),
        providerIds: z.array(z.number()),
        enabled: z.boolean(),
      }))
    }))
    .mutation(async ({ input }) => {
      await smsService.saveCountries(input.countries as CountryConfig[]);
      return { success: true, message: `${input.countries.length} país(es) salvos` };
    }),

  /**
   * Descobre provedores para um país específico e atualiza a lista desse país
   */
  discoverProvidersForCountry: protectedProcedure
    .input(z.object({
      countryCode: z.string(),
      maxPrice: z.string(),
    }))
    .mutation(async ({ input }) => {
      const config = await smsService.getConfig();
      const result = await smsService.discoverAndUpdateProviderList(input.countryCode, input.maxPrice);
      if (result.updated) {
        // Se multi-país configurado, atualiza os providerIds do país específico
        const countries = await smsService.getCountries();
        const updatedCountries = countries.map(c =>
          c.countryCode === input.countryCode
            ? { ...c, providerIds: result.providers }
            : c
        );
        if (config.countries.length > 0) {
          await smsService.saveCountries(updatedCountries);
        }
        return {
          success: true,
          providers: result.providers,
          message: `${result.providers.length} provedores encontrados para código ${input.countryCode}: [${result.providers.join(", ")}]`,
        };
      }
      return {
        success: false,
        providers: [],
        message: `Nenhum provedor encontrado para código ${input.countryCode} dentro do preço $${input.maxPrice}`,
      };
    }),

  // Providers management
  listProviders: protectedProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];

    return await db.select().from(providers).orderBy(providers.id);
  }),

  seedDefaults: protectedProcedure.mutation(async () => {
    const db = await getDb();
    if (!db) throw new Error("Database não disponível");

    // Seed default provider
    const existingProviders = await db.select().from(providers).limit(1);
    if (existingProviders.length === 0) {
      await db.insert(providers).values({
        slug: "manus",
        name: "Manus.im",
        baseUrl: "https://manus.im",
        enabled: true,
        config: {
          loginUrl: "https://manus.im/login",
          turnstileSiteKey: "0x4AAAAAAA_sd0eRNCinWBgU",
          emailFromDomain: "manus.im",
          smsRegionCode: "+62",
          smsLocale: "en",
        },
      });
    }

    // Seed default settings
    const defaultSettings = [
      { key: "email_domain", value: "lojasmesh.com", description: "Domínio catch-all para emails" },
      { key: "sms_country", value: "6", description: "Código do país SMS (6=Indonesia)" },
      { key: "sms_service", value: "ot", description: "Código do serviço SMS (ot=Other)" },
      { key: "sms_max_price", value: "0.01", description: "Preço máximo por número SMS ($)" },
      { key: "sms_provider_ids", value: "2295,3291,2482,1507,3250,3027,2413", description: "IDs dos provedores SMS (Gold $0.01)" },
      { key: "sms_max_retries", value: "3", description: "Máximo de tentativas SMS" },
      { key: "sms_wait_time", value: "120", description: "Tempo de espera por SMS (segundos)" },
      { key: "sms_poll_interval", value: "5", description: "Intervalo de polling SMS (segundos)" },
      { key: "sms_retry_delay_min", value: "3", description: "Delay mínimo entre retries (segundos)" },
      { key: "sms_retry_delay_max", value: "8", description: "Delay máximo entre retries (segundos)" },
      { key: "sms_cancel_wait", value: "125", description: "Tempo mínimo antes de cancelar (segundos)" },
      { key: "sms_auto_discover", value: "false", description: "Auto-descobrir provedores via getPricesV3" },
      { key: "invite_code", value: "", description: "Código de convite para novas contas (+500 créditos)" },
      { key: "proxy_auto_replace", value: "false", description: "Substituir proxies automaticamente via Webshare quando todos forem usados" },
      { key: "proxy_blocked_countries", value: "", description: "Lista de países bloqueados para proxy (ex: ID,BR,US)" },
    ];

    for (const s of defaultSettings) {
      const existing = await db.select().from(settings).where(eq(settings.key, s.key)).limit(1);
      if (existing.length === 0) {
        await setSetting(s.key, s.value, s.description);
      }
    }

    return { success: true, message: "Defaults seeded" };
  }),

  /**
   * Retorna o status do serviço FPJS (v6.0: Direct HTTP POST, sem Puppeteer)
   */
  getFpjsStatus: protectedProcedure.query(async () => {
    return {
      available: true, // v6.0: FPJS Direct Client sempre disponível (sem dependência de Chromium)
      mode: "direct-post",
      description: "FPJS Direct Client v6.0 — HTTP POST com XOR obfuscation (sem Puppeteer)",
    };
  }),

  /**
   * Testa o FPJS Direct Client gerando um requestId real
   */
  refillFpjsPool: protectedProcedure.mutation(async () => {
    try {
      const { getRequestIdDirect } = await import("../services/fpjsDirectClient");
      const { fingerprintService } = await import("../services/fingerprint");
      const profile = fingerprintService.generateProfile();
      const requestId = await getRequestIdDirect(profile);
      return { success: true, requestId, mode: "direct-post" };
    } catch (err) {
      return { success: false, message: `FPJS Direct falhou: ${err instanceof Error ? err.message : String(err)}` };
    }
  }),
});
