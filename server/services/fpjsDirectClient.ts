/**
 * FPJS Pro Direct Client — HTTP POST without Puppeteer (v6.0)
 *
 * Generates a REAL FPJS Pro requestId by:
 * 1. Building the fingerprint payload JSON (144 signals)
 * 2. Compressing with deflate-raw
 * 3. Applying XOR obfuscation (reverse-engineered from FPJS loader v3.11.8)
 * 4. Sending via HTTP POST to metrics.manus.im
 * 5. Decrypting the response to extract requestId
 *
 * This eliminates the need for Puppeteer/Chromium entirely.
 * Each requestId generation takes ~100-500ms instead of 5-10s.
 *
 * ADVANTAGES over Puppeteer approach:
 * - No browser process = no memory overhead, no bot detection via webdriver
 * - No TLS fingerprint mismatch (Puppeteer's Chromium vs real Chrome)
 * - Uses the SAME proxy as RPC calls (IP consistency guaranteed)
 * - No cookies to leak between accounts (_iidt, _vid_t)
 * - requestId is REAL (exists in FPJS DB, won't return 404 on Server API lookup)
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

function generateRandomIP(): string {
  return `192.168.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 254) + 1}`;
}

function generateUUID(): string {
  const hex = randomBytes(16).toString("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20,32)}`;
}

// ============================================================
// Fingerprint Payload Builder (144 signals)
// ============================================================

/**
 * Build the complete FPJS payload matching real browser output.
 * Uses data from the BrowserProfile to ensure consistency with RPC headers.
 */
