/**
 * Ghost - Utility Helpers
 * delay, nanoid, dcr-encoder, logger
 *
 * ANTI-DETECTION IMPROVEMENTS (v4.2):
 * - generateEmailPrefix: generates human-like email prefixes (name patterns)
 * - generatePassword: generates human-like passwords (word+number+symbol)
 * - betweenAccounts delay increased to 30-120s (more realistic)
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
  // ANTI-DETECTION: Increased from 5-10s to 30-120s between account creations
  // A human would take minutes between registrations; 5s is clearly a bot
  betweenAccounts: () => gaussianDelay(60000, 25000, 30000, 120000),
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

/**
 * Generate a human-like password.
 * Pattern: Word + Number(2-4 digits) + Symbol
 * Examples: "Sunrise42!", "Dragon2024#", "Coffee7$"
 *
 * ANTI-DETECTION: Humans don't use fully random passwords.
 * They typically combine a word, number, and symbol.
 */
export function generatePassword(length = 16): string {
  const words = [
    "Sunrise", "Dragon", "Coffee", "Shadow", "Phoenix", "Thunder", "Crystal",
    "Falcon", "Mystic", "Ranger", "Silver", "Golden", "Cosmic", "Brave",
    "Storm", "Blaze", "Frost", "River", "Eagle", "Tiger", "Ninja", "Comet",
    "Pixel", "Turbo", "Omega", "Alpha", "Delta", "Sigma", "Vortex", "Nexus",
  ];
  const symbols = ["!", "@", "#", "$", "%", "&", "*", "?"];
  const word = words[Math.floor(Math.random() * words.length)];
  const num = String(Math.floor(Math.random() * 9000) + 1000); // 4-digit number
  const sym = symbols[Math.floor(Math.random() * symbols.length)];

  // Shuffle the pattern slightly: word+num+sym or word+sym+num
  const password = Math.random() > 0.5 ? `${word}${num}${sym}` : `${word}${sym}${num}`;

  // If password is shorter than requested, pad with random chars
  if (password.length < length) {
    const extra = generateRandomString(length - password.length, "abcdefghijklmnopqrstuvwxyz0123456789");
    return password + extra;
  }
  return password.substring(0, length);
}

/**
 * Generate a human-like email prefix.
 * Patterns:
 *   - firstname.lastname (e.g., "john.smith")
 *   - firstname + number (e.g., "sarah92")
 *   - firstname_lastname (e.g., "mike_jones")
 *   - nickname (e.g., "cooldragon99")
 *
 * ANTI-DETECTION: Random alphanumeric strings like "a3bx9kq2mz4p" are
 * immediately recognizable as bot-generated. Human email prefixes follow
 * name-based or nickname patterns.
 */
export function generateEmailPrefix(_length = 10): string {
  const firstNames = [
    "james", "john", "robert", "michael", "william", "david", "richard", "joseph",
    "thomas", "charles", "mary", "patricia", "jennifer", "linda", "barbara",
    "elizabeth", "susan", "jessica", "sarah", "karen", "emma", "olivia", "ava",
    "isabella", "sophia", "mia", "charlotte", "amelia", "harper", "evelyn",
    "liam", "noah", "oliver", "elijah", "lucas", "mason", "ethan", "aiden",
    "alex", "chris", "sam", "taylor", "jordan", "casey", "morgan", "riley",
    "drew", "blake", "skyler", "quinn", "reese", "avery", "logan", "ryan",
  ];
  const lastNames = [
    "smith", "johnson", "williams", "brown", "jones", "garcia", "miller",
    "davis", "wilson", "anderson", "taylor", "thomas", "jackson", "white",
    "harris", "martin", "thompson", "young", "allen", "king", "wright",
    "scott", "green", "baker", "adams", "nelson", "hill", "carter", "mitchell",
  ];
  const nickPrefixes = [
    "cool", "dark", "fast", "wild", "epic", "pro", "super", "mega", "ultra",
    "neo", "cyber", "tech", "pixel", "turbo", "hyper", "alpha", "omega",
  ];
  const nickSuffixes = [
    "dragon", "wolf", "fox", "hawk", "storm", "blade", "fire", "ice",
    "shadow", "ghost", "ninja", "ranger", "hunter", "rider", "master",
  ];

  const pattern = Math.floor(Math.random() * 5);
  const fn = firstNames[Math.floor(Math.random() * firstNames.length)];
  const ln = lastNames[Math.floor(Math.random() * lastNames.length)];
  const num = Math.floor(Math.random() * 999) + 1;

  switch (pattern) {
    case 0: return `${fn}.${ln}`;                              // john.smith
    case 1: return `${fn}${num}`;                              // sarah92
    case 2: return `${fn}_${ln}`;                              // mike_jones
    case 3: {                                                   // john.smith42
      const n = Math.floor(Math.random() * 99) + 1;
      return `${fn}.${ln}${n}`;
    }
    case 4: {                                                   // cooldragon99
      const np = nickPrefixes[Math.floor(Math.random() * nickPrefixes.length)];
      const ns = nickSuffixes[Math.floor(Math.random() * nickSuffixes.length)];
      const n = Math.floor(Math.random() * 99) + 1;
      return `${np}${ns}${n}`;
    }
    default: return `${fn}${num}`;
  }
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
