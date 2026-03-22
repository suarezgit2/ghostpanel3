/**
 * FPJS Pro Direct Client — HTTP POST without Puppeteer (v8.0 — Anti-Detection Hardening)
 *
 * Generates a REAL FPJS Pro requestId by:
 * 1. Building the fingerprint payload JSON (144 signals)
 * 2. Compressing with deflate-raw
 * 3. Applying XOR obfuscation (reverse-engineered from FPJS loader v3.11.8)
 * 4. Sending via HTTP POST to metrics.manus.im
 * 5. Decrypting the response to extract requestId
 *
 * v8.0 CHANGES (Anti-Bot Audit Fixes):
 * - s58 (UA Client Hints): Now uses correct GREASE brand + build number from profile
 *   (was hardcoded "Not.A/Brand" v8 + build 7103 for ALL versions)
 * - s56 (TLS fingerprint): Deterministic per-profile instead of static for all
 * - s119 (Error stack): Varied per Chrome version instead of identical for all
 * - s49 (WebGL precision): OS-aware values (Windows ≠ macOS ≠ Linux)
 * - s50 (WebGL hash): Deterministic per GPU renderer instead of static
 * - s87 (CSS system colors): OS-aware (Windows light ≠ macOS ≠ Linux)
 * - s6 (Screen available): Realistic values based on screen size and OS
 * - s55 (Canvas/WebGL hash): Deterministic per clientId (was random per call)
 * - s94 (WebRTC): Realistic candidate format with varied ports and ufrags
 * - s79 (Fonts): OS-aware font list instead of Windows-only "default.ini"
 * - exp_s1003: OS-aware drive letter (Windows "c:" vs macOS/Linux empty)
 * - s22/s24 (Color depth): Correct values per OS
 * - s29 (GPU memory): Derived from GPU renderer instead of static 10GB
 * - s51 (Font metrics): OS-aware base values (Windows ≠ macOS ≠ Linux)
 * - s145 (Navigator features): OS-aware API list
 *
 * Reverse-engineered from FPJS Pro loader v3.11.8 (Hi/Yi/Xi functions).
 * Encryption is XOR obfuscation with a 9-byte random key embedded in the payload.
 */

import { randomBytes } from "crypto";
import { deflateRawSync } from "zlib";
import https from "https";
import http from "http";
import tls from "tls";
import type { ProxyInfo } from "./proxy";
import type { BrowserProfile } from "./fingerprint";
import { ensureImpers, getImpers, getImpersonateTarget } from "./httpClient";

// ============================================================
// FPJS XOR Obfuscation (reverse-engineered from Hi/Yi functions)
// ============================================================

const MARKERS_COMPRESSED: number[] = [3, 14];
const MARKERS_UNCOMPRESSED: number[] = [3, 13];
const KEY_LENGTH = 9;
const PADDING_RANGE = 3;

/**
 * Encrypt (obfuscate) data using FPJS's Hi() algorithm.
 * This is a simple XOR cipher with a random key embedded in the output.
 */
function fpjsEncrypt(plainData: Buffer, compressed: boolean): Buffer {
  const markers = compressed ? MARKERS_COMPRESSED : MARKERS_UNCOMPRESSED;
  const headerByte = randomBytes(1)[0];
  const paddingLen = randomBytes(1)[0] % (PADDING_RANGE + 1);
  const padding = randomBytes(paddingLen);
  const xorKey = randomBytes(KEY_LENGTH);

  const totalLen = 1 + markers.length + 1 + paddingLen + KEY_LENGTH + plainData.length;
  const output = Buffer.alloc(totalLen);
  let offset = 0;

  // Header byte
  output[offset++] = headerByte;

  // Marker bytes (header + marker value, wraps at 256)
  for (const marker of markers) {
    output[offset++] = (headerByte + marker) & 0xFF;
  }

  // Padding length (header + paddingLen, wraps at 256)
  output[offset++] = (headerByte + paddingLen) & 0xFF;

  // Random padding
  padding.copy(output, offset);
  offset += paddingLen;

  // XOR key
  xorKey.copy(output, offset);
  offset += KEY_LENGTH;

  // XOR-encrypted data
  for (let i = 0; i < plainData.length; i++) {
    output[offset++] = plainData[i] ^ xorKey[i % KEY_LENGTH];
  }

  return output;
}

/**
 * Decrypt data using FPJS's Yi() algorithm.
 */
function fpjsDecrypt(data: Buffer, markers: number[]): Buffer {
  if (data.length < markers.length + 2) {
    throw new Error("FPJS decrypt: data too short");
  }

  const headerByte = data[0];

  // Verify markers
  for (let i = 0; i < markers.length; i++) {
    const actual = (data[1 + i] - headerByte + 256) % 256;
    if (actual !== markers[i]) {
      throw new Error(`FPJS decrypt: marker mismatch at ${i}: expected ${markers[i]}, got ${actual}`);
    }
  }

  // Read padding length
  const paddingLenOffset = 1 + markers.length;
  const paddingLen = (data[paddingLenOffset] - headerByte + 256) % 256;

  // Calculate offsets
  const keyStart = paddingLenOffset + 1 + paddingLen;
  const dataStart = keyStart + KEY_LENGTH;

  if (data.length < dataStart) {
    throw new Error("FPJS decrypt: data too short for key + padding");
  }

  // Extract XOR key and decrypt
  const xorKey = data.slice(keyStart, keyStart + KEY_LENGTH);
  const decrypted = Buffer.alloc(data.length - dataStart);
  for (let i = 0; i < decrypted.length; i++) {
    decrypted[i] = data[dataStart + i] ^ xorKey[i % KEY_LENGTH];
  }

  return decrypted;
}

// ============================================================
// Signal Helpers
// ============================================================

function sig(value: unknown, status: number = 0): { s: number; v: unknown } {
  return { s: status, v: value };
}

const OK = 0;
const NOT_SUPPORTED = -1;
const ERROR = -2;
const TIMEOUT = -3;
const SKIPPED = -4;

function generateHexHash(): string {
  return randomBytes(16).toString("hex");
}

