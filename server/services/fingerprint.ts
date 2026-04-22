/**
 * FingerprintService + HumanizationEngine (v8.0 — Anti-Detection Hardening)
 * Generates realistic browser fingerprints with DCR encoding for manus.im
 *
 * v8.0 CHANGES (Anti-Bot Audit Fixes):
 * - REMOVED timezone offset jitter (was generating impossible offsets like 227min)
 *   Now uses EXACT offset from IANA timezone via Intl.DateTimeFormat
 * - ADDED Chrome version → GREASE brand mapping (each version has its own GREASE string)
 * - ADDED Chrome version → build number mapping (7103 is ONLY for Chrome 136, not all)
 * - ADDED `priority: u=1, i` header (Chrome sends this natively on POST requests)
 * - FIXED Accept-Language to include "en" with proper q-values for non-English locales
 * - EXPORTED chromeVersionData for use by fpjsDirectClient.ts (s58 payload consistency)
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
// Chrome Version Data (GREASE brands + build numbers)
// ============================================================

/**
 * Maps Chrome major version to its correct GREASE brand string and build number.
 * Data sourced from real browser traffic (fingerprint-scan.com) and
 * Chromium release history (GoogleChromeLabs/chrome-for-testing).
 *
 * The GREASE brand rotates per version — using the wrong one for a given
 * Chrome version is an instant tampering signal for FPJS.
 * The build number (3rd segment of full version) is unique per major version.
 */
export interface ChromeVersionInfo {
  greaseBrand: string;
  greaseVersion: string;
  buildNumber: string;
  fullVersion: string;
}

export const CHROME_VERSION_MAP: Record<string, ChromeVersionInfo> = {
  "131": { greaseBrand: "Not_A Brand",    greaseVersion: "24", buildNumber: "6778", fullVersion: "131.0.6778.264" },
  "132": { greaseBrand: "Not A(Brand",    greaseVersion: "8",  buildNumber: "6834", fullVersion: "132.0.6834.159" },
  "133": { greaseBrand: "Not(A:Brand",    greaseVersion: "99", buildNumber: "6943", fullVersion: "133.0.6943.141" },
  "134": { greaseBrand: "Not:A-Brand",    greaseVersion: "24", buildNumber: "6998", fullVersion: "134.0.6998.165" },
  "135": { greaseBrand: "Not-A.Brand",    greaseVersion: "8",  buildNumber: "7049", fullVersion: "135.0.7049.114" },
  "136": { greaseBrand: "Not.A/Brand",    greaseVersion: "99", buildNumber: "7103", fullVersion: "136.0.7103.113" },
  "137": { greaseBrand: "Not/A)Brand",    greaseVersion: "24", buildNumber: "7151", fullVersion: "137.0.7151.119" },
  "138": { greaseBrand: "Not)A;Brand",    greaseVersion: "8",  buildNumber: "7204", fullVersion: "138.0.7204.183" },
  "139": { greaseBrand: "Not;A=Brand",    greaseVersion: "99", buildNumber: "7258", fullVersion: "139.0.7258.154" },
  "140": { greaseBrand: "Not=A?Brand",    greaseVersion: "24", buildNumber: "7339", fullVersion: "140.0.7339.207" },
  "141": { greaseBrand: "Not?A_Brand",    greaseVersion: "8",  buildNumber: "7390", fullVersion: "141.0.7390.122" },
  "142": { greaseBrand: "Not_A Brand",    greaseVersion: "99", buildNumber: "7444", fullVersion: "142.0.7444.175" },
  "143": { greaseBrand: "Not A(Brand",    greaseVersion: "24", buildNumber: "7499", fullVersion: "143.0.7499.192" },
  "144": { greaseBrand: "Not(A:Brand",    greaseVersion: "8",  buildNumber: "7559", fullVersion: "144.0.7559.133" },
  "145": { greaseBrand: "Not:A-Brand",    greaseVersion: "99", buildNumber: "7632", fullVersion: "145.0.7632.117" },
  "146": { greaseBrand: "Not-A.Brand",    greaseVersion: "24", buildNumber: "7680", fullVersion: "146.0.7680.153" },
};

// Default to Chrome 145 (current stable as of March 2026)
const DEFAULT_CHROME_VERSION = "145";

/**
 * Get Chrome version info with fallback to default.
 */
