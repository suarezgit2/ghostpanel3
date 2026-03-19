/**
 * Script de inspeção do fingerprint gerado pelo GhostPanel
 * Executa o fingerprintService e decodifica o DCR para análise
 */

import crypto from "crypto";

// ---- Replicar helpers ----
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function generateClientId(length = 22) {
  const bytes = crypto.randomBytes(length);
  let id = "";
  for (let i = 0; i < length; i++) id += ALPHABET[bytes[i] % ALPHABET.length];
  return id;
}

function encodeDCR(jsonString) {
  const base64 = Buffer.from(jsonString).toString("base64");
  let encoded = "";
  for (let i = 0; i < base64.length; i++) {
    const c = base64.charCodeAt(i);
    if (c >= 65 && c <= 90) encoded += String.fromCharCode(((c - 65 + 3) % 26) + 65);
    else if (c >= 97 && c <= 122) encoded += String.fromCharCode(((c - 97 + 3) % 26) + 97);
    else if (c >= 48 && c <= 57) encoded += String.fromCharCode(((c - 48 + 3) % 10) + 48);
    else encoded += base64[i];
  }
  return encoded;
}

function decodeDCR(encoded) {
  let decoded = "";
  for (let i = 0; i < encoded.length; i++) {
    const c = encoded.charCodeAt(i);
    if (c >= 65 && c <= 90) decoded += String.fromCharCode(((c - 65 - 3 + 26) % 26) + 65);
    else if (c >= 97 && c <= 122) decoded += String.fromCharCode(((c - 97 - 3 + 26) % 26) + 97);
    else if (c >= 48 && c <= 57) decoded += String.fromCharCode(((c - 48 - 3 + 10) % 10) + 48);
    else decoded += encoded[i];
  }
  return JSON.parse(Buffer.from(decoded, "base64").toString("utf8"));
}

function getRealTimezoneOffset(timezone) {
  try {
    const now = new Date();
    const utcDate = new Date(now.toLocaleString("en-US", { timeZone: "UTC" }));
    const tzDate = new Date(now.toLocaleString("en-US", { timeZone: timezone }));
    return Math.round((utcDate.getTime() - tzDate.getTime()) / 60000);
  } catch {
    return 300;
  }
}

function generateFgRequestId() {
  const ALPHANUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const pageLoadDelay = 20000 + Math.floor(Math.random() * 20000);
  const ts = Date.now() - pageLoadDelay;
  let rand = "";
  for (let i = 0; i < 6; i++) rand += ALPHANUM[Math.floor(Math.random() * ALPHANUM.length)];
  return `${ts}.${rand}`;
}