function generateUUID(): string {
  const hex = randomBytes(16).toString("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20,32)}`;
}

// ============================================================
// OS-Aware Signal Generators
// ============================================================

/**
 * Generate realistic WebRTC ICE candidate.
 * Real Chrome generates random ports (49152-65535) and 4-char alphanumeric ufrags.
 */
function generateWebRTCCandidate(clientId: string): { u: string; e: string[] } {
  const h = hashCode(clientId + "webrtc");
  const port = 49152 + (h % 16383); // ephemeral port range
  // Generate deterministic but varied ufrag (4 alphanumeric chars)
  const ufragChars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let ufrag = "";
  let seed = hashCode(clientId + "ufrag");
  for (let i = 0; i < 4; i++) {
    ufrag += ufragChars[seed % ufragChars.length];
    seed = ((seed * 1103515245) + 12345) & 0x7fffffff;
  }
  // Generate a private IP that looks realistic
  const octet3 = (hashCode(clientId + "ip3") % 254) + 1;
  const octet4 = (hashCode(clientId + "ip4") % 254) + 1;
  const ip = `192.168.${octet3}.${octet4}`;

  return {
    u: generateUUID(),
    e: [`candidate:1 1 udp 2113937151 ${ip} ${port} typ host generation 0 ufrag ${ufrag} network-cost 999`],
  };
}

/**
 * Generate OS-aware CSS system colors.
 * Windows, macOS, and Linux have distinctly different system color schemes.
 */
function getSystemColors(os: "windows" | "macos" | "linux"): Record<string, string> {
  switch (os) {
    case "windows":
      return {
        ac: "rgb(0, 0, 0)", act: "rgb(0, 0, 0)", at: "rgb(255, 255, 255)",
        bg: "rgb(255, 255, 255)", bf: "rgb(0, 0, 0)", bt: "rgb(255, 255, 255)",
        cv: "rgb(255, 255, 255)", cvt: "rgb(0, 0, 0)", ft: "rgb(0, 0, 0)",
        ht: "rgb(0, 0, 238)", htb: "rgb(0, 0, 0)", hta: "rgb(85, 26, 139)",
        mk: "rgb(0, 0, 0)", mkb: "rgb(255, 255, 0)",
      };
    case "macos":
      return {
        ac: "rgb(0, 122, 255)", act: "rgb(255, 255, 255)", at: "rgb(255, 255, 255)",
        bg: "rgb(255, 255, 255)", bf: "rgb(0, 0, 0)", bt: "rgb(255, 255, 255)",
        cv: "rgb(255, 255, 255)", cvt: "rgb(0, 0, 0)", ft: "rgb(0, 0, 0)",
        ht: "rgb(0, 0, 238)", htb: "rgb(0, 0, 0)", hta: "rgb(85, 26, 139)",
        mk: "rgb(0, 0, 0)", mkb: "rgb(255, 255, 0)",
      };
    case "linux":
      return {
        ac: "rgb(53, 132, 228)", act: "rgb(255, 255, 255)", at: "rgb(255, 255, 255)",
        bg: "rgb(255, 255, 255)", bf: "rgb(0, 0, 0)", bt: "rgb(255, 255, 255)",
        cv: "rgb(255, 255, 255)", cvt: "rgb(0, 0, 0)", ft: "rgb(0, 0, 0)",
        ht: "rgb(0, 0, 238)", htb: "rgb(0, 0, 0)", hta: "rgb(85, 26, 139)",
        mk: "rgb(0, 0, 0)", mkb: "rgb(255, 255, 0)",
      };
  }
}

/**
 * Generate OS-aware font metrics base values.
 * Windows, macOS, and Linux render text with different metrics due to
 * different font engines (DirectWrite, CoreText, FreeType).
 */
function getFontMetrics(os: "windows" | "macos" | "linux", clientId: string): Record<string, number> {
  const jitter = (seed: string) => ((hashCode(clientId + seed) % 100) - 50) / 100; // ±0.5

  switch (os) {
    case "windows":
      return {
        default: 149.3125 + jitter("f_def"),
        apple: 149.3125 + jitter("f_apl"),
        serif: 149.3125 + jitter("f_ser"),
        sans: 144.015625 + jitter("f_san"),
        mono: 132.609375 + jitter("f_mon"),
        min: 9.34375 + jitter("f_min"),
        system: 144.640625 + jitter("f_sys"),
      };
    case "macos":
      return {
        default: 150.4375 + jitter("f_def"),
        apple: 150.4375 + jitter("f_apl"),
        serif: 150.4375 + jitter("f_ser"),
        sans: 144.859375 + jitter("f_san"),
        mono: 131.203125 + jitter("f_mon"),
        min: 9.34375 + jitter("f_min"),
        system: 144.859375 + jitter("f_sys"),
      };
    case "linux":
      return {
        default: 150.078125 + jitter("f_def"),
        apple: 150.078125 + jitter("f_apl"),
        serif: 150.078125 + jitter("f_ser"),
        sans: 143.953125 + jitter("f_san"),
        mono: 130.40625 + jitter("f_mon"),
        min: 8.890625 + jitter("f_min"),
        system: 143.953125 + jitter("f_sys"),
      };
  }
}

/**
 * Generate OS-aware screen available rect.
 * Windows: taskbar at bottom (40px default), macOS: menu bar at top (25px),
 * Linux: varies but typically top panel (28px).
 */
function getScreenAvailable(os: "windows" | "macos" | "linux", screenWidth: number, screenHeight: number): number[] {
  switch (os) {
    case "windows": {
      const taskbarHeight = 40 + (hashCode(screenWidth + "tb") % 8); // 40-48px
      return [0, 0, screenWidth, screenHeight - taskbarHeight];
    }
    case "macos": {
      const menuBarHeight = 25;
      return [0, menuBarHeight, screenWidth, screenHeight - menuBarHeight];
    }
    case "linux": {
      const panelHeight = 28 + (hashCode(screenWidth + "pn") % 6); // 28-34px
      return [0, panelHeight, screenWidth, screenHeight - panelHeight];
    }
  }
}

/**
 * Generate OS-aware WebGL float precision values.
 * Different GPU drivers report different precision ranges.
 */
function getWebGLPrecision(os: "windows" | "macos" | "linux", gpuRenderer: string): [number, number] {
  // Intel GPUs on Windows
  if (os === "windows" && gpuRenderer.includes("Intel")) {
    return [0.09999999403953552, 0.10000000149011612];
  }
  // NVIDIA on Windows
  if (os === "windows" && (gpuRenderer.includes("NVIDIA") || gpuRenderer.includes("GeForce"))) {
    return [0.0009765625, 0.0009765625];
  }
  // AMD on Windows
  if (os === "windows" && (gpuRenderer.includes("AMD") || gpuRenderer.includes("Radeon"))) {
    return [0.0009765625, 0.0009765625];
  }
  // macOS (Apple GPU or Intel)
  if (os === "macos") {
    if (gpuRenderer.includes("Apple")) {
      return [0.0009765625, 0.0009765625];
    }
    return [0.09999999403953552, 0.10000000149011612];
  }
  // Linux (Mesa/Intel/NVIDIA)
  if (os === "linux") {
    return [0.09999999403953552, 0.10000000149011612];
  }
  // Default fallback
  return [0.09999999403953552, 0.10000000149011612];
}

/**
 * Estimate GPU memory from renderer string.
 * Real Chrome reports this via WebGL extension WEBGL_memory_info.
 */
function estimateGPUMemory(gpuRenderer: string): number {
  if (gpuRenderer.includes("RTX 4090") || gpuRenderer.includes("RTX 4080")) return 17179869184;
  if (gpuRenderer.includes("RTX 3090")) return 12884901888;
  if (gpuRenderer.includes("RTX 3080") || gpuRenderer.includes("RTX 3070")) return 10737418240;
  if (gpuRenderer.includes("RTX 3060") || gpuRenderer.includes("RTX 2080")) return 8589934592;
  if (gpuRenderer.includes("RTX 2070") || gpuRenderer.includes("RTX 2060")) return 6442450944;
  if (gpuRenderer.includes("GTX 1660") || gpuRenderer.includes("GTX 1650")) return 4294967296;
  if (gpuRenderer.includes("GTX 1080") || gpuRenderer.includes("GTX 1070")) return 8589934592;
  if (gpuRenderer.includes("Radeon RX 7") || gpuRenderer.includes("Radeon RX 6")) return 8589934592;
  if (gpuRenderer.includes("Apple M")) return 8589934592;
  if (gpuRenderer.includes("Apple GPU")) return 8589934592;
  if (gpuRenderer.includes("Iris Xe") || gpuRenderer.includes("Iris Plus")) return 4294967296;
  if (gpuRenderer.includes("UHD Graphics")) return 2147483648;
  if (gpuRenderer.includes("Intel")) return 2147483648;
  // Default: 4GB
  return 4294967296;
}

/**
 * Generate a deterministic TLS fingerprint hash per profile.
 * In real FPJS, this is collected at the CDN edge from the TLS handshake.
 * We generate a plausible base64 value that varies per profile to avoid
 * all accounts sharing the same static hash.
 */
function generateTLSFingerprint(clientId: string): string {
  // Generate 64 deterministic bytes and encode as base64
  const bytes = Buffer.alloc(64);
  let seed = hashCode(clientId + "tls_fp");
  for (let i = 0; i < 64; i++) {
    seed = ((seed * 1103515245) + 12345) & 0x7fffffff;
    bytes[i] = seed & 0xFF;
  }
  return bytes.toString("base64");
}

/**
 * Generate OS-aware error stack trace for s119.
 * The line/column numbers vary subtly by Chrome version.
 */
function generateErrorStack(chromeMajorVersion: string): string {
  const h = hashCode(chromeMajorVersion + "err_stack");
  const col = 1 + (h % 3); // column 1-3
  return `TypeError: Cannot read properties of null (reading '0')\n    at https://files.manuscdn.com/assets/js/fpm_loader_v3.11.8.js:1:${col}`;
}

/**
 * Generate OS-aware navigator feature list for s145.
 * macOS and Linux Chrome have slightly different navigator properties.
 */
function getNavigatorFeatures(os: "windows" | "macos" | "linux"): string[] {
  const base = [
    "getGamepads", "javaEnabled", "sendBeacon", "vibrate",
    "NavigatorUAData", "bluetooth", "clipboard", "credentials",
    "keyboard", "managed", "mediaDevices", "storage",
    "serviceWorker", "virtualKeyboard", "wakeLock", "xr",
  ];
  if (os === "linux") {
    // Linux Chrome doesn't expose bluetooth or xr in many configurations
    return base.filter(f => f !== "bluetooth" && f !== "xr");
  }
  return base;
}

/**
 * Generate OS-aware font config path for s79.
 * Windows: "default.ini", macOS: null (not supported), Linux: "fonts.conf"
 */
function getFontConfig(os: "windows" | "macos" | "linux"): { value: unknown; status: number } {
  switch (os) {
    case "windows":
      return { value: [{ n: "default.ini", l: -1 }], status: TIMEOUT };
    case "macos":
      return { value: null, status: NOT_SUPPORTED };
    case "linux":
      return { value: [{ n: "fonts.conf", l: -1 }], status: TIMEOUT };
  }
}

// ============================================================
// Fingerprint Payload Builder (144 signals)
// ============================================================

/**
 * Build the complete FPJS payload matching real browser output.
 * Uses data from the BrowserProfile to ensure consistency with RPC headers.
 *
 * v8.0: All signals are now OS-aware and version-consistent.
 */
function buildFpjsPayload(profile: BrowserProfile): Record<string, unknown> {
  const now = Date.now();
  const os = profile.detectedOS;
  const isWindows = os === "windows";
  const isMacOS = os === "macos";
  const isChrome = profile.userAgent.includes("Chrome") && !profile.userAgent.includes("Firefox");
  const chromeVersion = profile.chromeMajorVersion;

  // v8.0: Build User-Agent Client Hints with CORRECT GREASE brand + build number
  const uaData = isChrome ? {
    b: [
      { brand: "Chromium", version: chromeVersion },
      { brand: "Google Chrome", version: chromeVersion },
      { brand: profile.greaseBrand, version: profile.greaseVersion },
    ],
    m: false,
    p: isWindows ? "Windows" : (isMacOS ? "macOS" : "Linux"),
    h: {
      brands: JSON.stringify([
        { brand: "Chromium", version: chromeVersion },
        { brand: "Google Chrome", version: chromeVersion },
        { brand: profile.greaseBrand, version: profile.greaseVersion },
      ]),
      mobile: "false",
      platform: isWindows ? "Windows" : (isMacOS ? "macOS" : "Linux"),
      platformVersion: isWindows ? "15.0.0" : (isMacOS ? "14.7.1" : "6.8.0"),
      architecture: "x86",
      bitness: "64",
      model: "",
      uaFullVersion: profile.chromeFullVersion,
      fullVersionList: JSON.stringify([
        { brand: "Chromium", version: profile.chromeFullVersion },
        { brand: "Google Chrome", version: profile.chromeFullVersion },
        { brand: profile.greaseBrand, version: `${profile.greaseVersion}.0.0.0` },
      ]),
    },
    nah: [],
  } : {
    b: [], m: false, p: "", h: {
      brands: "[]", mobile: "false", platform: "", platformVersion: "",
      architecture: "", bitness: "", model: "", uaFullVersion: "", fullVersionList: "[]",
    }, nah: [],
  };

  // Audio fingerprint — realistic Chrome values with slight per-profile variation
  const audioBase = 124.04347527516074;
  const audioJitter = (hashCode(profile.clientId) % 1000) / 100000; // deterministic per profile
  const audioFp = audioBase + audioJitter;

  // Canvas hashes — deterministic per profile to maintain consistency across calls
  const canvasGeometry = deterministicHash(profile.clientId + "canvas_geo");
  const canvasText = deterministicHash(profile.clientId + "canvas_txt");
  const mathHash = deterministicHash(profile.clientId + "math");
  const webglHash = deterministicHash(profile.clientId + "webgl");

  // v8.0: OS-aware font metrics
  const fontBase = getFontMetrics(os, profile.clientId);

  // WebGL vendor/renderer — sourced from Apify (consistent with OS/device)
  const webglVendor = profile.webglVendor;
  const webglRenderer = profile.webglRenderer;

  // v8.0: OS-aware WebGL precision and GPU memory
  const webglPrecision = getWebGLPrecision(os, webglRenderer);
  const gpuMemory = estimateGPUMemory(webglRenderer);

  // v8.0: OS-aware screen available rect
  const screenAvail = getScreenAvailable(os, profile.screenWidth, profile.screenHeight);

  // v8.0: OS-aware CSS system colors
  const systemColors = getSystemColors(os);

  // v8.0: OS-aware font config
  const fontConfig = getFontConfig(os);

  // v8.0: Deterministic canvas/webgl hash (NOT random per call)
  const canvasWebglHash = deterministicHash(profile.clientId + "s55_canvas_webgl");

  // v8.0: Deterministic TLS fingerprint per profile
  const tlsFingerprint = generateTLSFingerprint(profile.clientId);

  // v8.0: Version-aware error stack
  const errorStack = generateErrorStack(chromeVersion);

  // v8.0: OS-aware WebRTC candidate
  const webrtcCandidate = generateWebRTCCandidate(profile.clientId);

  // v8.0: OS-aware navigator features
  const navigatorFeatures = getNavigatorFeatures(os);

  return {
    // Metadata
    c: "nG226lNwQWNTTWzOzKbF",
    m: "l",
    l: "jsl/3.11.8",
    mo: ["id"],  // ONLY identification — no bot detection (bd) or extras (ex)
    sc: { u: "https://files.manuscdn.com/assets/js/fpm_loader_v3.11.8.js" },
    gt: 1,
    ab: { noop: "b", CTRb3vV: "ctrl" },
    url: "https://manus.im/login",
    epv: "e683a40",
    lr: [{ r: null }],

    // v8.0: TLS fingerprint — deterministic per profile (was static for all)
    s56: sig(tlsFingerprint),
    s67: sig(null, NOT_SUPPORTED),

    // Browser signals
    s1: sig(isWindows ? null : (os === "linux" ? "Linux x86_64" : null), isWindows ? NOT_SUPPORTED : OK),
    s2: sig([profile.languages]),
    s3: sig(profile.colorDepth),
    s4: sig(profile.deviceMemory),
    s5: sig([profile.screenWidth, profile.screenHeight]),
    // v8.0: OS-aware screen available rect (was [0,0,0,0])
    s6: sig(screenAvail),
    s7: sig(profile.hardwareConcurrency),
    s9: sig(profile.timezone),
    s10: sig(true),
    s11: sig(true),
    s13: sig(false),
    s14: sig(null, NOT_SUPPORTED),
    s15: sig(profile.platform),
    s16: sig([
      { name: "PDF Viewer", description: "Portable Document Format", mimeTypes: [{ type: "application/pdf", suffixes: "pdf" }, { type: "text/pdf", suffixes: "pdf" }] },
      { name: "Chrome PDF Viewer", description: "Portable Document Format", mimeTypes: [{ type: "application/pdf", suffixes: "pdf" }, { type: "text/pdf", suffixes: "pdf" }] },
      { name: "Chromium PDF Viewer", description: "Portable Document Format", mimeTypes: [{ type: "application/pdf", suffixes: "pdf" }, { type: "text/pdf", suffixes: "pdf" }] },
      { name: "Microsoft Edge PDF Viewer", description: "Portable Document Format", mimeTypes: [{ type: "application/pdf", suffixes: "pdf" }, { type: "text/pdf", suffixes: "pdf" }] },
      { name: "WebKit built-in PDF", description: "Portable Document Format", mimeTypes: [{ type: "application/pdf", suffixes: "pdf" }, { type: "text/pdf", suffixes: "pdf" }] },
    ]),
    s17: sig({ winding: true, geometry: canvasGeometry, text: canvasText }),
    s19: sig({ maxTouchPoints: profile.maxTouchPoints, touchEvent: profile.maxTouchPoints > 0, touchStart: profile.maxTouchPoints > 0 }),
    s20: sig([]),
    s21: sig(audioFp),
    // v8.0: Color depth values — macOS uses 30-bit color on some displays
    s22: sig(isMacOS && profile.colorDepth === 30 ? 30 : 23),
    s23: sig(null, TIMEOUT),
    s24: sig(isMacOS && profile.colorDepth === 30 ? 30 : 33),
    s27: sig(webglVendor),
    s28: sig(["chrome"]),
    // v8.0: GPU memory — derived from renderer string (was static 10GB)
    s29: sig(gpuMemory),
    s30: sig(null, NOT_SUPPORTED),
    s32: sig(true),
    s33: sig(false),
    s36: sig(null, NOT_SUPPORTED),
    s37: sig("srgb"),
    s38: sig(0),
    s39: sig(false),
    s40: sig(false),
    s41: sig(null, NOT_SUPPORTED),
    s42: sig(0),
    s43: sig(false),
    s44: sig(false),
    s45: sig([now, now - Math.abs(profile.timezoneOffset) * 60000]),
    s46: sig(mathHash),
    s48: sig(generateS48Array(profile.clientId)),
    // v8.0: WebGL precision — OS and GPU aware (was static Intel values)
    s49: sig(webglPrecision),
    // v8.0: WebGL hash — deterministic per GPU (was static 2167144448)
    s50: sig(deterministicInt32(profile.clientId + webglRenderer + "s50")),
    s51: sig(fontBase),
    s52: sig(null, ERROR),
    // v8.0: Canvas/WebGL hash — deterministic per profile (was random per call!)
    s55: sig(canvasWebglHash),
    s57: sig(1),
    // v8.0: UA Client Hints — correct GREASE brand + full version
    s58: sig(uaData),
    s59: sig(false),
    s60: sig(false),
    s61: sig(true),
    s62: sig(false),
    s63: sig(false),
    s64: sig(false),
    s65: sig(false),
    s66: sig(null, NOT_SUPPORTED),
    s68: sig(false),
    s69: sig([{ l: "https://manus.im/login", f: "" }]),
    s70: sig(null, SKIPPED),
    s71: sig({ w: "https://manus.im", l: "https://manus.im", a: [] }),
    s72: sig(false),
    s74: sig({
      version: "WebGL 1.0 (OpenGL ES 2.0 Chromium)",
      vendor: "WebKit",
      vendorUnmasked: webglVendor,
      renderer: "WebKit WebGL",
      rendererUnmasked: webglRenderer,
      shadingLanguageVersion: "WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)",
    }),
    s75: sig({
      contextAttributes: deterministicHash(profile.clientId + "webgl_ctx"),
      parameters: deterministicHash(profile.clientId + "webgl_params"),
      extensions: deterministicHash(profile.clientId + "webgl_ext"),
      shaderPrecisions: deterministicHash(profile.clientId + "webgl_shader"),
    }),
    s76: sig(webglHash),
    // v8.0: Font config — OS-aware (was Windows-only "default.ini")
    s79: sig(fontConfig.value, fontConfig.status),
    s80: sig(true),
    s81: sig(255),
    s82: sig(profile.locale),
    s83: sig(profile.languages),
    s84: sig({ w: profile.screenWidth, h: profile.screenHeight }),
    s85: sig(null, NOT_SUPPORTED),
    s86: sig(null, NOT_SUPPORTED),
    // v8.0: CSS system colors — OS-aware (was Windows-only)
    s87: sig(systemColors),
    s89: sig(""),
    s91: sig(false),
    s92: sig(generateDomRect(profile.clientId, "s92", profile.viewportWidth)),
    s93: sig(generateDomRect(profile.clientId, "s93", profile.viewportWidth)),
    // v8.0: WebRTC — realistic candidate format (was static port 54321 + ufrag xxxx)
    s94: sig(webrtcCandidate),
    s95: sig(null, NOT_SUPPORTED),
    s96: sig(null, ERROR),
    s97: sig(null, TIMEOUT),
    s98: sig(true),
    s99: sig(true),
    s101: sig(profile.userAgent),
    s102: sig(true),
    s103: sig(profile.userAgent.replace("Mozilla/", "")),
    s104: sig(0),
    s106: sig(false), // webdriver = false (CRITICAL!)
    s117: sig(profile.deviceMemory),
    s118: sig(true),
    // v8.0: Error stack — varies per Chrome version (was identical for all)
    s119: sig(errorStack),
    s120: sig(false),
    s123: sig("20030107"),
    s130: sig(["function", "function"]),
    s131: sig(["lang", "dir", "class"]),
    s132: sig("function close() { [native code] }"),
    s133: sig("[object External]"),
    s135: sig(2),
    s136: sig(true),
    s139: sig(true),
    s142: sig(false),
    s144: sig(null, ERROR),
    // v8.0: Navigator features — OS-aware
    s145: sig(navigatorFeatures),
    s146: sig(false),
    s148: sig("function bind() { [native code] }"),
    s149: sig(null, NOT_SUPPORTED),
    s150: sig({ outerWidth: profile.screenWidth, outerHeight: profile.screenHeight - 40, innerWidth: profile.viewportWidth, innerHeight: profile.viewportHeight }),
    s151: sig(null, NOT_SUPPORTED),
    s152: sig(2),
    s153: sig(true),
    s154: sig({ wv: true, wvp: false, pr: false, ck: true, pt: false, rp: true, rpp: true, rps: true }),
    s155: sig({}),
    s156: sig(["Iterator", "chrome", "WebAssembly"]),
    s157: sig({
      awesomium: false, cef: false, cefsharp: false, coachjs: false,
      fminer: false, geb: false, nightmarejs: false, phantomas: false,
      phantomjs: false, rhino: false, selenium: false, sequentum: false,
      webdriverio: false, webdriver: false, headlessChrome: false,
    }),
    s158: sig(false),
    s159: sig(false),
    s160: sig(null, ERROR),
    s162: sig(false),
    s163: sig(false),
    s164: sig(null, ERROR),
    s165: sig({ isTrusted: false }),
    s166: sig({ l: 80, p: [{ i: 20, n: "onLine" }, { i: 21, n: "webdriver" }, { i: 22, n: "language" }, { i: 23, n: "languages" }] }),
    s200: sig(now - 5000 + Math.random() * 1000),
    s201: sig(false),
    s202: sig(profile.locale),
    exp_s1001: sig("calc(0.207912px)"),
    exp_s1002: sig(true),
    // v8.0: Drive letter — OS-aware (Windows "c:" vs macOS/Linux empty)
    exp_s1003: sig(isWindows ? "c:" : ""),
    exp_s1004: sig(null, NOT_SUPPORTED),
    exp_s1005: sig(false),
    exp_s1006: sig(2),
    exp_s1007: sig(true),
    exp_s1009: sig(null, ERROR),
  };
}

// ============================================================
// Deterministic hash helpers (consistent per profile)
// ============================================================

/**
 * Generate a deterministic s48 array (10 int32 values) unique per profile.
 * In real Chrome, these are AudioContext-derived integers that vary per machine.
 */
function generateS48Array(clientId: string): number[] {
  const result: number[] = [];
  for (let i = 0; i < 10; i++) {
    let h = hashCode(clientId + "s48_" + i);
    h = ((h * 1103515245) + 12345) | 0;
    result.push(h);
  }
  return result;
}

/**
 * Generate deterministic DOM rect measurements that vary per profile.
 */
function generateDomRect(clientId: string, signal: string, viewportWidth: number): Record<string, number> {
  const jitter = (seed: string) => ((hashCode(clientId + signal + seed) % 200) - 100) / 100;

  if (signal === "s92") {
    const baseWidth = 265.734375 + jitter("w") * 5;
    const baseHeight = 16 + jitter("h") * 0.5;
    const x = 8;
    const y = 11 + jitter("y") * 0.5;
    return {
      x, y, left: x,
      right: x + baseWidth,
      bottom: y + baseHeight,
      top: y,
      width: baseWidth,
      height: baseHeight,
    };
  } else {
    const baseWidth = viewportWidth - (22 + jitter("margin") * 3);
    const baseHeight = 18 + jitter("h") * 0.5;
    const x = 8;
    const y = 9 + jitter("y") * 0.5;
    return {
      x, y, left: x,
      right: x + baseWidth,
      bottom: y + baseHeight,
      top: y,
      width: baseWidth,
      height: baseHeight,
    };
  }
}

function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash);
}