export function getChromeVersionInfo(majorVersion: string): ChromeVersionInfo {
  return CHROME_VERSION_MAP[majorVersion] || CHROME_VERSION_MAP[DEFAULT_CHROME_VERSION];
}

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
 *
 * v8.0: NO JITTER — the offset MUST be exact. Timezone offsets are always
 * multiples of 15 or 30 minutes. Adding random jitter creates impossible
 * values (e.g., 227 minutes) that are trivially detectable.
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
  "Europe/Athens": -120,
  "Europe/Helsinki": -120,
  "Europe/Moscow": -180,
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
  eu: ["Europe/London", "Europe/Berlin", "Europe/Paris", "Europe/Madrid", "Europe/Athens", "Europe/Helsinki"],
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

/**
 * v9.5: Ensure timezone and locale are geo-coherent within the "asia" region.
 * Without this, a Japan proxy could get Asia/Kolkata + ja-JP (impossible combination).
 */
const ASIA_TZ_LOCALE_MAP: Record<string, string[]> = {
  "Asia/Tokyo": ["ja-JP"],
  "Asia/Shanghai": ["zh-CN"],
  "Asia/Kolkata": ["en-IN"],
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

  // === v8.0: Chrome version metadata (used by fpjsDirectClient.ts for s58) ===

  /** Chrome major version extracted from UA, e.g. "141" */
  chromeMajorVersion: string;
  /** Full Chrome version string, e.g. "141.0.7390.122" */
  chromeFullVersion: string;
  /** GREASE brand string for this Chrome version, e.g. "Not?A_Brand" */
  greaseBrand: string;
  /** GREASE brand version string, e.g. "8" */
  greaseVersion: string;
  /** Detected OS for cross-signal consistency: "windows" | "macos" | "linux" */
  detectedOS: "windows" | "macos" | "linux";
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
  timezoneOffset: number;
  realFgRequestId?: string;
}): string {
  const fgRequestId = params.realFgRequestId || generateFgRequestId();
  
  // DEBUG: Log do FPJS requestId
  if (params.realFgRequestId) {
    console.log('[DCR-DEBUG] FPJS realFgRequestId:', params.realFgRequestId);
  } else {
    console.log('[DCR-DEBUG] FPJS realFgRequestId NAO FOI FORNECIDO, usando fallback:', fgRequestId);
  }

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
    // v10.8: Removed timestamp skew. Use Date.now() directly to match real browser behavior.
    timestamp: Date.now(),
    timezoneOffset: params.timezoneOffset,
  };
  
  const payloadStr = JSON.stringify(payload);
  console.log('[DCR-DEBUG] Payload DCR completo:', payloadStr);
  return payloadStr;
}

// ============================================================
// OS mapping for Apify constraints
// ============================================================

/**
 * Map our region to Apify OS constraints.
 * We only use desktop + Windows/macOS/Linux to match our use case.
 */
function getApifyOS(_region: string): ("windows" | "macos" | "linux")[] {
  // Predominantly Windows, with some macOS variation
  const roll = Math.random();
  if (roll < 0.70) return ["windows"];
  if (roll < 0.90) return ["macos"];
  return ["linux"];
}

/**
 * Detect OS from platform string for cross-signal consistency.
 */
function detectOS(platform: string): "windows" | "macos" | "linux" {
  if (platform.includes("Win")) return "windows";
  if (platform === "MacIntel" || platform.includes("Mac")) return "macos";
  return "linux";
}

// ============================================================
// Accept-Language builder
// ============================================================

/**
 * Build a realistic Accept-Language header value.
 * Real Chrome sends locale with region, then language without region, then "en" as fallback.
 * Example for pt-BR: "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7"
 * Example for en-US: "en-US,en;q=0.9"
 */
