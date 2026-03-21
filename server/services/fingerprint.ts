/**
 * FingerprintService + HumanizationEngine (v7.0 — Apify Integration)
 * Generates realistic browser fingerprints with DCR encoding for manus.im
 *
 * v7.0 CHANGES:
 * - Integrated Apify fingerprint-generator (Bayesian Network trained on real browsers)
 * - All fingerprint attributes are now INTERNALLY CONSISTENT:
 *   GPU matches OS, screen matches device, deviceMemory matches hardware, etc.
 * - BrowserProfile extended with Apify-sourced fields:
 *   deviceMemory, hardwareConcurrency, webglVendor, webglRenderer,
 *   fonts, audioCodecs, videoCodecs, battery, maxTouchPoints
 * - Fallback to legacy hardcoded profiles if Apify fails
 *
 * DCR format reverse-engineered from manus.im frontend (module 54273):
 * {
 *   ua: string,           // navigator.userAgent
 *   locale: string,       // e.g. "en-US"
 *   languages: string[],  // navigator.languages
 *   timezone: string,     // IANA timezone
 *   fgRequestId: string,  // FingerprintJS Pro requestId (real via rpc.ts)
 *   clientId: string,     // localStorage client_id_v2
 *   screen: { width, height },
 *   viewport: { width, height },
 *   timestamp: number,    // Date.now()
 *   timezoneOffset: number // new Date().getTimezoneOffset()
 * }
 */

import { encodeDCR, generateClientId } from "../utils/helpers";
import { FingerprintGenerator } from "fingerprint-generator";

// ============================================================
// Apify Fingerprint Generator (singleton)
// ============================================================

const apifyGenerator = new FingerprintGenerator();

// ============================================================
// Synthetic fallback (used only if Apify fails)
// ============================================================

/**
 * Generate a synthetic FingerprintJS Pro requestId as fallback.
 * Format: {timestamp}.{6 random alphanumeric chars}
 */
function generateFgRequestId(): string {
  const ALPHANUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const pageLoadDelay = 20000 + Math.floor(Math.random() * 20000);
  const ts = Date.now() - pageLoadDelay;
  let rand = '';
  for (let i = 0; i < 6; i++) {
    rand += ALPHANUM[Math.floor(Math.random() * ALPHANUM.length)];
  }
  return `${ts}.${rand}`;
}

// ============================================================
// Timezone helpers
// ============================================================

/**
 * Get the REAL timezone offset in minutes for a given IANA timezone.
 * Uses Intl.DateTimeFormat to correctly handle DST.
 */
function getRealTimezoneOffset(timezone: string): number {
  try {
    const now = new Date();
    const utcDate = new Date(now.toLocaleString("en-US", { timeZone: "UTC" }));
    const tzDate = new Date(now.toLocaleString("en-US", { timeZone: timezone }));
    const diffMs = utcDate.getTime() - tzDate.getTime();
    return Math.round(diffMs / 60000);
  } catch {
    return STATIC_TZ_OFFSETS[timezone] ?? 300;
  }
}