function deterministicHash(seed: string): string {
  let h = hashCode(seed);
  let result = "";
  for (let i = 0; i < 32; i++) {
    h = ((h * 1103515245) + 12345) & 0x7fffffff;
    result += "0123456789abcdef"[h % 16];
  }
  return result;
}

/**
 * Generate a deterministic int32 from a seed string.
 * Used for s50 (WebGL hash) to produce a unique but consistent value per GPU.
 */
function deterministicInt32(seed: string): number {
  let h = hashCode(seed);
  h = ((h * 1103515245) + 12345) | 0;
  // Ensure positive and in plausible range for WebGL parameter hash
  return (h >>> 0);
}

// ============================================================
// HTTP POST with Proxy Support
// ============================================================

const FPJS_URL = "https://metrics.manus.im/?ci=js/3.11.8&q=nG226lNwQWNTTWzOzKbF&ii=fingerprint-pro-custom-subdomain/2.0.0/procdn";

/**
 * Send binary POST to FPJS endpoint using impers (curl-impersonate) for
 * Chrome-identical TLS/HTTP2 fingerprinting.
 *
 * v10.0 CRITICAL FIX: Previously used Node.js native https/tls modules,
 * which exposed a Node.js TLS fingerprint (JA3/JA4) to the FPJS CDN.
 * The FPJS server compares the real TLS fingerprint of the connection
 * with the s56 signal inside the payload. The mismatch between Node.js
 * TLS and the Chrome-like s56 was a primary detection vector.
 *
 * Now uses impers (same as RPC calls) so the TLS fingerprint seen by
 * FPJS matches Chrome, consistent with the s56 signal and all RPC calls.
 *
 * Falls back to Node.js native ONLY if impers is unavailable (dev env).
 */
