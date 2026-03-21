/**
 * Ghost - Utility Helpers
 * delay, nanoid, dcr-encoder, logger
 *
 * v8.0 CHANGES (Anti-Detection Hardening):
 * - generatePassword: Expanded from 30 to 150 words, added more patterns
 *   (word+year, word+birthday, etc.) to reduce statistical density
 * - generateEmailPrefix: Expanded from 54/29 to 200+/120+ names,
 *   added international names, more patterns (initials, year-based, etc.)
 * - Total combinatorial space increased from ~2M to ~500M+
 */

import crypto from "crypto";
import { getDb } from "../db";
import { logs } from "../../drizzle/schema";

// ============================================================
// DELAY
// ============================================================

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * Throws AbortError if signal is already aborted.
 * Use as a checkpoint between steps to bail out early.
 */
export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

export function randomDelay(minMs: number, maxMs: number, signal?: AbortSignal): Promise<void> {
  const delay = minMs + Math.random() * (maxMs - minMs);
  return sleep(Math.round(delay), signal);
}

export function gaussianDelay(meanMs: number, stdDevMs: number, minMs?: number, maxMs?: number, signal?: AbortSignal): Promise<void> {
  const u1 = Math.random();
  const u2 = Math.random();
  const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  let delay = meanMs + z0 * stdDevMs;
  if (minMs !== undefined) delay = Math.max(delay, minMs);
  if (maxMs !== undefined) delay = Math.min(delay, maxMs);
  return sleep(Math.round(delay), signal);
}

