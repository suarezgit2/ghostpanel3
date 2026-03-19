/**
 * Ghost - Settings Helpers
 * Carrega e gerencia configurações dinâmicas do banco de dados
 */

import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { settings } from "../../drizzle/schema";
import { ENV } from "../_core/env";

// Env var fallbacks for API keys (DB settings override these)
const ENV_FALLBACKS: Record<string, string> = {
  capsolver_api_key: ENV.capsolverApiKey,
  smsbower_api_key: ENV.smsbowerApiKey,
  webshare_api_key: ENV.webshareApiKey,
  zoho_client_id: ENV.zohoClientId,
  zoho_client_secret: ENV.zohoClientSecret,
  zoho_refresh_token: ENV.zohoRefreshToken,
  zoho_account_id: ENV.zohoAccountId,
  email_domain: "lojasmesh.com",
};

// In-memory cache with TTL
const cache = new Map<string, { value: string; expiresAt: number }>();
const CACHE_TTL = 60_000; // 1 minute

export async function getSetting(key: string): Promise<string | null> {
  // Check cache first
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  try {
    const db = await getDb();
    if (db) {
      const result = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
      if (result.length > 0) {
        const value = result[0].value;
        cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL });
        return value;
      }
    }
  } catch {
    // DB not available, fall through to env fallback
  }

  // Fallback to environment variable
  const envFallback = ENV_FALLBACKS[key];
  if (envFallback) {
    cache.set(key, { value: envFallback, expiresAt: Date.now() + CACHE_TTL });
    return envFallback;
  }

  return null;
}

export async function setSetting(key: string, value: string, description?: string): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const existing = await db.select().from(settings).where(eq(settings.key, key)).limit(1);

  if (existing.length > 0) {
    await db.update(settings).set({ value, ...(description ? { description } : {}) }).where(eq(settings.key, key));
  } else {
    await db.insert(settings).values({ key, value, description: description || null });
  }

  // Update cache
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL });
}

export async function getAllSettings(): Promise<Record<string, string>> {
  const db = await getDb();
  if (!db) return {};

  const result = await db.select().from(settings);
  const map: Record<string, string> = {};
  for (const row of result) {
    map[row.key] = row.value;
  }
  return map;
}

export function clearSettingsCache(): void {
  cache.clear();
}