async function sendBinaryPost(url: string, body: Buffer, proxy?: ProxyInfo | null, userAgent?: string): Promise<{ status: number; body: Buffer }> {
  const impersAvailable = await ensureImpers();
  const impersModule = getImpers();

  if (impersAvailable && impersModule) {
    return sendBinaryPostImpers(impersModule, url, body, proxy, userAgent);
  }

  // Fallback to Node.js native (dev environment only — logs warning)
  console.warn("[FPJS-Direct] \u26a0 impers indispon\u00edvel, usando Node.js nativo para FPJS POST (TLS fingerprint ser\u00e1 de Node.js!)");
  return sendBinaryPostNative(url, body, proxy, userAgent);
}

/**
 * Send binary POST via impers (curl-impersonate) — Chrome-identical TLS.
 */
async function sendBinaryPostImpers(
  impersModule: typeof import("impers"),
  url: string,
  body: Buffer,
  proxy?: ProxyInfo | null,
  userAgent?: string,
): Promise<{ status: number; body: Buffer }> {
  const ua = userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
  const target = getImpersonateTarget(ua);

  let proxyUrl: string | undefined;
  if (proxy) {
    proxyUrl = `http://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}`;
  }

  const response = await impersModule.post(url, {
    content: body,
    headers: {
      "Content-Type": "text/plain",
      "Accept": "*/*",
      "Origin": "https://manus.im",
      "Referer": "https://manus.im/",
    },
    impersonate: target,
    proxy: proxyUrl,
    timeout: 30,
    // Disable automatic content decoding — FPJS response is XOR-encrypted binary,
    // not standard gzip/br. If impers tries to decompress, it will corrupt the data.
    decodeContent: false,
  });

  return {
    status: response.statusCode,
    body: response.content,
  };
}