const STATIC_TZ_OFFSETS: Record<string, number> = {
  "America/New_York": 240,
  "America/Chicago": 300,
  "America/Denver": 360,
  "America/Los_Angeles": 420,
  "America/Sao_Paulo": 180,
  "America/Fortaleza": 180,
  "America/Manaus": 240,
  "Europe/London": 0,
  "Europe/Berlin": -60,
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

// ============================================================
// Region config
// ============================================================

const TIMEZONES: Record<string, string[]> = {
  us: ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles"],
  br: ["America/Sao_Paulo", "America/Fortaleza", "America/Manaus"],
  eu: ["Europe/London", "Europe/Berlin", "Europe/Paris", "Europe/Madrid"],
  asia: ["Asia/Tokyo", "Asia/Shanghai", "Asia/Kolkata"],
  id: ["Asia/Jakarta"],
  sg: ["Asia/Singapore"],
  default: ["America/New_York", "America/Chicago", "America/Los_Angeles", "Europe/London", "America/Sao_Paulo"],
};

const LOCALES: Record<string, string[]> = {
  us: ["en-US"],
  br: ["pt-BR"],
  eu: ["en-GB", "de-DE", "fr-FR", "es-ES"],
  asia: ["ja-JP", "zh-CN", "en-SG"],
  id: ["en-ID", "id-ID"],
  sg: ["en-SG"],
  default: ["en-US", "pt-BR", "en-GB"],
};

// ============================================================
// First entry distribution
// ============================================================

const FIRST_ENTRY_OPTIONS: Array<{ value: string | undefined; weight: number }> = [
  { value: undefined, weight: 45 },
  { value: "https://manus.im/login", weight: 15 },
  { value: "https://manus.im/", weight: 10 },
  { value: "https://www.google.com", weight: 12 },
  { value: "https://www.google.com/search", weight: 5 },
  { value: "https://twitter.com", weight: 4 },
  { value: "https://x.com", weight: 3 },
  { value: "https://www.linkedin.com", weight: 2 },
  { value: "https://www.reddit.com", weight: 2 },
  { value: "https://www.facebook.com", weight: 1 },
  { value: "https://news.ycombinator.com", weight: 1 },
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

// ============================================================
// BrowserProfile (extended with Apify fields for FPJS payload)
// ============================================================

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
  firstEntry: string | undefined;
  timezoneOffset: number;

  // === Apify-sourced fields (used by fpjsDirectClient.ts for 144 signals) ===

  /** GPU vendor string, e.g. "Google Inc. (Intel)" */
  webglVendor: string;
  /** GPU renderer string, e.g. "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 ...)" */
  webglRenderer: string;
  /** Device memory in GB (1, 2, 4, 8, 16, 32) */
  deviceMemory: number;
  /** Logical CPU cores */
  hardwareConcurrency: number;
  /** Max touch points (0 for desktop, 1-10 for touch devices) */
  maxTouchPoints: number;
  /** List of installed fonts */
  fonts: string[];
  /** Audio codecs support map */
  audioCodecs: Record<string, string>;
  /** Video codecs support map */
  videoCodecs: Record<string, string>;
  /** Battery info (null if not available) */
  battery: { charging: boolean; chargingTime: number | null; dischargingTime: number | null; level: number } | null;
  /** Device pixel ratio */
  devicePixelRatio: number;
}

// ============================================================
// DCR builder
// ============================================================

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
  realFgRequestId?: string;
}): string {
  const tzOffset = getRealTimezoneOffset(params.timezone);
  const fgRequestId = params.realFgRequestId || generateFgRequestId();

  const payload = {
    ua: params.ua,
    locale: params.locale,
    languages: params.languages,
    timezone: params.timezone,
    fgRequestId,
    clientId: params.clientId,
    screen: {
      width: params.screenWidth,
      height: params.screenHeight,
    },
    viewport: {
      width: params.viewportWidth,
      height: params.viewportHeight,
    },
    timestamp: Date.now() - (1000 + Math.floor(Math.random() * 9000)),
    timezoneOffset: tzOffset,
  };
  return JSON.stringify(payload);
}

// ============================================================
// OS mapping for Apify constraints
// ============================================================

/**
 * Map our region to Apify OS constraints.
 * We only use desktop + Windows/macOS/Linux to match our use case.
 */
function getApifyOS(region: string): ("windows" | "macos" | "linux")[] {
  // Predominantly Windows, with some macOS variation
  const roll = Math.random();
  if (roll < 0.70) return ["windows"];
  if (roll < 0.90) return ["macos"];
  return ["linux"];
}

// ============================================================
// FingerprintService
// ============================================================

class FingerprintService {
  /**
   * Generate a browser profile using Apify fingerprint-generator.
   * Falls back to legacy hardcoded profiles if Apify fails.
   */
  generateProfile(region = "default"): BrowserProfile {
    const clientId = generateClientId();
    const firstEntry = randomFirstEntry();

    // Region-specific settings
    const tzList = TIMEZONES[region] || TIMEZONES.default;
    const timezone = tzList[Math.floor(Math.random() * tzList.length)];
    const localeList = LOCALES[region] || LOCALES.default;
    const locale = localeList[Math.floor(Math.random() * localeList.length)];

    const languages = [locale];
    if (!locale.startsWith("en")) languages.push("en-US");
    languages.push("en");

    try {
      return this._generateWithApify(region, clientId, firstEntry, timezone, locale, languages);
    } catch (err) {
      console.warn(`[Fingerprint] Apify generation failed, using legacy fallback: ${err}`);
      return this._generateLegacy(region, clientId, firstEntry, timezone, locale, languages);
    }
  }