export const STEP_DELAYS = {
  afterTurnstile: (signal?: AbortSignal) => gaussianDelay(2000, 800, 1000, 4000, signal),
  afterEmailCheck: (signal?: AbortSignal) => gaussianDelay(1500, 500, 800, 3000, signal),
  afterEmailCodeSent: (signal?: AbortSignal) => gaussianDelay(3000, 1000, 1500, 6000, signal),
  afterEmailCodeReceived: (signal?: AbortSignal) => gaussianDelay(4000, 1500, 2000, 8000, signal),
  afterRegistration: (signal?: AbortSignal) => gaussianDelay(8000, 3000, 4000, 15000, signal),
  afterSmsSent: (signal?: AbortSignal) => gaussianDelay(2000, 800, 1000, 4000, signal),
  afterSmsCodeReceived: (signal?: AbortSignal) => gaussianDelay(3000, 1000, 1500, 6000, signal),
  betweenAccounts: (signal?: AbortSignal) => gaussianDelay(60000, 25000, 30000, 120000, signal),
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
 * v8.0: Expanded to 150 words and 8 patterns to increase combinatorial space.
 *
 * Patterns (weighted):
 *   - Word + 4-digit number + symbol (30%): "Sunrise4521!"
 *   - Word + symbol + 4-digit number (15%): "Dragon!2024"
 *   - Word + year (15%): "Coffee2024"
 *   - Word + 2-digit + symbol + word (10%): "Storm42!Fire"
 *   - Uppercase word + lowercase word + number (10%): "SilverFox99"
 *   - Word + birthday-style (10%): "Phoenix0315"
 *   - Word + 3-digit + symbol (5%): "Crystal789#"
 *   - Two words + symbol (5%): "ThunderStorm!"
 *
 * Total space: ~150 * 9000 * 8 * 8 patterns ≈ 500M+ combinations
 */
export function generatePassword(length = 16): string {
  const words = [
    // Nature & Weather (30)
    "Sunrise", "Sunset", "Thunder", "Storm", "Blaze", "Frost", "River", "Ocean",
    "Mountain", "Forest", "Meadow", "Valley", "Canyon", "Desert", "Glacier",
    "Aurora", "Breeze", "Tempest", "Cascade", "Horizon", "Eclipse", "Solstice",
    "Monsoon", "Cyclone", "Tornado", "Tsunami", "Volcano", "Avalanche", "Wildfire", "Rainbow",
    // Animals (25)
    "Dragon", "Phoenix", "Eagle", "Tiger", "Falcon", "Wolf", "Panther", "Cobra",
    "Hawk", "Raven", "Dolphin", "Jaguar", "Mustang", "Viper", "Griffin",
    "Scorpion", "Sparrow", "Condor", "Leopard", "Stallion", "Buffalo", "Coyote",
    "Mantis", "Osprey", "Pelican",
    // Tech & Sci-Fi (25)
    "Pixel", "Turbo", "Omega", "Alpha", "Delta", "Sigma", "Nexus", "Cyber",
    "Quantum", "Photon", "Neutron", "Proton", "Vector", "Matrix", "Binary",
    "Cipher", "Vertex", "Prism", "Helix", "Quasar", "Nebula", "Pulsar",
    "Plasma", "Fusion", "Orbital",
    // Everyday Objects (25)
    "Coffee", "Crystal", "Silver", "Golden", "Shadow", "Mystic", "Cosmic",
    "Brave", "Comet", "Ranger", "Ninja", "Vortex", "Beacon", "Anchor",
    "Compass", "Lantern", "Marble", "Velvet", "Copper", "Bronze", "Ivory",
    "Obsidian", "Sapphire", "Emerald", "Diamond",
    // Abstract & Emotions (25)
    "Spirit", "Zenith", "Serenity", "Harmony", "Valor", "Triumph", "Legacy",
    "Fortune", "Destiny", "Liberty", "Justice", "Wisdom", "Courage", "Honor",
    "Glory", "Victory", "Passion", "Radiant", "Stellar", "Infinite", "Eternal",
    "Supreme", "Majestic", "Phantom", "Enigma",
    // Colors & Elements (20)
    "Crimson", "Azure", "Scarlet", "Indigo", "Amber", "Cobalt", "Titanium",
    "Carbon", "Neon", "Chrome", "Platinum", "Mercury", "Onyx", "Jade",
    "Ruby", "Topaz", "Garnet", "Opal", "Pearl", "Coral",
  ];

  const symbols = ["!", "@", "#", "$", "%", "&", "*", "?", "^", "+", "=", "~"];

  const word1 = words[Math.floor(Math.random() * words.length)];
  const word2 = words[Math.floor(Math.random() * words.length)];
  const sym = symbols[Math.floor(Math.random() * symbols.length)];
  const num4 = String(Math.floor(Math.random() * 9000) + 1000); // 4-digit
  const num3 = String(Math.floor(Math.random() * 900) + 100);   // 3-digit
  const num2 = String(Math.floor(Math.random() * 90) + 10);     // 2-digit
  const year = String(Math.floor(Math.random() * 8) + 2018);    // 2018-2025
  const month = String(Math.floor(Math.random() * 12) + 1).padStart(2, "0");
  const day = String(Math.floor(Math.random() * 28) + 1).padStart(2, "0");

  const pattern = Math.random();
  let password: string;

  if (pattern < 0.30) {
    password = `${word1}${num4}${sym}`;
  } else if (pattern < 0.45) {
    password = `${word1}${sym}${num4}`;
  } else if (pattern < 0.60) {
    password = `${word1}${year}`;
  } else if (pattern < 0.70) {
    password = `${word1}${num2}${sym}${word2}`;
  } else if (pattern < 0.80) {
    password = `${word1}${word2}${num2}`;
  } else if (pattern < 0.90) {
    password = `${word1}${month}${day}`;
  } else if (pattern < 0.95) {
    password = `${word1}${num3}${sym}`;
  } else {
    password = `${word1}${word2}${sym}`;
  }

  if (password.length < length) {
    const extra = generateRandomString(length - password.length, "abcdefghijklmnopqrstuvwxyz0123456789");
    return password + extra;
  }
  return password.substring(0, length);
}

/**
 * Generate a human-like email prefix.
 * v8.0: Expanded to 200+ first names, 120+ last names, added international names
 * and more patterns (initials, year-based, profession-based).
 *
 * Patterns (weighted):
 *   - firstname.lastname (20%): "john.smith"
 *   - firstname + number (15%): "sarah92"
 *   - firstname_lastname (10%): "mike_jones"
 *   - firstname.lastname + number (15%): "john.smith42"
 *   - nickname (10%): "cooldragon99"
 *   - initial + lastname + number (10%): "jsmith42"
 *   - firstname + year (10%): "sarah2024"
 *   - firstname.initial + lastname (5%): "j.smith"
 *   - profession + name (5%): "dev.sarah"
 *
 * Total space: ~200 * 120 * 999 * 9 patterns ≈ 200M+ combinations
 */
export function generateEmailPrefix(_length = 10): string {
  const firstNames = [
    // English Male (50)
    "james", "john", "robert", "michael", "william", "david", "richard", "joseph",
    "thomas", "charles", "daniel", "matthew", "anthony", "mark", "donald",
    "steven", "paul", "andrew", "joshua", "kenneth", "kevin", "brian",
    "george", "timothy", "ronald", "edward", "jason", "jeffrey", "ryan",
    "jacob", "gary", "nicholas", "eric", "jonathan", "stephen", "larry",
    "justin", "scott", "brandon", "benjamin", "samuel", "raymond", "gregory",
    "frank", "alexander", "patrick", "jack", "dennis", "jerry", "tyler",
    // English Female (50)
    "mary", "patricia", "jennifer", "linda", "barbara", "elizabeth", "susan",
    "jessica", "sarah", "karen", "emma", "olivia", "ava", "isabella",
    "sophia", "mia", "charlotte", "amelia", "harper", "evelyn", "abigail",
    "emily", "madison", "chloe", "grace", "victoria", "penelope", "riley",
    "layla", "zoey", "nora", "lily", "eleanor", "hannah", "lillian",
    "addison", "aubrey", "stella", "natalie", "zoe", "leah", "hazel",
    "violet", "aurora", "savannah", "audrey", "brooklyn", "bella", "claire", "skylar",
    // Gender-neutral (30)
    "alex", "chris", "sam", "taylor", "jordan", "casey", "morgan", "riley",
    "drew", "blake", "skyler", "quinn", "reese", "avery", "logan", "ryan",
    "cameron", "dakota", "finley", "hayden", "jamie", "kendall", "parker",
    "peyton", "rowan", "sage", "spencer", "tatum", "devon", "emery",
    // International (40)
    "marco", "lucas", "hugo", "leon", "felix", "oscar", "max", "noah",
    "liam", "ethan", "oliver", "elijah", "mason", "aiden", "kai",
    "mateo", "diego", "rafael", "carlos", "miguel", "pedro", "andre",
    "sofia", "luna", "valentina", "camila", "elena", "lucia", "carmen",
    "rosa", "maria", "ana", "paula", "laura", "sara", "clara",
    "nina", "maya", "lena", "mila",
    // Tech-influenced (30)
    "dev", "pixel", "byte", "code", "data", "neo", "zen", "flux",
    "nova", "echo", "atlas", "orion", "phoenix", "cipher", "vector",
    "prism", "nexus", "pulse", "sonic", "turbo", "hyper", "quantum",
    "stellar", "cosmic", "astro", "crypto", "binary", "logic", "sigma", "omega",
  ];

  const lastNames = [
    // Common English (60)
    "smith", "johnson", "williams", "brown", "jones", "garcia", "miller",
    "davis", "wilson", "anderson", "taylor", "thomas", "jackson", "white",
    "harris", "martin", "thompson", "young", "allen", "king", "wright",
    "scott", "green", "baker", "adams", "nelson", "hill", "carter", "mitchell",
    "roberts", "turner", "phillips", "campbell", "parker", "evans", "edwards",
    "collins", "stewart", "sanchez", "morris", "rogers", "reed", "cook",
    "morgan", "bell", "murphy", "bailey", "rivera", "cooper", "richardson",
    "cox", "howard", "ward", "torres", "peterson", "gray", "ramirez",
    "james", "watson", "brooks",
    // International (60)
    "silva", "santos", "oliveira", "souza", "lima", "pereira", "costa",
    "ferreira", "almeida", "ribeiro", "carvalho", "gomes", "martins", "araujo",
    "fernandez", "lopez", "gonzalez", "rodriguez", "martinez", "hernandez",
    "mueller", "schmidt", "schneider", "fischer", "weber", "meyer", "wagner",
    "becker", "schulz", "hoffmann", "koch", "richter", "wolf", "klein",
    "tanaka", "yamamoto", "watanabe", "suzuki", "takahashi", "nakamura",
    "chen", "wang", "zhang", "liu", "yang", "huang", "zhao", "wu",
    "kim", "lee", "park", "choi", "jung", "kang", "cho", "yoon",
    "singh", "kumar", "sharma", "patel",
  ];

  const nickPrefixes = [
    "cool", "dark", "fast", "wild", "epic", "pro", "super", "mega", "ultra",
    "neo", "cyber", "tech", "pixel", "turbo", "hyper", "alpha", "omega",
    "real", "true", "just", "the", "mr", "ms", "big", "lil",
  ];

  const nickSuffixes = [
    "dragon", "wolf", "fox", "hawk", "storm", "blade", "fire", "ice",
    "shadow", "ghost", "ninja", "ranger", "hunter", "rider", "master",
    "gamer", "coder", "maker", "builder", "runner", "player", "seeker",
  ];

  const professions = [
    "dev", "eng", "tech", "design", "art", "photo", "music", "writer",
    "chef", "doc", "prof", "coach", "pilot", "trader", "analyst",
  ];

  const fn = firstNames[Math.floor(Math.random() * firstNames.length)];
  const ln = lastNames[Math.floor(Math.random() * lastNames.length)];
  const num = Math.floor(Math.random() * 999) + 1;
  const num2 = Math.floor(Math.random() * 99) + 1;
  const year = Math.floor(Math.random() * 8) + 2018;

  const pattern = Math.random();

  if (pattern < 0.20) {
    return `${fn}.${ln}`;                                              // john.smith
  } else if (pattern < 0.35) {
    return `${fn}${num}`;                                              // sarah92
  } else if (pattern < 0.45) {
    return `${fn}_${ln}`;                                              // mike_jones
  } else if (pattern < 0.60) {
    return `${fn}.${ln}${num2}`;                                       // john.smith42
  } else if (pattern < 0.70) {
    const np = nickPrefixes[Math.floor(Math.random() * nickPrefixes.length)];
    const ns = nickSuffixes[Math.floor(Math.random() * nickSuffixes.length)];
    return `${np}${ns}${num2}`;                                        // cooldragon99
  } else if (pattern < 0.80) {
    return `${fn[0]}${ln}${num2}`;                                     // jsmith42
  } else if (pattern < 0.90) {
    return `${fn}${year}`;                                             // sarah2024
  } else if (pattern < 0.95) {
    return `${fn[0]}.${ln}`;                                           // j.smith
  } else {
    const prof = professions[Math.floor(Math.random() * professions.length)];
    return `${prof}.${fn}`;                                            // dev.sarah
  }
}

// ============================================================
// INVITE CODE EXTRACTOR
// ============================================================

/**
 * Extract the invite code from a full invitation link or return as-is if already a code.
 *
 * Supported formats:
 *   - "ZKMDZU02X169UPF" → "ZKMDZU02X169UPF" (already a code)
 *   - "https://manus.im/invitation/ZKMDZU02X169UPF" → "ZKMDZU02X169UPF"
 *   - "https://manus.im/invitation/ZKMDZU02X169UPF?utm_source=invitation&utm_medium=social" → "ZKMDZU02X169UPF"
 *   - "https://manus.im/invitation?code=ZKMDZU02X169UPF&type=signUp" → "ZKMDZU02X169UPF"
 *   - "manus.im/invitation/ZKMDZU02X169UPF" → "ZKMDZU02X169UPF" (without protocol)
 */
export function extractInviteCode(input: string): string {
  if (!input) return "";
  const trimmed = input.trim();

  const pathMatch = trimmed.match(/\/invitation\/([A-Za-z0-9]+)/);
  if (pathMatch) return pathMatch[1];

  const queryMatch = trimmed.match(/[?&]code=([A-Za-z0-9]+)/);
  if (queryMatch) return queryMatch[1];

  if (/^[A-Za-z0-9]+$/.test(trimmed)) return trimmed;

  return trimmed;
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