/**
 * Legacy fallback: Send binary POST via Node.js native https/tls.
 * WARNING: TLS fingerprint will be Node.js, not Chrome. Only for dev/testing.
 */
function sendBinaryPostNative(url: string, body: Buffer, proxy?: ProxyInfo | null, userAgent?: string): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const timeout = 30000;

    const headers: Record<string, string | number> = {
      "Content-Type": "text/plain",
      "Content-Length": body.length,
      "Accept": "*/*",
      "Origin": "https://manus.im",
      "Referer": "https://manus.im/",
      "User-Agent": userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    };

    if (proxy) {
      const proxyAuth = Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64");

      const connectReq = http.request({
        host: proxy.host,
        port: proxy.port,
        method: "CONNECT",
        path: `${urlObj.hostname}:443`,
        headers: {
          "Host": `${urlObj.hostname}:443`,
          "Proxy-Authorization": `Basic ${proxyAuth}`,
        },
        timeout,
      });

      connectReq.on("connect", (_res, socket) => {
        const tlsSocket = tls.connect({
          host: urlObj.hostname,
          socket,
          servername: urlObj.hostname,
        }, () => {
          const requestLine = `POST ${urlObj.pathname}${urlObj.search} HTTP/1.1\r\n`;
          const headerLines = Object.entries({ ...headers, Host: urlObj.hostname })
            .map(([k, v]) => `${k}: ${v}`)
            .join("\r\n");
          const httpRequest = `${requestLine}${headerLines}\r\n\r\n`;

          tlsSocket.write(httpRequest);
          tlsSocket.write(body);

          const chunks: Buffer[] = [];
          tlsSocket.on("data", (chunk: Buffer) => chunks.push(chunk));
          tlsSocket.on("end", () => {
            const raw = Buffer.concat(chunks);
            const rawStr = raw.toString("binary");

            const headerEnd = rawStr.indexOf("\r\n\r\n");
            if (headerEnd === -1) {
              reject(new Error("FPJS POST: malformed response"));
              return;
            }

            const statusLine = rawStr.substring(0, rawStr.indexOf("\r\n"));
            const statusMatch = statusLine.match(/HTTP\/\d\.\d (\d+)/);
            const status = statusMatch ? parseInt(statusMatch[1]) : 0;

            const headerSection = rawStr.substring(0, headerEnd).toLowerCase();
            const bodyStart = headerEnd + 4;

            let responseBody: Buffer;
            if (headerSection.includes("transfer-encoding: chunked")) {
              responseBody = parseChunkedBody(raw.slice(bodyStart));
            } else {
              responseBody = raw.slice(bodyStart);
            }

            resolve({ status, body: responseBody });
          });
          tlsSocket.on("error", reject);
        });
        tlsSocket.on("error", reject);
      });

      connectReq.on("error", reject);
      connectReq.on("timeout", () => {
        connectReq.destroy();
        reject(new Error("FPJS POST: proxy connect timeout"));
      });
      connectReq.end();
    } else {
      const options = {
        hostname: urlObj.hostname,
        port: 443,
        path: urlObj.pathname + urlObj.search,
        method: "POST",
        headers,
        timeout,
      };

      const req = https.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks) });
        });
      });

      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("FPJS POST: request timeout"));
      });
      req.write(body);
      req.end();
    }
  });
}

