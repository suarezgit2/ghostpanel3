/**
 * TLS/HTTP2 Fingerprint Comparison Test
 * Compares impers (Chrome impersonation) vs Node.js native fetch
 * against tls.peet.ws — a service that reports your TLS and HTTP/2 fingerprints
 */

import * as impers from "impers";

const PEET_URL = "https://tls.peet.ws/api/all";

// Known Chrome fingerprint values for reference
const CHROME_AKAMAI = "1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p";
const CHROME_PSEUDO_HEADERS = [":method", ":authority", ":scheme", ":path"];

console.log("╔══════════════════════════════════════════════════════════════╗");
console.log("║   GhostPanel v5.0 — TLS/HTTP2 Fingerprint Comparison Test  ║");
console.log("╚══════════════════════════════════════════════════════════════╝\n");

// ============================================================
// Test 1: impers with Chrome impersonation
// ============================================================
console.log("━━━ TEST 1: impers (Chrome impersonation) ━━━\n");

try {
  const r1 = await impers.get(PEET_URL, { impersonate: "chrome" });
  const d1 = r1.json();

  console.log("HTTP Version:", d1.http_version);
  console.log("JA3 Hash:    ", d1.tls?.ja3_hash);
  console.log("JA4:         ", d1.tls?.ja4);
  console.log("Akamai FP:   ", d1.http2?.akamai_fingerprint);
  console.log("Cipher Count:", d1.tls?.ciphers?.length);

  // Extract pseudo-header order from HEADERS frame
  const headersFrame = d1.http2?.sent_frames?.find(f => f.frame_type === "HEADERS");
  if (headersFrame) {
    const pseudoHeaders = headersFrame.headers
      ?.filter(h => h.startsWith(":"))
      ?.map(h => h.split(":")[1] ? ":" + h.split(":")[1].trim() : h);
    console.log("Pseudo-Hdr:  ", pseudoHeaders?.join(", "));
  }

  // SETTINGS frame analysis
  const settingsFrame = d1.http2?.sent_frames?.find(f => f.frame_type === "SETTINGS");
  if (settingsFrame) {
    console.log("SETTINGS:    ", settingsFrame.settings?.join(", "));
  }

  // WINDOW_UPDATE frame
  const windowFrame = d1.http2?.sent_frames?.find(f => f.frame_type === "WINDOW_UPDATE");
  if (windowFrame) {
    console.log("WIN_UPDATE:  ", `increment=${windowFrame.increment}`);
  }

  // Validation
  console.log("\n--- Validação ---");
  const akamaiMatch = d1.http2?.akamai_fingerprint === CHROME_AKAMAI;
  console.log(`Akamai FP = Chrome? ${akamaiMatch ? "✅ SIM" : "❌ NÃO"}`);
  console.log(`HTTP/2?            ${d1.http_version === "h2" ? "✅ SIM" : "❌ NÃO"}`);

  // Check INITIAL_WINDOW_SIZE
  const hasCorrectWindow = settingsFrame?.settings?.some(s => s.includes("6291456"));
  console.log(`WINDOW_SIZE=6MB?   ${hasCorrectWindow ? "✅ SIM" : "❌ NÃO"}`);

  // Check WINDOW_UPDATE increment
  const hasCorrectIncrement = windowFrame?.increment === 15663105;
  console.log(`WIN_UPDATE=15.6M?  ${hasCorrectIncrement ? "✅ SIM" : "❌ NÃO"}`);

} catch (e) {
  console.error("ERROR:", e.message);
}

// ============================================================
// Test 2: Node.js native fetch (for comparison)
// ============================================================
console.log("\n━━━ TEST 2: Node.js native fetch (sem impersonation) ━━━\n");

try {
  const r2 = await fetch(PEET_URL);
  const d2 = await r2.json();

  console.log("HTTP Version:", d2.http_version);
  console.log("JA3 Hash:    ", d2.tls?.ja3_hash);
  console.log("JA4:         ", d2.tls?.ja4);
  console.log("Akamai FP:   ", d2.http2?.akamai_fingerprint || "N/A (HTTP/1.1)");
  console.log("Cipher Count:", d2.tls?.ciphers?.length);
  console.log("User-Agent:  ", d2.user_agent);

  console.log("\n--- Validação ---");
  console.log(`HTTP/2?            ${d2.http_version === "h2" ? "✅ SIM" : "❌ NÃO (HTTP/1.1 — detectable!)"}`);
  console.log(`Akamai FP?         ${d2.http2?.akamai_fingerprint ? "✅ Presente" : "❌ AUSENTE (detectable!)"}`);

} catch (e) {
  console.error("ERROR:", e.message);
}

// ============================================================
// Test 3: impers with specific Chrome version (chrome136)
// ============================================================
console.log("\n━━━ TEST 3: impers (Chrome 136 específico) ━━━\n");

try {
  const r3 = await impers.get(PEET_URL, { impersonate: "chrome136" });
  const d3 = r3.json();

  console.log("HTTP Version:", d3.http_version);
  console.log("JA3 Hash:    ", d3.tls?.ja3_hash);
  console.log("JA4:         ", d3.tls?.ja4);
  console.log("Akamai FP:   ", d3.http2?.akamai_fingerprint);

  const akamaiMatch = d3.http2?.akamai_fingerprint === CHROME_AKAMAI;
  console.log(`Akamai = Chrome?   ${akamaiMatch ? "✅ SIM" : "❌ NÃO"}`);

} catch (e) {
  console.error("ERROR:", e.message);
}

// ============================================================
// Test 4: impers POST (simulating RPC call)
// ============================================================
console.log("\n━━━ TEST 4: impers POST com headers customizados (simula RPC) ━━━\n");

try {
  const customHeaders = {
    "Content-Type": "application/json",
    "Accept": "*/*",
    "Origin": "https://manus.im",
    "Referer": "https://manus.im/",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-Language": "en-US,en;q=0.9",
    "Connect-Protocol-Version": "1",
    "x-client-type": "web",
    "x-client-version": "2.3.1",
  };

  const r4 = await impers.post(PEET_URL, {
    impersonate: "chrome136",
    headers: customHeaders,
    content: JSON.stringify({ test: true }),
  });
  const d4 = r4.json();

  console.log("HTTP Version:", d4.http_version);
  console.log("JA3 Hash:    ", d4.tls?.ja3_hash);
  console.log("Akamai FP:   ", d4.http2?.akamai_fingerprint);

  // Check that our custom headers were sent
  const headersFrame = d4.http2?.sent_frames?.find(f => f.frame_type === "HEADERS");
  if (headersFrame) {
    const sentHeaders = headersFrame.headers || [];
    const hasOrigin = sentHeaders.some(h => h.includes("manus.im"));
    const hasConnectProto = sentHeaders.some(h => h.includes("connect-protocol-version"));
    console.log(`Origin header?     ${hasOrigin ? "✅ SIM" : "❌ NÃO"}`);
    console.log(`Connect-Proto?     ${hasConnectProto ? "✅ SIM" : "❌ NÃO"}`);
  }

  console.log(`Akamai = Chrome?   ${d4.http2?.akamai_fingerprint === CHROME_AKAMAI ? "✅ SIM" : "❌ NÃO"}`);

} catch (e) {
  console.error("ERROR:", e.message);
}

console.log("\n╔══════════════════════════════════════════════════════════════╗");
console.log("║                    Testes concluídos!                       ║");
console.log("╚══════════════════════════════════════════════════════════════╝");
