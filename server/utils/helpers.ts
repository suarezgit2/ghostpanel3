/**
 * Ghost - Utility Helpers
 * delay, nanoid, dcr-encoder, logger
 */

import crypto from "crypto";
import { getDb } from "../db";
import { logs } from "../../drizzle/schema";

// ============================================================
// DELAY
// ============================================================

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function randomDelay(minMs: number, maxMs: number): Promise<void> {
  const delay = minMs + Math.random() * (maxMs - minMs);
  return sleep(Math.round(delay));
}

export function gaussianDelay(meanMs: number, stdDevMs: number, minMs?: number, maxMs?: number): Promise<void> {
  const u1 = Math.random();
  const u2 = Math.random();
  const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  let delay = meanMs + z0 * stdDevMs;
  if (minMs !== undefined) delay = Math.max(delay, minMs);
  if (maxMs !== undefined) delay = Math.min(delay, maxMs);
  return sleep(Math.round(delay));
}

export const STEP_DELAYS = {
  afterTurnstile: () => gaussianDelay(2000, 800, 1000, 4000),
  afterEmailCheck: () => gaussianDelay(1500, 500, 800, 3000),
  afterEmailCodeSent: () => gaussianDelay(3000, 1000, 1500, 6000),
  afterEmailCodeReceived: () => gaussianDelay(4000, 1500, 2000, 8000),
  afterRegistration: () => gaussianDelay(8000, 3000, 4000, 15000),
  afterSmsSent: () => gaussianDelay(2000, 800, 1000, 4000),
  afterSmsCodeReceived: () => gaussianDelay(3000, 1000, 1500, 6000),
  betweenAccounts: () => gaussianDelay(5000, 2000, 3000, 10000),
};

// ============================================================
// NANOID
// ============================================================

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export function generateClientId(length = 22): string {
  const bytes = crypto.randomBytes(length);
  let id = "";
  for (let i = 0; i < length; i++) {
    id += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return id;
}

export function generateRandomString(length: number, charset?: string): string {
  const chars = charset || ALPHABET;
  const bytes = crypto.randomBytes(length);
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
}

export function generatePassword(length = 16): string {
  const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%&*";
  return generateRandomString(length, charset);
}

export function generateEmailPrefix(length = 10): string {
  const charset = "abcdefghijklmnopqrstuvwxyz0123456789";
  return generateRandomString(length, charset);
}

// ============================================================
// DCR ENCODER
// ============================================================

export function encodeDCR(jsonString: string): string {
  const base64 = Buffer.from(jsonString).toString("base64");
  let encoded = "";
  for (let i = 0; i < base64.length; i++) {
    const c = base64.charCodeAt(i);
    if (c >= 65 && c <= 90) {
      encoded += String.fromCharCode(((c - 65 + 3) % 26) + 65);
    } else if (c >= 97 && c <= 122) {
      encoded += String.fromCharCode(((c - 97 + 3) % 26) + 97);
    } else if (c >= 48 && c <= 57) {
      encoded += String.fromCharCode(((c - 48 + 3) % 10) + 48);
    } else {
      encoded += base64[i];
    }
  }
  return encoded;
}

// ============================================================
// LOGGER
// ============================================================

export const logger = {
  async info(source: string, message: string, details: Record<string, unknown> = {}, jobId?: number) {
    const ts = new Date().toISOString();
    console.log(`[${ts}] [INFO] [${source}] ${message}`);
    await _saveLog("info", source, message, details, jobId);
  },
  async warn(source: string, message: string, details: Record<string, unknown> = {}, jobId?: number) {
    const ts = new Date().toISOString();
    console.warn(`[${ts}] [WARN] [${source}] ${message}`);
    await _saveLog("warn", source, message, details, jobId);
  },
  async error(source: string, message: string, details: Record<string, unknown> = {}, jobId?: number) {
    const ts = new Date().toISOString();
    console.error(`[${ts}] [ERROR] [${source}] ${message}`);
    await _saveLog("error", source, message, details, jobId);
  },
};

async function _saveLog(
  level: "info" | "warn" | "error" | "debug",
  source: string,
  message: string,
  details: Record<string, unknown>,
  jobId?: number
) {
  try {
    const db = await getDb();
    if (!db) return;
    await db.insert(logs).values({
      level,
      source,
      message: message.substring(0, 500),
      details,
      jobId: jobId || null,
    });
  } catch (_) {
    // Silently fail - don't break the flow for logging
  }
}