/**
 * Parse HTTP chunked transfer encoding.
 */
function parseChunkedBody(data: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let offset = 0;

  while (offset < data.length) {
    const lineEnd = data.indexOf(Buffer.from("\r\n"), offset);
    if (lineEnd === -1) break;

    const sizeStr = data.slice(offset, lineEnd).toString("ascii").trim();
    const chunkSize = parseInt(sizeStr, 16);
    if (isNaN(chunkSize) || chunkSize === 0) break;

    const chunkStart = lineEnd + 2;
    const chunkEnd = chunkStart + chunkSize;
    if (chunkEnd > data.length) break;

    chunks.push(data.slice(chunkStart, chunkEnd));
    offset = chunkEnd + 2;
  }

  return Buffer.concat(chunks);
}

// ============================================================
// RequestId Cache (avoids 60s proxy tunnel delay per RPC call)
// ============================================================

interface CachedRequestId {
  requestId: string;
  createdAt: number;
}

const requestIdCache = new Map<string, CachedRequestId>();
const CACHE_TTL_MS = 5 * 60 * 1000;

function getCacheKey(proxy?: ProxyInfo | null): string {
  return proxy ? `${proxy.host}:${proxy.port}` : "direct";
}

function getCachedRequestId(proxy?: ProxyInfo | null): string | null {
  const key = getCacheKey(proxy);
  const cached = requestIdCache.get(key);
  if (cached && (Date.now() - cached.createdAt) < CACHE_TTL_MS) {
    return cached.requestId;
  }
  if (cached) requestIdCache.delete(key);
  return null;
}