function buildAcceptLanguage(locale: string, languages: string[]): string {
  const parts: string[] = [];
  const seen = new Set<string>();

  // Primary locale at q=1.0 (implicit)
  parts.push(locale);
  seen.add(locale);

  // Language without region at q=0.9
  const lang = locale.split("-")[0];
  if (!seen.has(lang)) {
    parts.push(`${lang};q=0.9`);
    seen.add(lang);
  }

  // Additional languages from profile
  let q = 0.8;
  for (const l of languages) {
    if (!seen.has(l) && q >= 0.5) {
      parts.push(`${l};q=${q.toFixed(1)}`);
      seen.add(l);
      q -= 0.1;
    }
  }

  // Always include "en" as final fallback if not already present
  if (!seen.has("en")) {
    parts.push(`en;q=${Math.max(q, 0.5).toFixed(1)}`);
  }

  return parts.join(",");
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

    // v9.5: For "asia" region, force locale to match the selected timezone.
    // Without this, a Japan proxy (Asia/Tokyo) could get zh-CN locale or
    // an India proxy (Asia/Kolkata) could get ja-JP — impossible combinations
    // that anti-bot systems trivially detect.
    let locale: string;
    if (region === "asia" && ASIA_TZ_LOCALE_MAP[timezone]) {
      const coherentLocales = ASIA_TZ_LOCALE_MAP[timezone];
      locale = coherentLocales[Math.floor(Math.random() * coherentLocales.length)];
    } else {
      const localeList = LOCALES[region] || LOCALES.default;
      locale = localeList[Math.floor(Math.random() * localeList.length)];
    }

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

    // v10.0: Fixed Chrome version range to match impers TLS impersonation capability.
    // impers supports up to chrome142. If Apify generates Chrome 144/145, the UA
    // headers say "Chrome/145" but the TLS/HTTP2 fingerprint is chrome142.
    // Anti-bot systems can detect this version mismatch.
    // By constraining Apify to 140-142, the UA and TLS fingerprint are consistent.
    const { headers: apifyHeaders, fingerprint: fp } =
      apifyGenerator.getFingerprint({
        browsers: [{ name: "chrome", minVersion: 140, maxVersion: 142 }],
        devices: ["desktop"],
        operatingSystems: osConstraint,
      });

    // Extract screen dimensions from Apify
    let screenWidth = fp.screen.width;
    let screenHeight = fp.screen.height;

    // v10.0 SANITIZATION: Reject portrait-mode screens on desktop (e.g. 777x1164).
    // Real desktop monitors are always landscape or square. Portrait screens are
    // a trivial bot detection signal.
    if (screenHeight > screenWidth) {
      console.warn(`[Fingerprint] Apify gerou tela retrato (${screenWidth}x${screenHeight}), corrigindo para 1920x1080`);
      screenWidth = 1920;
      screenHeight = 1080;
    }

    // v10.0 SANITIZATION: Reject unrealistically small screens (< 1024x768).
    if (screenWidth < 1024 || screenHeight < 600) {
      console.warn(`[Fingerprint] Apify gerou tela muito pequena (${screenWidth}x${screenHeight}), corrigindo para 1920x1080`);
      screenWidth = 1920;
      screenHeight = 1080;
    }

    const chromeUiHeight = 80 + Math.floor(Math.random() * 40);
    // Use Apify's innerWidth/outerWidth if available, otherwise derive from screen
    let viewportWidth = fp.screen.innerWidth > 0 ? fp.screen.innerWidth : screenWidth;
    let viewportHeight = fp.screen.innerHeight > 0 ? fp.screen.innerHeight : (screenHeight - chromeUiHeight);

    // Ensure viewport is consistent with (possibly corrected) screen dimensions
    if (viewportWidth > screenWidth) viewportWidth = screenWidth;
    if (viewportHeight > screenHeight) viewportHeight = screenHeight - chromeUiHeight;

    const colorDepth = fp.screen.colorDepth || 24;

    // v10.0 SANITIZATION: Clamp devicePixelRatio to realistic desktop values (1-2).
    // Values like 2.75 are mobile-only and suspicious on desktop.
    let devicePixelRatio = fp.screen.devicePixelRatio || 1;
    if (devicePixelRatio > 2) {
      console.warn(`[Fingerprint] Apify gerou devicePixelRatio=${devicePixelRatio} (m\u00f3vel), corrigindo para 1`);
      devicePixelRatio = 1;
    }

    // Use Apify's user agent (it's consistent with the generated fingerprint)
    const userAgent = fp.navigator.userAgent;
    const platform = fp.navigator.platform;
    const detectedOSValue = detectOS(platform);

    // Extract GPU info
    const webglVendor = fp.videoCard?.vendor || "Google Inc. (Intel)";
    const webglRenderer = fp.videoCard?.renderer || "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)";

    // Extract hardware info
    let deviceMemory = fp.navigator.deviceMemory ?? 8;
    let hardwareConcurrency = fp.navigator.hardwareConcurrency || 8;
    const maxTouchPoints = fp.navigator.maxTouchPoints ?? 0;

    // v10.0 SANITIZATION: Force minimum deviceMemory to 2 GB.
    // Real Chrome reports 0.25, 0.5, 1, 2, 4, 8 — but 0 is impossible and
    // values < 2 are extremely rare on desktops capable of running Chrome 142+.
    if (deviceMemory < 2) {
      console.warn(`[Fingerprint] Apify gerou deviceMemory=${deviceMemory}, corrigindo para 8`);
      deviceMemory = 8;
    }

    // v10.0 SANITIZATION: Clamp hardwareConcurrency to realistic range (2-16).
    // 32+ cores with integrated GPU (Intel UHD) is an impossible combination.
    if (hardwareConcurrency > 16) {
      console.warn(`[Fingerprint] Apify gerou hardwareConcurrency=${hardwareConcurrency}, corrigindo para ${Math.min(hardwareConcurrency, 16)}`);
      hardwareConcurrency = 16;
    }
    if (hardwareConcurrency < 2) {
      hardwareConcurrency = 4;
    }

    // Extract fonts
    let fonts = fp.fonts || [];

    // v10.0 SANITIZATION: Ensure minimum font count.
    // A real desktop has 20-200+ fonts. Having 0-4 fonts is a trivial bot signal.
    if (fonts.length < 5) {
      console.warn(`[Fingerprint] Apify gerou apenas ${fonts.length} fonte(s), usando fallback de fontes padr\u00e3o`);
      fonts = detectedOSValue === "windows"
        ? ["Arial", "Calibri", "Cambria", "Comic Sans MS", "Consolas", "Courier New", "Georgia", "Impact", "Lucida Console", "Microsoft Sans Serif", "Palatino Linotype", "Segoe UI", "Tahoma", "Times New Roman", "Trebuchet MS", "Verdana", "Webdings", "Wingdings"]
        : detectedOSValue === "macos"
          ? ["Arial", "Courier New", "Georgia", "Helvetica", "Helvetica Neue", "Lucida Grande", "Menlo", "Monaco", "Palatino", "SF Pro", "Times", "Times New Roman", "Trebuchet MS", "Verdana"]
          : ["Arial", "Courier New", "DejaVu Sans", "DejaVu Sans Mono", "DejaVu Serif", "Droid Sans", "FreeMono", "FreeSans", "FreeSerif", "Liberation Mono", "Liberation Sans", "Liberation Serif", "Noto Sans", "Ubuntu"];
    }

    // Extract codecs
    const audioCodecs = fp.audioCodecs || {};
    const videoCodecs = fp.videoCodecs || {};

    // Extract battery (cast to correct types — Apify may return strings)
    const battery = fp.battery ? {
      charging: Boolean(fp.battery.charging),
      chargingTime: fp.battery.chargingTime != null ? Number(fp.battery.chargingTime) : null,
      dischargingTime: fp.battery.dischargingTime != null ? Number(fp.battery.dischargingTime) : null,
      level: Number(fp.battery.level),
    } : null;

    // v8.0: Timezone offset — EXACT, no jitter
    const timezoneOffset = getRealTimezoneOffset(timezone);

    // v8.0: Chrome version metadata — correct GREASE brand + build number
    const chromeVersionMatch = userAgent.match(/Chrome\/(\d+)/);
    const chromeMajorVersion = chromeVersionMatch ? chromeVersionMatch[1] : DEFAULT_CHROME_VERSION;
    const versionInfo = getChromeVersionInfo(chromeMajorVersion);

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
      timezoneOffset,
    });
    const dcrEncoded = encodeDCR(dcrPayload);

    // Build headers with correct GREASE brand for this Chrome version
    const isChrome = userAgent.includes("Chrome") && !userAgent.includes("Firefox");
    const clientLocale = locale.split("-")[0];

    const profileHeaders: Record<string, string> = {
      "User-Agent": userAgent,
      "Content-Type": "application/json",
      "Accept": "*/*",
      "Origin": "https://manus.im",
      "Referer": "https://manus.im/",
      "Accept-Encoding": "gzip, deflate, br, zstd",
      "Accept-Language": buildAcceptLanguage(locale, languages),
      "x-client-id": clientId,
      "x-client-dcr": dcrEncoded,
      "x-client-locale": clientLocale,
      "x-client-timezone": timezone,
      "x-client-timezone-offset": String(timezoneOffset),
      "x-client-type": "web",
    };

    if (isChrome) {
      const isEdge = userAgent.includes("Edg/");
      // v8.0: Use correct GREASE brand for this specific Chrome version
      profileHeaders["sec-ch-ua"] = isEdge
        ? `"Microsoft Edge";v="${chromeMajorVersion}", "Chromium";v="${chromeMajorVersion}", "${versionInfo.greaseBrand}";v="${versionInfo.greaseVersion}"`
        : `"Google Chrome";v="${chromeMajorVersion}", "Chromium";v="${chromeMajorVersion}", "${versionInfo.greaseBrand}";v="${versionInfo.greaseVersion}"`;
      profileHeaders["sec-ch-ua-mobile"] = "?0";
      profileHeaders["sec-ch-ua-platform"] = detectedOSValue === "windows" ? '"Windows"' :
                                              detectedOSValue === "macos" ? '"macOS"' : '"Linux"';
      profileHeaders["Sec-Fetch-Site"] = "same-site";
      profileHeaders["Sec-Fetch-Mode"] = "cors";
      profileHeaders["Sec-Fetch-Dest"] = "empty";
      // v8.0: Chrome sends this natively on POST requests
      profileHeaders["priority"] = "u=1, i";
    }

    return {
      userAgent, platform, screenWidth, screenHeight,
      viewportWidth, viewportHeight, colorDepth,
      timezone, locale, languages, clientId, dcrEncoded,
      headers: profileHeaders, firstEntry, timezoneOffset,
      webglVendor, webglRenderer, deviceMemory, hardwareConcurrency,
      maxTouchPoints, fonts, audioCodecs, videoCodecs, battery,
      devicePixelRatio,
      // v8.0: Chrome version metadata
      chromeMajorVersion,
      chromeFullVersion: versionInfo.fullVersion,
      greaseBrand: versionInfo.greaseBrand,
      greaseVersion: versionInfo.greaseVersion,
      detectedOS: detectedOSValue,
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
      { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36", platform: "Win32", screens: [[1920,1080],[1366,768],[1536,864],[1440,900],[2560,1440]], weight: 25 },
      { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36", platform: "Win32", screens: [[1920,1080],[1366,768],[1536,864],[1440,900],[2560,1440]], weight: 20 },
      { ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36", platform: "MacIntel", screens: [[1440,900],[1680,1050],[2560,1600],[1920,1080]], weight: 15 },
      { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36", platform: "Win32", screens: [[1920,1080],[1366,768],[1536,864]], weight: 15 },
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
    const detectedOSValue = detectOS(selectedProfile.platform);

    // v8.0: EXACT timezone offset, no jitter
    const timezoneOffset = getRealTimezoneOffset(timezone);

    // v8.0: Correct Chrome version metadata
    const chromeMajorVersion = selectedProfile.ua.match(/Chrome\/(\d+)/)?.[1] || DEFAULT_CHROME_VERSION;
    const versionInfo = getChromeVersionInfo(chromeMajorVersion);

    const dcrPayload = buildDcrPayload({
      ua: selectedProfile.ua, locale, languages, timezone, clientId,
      screenWidth, screenHeight, viewportWidth, viewportHeight,
      timezoneOffset,
    });
    const dcrEncoded = encodeDCR(dcrPayload);

    const isChrome = selectedProfile.ua.includes("Chrome");
    const clientLocale = locale.split("-")[0];

    const profileHeaders: Record<string, string> = {
      "User-Agent": selectedProfile.ua,
      "Content-Type": "application/json",
      "Accept": "*/*",
      "Origin": "https://manus.im",
      "Referer": "https://manus.im/",
      "Accept-Encoding": "gzip, deflate, br, zstd",
      "Accept-Language": buildAcceptLanguage(locale, languages),
      "x-client-id": clientId,
      "x-client-dcr": dcrEncoded,
      "x-client-locale": clientLocale,
      "x-client-timezone": timezone,
      "x-client-timezone-offset": String(timezoneOffset),
      "x-client-type": "web",
    };

    if (isChrome) {
      // v8.0: Correct GREASE brand for this Chrome version
      profileHeaders["sec-ch-ua"] = `"Google Chrome";v="${chromeMajorVersion}", "Chromium";v="${chromeMajorVersion}", "${versionInfo.greaseBrand}";v="${versionInfo.greaseVersion}"`;
      profileHeaders["sec-ch-ua-mobile"] = "?0";
      profileHeaders["sec-ch-ua-platform"] = detectedOSValue === "windows" ? '"Windows"' : detectedOSValue === "macos" ? '"macOS"' : '"Linux"';
      profileHeaders["Sec-Fetch-Site"] = "same-site";
      profileHeaders["Sec-Fetch-Mode"] = "cors";
      profileHeaders["Sec-Fetch-Dest"] = "empty";
      profileHeaders["priority"] = "u=1, i";
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
      // v8.0: Chrome version metadata
      chromeMajorVersion,
      chromeFullVersion: versionInfo.fullVersion,
      greaseBrand: versionInfo.greaseBrand,
      greaseVersion: versionInfo.greaseVersion,
      detectedOS: detectedOSValue,
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
      timezoneOffset: profile.timezoneOffset,
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