// ---- Perfis UA ----
const UA_PROFILES = [
  { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36", platform: "Win32", screens: [[1920,1080],[1366,768],[1536,864]], chromeVersion: "136", weight: 25 },
  { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36", platform: "Win32", screens: [[1920,1080],[1366,768]], chromeVersion: "135", weight: 20 },
  { ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36", platform: "MacIntel", screens: [[1440,900],[2560,1600]], chromeVersion: "136", weight: 15 },
];

const TIMEZONES = {
  us: ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles"],
};

const FIRST_ENTRY_OPTIONS = [
  { value: "direct", weight: 55 }, { value: "google", weight: 25 },
  { value: "twitter", weight: 8 }, { value: "linkedin", weight: 5 },
  { value: "facebook", weight: 4 }, { value: "reddit", weight: 3 },
];

function randomFirstEntry() {
  const total = FIRST_ENTRY_OPTIONS.reduce((s, o) => s + o.weight, 0);
  let r = Math.random() * total;
  for (const opt of FIRST_ENTRY_OPTIONS) { r -= opt.weight; if (r <= 0) return opt.value; }
  return "direct";
}

// ---- Gerar perfil ----
const profile = UA_PROFILES[0]; // Windows Chrome 136
const [screenWidth, screenHeight] = [1920, 1080];
const viewportWidth = 1920;
const viewportHeight = 1080 - (80 + Math.floor(Math.random() * 40));
const timezone = "America/New_York";
const locale = "en-US";
const languages = ["en-US", "en"];
const clientId = generateClientId();
const firstEntry = randomFirstEntry();
const timezoneOffset = getRealTimezoneOffset(timezone);
const chromeVersion = profile.chromeVersion;

const dcrPayload = {
  ua: profile.ua,
  locale,
  languages,
  timezone,
  fgRequestId: generateFgRequestId(),
  clientId,
  screen: { width: screenWidth, height: screenHeight },
  viewport: { width: viewportWidth, height: viewportHeight },
  timestamp: Date.now(),
  timezoneOffset,
};

const dcrEncoded = encodeDCR(JSON.stringify(dcrPayload));
const dcrDecoded = decodeDCR(dcrEncoded);

// ---- Headers ----
const headers = {
  "User-Agent": profile.ua,
  "Content-Type": "application/json",
  "Accept": "*/*",
  "Origin": "https://manus.im",
  "Referer": "https://manus.im/",
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "Accept-Language": `${locale},en;q=0.9`,
  "x-client-id": clientId,
  "x-client-dcr": dcrEncoded,
  "X-Client-Locale": "en",
  "X-Client-Timezone": timezone,
  "X-Client-Timezone-Offset": String(timezoneOffset),
  "X-Client-Type": "web",
  "X-Client-Version": "2.3.1",
  "sec-ch-ua": `"Google Chrome";v="${chromeVersion}", "Chromium";v="${chromeVersion}", "Not A(Brand";v="24"`,
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "Sec-Fetch-Site": "same-site",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Dest": "empty",
};

// ---- Relatório ----
console.log("\n=== GHOST PANEL — INSPEÇÃO DE FINGERPRINT ===\n");

console.log("📋 PERFIL GERADO:");
console.log(`  User-Agent:       ${profile.ua}`);
console.log(`  Platform:         ${profile.platform}`);
console.log(`  Screen:           ${screenWidth}x${screenHeight}`);
console.log(`  Viewport:         ${viewportWidth}x${viewportHeight}`);
console.log(`  Timezone:         ${timezone}`);
console.log(`  TimezoneOffset:   ${timezoneOffset} min (${timezoneOffset/60}h west of UTC)`);
console.log(`  Locale:           ${locale}`);
console.log(`  Languages:        ${JSON.stringify(languages)}`);
console.log(`  ClientId:         ${clientId}`);
console.log(`  FirstEntry:       ${firstEntry}`);
console.log(`  Chrome Version:   ${chromeVersion}`);

console.log("\n📦 DCR DECODIFICADO:");
console.log(JSON.stringify(dcrDecoded, null, 2));

console.log("\n🔍 VERIFICAÇÕES DE CONSISTÊNCIA:");

// 1. UA vs sec-ch-ua
const uaChrome = profile.ua.match(/Chrome\/(\d+)/)?.[1];
const secChrome = headers["sec-ch-ua"].match(/v="(\d+)"/)?.[1];
const uaMatch = uaChrome === secChrome;
console.log(`  [${uaMatch ? "✅" : "❌"}] UA Chrome version (${uaChrome}) == sec-ch-ua version (${secChrome})`);

// 2. Timezone vs TimezoneOffset
const expectedOffset = getRealTimezoneOffset(timezone);
const offsetMatch = timezoneOffset === expectedOffset;
console.log(`  [${offsetMatch ? "✅" : "❌"}] Timezone (${timezone}) offset (${timezoneOffset}) == calculado (${expectedOffset})`);

// 3. DST awareness (em março 2026, NY deve ser EDT = UTC-4 = offset 240)
const isDSTCorrect = timezoneOffset === 240; // EDT em março
console.log(`  [${isDSTCorrect ? "✅" : "❌"}] DST-aware: NY em março = EDT (offset=240) — atual: ${timezoneOffset}`);

// 4. fgRequestId format
const fgMatch = /^\d{13}\.[a-zA-Z0-9]{6}$/.test(dcrDecoded.fgRequestId);
console.log(`  [${fgMatch ? "✅" : "❌"}] fgRequestId formato válido: "${dcrDecoded.fgRequestId}"`);

// 5. fgRequestId timestamp (deve ser 20-40s antes do DCR timestamp)
const fgTs = parseInt(dcrDecoded.fgRequestId.split(".")[0]);
const dcrTs = dcrDecoded.timestamp;
const diff = dcrTs - fgTs;
const diffOk = diff >= 20000 && diff <= 40000;
console.log(`  [${diffOk ? "✅" : "❌"}] fgRequestId timestamp ${diff}ms antes do DCR (esperado: 20000-40000ms)`);

// 6. DCR timestamp freshness
const age = Date.now() - dcrDecoded.timestamp;
const fresh = age < 1000;
console.log(`  [${fresh ? "✅" : "❌"}] DCR timestamp fresco: ${age}ms atrás`);

// 7. clientId no DCR == clientId no header
const clientIdMatch = dcrDecoded.clientId === clientId;
console.log(`  [${clientIdMatch ? "✅" : "❌"}] clientId no DCR == header x-client-id`);

// 8. UA no DCR == UA no header
const uaDcrMatch = dcrDecoded.ua === headers["User-Agent"];
console.log(`  [${uaDcrMatch ? "✅" : "❌"}] UA no DCR == User-Agent header`);

// 9. locale no DCR == X-Client-Locale (base)
const localeDcrMatch = dcrDecoded.locale === locale;
const clientLocaleMatch = headers["X-Client-Locale"] === locale.split("-")[0];
console.log(`  [${localeDcrMatch ? "✅" : "❌"}] locale no DCR == "${locale}"`);
console.log(`  [${clientLocaleMatch ? "✅" : "❌"}] X-Client-Locale == "${locale.split("-")[0]}" (base sem região)`);

// 10. sec-ch-ua-platform vs platform
const platformMap = { "Win32": '"Windows"', "MacIntel": '"macOS"', "Linux x86_64": '"Linux"' };
const platformMatch = headers["sec-ch-ua-platform"] === platformMap[profile.platform];
console.log(`  [${platformMatch ? "✅" : "❌"}] sec-ch-ua-platform (${headers["sec-ch-ua-platform"]}) == platform (${profile.platform})`);

// 11. viewport < screen
const viewportOk = viewportHeight < screenHeight && viewportWidth === screenWidth;
console.log(`  [${viewportOk ? "✅" : "❌"}] viewport (${viewportWidth}x${viewportHeight}) < screen (${screenWidth}x${screenHeight})`);

// 12. firstEntry distribution check (gerar 100 amostras)
const entries = {};
for (let i = 0; i < 100; i++) {
  const e = randomFirstEntry();
  entries[e] = (entries[e] || 0) + 1;
}
const directPct = entries["direct"] || 0;
const notAllDirect = directPct < 100;
console.log(`  [${notAllDirect ? "✅" : "❌"}] firstEntry distribuição (100 amostras): ${JSON.stringify(entries)}`);

console.log("\n📊 HEADERS PARA API MANUS:");
for (const [k, v] of Object.entries(headers)) {
  const truncated = v.length > 80 ? v.substring(0, 77) + "..." : v;
  console.log(`  ${k}: ${truncated}`);
}

console.log("\n✅ Inspeção concluída.\n");