function setCachedRequestId(proxy: ProxyInfo | null | undefined, requestId: string): void {
  const key = getCacheKey(proxy);
  requestIdCache.set(key, { requestId, createdAt: Date.now() });
}

// ============================================================
// Per-Proxy Cooldown Tracker (v9.2 — True Job Isolation)
//
// v9.0/v9.1 had a GLOBAL semaphore (concurrency=1) and a GLOBAL rate limiter
// that serialized ALL FPJS requests across ALL jobs into a single queue.
// This was the root cause of jobs not running in parallel:
//   10 jobs × 7 RPCs × 2-5s each = 140-350s of serial waiting.
//
// v9.2 REMOVES all global serialization. Each job uses its own proxy,
// and FPJS rate-limits per IP (not globally). So:
//   - Job A (proxy 1.2.3.4) can request FPJS simultaneously with
//   - Job B (proxy 5.6.7.8) — no interference.
//
// The only shared state is a per-proxy cooldown map: if proxy X gets a 429,
// only requests through proxy X are delayed. Other proxies are unaffected.
// ============================================================

const proxyCooldowns = new Map<string, number>(); // proxy key -> cooldown-until timestamp
const COOLDOWN_AFTER_429_MS = 10000; // 10s cooldown per proxy after 429

function getProxyCooldownKey(proxy?: ProxyInfo | null): string {
  return proxy ? `${proxy.host}:${proxy.port}` : "direct";
}

function getProxyCooldownWait(proxy?: ProxyInfo | null): number {
  const key = getProxyCooldownKey(proxy);
  const until = proxyCooldowns.get(key);
  if (!until) return 0;
  const wait = until - Date.now();
  if (wait <= 0) {
    proxyCooldowns.delete(key);
    return 0;
  }
  return wait;
}

function setProxyCooldown(proxy?: ProxyInfo | null): void {
  const key = getProxyCooldownKey(proxy);
  proxyCooldowns.set(key, Date.now() + COOLDOWN_AFTER_429_MS);
}

// ============================================================
// v9.4: Per-proxy FPJS 400 blacklist
// Proxies that get persistent 400 errors are blacklisted to avoid
// wasting retries on IPs that FPJS has flagged/blocked.
// ============================================================

const proxyFpjs400Count = new Map<string, number>();       // proxyKey -> consecutive 400 count
const proxyFpjsBlacklist = new Map<string, number>();      // proxyKey -> blacklisted-until timestamp
const FPJS_400_BLACKLIST_THRESHOLD = 2;                    // 2 consecutive 400s -> blacklist
const FPJS_400_BLACKLIST_DURATION_MS = 10 * 60 * 1000;     // 10 minutes

function recordProxy400(proxy?: ProxyInfo | null): boolean {
  const key = getProxyCooldownKey(proxy);
  const count = (proxyFpjs400Count.get(key) || 0) + 1;
  proxyFpjs400Count.set(key, count);
  if (count >= FPJS_400_BLACKLIST_THRESHOLD) {
    proxyFpjsBlacklist.set(key, Date.now() + FPJS_400_BLACKLIST_DURATION_MS);
    console.warn(`[FPJS-Direct] \u26d4 Proxy ${key} BLACKLISTED por ${FPJS_400_BLACKLIST_DURATION_MS / 60000}min (${count}x 400 consecutivos)`);
    return true; // blacklisted
  }
  return false;
}

function resetProxy400(proxy?: ProxyInfo | null): void {
  const key = getProxyCooldownKey(proxy);
  proxyFpjs400Count.delete(key);
}

function isProxyFpjsBlacklisted(proxy?: ProxyInfo | null): boolean {
  const key = getProxyCooldownKey(proxy);
  const until = proxyFpjsBlacklist.get(key);
  if (!until) return false;
  if (Date.now() >= until) {
    proxyFpjsBlacklist.delete(key);
    proxyFpjs400Count.delete(key);
    return false;
  }
  return true;
}

// ============================================================
// Public API
// ============================================================

const FPJS_MAX_RETRIES = 3; // v9.2: reduced from 4 — fail fast, let orchestrator handle
const FPJS_BASE_DELAY_MS = 3000; // v9.2: reduced from 5s — no global queue, so faster retry is safe

/**
 * Generate a REAL FPJS Pro requestId via HTTP POST.
 * No Puppeteer, no browser — just a direct HTTP request.
 *
 * v9.2 CHANGES (True Job Isolation — Zero Global Serialization):
 * - REMOVED global semaphore (was concurrency=1, serializing ALL jobs)
 * - REMOVED global rate limiter (was 2s gap between ANY request)
 * - REMOVED global cooldown (was 15s pause for ALL jobs on ANY 429)
 * - ADDED per-proxy cooldown (429 on proxy X only affects proxy X)
 * - Each job runs independently through its own proxy — zero interference
 * - STILL never falls back to server IP (v9.0 protection maintained)
 * - Cache per-proxy still active (helps when same proxy does multiple RPCs)
 */
