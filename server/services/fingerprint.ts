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
 *   fgRequestId: string,  // FingerprintJS Pro requestId (empty string when not available)
 *   clientId: string,     // localStorage client_id_v2
 *   screen: { width, height },
 *   viewport: { width, height },
 *   timestamp: number,    // Date.now()
 *   timezoneOffset: number // new Date().getTimezoneOffset()
 * }
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

interface UAProfile {
  ua: string;
  platform: string;
  screens: number[][];
  weight: number;
}

const UA_PROFILES: UAProfile[] = [
  { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36", platform: "Win32", screens: [[1920,1080],[1366,768],[1536,864],[1440,900],[2560,1440]], weight: 30 },
  { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36", platform: "Win32", screens: [[1920,1080],[1366,768],[1536,864],[1440,900],[2560,1440]], weight: 20 },
  { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36", platform: "Win32", screens: [[1920,1080],[1366,768],[1536,864],[1440,900]], weight: 10 },
  { ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36", platform: "MacIntel", screens: [[1440,900],[1680,1050],[2560,1600],[1920,1080]], weight: 12 },
  { ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36", platform: "MacIntel", screens: [[1440,900],[1680,1050],[2560,1600],[1920,1080]], weight: 8 },
  { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0", platform: "Win32", screens: [[1920,1080],[1366,768],[1536,864]], weight: 5 },
  { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0", platform: "Win32", screens: [[1920,1080],[1366,768],[1536,864],[1440,900]], weight: 8 },
  { ua: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36", platform: "Linux x86_64", screens: [[1920,1080],[1366,768],[2560,1440]], weight: 3 },
];

const TIMEZONES: Record<string, string[]> = {
  us: ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles"],
  br: ["America/Sao_Paulo", "America/Fortaleza", "America/Manaus"],
  eu: ["Europe/London", "Europe/Berlin", "Europe/Paris", "Europe/Madrid"],
  asia: ["Asia/Tokyo", "Asia/Shanghai", "Asia/Singapore", "Asia/Kolkata"],
  default: ["America/New_York", "America/Chicago", "America/Los_Angeles", "Europe/London", "America/Sao_Paulo"],
};

// UTC offsets in minutes (positive = west of UTC, matching JS getTimezoneOffset())
const TZ_OFFSETS: Record<string, number> = {
  "America/New_York": 300,
  "America/Chicago": 360,
  "America/Denver": 420,
  "America/Los_Angeles": 480,
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

const LOCALES: Record<string, string[]> = {
  us: ["en-US"],
  br: ["pt-BR", "en-US"],
  eu: ["en-GB", "de-DE", "fr-FR", "es-ES"],
  asia: ["ja-JP", "zh-CN", "en-SG"],
  default: ["en-US", "pt-BR", "en-GB"],
};

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
}

/**
 * Build the DCR payload matching the exact format used by manus.im frontend.
 * Reverse-engineered from module 54273 of the manus.im webapp.
 *
 * The real getDCR() builds:
 * {
 *   ua, locale, languages, timezone, fgRequestId, clientId,
 *   screen: { width, height }, viewport: { width, height },
 *   timestamp, timezoneOffset
 * }
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
  const tzOffset = TZ_OFFSETS[params.timezone] ?? 300;
  const payload = {
    ua: params.ua,
    locale: params.locale,
    languages: params.languages,
    timezone: params.timezone,
    fgRequestId: generateFgRequestId(), // FingerprintJS Pro requestId — realistic format {ts}.{rand6}
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

    // Build DCR with the CORRECT format matching manus.im frontend
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

    const isChrome = selectedProfile.ua.includes("Chrome");
    const chromeVersion = selectedProfile.ua.match(/Chrome\/(\d+)/)?.[1] || "133";

    // X-Client-Locale: use base language only ("en", not "en-US") — matches real browser behavior
    const clientLocale = locale.split("-")[0];

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
      "X-Client-Locale": clientLocale,
      "X-Client-Timezone": timezone,
      "X-Client-Timezone-Offset": String(TZ_OFFSETS[timezone] ?? 300),
      "X-Client-Type": "web",
      "X-Client-Version": "1.0.0",
    };

    if (isChrome) {
      const isEdge = selectedProfile.ua.includes("Edg/");
      // Use exact Chrome brand format: "Not A(Brand" (matches real Chrome 143 traffic)
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
    };
  }

  /**
   * Regenerate the DCR for a given profile with a fresh timestamp.
   * Used for calls that require a fresh DCR (e.g. CheckInvitationCode).
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
      "x-client-type", "x-client-version",
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