  /**
   * Generate profile using Apify fingerprint-generator (Bayesian Network).
   * Produces internally consistent fingerprints trained on real browser data.
   */
  private _generateWithApify(
    region: string,
    clientId: string,
    firstEntry: string | undefined,
    timezone: string,
    locale: string,
    languages: string[],
  ): BrowserProfile {
    const osConstraint = getApifyOS(region);

    const { headers: apifyHeaders, fingerprint: fp } = apifyGenerator.getFingerprint({
      devices: ["desktop"],
      operatingSystems: osConstraint,
    });

    // Extract screen dimensions from Apify
    const screenWidth = fp.screen.width;
    const screenHeight = fp.screen.height;
    const chromeUiHeight = 80 + Math.floor(Math.random() * 40);
    // Use Apify's innerWidth/outerWidth if available, otherwise derive from screen
    const viewportWidth = fp.screen.innerWidth > 0 ? fp.screen.innerWidth : screenWidth;
    const viewportHeight = fp.screen.innerHeight > 0 ? fp.screen.innerHeight : (screenHeight - chromeUiHeight);
    const colorDepth = fp.screen.colorDepth || 24;
    const devicePixelRatio = fp.screen.devicePixelRatio || 1;

    // Use Apify's user agent (it's consistent with the generated fingerprint)
    const userAgent = fp.navigator.userAgent;
    const platform = fp.navigator.platform;

    // Extract GPU info
    const webglVendor = fp.videoCard?.vendor || "Google Inc. (Intel)";
    const webglRenderer = fp.videoCard?.renderer || "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)";

    // Extract hardware info
    const deviceMemory = fp.navigator.deviceMemory ?? 8;
    const hardwareConcurrency = fp.navigator.hardwareConcurrency || 8;
    const maxTouchPoints = fp.navigator.maxTouchPoints ?? 0;

    // Extract fonts
    const fonts = fp.fonts || [];

    // Extract codecs
    const audioCodecs = fp.audioCodecs || {};
    const videoCodecs = fp.videoCodecs || {};

    // Extract battery
    const battery = fp.battery ? {
      charging: fp.battery.charging,
      chargingTime: fp.battery.chargingTime,
      dischargingTime: fp.battery.dischargingTime,
      level: fp.battery.level,
    } : null;

    // Timezone offset
    const baseOffset = getRealTimezoneOffset(timezone);
    const jitterMinutes = Math.floor(Math.random() * 31) - 15;
    const timezoneOffset = baseOffset + jitterMinutes;

    // Build DCR
    const dcrPayload = buildDcrPayload({
      ua: userAgent,
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

    // Build headers
    const isChrome = userAgent.includes("Chrome") && !userAgent.includes("Firefox");
    const chromeVersionMatch = userAgent.match(/Chrome\/(\d+)/);
    const chromeVersion = chromeVersionMatch ? chromeVersionMatch[1] : "136";
    const clientLocale = locale.split("-")[0];

    const profileHeaders: Record<string, string> = {
      "User-Agent": userAgent,
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
    };

    if (isChrome) {
      const isEdge = userAgent.includes("Edg/");
      profileHeaders["sec-ch-ua"] = isEdge
        ? `"Microsoft Edge";v="${chromeVersion}", "Chromium";v="${chromeVersion}", "Not A(Brand";v="24"`
        : `"Google Chrome";v="${chromeVersion}", "Chromium";v="${chromeVersion}", "Not A(Brand";v="24"`;
      profileHeaders["sec-ch-ua-mobile"] = "?0";
      profileHeaders["sec-ch-ua-platform"] = platform.includes("Win") ? '"Windows"' :
                                              platform === "MacIntel" ? '"macOS"' : '"Linux"';
      profileHeaders["Sec-Fetch-Site"] = "same-site";
      profileHeaders["Sec-Fetch-Mode"] = "cors";
      profileHeaders["Sec-Fetch-Dest"] = "empty";
    }

    return {
      userAgent, platform, screenWidth, screenHeight,
      viewportWidth, viewportHeight, colorDepth,
      timezone, locale, languages, clientId, dcrEncoded,
      headers: profileHeaders, firstEntry, timezoneOffset,
      webglVendor, webglRenderer, deviceMemory, hardwareConcurrency,
      maxTouchPoints, fonts, audioCodecs, videoCodecs, battery,
      devicePixelRatio,
    };
  }

  /**
   * Legacy fallback: hardcoded UA profiles (used if Apify fails).
   */
  private _generateLegacy(
    region: string,
    clientId: string,
    firstEntry: string | undefined,
    timezone: string,
    locale: string,
    languages: string[],
  ): BrowserProfile {
    const UA_PROFILES = [
      { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36", platform: "Win32", screens: [[1920,1080],[1366,768],[1536,864],[1440,900],[2560,1440]], weight: 25 },
      { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36", platform: "Win32", screens: [[1920,1080],[1366,768],[1536,864],[1440,900],[2560,1440]], weight: 20 },
      { ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36", platform: "MacIntel", screens: [[1440,900],[1680,1050],[2560,1600],[1920,1080]], weight: 15 },
      { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36", platform: "Win32", screens: [[1920,1080],[1366,768],[1536,864]], weight: 15 },
    ];

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
    const colorDepth = 24;

    const baseOffset = getRealTimezoneOffset(timezone);
    const jitterMinutes = Math.floor(Math.random() * 31) - 15;
    const timezoneOffset = baseOffset + jitterMinutes;

    const dcrPayload = buildDcrPayload({
      ua: selectedProfile.ua, locale, languages, timezone, clientId,
      screenWidth, screenHeight, viewportWidth, viewportHeight,
    });
    const dcrEncoded = encodeDCR(dcrPayload);

    const isChrome = selectedProfile.ua.includes("Chrome");
    const chromeVersion = selectedProfile.ua.match(/Chrome\/(\d+)/)?.[1] || "136";
    const clientLocale = locale.split("-")[0];

    const profileHeaders: Record<string, string> = {
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
    };

    if (isChrome) {
      profileHeaders["sec-ch-ua"] = `"Google Chrome";v="${chromeVersion}", "Chromium";v="${chromeVersion}", "Not A(Brand";v="24"`;
      profileHeaders["sec-ch-ua-mobile"] = "?0";
      profileHeaders["sec-ch-ua-platform"] = selectedProfile.platform === "Win32" ? '"Windows"' : '"macOS"';
      profileHeaders["Sec-Fetch-Site"] = "same-site";
      profileHeaders["Sec-Fetch-Mode"] = "cors";
      profileHeaders["Sec-Fetch-Dest"] = "empty";
    }

    return {
      userAgent: selectedProfile.ua, platform: selectedProfile.platform,
      screenWidth, screenHeight, viewportWidth, viewportHeight,
      colorDepth, timezone, locale, languages, clientId, dcrEncoded,
      headers: profileHeaders, firstEntry, timezoneOffset,
      // Legacy defaults for Apify fields
      webglVendor: "Google Inc. (NVIDIA)",
      webglRenderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
      deviceMemory: 8,
      hardwareConcurrency: 8,
      maxTouchPoints: 0,
      fonts: [],
      audioCodecs: {},
      videoCodecs: {},
      battery: null,
      devicePixelRatio: 1,
    };
  }

  /**
   * Regenerate the DCR for a given profile with a fresh timestamp and fgRequestId.
   * MUST be called before every RPC call.
   */
  regenerateDcr(profile: BrowserProfile, newRealFgRequestId?: string): string {
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
      realFgRequestId: newRealFgRequestId,
    });
    return encodeDCR(dcrPayload);
  }

  getOrderedHeaders(profile: BrowserProfile, extraHeaders: Record<string, string> = {}): Record<string, string> {
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