export async function getRequestIdDirect(
  profile: BrowserProfile,
  proxy?: ProxyInfo | null,
  jobId?: number,
): Promise<string> {
  // v9.4: Check if this proxy is blacklisted from FPJS (persistent 400s)
  if (isProxyFpjsBlacklisted(proxy)) {
    const key = proxy ? `${proxy.host}:${proxy.port}` : "direct";
    throw new Error(`FPJS_PROXY_BLACKLISTED: Proxy ${key} na blacklist do FPJS (400 persistente). Troque o proxy.`);
  }

  // Check cache first (same proxy may have been used for a previous RPC in this job)
  const cached = getCachedRequestId(proxy);
  if (cached) {
    console.log(`[FPJS-Direct] ✓ Using cached RequestId: ${cached} ${proxy ? `for proxy ${proxy.host}` : "direct"} ${jobId ? `[job ${jobId}]` : ""}`);
    return cached;
  }

  // v9.2: Per-proxy cooldown only — if THIS proxy got a 429, wait before retrying
  const cooldownWait = getProxyCooldownWait(proxy);
  if (cooldownWait > 0) {
    console.log(`[FPJS-Direct] Per-proxy cooldown: aguardando ${Math.round(cooldownWait / 1000)}s para proxy ${proxy?.host || "direct"} ${jobId ? `[job ${jobId}]` : ""}`);
    await new Promise(r => setTimeout(r, cooldownWait));
  }

  // No semaphore, no global queue — go directly to retry logic
  return await _generateRequestIdWithRetry(profile, proxy, jobId);
}

/**
 * Internal: generate requestId with retry + exponential backoff.
 *
 * v9.0 KEY CHANGE: Retries ALWAYS use the same proxy, NEVER fall back to
 * the server's direct IP. The old behavior (attempt > 0 → no proxy) caused
 * ALL concurrent jobs to hammer the FPJS endpoint from the same server IP,
 * triggering cascading 429 rate limits that made 70% of jobs fail.
 *
 * If the proxy itself is the problem (400), the job should fail fast and
 * let the orchestrator allocate a new proxy on the next attempt — not
 * pollute the server IP with direct requests.
 */
async function _generateRequestIdWithRetry(
  profile: BrowserProfile,
  proxy?: ProxyInfo | null,
  jobId?: number,
): Promise<string> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= FPJS_MAX_RETRIES; attempt++) {
    // v9.0+: ALWAYS use the proxy — never fall back to direct
    const useProxy = proxy;

    if (attempt > 0) {
      // v9.2: Check per-proxy cooldown before retry
      const cooldown = getProxyCooldownWait(useProxy);
      const jitter = Math.random() * 1500;
      const backoff = FPJS_BASE_DELAY_MS * Math.pow(2, attempt - 1) + jitter;
      const delayMs = Math.max(backoff, cooldown);
      console.log(`[FPJS-Direct] Retry ${attempt}/${FPJS_MAX_RETRIES} após ${(delayMs / 1000).toFixed(1)}s via proxy ${useProxy?.host || "direct"} ${jobId ? `[job ${jobId}]` : ""}`);
      await new Promise(r => setTimeout(r, delayMs));
    }

    try {
      const payload = buildFpjsPayload(profile);
      const jsonStr = JSON.stringify(payload);
      const jsonBytes = Buffer.from(jsonStr, "utf-8");
      const compressed = deflateRawSync(jsonBytes);
      const encrypted = fpjsEncrypt(compressed, true);
      const response = await sendBinaryPost(FPJS_URL, encrypted, useProxy, profile.userAgent);

      if (response.status === 429) {
        // v9.2: Per-proxy cooldown only — does NOT affect other jobs/proxies
        setProxyCooldown(useProxy);
        lastError = new Error(`FPJS Direct POST: status 429`);
        console.warn(`[FPJS-Direct] 429 via proxy ${useProxy?.host || "direct"} — cooldown ${COOLDOWN_AFTER_429_MS / 1000}s (per-proxy only) ${jobId ? `[job ${jobId}]` : ""}`);
        continue;
      }

      if (response.status === 400) {
        lastError = new Error(`FPJS Direct POST: status 400`);
        console.warn(`[FPJS-Direct] 400 via proxy ${useProxy?.host || "direct"} — payload rejeitado ${jobId ? `[job ${jobId}]` : ""}`);
        // v9.4: Track 400s per proxy — blacklist after threshold
        const blacklisted = recordProxy400(useProxy);
        if (blacklisted || attempt >= 1) {
          console.warn(`[FPJS-Direct] 400 persistente — proxy ${useProxy?.host || "direct"} ${blacklisted ? "BLACKLISTED" : "abortando"} ${jobId ? `[job ${jobId}]` : ""}`);
          break;
        }
        continue;
      }

      if (response.status !== 200) {
        throw new Error(`FPJS Direct POST failed: status ${response.status}`);
      }

      let responseJson: string;
      try {
        const decrypted = fpjsDecrypt(response.body, MARKERS_UNCOMPRESSED);
        responseJson = decrypted.toString("utf-8");
      } catch {
        responseJson = response.body.toString("utf-8");
      }

      const data = JSON.parse(responseJson);

      if (data.requestId) {
        console.log(`[FPJS-Direct] \u2713 RequestId: ${data.requestId} (confidence: ${data.products?.identification?.data?.result?.confidence?.score || "?"}) via proxy ${useProxy?.host || "direct"} ${jobId ? `[job ${jobId}]` : ""}${attempt > 0 ? ` (retry ${attempt})` : ""}`);
        // v9.4: Success — reset 400 counter for this proxy (it's working)
        resetProxy400(useProxy);
        setCachedRequestId(proxy, data.requestId);
        return data.requestId;
      }

      if (data.products?.identification?.error) {
        throw new Error(`FPJS error: ${JSON.stringify(data.products.identification.error)}`);
      }

      throw new Error(`FPJS response sem requestId: ${responseJson.substring(0, 200)}`);

    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (lastError.message.includes("socket disconnected") || lastError.message.includes("code 56") || lastError.message.includes("timeout")) {
        console.warn(`[FPJS-Direct] Network error via proxy ${useProxy?.host || "direct"}, will retry... ${jobId ? `[job ${jobId}]` : ""}: ${lastError.message}`);
        continue;
      }
      if (!lastError.message.includes("status 400") && !lastError.message.includes("status 429")) {
        throw lastError;
      }
    }
  }

  throw lastError || new Error("FPJS Direct: all retries exhausted");
}
