/**
 * FingerprintService + HumanizationEngine
 * Generates realistic browser fingerprints with DCR encoding for manus.im
 *
 * DCR format reverse-engineered from manus.im frontend (module 54273):
 * {
 *   ua: string,           // navigator.userAgent
 *   locale: string,       // e.g. "en-US"
 *   languages: string[],  // navigator.languages
 *   timezone: string,     // IANA timezone
 *   fgRequestId: string,  // FingerprintJS Pro requestId (real or synthetic)
 *   clientId: string,     // localStorage client_id_v2
 *   screen: { width, height },
 *   viewport: { width, height },
 *   timestamp: number,    // Date.now()
 *   timezoneOffset: number // new Date().getTimezoneOffset()
 * }
 *
 * ANTI-DETECTION IMPROVEMENTS (v4.2):
 * - Real timezone offsets with DST awareness (Intl.DateTimeFormat)
 * - DCR is regenerated fresh on every call (fresh timestamp + fresh fgRequestId)
 * - Updated Chrome versions (133 removed, 134/135/136 added)
 * - firstEntry randomized with realistic distribution
 * - X-Client-Version updated to match current Manus frontend
 */

import { encodeDCR, generateClientId } from "../utils/helpers";

/**
 * Generate a realistic FingerprintJS Pro requestId.
 * Format: {timestamp}.{6 random alphanumeric chars}
 * Reverse-engineered from real manus.im traffic (e.g. "1773892887732.wI3xcp").
 * The timestamp is set to ~20-40 seconds BEFORE the DCR is built,
 * simulating the page load time before the API call.
 */
function generateFgRequestId(): string {
  const ALPHANUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  // Simulate page loaded 20-40 seconds ago
  const pageLoadDelay = 20000 + Math.floor(Math.random() * 20000);
  const ts = Date.now() - pageLoadDelay;
  let rand = '';
  for (let i = 0; i < 6; i++) {
    rand += ALPHANUM[Math.floor(Math.random() * ALPHANUM.length)];
  }
  return `${ts}.${rand}`;
}

/**
 * Get the REAL timezone offset in minutes for a given IANA timezone.
 * Uses Intl.DateTimeFormat to correctly handle DST (Daylight Saving Time).
 * Positive = west of UTC (matches JS getTimezoneOffset() convention).
 *
 * Example: In March 2026, America/New_York is in EDT (UTC-4) → offset = 240
 *          In January 2026, America/New_York is in EST (UTC-5) → offset = 300
 */
function getRealTimezoneOffset(timezone: string): number {
  try {
    const now = new Date();
    // Get the UTC time parts for this timezone
    const utcDate = new Date(now.toLocaleString("en-US", { timeZone: "UTC" }));
    const tzDate = new Date(now.toLocaleString("en-US", { timeZone: timezone }));
    const diffMs = utcDate.getTime() - tzDate.getTime();
    // Convert to minutes (positive = west of UTC, matching JS convention)
    return Math.round(diffMs / 60000);
  } catch {
    // Fallback to static values if timezone is invalid
    return STATIC_TZ_OFFSETS[timezone] ?? 300;
  }
}

// Static fallback offsets (used only if Intl fails)
const STATIC_TZ_OFFSETS: Record<string, number> = {
  "America/New_York": 240,   // EDT in March (DST active)
  "America/Chicago": 300,    // CDT in March
  "America/Denver": 360,     // MDT in March
  "America/Los_Angeles": 420, // PDT in March
  "America/Sao_Paulo": 180,  // BRT (no DST in 2026)
  "America/Fortaleza": 180,
  "America/Manaus": 240,
  "Europe/London": 0,        // GMT in March (BST starts late March)
  "Europe/Berlin": -60,      // CET in March (CEST starts late March)
  "Europe/Paris": -60,
  "Europe/Madrid": -60,
  "Asia/Tokyo": -540,
  "Asia/Shanghai": -480,
  "Asia/Singapore": -480,
  "Asia/Kolkata": -330,
  "Asia/Jakarta": -420,
  "Australia/Sydney": -660,
  "Pacific/Auckland": -780,
};

interface UAProfile {
  ua: string;
  platform: string;
  screens: number[][];
  weight: number;
  chromeVersion?: string;
}