function buildFpjsPayload(profile: BrowserProfile): Record<string, unknown> {
  const now = Date.now();
  const isWindows = profile.platform.includes("Win");
  const isChrome = profile.userAgent.includes("Chrome") && !profile.userAgent.includes("Firefox");
  const chromeVersionMatch = profile.userAgent.match(/Chrome\/(\d+)/);
  const chromeVersion = chromeVersionMatch ? chromeVersionMatch[1] : "136";

  // Build User-Agent Client Hints data (only for Chrome-based browsers)
  const uaData = isChrome ? {
    b: [
      { brand: "Chromium", version: chromeVersion },
      { brand: "Google Chrome", version: chromeVersion },
      { brand: "Not.A/Brand", version: "8" },
    ],
    m: false,
    p: isWindows ? "Windows" : (profile.platform === "MacIntel" ? "macOS" : "Linux"),
    h: {
      brands: JSON.stringify([
        { brand: "Chromium", version: chromeVersion },
        { brand: "Google Chrome", version: chromeVersion },
        { brand: "Not.A/Brand", version: "8" },
      ]),
      mobile: "false",
      platform: isWindows ? "Windows" : (profile.platform === "MacIntel" ? "macOS" : "Linux"),
      platformVersion: isWindows ? "15.0.0" : (profile.platform === "MacIntel" ? "14.7.1" : "6.8.0"),
      architecture: "x86",
      bitness: "64",
      model: "",
      uaFullVersion: `${chromeVersion}.0.7103.116`,
      fullVersionList: JSON.stringify([
        { brand: "Chromium", version: `${chromeVersion}.0.7103.116` },
        { brand: "Google Chrome", version: `${chromeVersion}.0.7103.116` },
        { brand: "Not.A/Brand", version: "8.0.0.0" },
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

  // Font metrics — slight variation per profile
  const fontBase = {
    default: 149.3125, apple: 149.3125, serif: 149.3125,
    sans: 144.015625, mono: 132.609375, min: 9.34375, system: 144.640625,
  };

  // WebGL vendor/renderer — realistic values based on platform
  const webglVendor = isWindows ? "Google Inc. (NVIDIA)" : (profile.platform === "MacIntel" ? "Google Inc. (Apple)" : "Google Inc. (Mesa)");
  const webglRenderer = isWindows
    ? "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)"
    : (profile.platform === "MacIntel"
      ? "ANGLE (Apple, Apple M1, OpenGL 4.1)"
      : "ANGLE (Mesa, llvmpipe (LLVM 15.0.7, 256 bits), OpenGL ES 3.1)");

  return {
    // Metadata
    c: "nG226lNwQWNTTWzOzKbF",
    m: "l",
    l: "jsl/3.11.8",
    mo: ["id", "bd", "ex"],
    sc: { u: "https://files.manuscdn.com/assets/js/fpm_loader_v3.11.8.js" },
    gt: 1,
    ab: { noop: "b", CTRb3vV: "ctrl" },
    url: "https://manus.im/login",
    epv: "e683a40",
    lr: [{ r: null }],

    // TLS fingerprint (collected by FPJS CDN, not by browser — we send a plausible value)
    s56: sig("ycAz3DWQ0bGY10Y+hHGxnMAgP+qKWIqrfqR9mclysW1Ak7T5CW7GIp2x2a+uhoxZveSYx3ATPZY7ZAMNmjWY90MvmAwwNQ=="),
    s67: sig(null, NOT_SUPPORTED),

    // Browser signals
    s1: sig(isWindows ? null : (profile.platform === "Linux x86_64" ? "Linux x86_64" : null), isWindows ? NOT_SUPPORTED : OK),
    s2: sig([profile.languages]),
    s3: sig(profile.colorDepth),
    s4: sig(8), // deviceMemory
    s5: sig([profile.screenWidth, profile.screenHeight]),
    s6: sig([0, 0, 0, 0]),
    s7: sig(8), // hardwareConcurrency
    s9: sig(profile.timezone),
    s10: sig(true),
    s11: sig(true),
    s12: sig(true),
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
    s19: sig({ maxTouchPoints: 0, touchEvent: false, touchStart: false }),
    s20: sig([]),
    s21: sig(audioFp),
    s22: sig(23),
    s23: sig(null, TIMEOUT),
    s24: sig(33),
    s27: sig(webglVendor),
    s28: sig(["chrome"]),
    s29: sig(10737418240),
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
    s48: sig([1574966915, -801625375, 1031927533, -414484534, -761553675, -1336904198, -1698891509, 1776498361, -1280249498, 1479071338]),
    s49: sig([0.09999999403953552, 0.10000000149011612]),
    s50: sig(2167144448),
    s51: sig(fontBase),
    s52: sig(null, ERROR),
    s55: sig(randomBytes(64).toString("base64")),
    s57: sig(1),
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
    s79: sig([{ n: "default.ini", l: -1 }], TIMEOUT),
    s80: sig(true),
    s81: sig(255),
    s82: sig(profile.locale),
    s83: sig(profile.languages),
    s84: sig({ w: profile.screenWidth, h: profile.screenHeight }),
    s85: sig(null, NOT_SUPPORTED),
    s86: sig(null, NOT_SUPPORTED),
    s87: sig({
      ac: "rgb(0, 0, 0)", act: "rgb(0, 0, 0)", at: "rgb(255, 255, 255)",
      bg: "rgb(255, 255, 255)", bf: "rgb(0, 0, 0)", bt: "rgb(255, 255, 255)",
      cv: "rgb(255, 255, 255)", cvt: "rgb(0, 0, 0)", ft: "rgb(0, 0, 0)",
      ht: "rgb(0, 0, 238)", htb: "rgb(0, 0, 0)", hta: "rgb(85, 26, 139)",
      mk: "rgb(0, 0, 0)", mkb: "rgb(255, 255, 0)",
    }),
    s89: sig(""),
    s91: sig(false),
    s92: sig({ x: 8, y: 11, left: 8, right: 273.734375, bottom: 27, top: 11, width: 265.734375, height: 16 }),
    s93: sig({ x: 8, y: 9, left: 8, right: 1605.078125, bottom: 27, top: 9, width: 1597.078125, height: 18 }),
    s94: sig({ u: generateUUID(), e: ["candidate:1 1 udp 2113937151 " + generateRandomIP() + " 54321 typ host generation 0 ufrag xxxx network-cost 999"] }),
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
    s117: sig(8),
    s118: sig(true),
    s119: sig("TypeError: Cannot read properties of null (reading '0')\n    at https://files.manuscdn.com/assets/js/fpm_loader_v3.11.8.js:1:1"),
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
    s145: sig(["getGamepads", "javaEnabled", "sendBeacon", "vibrate", "NavigatorUAData", "bluetooth", "clipboard", "credentials", "keyboard", "managed", "mediaDevices", "storage", "serviceWorker", "virtualKeyboard", "wakeLock", "xr"]),
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
    exp_s1003: sig("c:"),
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

function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}

function deterministicHash(seed: string): string {
  // Generate a deterministic 32-char hex hash from a seed string
  // This ensures the same profile always produces the same canvas/webgl hashes
  let h = hashCode(seed);
  let result = "";
  for (let i = 0; i < 32; i++) {
    h = ((h * 1103515245) + 12345) & 0x7fffffff;
    result += "0123456789abcdef"[h % 16];
  }
  return result;
}

// ============================================================
// HTTP POST with Proxy Support
// ============================================================

const FPJS_URL = "https://metrics.manus.im/?ci=js/3.11.8&q=nG226lNwQWNTTWzOzKbF&ii=fingerprint-pro-custom-subdomain/2.0.0/procdn";

/**
 * Send binary POST to FPJS endpoint, optionally through a proxy.
 * Uses Node.js native https/http modules for binary body support.
 * Does NOT need TLS impersonation — this is a request to FPJS's own CDN,
 * not to Manus's API. FPJS doesn't check TLS fingerprints on their metrics endpoint.
 */
function sendBinaryPost(url: string, body: Buffer, proxy?: ProxyInfo | null, userAgent?: string): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const timeout = 30000;

    const headers: Record<string, string | number> = {
      "Content-Type": "application/octet-stream",
      "Content-Length": body.length,
      "Accept": "*/*",
      "Origin": "https://manus.im",
      "Referer": "https://manus.im/",
      "User-Agent": userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    };

    if (proxy) {
      // Use HTTP CONNECT tunnel through proxy
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
        // Now create TLS connection through the tunnel
        const tlsSocket = tls.connect({
          host: urlObj.hostname,
          socket,
          servername: urlObj.hostname,
        }, () => {
          // Send HTTP request through TLS tunnel
          const requestLine = `POST ${urlObj.pathname}${urlObj.search} HTTP/1.1\r\n`;
          const headerLines = Object.entries({ ...headers, Host: urlObj.hostname })
            .map(([k, v]) => `${k}: ${v}`)
            .join("\r\n");
          const httpRequest = `${requestLine}${headerLines}\r\n\r\n`;

          tlsSocket.write(httpRequest);
          tlsSocket.write(body);

          // Read response
          const chunks: Buffer[] = [];
          tlsSocket.on("data", (chunk: Buffer) => chunks.push(chunk));
          tlsSocket.on("end", () => {
            const raw = Buffer.concat(chunks);
            const rawStr = raw.toString("binary");

            // Parse HTTP response
            const headerEnd = rawStr.indexOf("\r\n\r\n");
            if (headerEnd === -1) {
              reject(new Error("FPJS POST: malformed response"));
              return;
            }

            const statusLine = rawStr.substring(0, rawStr.indexOf("\r\n"));
            const statusMatch = statusLine.match(/HTTP\/\d\.\d (\d+)/);
            const status = statusMatch ? parseInt(statusMatch[1]) : 0;

            // Check for chunked transfer encoding
            const headerSection = rawStr.substring(0, headerEnd).toLowerCase();
            const bodyStart = headerEnd + 4;

            let responseBody: Buffer;
            if (headerSection.includes("transfer-encoding: chunked")) {
              // Parse chunked encoding
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
      // Direct HTTPS request (no proxy)
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
    // Find chunk size line
    const lineEnd = data.indexOf(Buffer.from("\r\n"), offset);
    if (lineEnd === -1) break;

    const sizeStr = data.slice(offset, lineEnd).toString("ascii").trim();
    const chunkSize = parseInt(sizeStr, 16);
    if (isNaN(chunkSize) || chunkSize === 0) break;

    const chunkStart = lineEnd + 2;
    const chunkEnd = chunkStart + chunkSize;
    if (chunkEnd > data.length) break;

    chunks.push(data.slice(chunkStart, chunkEnd));
    offset = chunkEnd + 2; // Skip trailing \r\n
  }

  return Buffer.concat(chunks);
}

// ============================================================
// Public API
// ============================================================

/**
 * Generate a REAL FPJS Pro requestId via HTTP POST.
 * No Puppeteer, no browser — just a direct HTTP request.
 *
 * @param profile - BrowserProfile from fingerprintService.generateProfile()
 * @param proxy - Proxy to route through (same as RPC calls for IP consistency)
 * @param jobId - Optional job ID for logging
 * @returns Real FPJS Pro requestId (format: "{timestamp}.{6chars}")
 */
export async function getRequestIdDirect(
  profile: BrowserProfile,
  proxy?: ProxyInfo | null,
  jobId?: number,
): Promise<string> {
  // 1. Build the fingerprint payload (144 signals)
  const payload = buildFpjsPayload(profile);

  // 2. Serialize to JSON bytes
  const jsonStr = JSON.stringify(payload);
  const jsonBytes = Buffer.from(jsonStr, "utf-8");

  // 3. Compress with deflate-raw (payload is always > 1024 bytes)
  const compressed = deflateRawSync(jsonBytes);

  // 4. Apply XOR obfuscation with compressed markers [3, 14]
  const encrypted = fpjsEncrypt(compressed, true);

  // 5. Send via HTTP POST
  const response = await sendBinaryPost(FPJS_URL, encrypted, proxy, profile.userAgent);

  if (response.status !== 200) {
    throw new Error(`FPJS Direct POST failed: status ${response.status}`);
  }

  // 6. Decrypt the response (uses uncompressed markers [3, 13])
  let responseJson: string;
  try {
    const decrypted = fpjsDecrypt(response.body, MARKERS_UNCOMPRESSED);
    responseJson = decrypted.toString("utf-8");
  } catch {
    // Fallback: try as plain text
    responseJson = response.body.toString("utf-8");
  }

  // 7. Parse and extract requestId
  const data = JSON.parse(responseJson);

  if (data.requestId) {
    console.log(`[FPJS-Direct] ✓ RequestId: ${data.requestId} (confidence: ${data.products?.identification?.data?.result?.confidence?.score || "?"}) ${proxy ? `via proxy ${proxy.host}` : "direct"} ${jobId ? `[job ${jobId}]` : ""}`);
    return data.requestId;
  }

  if (data.products?.identification?.error) {
    throw new Error(`FPJS error: ${JSON.stringify(data.products.identification.error)}`);
  }

  throw new Error(`FPJS response sem requestId: ${responseJson.substring(0, 200)}`);
}
