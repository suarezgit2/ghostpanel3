/**
 * Auto-seed defaults on first boot.
 * Runs once when the server starts — creates the Manus provider
 * and default settings if they don't exist yet.
 */

import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { settings, providers } from "../../drizzle/schema";
import { setSetting } from "./settings";

export async function autoSeedDefaults(): Promise<void> {
  const db = await getDb();
  if (!db) {
    console.log("[AutoSeed] Database não disponível, pulando seed");
    return;
  }

  // Check if already seeded (provider exists)
  const existingProviders = await db.select().from(providers).limit(1);
  if (existingProviders.length > 0) {
    console.log("[AutoSeed] Defaults já existem, pulando seed");
    return;
  }

  console.log("[AutoSeed] Primeiro boot detectado, criando defaults...");

  // Seed default provider
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

  // Seed default settings
  const defaultSettings = [
    { key: "email_domain", value: "lojasmesh.com", description: "Domínio catch-all para emails" },
    { key: "sms_country", value: "6", description: "Código do país SMS (6=Indonesia)" },
    { key: "sms_service", value: "ot", description: "Código do serviço SMS (ot=Other)" },
    { key: "sms_max_price", value: "0.01", description: "Preço máximo por número SMS ($)" },
    { key: "sms_provider_ids", value: "", description: "IDs dos provedores SMS legado (vazio quando multi-país ativo)" },
    { key: "sms_max_retries", value: "3", description: "Máximo de tentativas SMS" },
    { key: "sms_wait_time", value: "120", description: "Tempo de espera por SMS (segundos)" },
    { key: "sms_poll_interval", value: "5", description: "Intervalo de polling SMS (segundos)" },
    { key: "sms_retry_delay_min", value: "3", description: "Delay mínimo entre retries (segundos)" },
    { key: "sms_retry_delay_max", value: "8", description: "Delay máximo entre retries (segundos)" },
    { key: "sms_cancel_wait", value: "125", description: "Tempo mínimo antes de cancelar (segundos)" },
    { key: "sms_auto_discover", value: "false", description: "Auto-descobrir provedores via getPricesV3" },
    { key: "sms_countries", value: JSON.stringify([
      { countryCode: "6",  regionCode: "+62", name: "Indonesia",   maxPrice: "0.022", providerIds: [], enabled: true },
      { countryCode: "73", regionCode: "+55", name: "Brazil",      maxPrice: "0.02",  providerIds: [], enabled: true },
      { countryCode: "33", regionCode: "+57", name: "Colombia",    maxPrice: "0.02",  providerIds: [], enabled: true },
      { countryCode: "46", regionCode: "+46", name: "Sweden",      maxPrice: "0.02",  providerIds: [], enabled: true },
      { countryCode: "48", regionCode: "+31", name: "Netherlands", maxPrice: "0.02",  providerIds: [], enabled: true },
    ]), description: "Configuração multi-país SMS (JSON)" },
    // v9.7: SMSPool — segunda API de SMS (desabilitada por padrão)
    { key: "smspool_enabled", value: "false", description: "SMSPool: habilitado/desabilitado" },
    { key: "smspool_api_key", value: "", description: "SMSPool: API key" },
    { key: "smspool_service_id", value: "", description: "SMSPool: ID do serviço (vazio = auto)" },
    { key: "smspool_country_id", value: "", description: "SMSPool: ID do país (vazio = auto)" },
    { key: "smspool_max_price", value: "0.50", description: "SMSPool: preço máximo por número" },
    { key: "smspool_pool", value: "", description: "SMSPool: pool preferida (vazio = auto)" },
    { key: "smspool_priority", value: "secondary", description: "SMSPool: prioridade (primary/secondary)" },
  ];

  for (const s of defaultSettings) {
    const existing = await db.select().from(settings).where(eq(settings.key, s.key)).limit(1);
    if (existing.length === 0) {
      await setSetting(s.key, s.value, s.description);
    }
  }

  console.log("[AutoSeed] Defaults criados com sucesso!");
}