// UPDATED: Chrome 132 removed (too old), Chrome 134/135/136 added
// Chrome 143 remains dominant (most recent stable in early 2026)
const UA_PROFILES: UAProfile[] = [
  { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36", platform: "Win32", screens: [[1920,1080],[1366,768],[1536,864],[1440,900],[2560,1440]], weight: 25, chromeVersion: "136" },
  { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36", platform: "Win32", screens: [[1920,1080],[1366,768],[1536,864],[1440,900],[2560,1440]], weight: 20, chromeVersion: "135" },
  { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36", platform: "Win32", screens: [[1920,1080],[1366,768],[1536,864],[1440,900]], weight: 15, chromeVersion: "134" },
  { ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36", platform: "MacIntel", screens: [[1440,900],[1680,1050],[2560,1600],[1920,1080]], weight: 15, chromeVersion: "136" },
  { ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36", platform: "MacIntel", screens: [[1440,900],[1680,1050],[2560,1600],[1920,1080]], weight: 10, chromeVersion: "135" },
  { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:137.0) Gecko/20100101 Firefox/137.0", platform: "Win32", screens: [[1920,1080],[1366,768],[1536,864]], weight: 5 },
  { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36 Edg/136.0.0.0", platform: "Win32", screens: [[1920,1080],[1366,768],[1536,864],[1440,900]], weight: 8, chromeVersion: "136" },
  { ua: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36", platform: "Linux x86_64", screens: [[1920,1080],[1366,768],[2560,1440]], weight: 2, chromeVersion: "135" },
];

const TIMEZONES: Record<string, string[]> = {
  us: ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles"],
  br: ["America/Sao_Paulo", "America/Fortaleza", "America/Manaus"],
  eu: ["Europe/London", "Europe/Berlin", "Europe/Paris", "Europe/Madrid"],
  asia: ["Asia/Tokyo", "Asia/Shanghai", "Asia/Singapore", "Asia/Kolkata"],
  default: ["America/New_York", "America/Chicago", "America/Los_Angeles", "Europe/London", "America/Sao_Paulo"],
};

const LOCALES: Record<string, string[]> = {
  us: ["en-US"],
  br: ["pt-BR", "en-US"],
  eu: ["en-GB", "de-DE", "fr-FR", "es-ES"],
  asia: ["ja-JP", "zh-CN", "en-SG"],
  default: ["en-US", "pt-BR", "en-GB"],
};

/**
 * Realistic firstEntry distribution.
 * Reverse-engineered from manus.im frontend (module 10358):
 *   getFirstEntry() reads localStorage "first_entry"
 *   Returns the stored value or undefined if empty/"0"
 *
 * The value stored is the FULL URL of the referrer or landing page:
 *   - undefined (not sent) — direct access (most common)
 *   - "https://manus.im/login" — direct to login page
 *   - "https://www.google.com" — came from Google
 *   - "https://twitter.com" — came from Twitter
 *
 * IMPORTANT: The old values ("direct", "google") were WRONG.
 * The real frontend stores full URLs, not short strings.
 */
const FIRST_ENTRY_OPTIONS: Array<{ value: string | undefined; weight: number }> = [
  { value: undefined, weight: 45 },                          // Direct access — getFirstEntry() returns undefined
  { value: "https://manus.im/login", weight: 15 },           // Direct to login
  { value: "https://manus.im/", weight: 10 },                // Direct to homepage
  { value: "https://www.google.com", weight: 12 },           // Google organic
  { value: "https://www.google.com/search", weight: 5 },     // Google search
  { value: "https://twitter.com", weight: 4 },               // Twitter/X
  { value: "https://x.com", weight: 3 },                     // X (new domain)
  { value: "https://www.linkedin.com", weight: 2 },          // LinkedIn
  { value: "https://www.reddit.com", weight: 2 },            // Reddit
  { value: "https://www.facebook.com", weight: 1 },          // Facebook
  { value: "https://news.ycombinator.com", weight: 1 },      // Hacker News
];

function randomFirstEntry(): string | undefined {
  const total = FIRST_ENTRY_OPTIONS.reduce((s, o) => s + o.weight, 0);
  let r = Math.random() * total;
  for (const opt of FIRST_ENTRY_OPTIONS) {
    r -= opt.weight;
    if (r <= 0) return opt.value;
  }
  return undefined;
}

export interface BrowserProfile {
  userAgent: string;
  platform: string;
  screenWidth: number;
  screenHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  colorDepth: number;
  timezone: string;
  locale: string;
  languages: string[];
  clientId: string;
  dcrEncoded: string;
  headers: Record<string, string>;
  /** firstEntry value for authCommandCmd (URL or undefined for direct access) */
  firstEntry: string | undefined;
  /** Real timezone offset in minutes (DST-aware) */
  timezoneOffset: number;
}

/**
 * Build the DCR payload matching the exact format used by manus.im frontend.
 * Reverse-engineered from module 54273 of the manus.im webapp.
 *
 * IMPORTANT: This function generates a FRESH fgRequestId and timestamp on every call.
 * The real browser regenerates the DCR for each API call (timestamp changes).
 */
function buildDcrPayload(params: {
  ua: string;
  locale: string;
  languages: string[];
  timezone: string;
  clientId: string;
  screenWidth: number;
  screenHeight: number;
  viewportWidth: number;
  viewportHeight: number;
}): string {
  const tzOffset = getRealTimezoneOffset(params.timezone);
  const payload = {
    ua: params.ua,
    locale: params.locale,
    languages: params.languages,
    timezone: params.timezone,
    fgRequestId: generateFgRequestId(), // Fresh on every call — matches real browser behavior
    clientId: params.clientId,
    screen: {
      width: params.screenWidth,
      height: params.screenHeight,
    },
    viewport: {
      width: params.viewportWidth,
      height: params.viewportHeight,
    },
    timestamp: Date.now(),
    timezoneOffset: tzOffset,
  };
  return JSON.stringify(payload);
}

class FingerprintService {
  generateProfile(region = "default"): BrowserProfile {
    // Weighted random UA selection
    const totalWeight = UA_PROFILES.reduce((sum, p) => sum + p.weight, 0);
    let random = Math.random() * totalWeight;
    let selectedProfile = UA_PROFILES[0];
    for (const profile of UA_PROFILES) {
      random -= profile.weight;
      if (random <= 0) { selectedProfile = profile; break; }
    }

    const screenIdx = Math.floor(Math.random() * selectedProfile.screens.length);
    const [screenWidth, screenHeight] = selectedProfile.screens[screenIdx];
    const chromeUiHeight = 80 + Math.floor(Math.random() * 40);
    const viewportWidth = screenWidth;
    const viewportHeight = screenHeight - chromeUiHeight;

    const tzList = TIMEZONES[region] || TIMEZONES.default;
    const timezone = tzList[Math.floor(Math.random() * tzList.length)];
    const localeList = LOCALES[region] || LOCALES.default;
    const locale = localeList[Math.floor(Math.random() * localeList.length)];

    const languages = [locale];
    if (!locale.startsWith("en")) languages.push("en-US");
    languages.push("en");

    const colorDepth = 24;
    const clientId = generateClientId();
    const firstEntry = randomFirstEntry();

    // Get DST-aware timezone offset
    const timezoneOffset = getRealTimezoneOffset(timezone);

    // Build DCR with fresh timestamp and fgRequestId
    const dcrPayload = buildDcrPayload({
      ua: selectedProfile.ua,
      locale,
      languages,
      timezone,
      clientId,
      screenWidth,
      screenHeight,
      viewportWidth,
      viewportHeight,
    });

    const dcrEncoded = encodeDCR(dcrPayload);

    const isChrome = selectedProfile.ua.includes("Chrome") && !selectedProfile.ua.includes("Firefox");
    const chromeVersion = selectedProfile.chromeVersion || selectedProfile.ua.match(/Chrome\/(\d+)/)?.[1] || "136";

    // X-Client-Locale: uses translationManager.locale which is the full locale ("en", "zh-CN", etc.)
    // Reverse-engineered from module 99238: e.set("x-client-locale", r.I.translationManager.locale)
    // The translationManager locale is typically the base language ("en") for English users
    const clientLocale = locale.split("-")[0];

    // IMPORTANT: These headers match EXACTLY what the real manus.im frontend sends.
    // Reverse-engineered from module 99238 (chunk 99238-182ef26fd616703a.js).
    // The frontend sets these headers on EVERY request:
    //   e.set("x-client-type", "web")
    //   e.set("x-client-id", clientId)
    //   e.set("x-client-locale", translationManager.locale)
    //   e.set("x-client-timezone", Intl.DateTimeFormat().resolvedOptions().timeZone)
    //   e.set("x-client-timezone-offset", String(new Date().getTimezoneOffset()))
    //
    // NOTE: The frontend does NOT send "x-client-version"!
    // The old "X-Client-Version: 2.3.1" was a PHANTOM header that would flag us as a bot.
    const headers: Record<string, string> = {
      "User-Agent": selectedProfile.ua,
      "Content-Type": "application/json",
      "Accept": "*/*",
      "Origin": "https://manus.im",
      "Referer": "https://manus.im/",
      "Accept-Encoding": "gzip, deflate, br, zstd",
      "Accept-Language": locale + "," + locale.split("-")[0] + ";q=0.9",
      "x-client-id": clientId,
      "x-client-dcr": dcrEncoded,
      "x-client-locale": clientLocale,
      "x-client-timezone": timezone,
      "x-client-timezone-offset": String(timezoneOffset),
      "x-client-type": "web",
      // NO x-client-version — the real frontend does NOT send this header!
    };

    if (isChrome) {
      const isEdge = selectedProfile.ua.includes("Edg/");
      headers["sec-ch-ua"] = isEdge
        ? `"Microsoft Edge";v="${chromeVersion}", "Chromium";v="${chromeVersion}", "Not A(Brand";v="24"`
        : `"Google Chrome";v="${chromeVersion}", "Chromium";v="${chromeVersion}", "Not A(Brand";v="24"`;
      headers["sec-ch-ua-mobile"] = "?0";
      headers["sec-ch-ua-platform"] = selectedProfile.platform === "Win32" ? '"Windows"' :
                                       selectedProfile.platform === "MacIntel" ? '"macOS"' : '"Linux"';
      headers["Sec-Fetch-Site"] = "same-site";
      headers["Sec-Fetch-Mode"] = "cors";
      headers["Sec-Fetch-Dest"] = "empty";
    }

    return {
      userAgent: selectedProfile.ua, platform: selectedProfile.platform,
      screenWidth, screenHeight, viewportWidth, viewportHeight,
      colorDepth, timezone, locale, languages, clientId, dcrEncoded, headers,
      firstEntry, timezoneOffset,
    };
  }

  /**
   * Regenerate the DCR for a given profile with a fresh timestamp and fgRequestId.
   * MUST be called before every RPC call to match real browser behavior.
   * The real manus.im frontend always generates a fresh DCR per call.
   */
  regenerateDcr(profile: BrowserProfile): string {
    const dcrPayload = buildDcrPayload({
      ua: profile.userAgent,
      locale: profile.locale,
      languages: profile.languages,
      timezone: profile.timezone,
      clientId: profile.clientId,
      screenWidth: profile.screenWidth,
      screenHeight: profile.screenHeight,
      viewportWidth: profile.viewportWidth,
      viewportHeight: profile.viewportHeight,
    });
    return encodeDCR(dcrPayload);
  }

  getOrderedHeaders(profile: BrowserProfile, extraHeaders: Record<string, string> = {}): Record<string, string> {
    // Chrome header order matches real browser traffic (observed from DevTools)
    const CHROME_HEADER_ORDER = [
      "host", "connection", "content-length",
      "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform",
      "user-agent", "content-type", "accept",
      "authorization",
      "connect-protocol-version",
      "origin",
      "priority",
      "referer",
      "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site",
      "accept-encoding", "accept-language",
      "x-client-dcr",
      "x-client-id", "x-client-locale", "x-client-timezone", "x-client-timezone-offset",
      "x-client-type",
    ];

    const allHeaders = { ...profile.headers, ...extraHeaders };
    const ordered: Record<string, string> = {};

    for (const key of CHROME_HEADER_ORDER) {
      const headerKey = Object.keys(allHeaders).find((k) => k.toLowerCase() === key.toLowerCase());
      if (headerKey) ordered[headerKey] = allHeaders[headerKey];
    }

    for (const [key, value] of Object.entries(allHeaders)) {
      if (!ordered[key]) ordered[key] = value;
    }

    return ordered;
  }
}

export const fingerprintService = new FingerprintService();
