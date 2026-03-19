/**
 * GhostPanel v5.0 — Real Fingerprint Tests
 *
 * Testa EXATAMENTE o que os servidores veem quando recebem requisições do GhostPanel.
 * Não usa browser — testa as requisições HTTP reais com TLS impersonation.
 *
 * Testes:
 * 1. tls.peet.ws — Análise completa de TLS + HTTP/2 fingerprint
 * 2. tls.browserleaks.com — Segundo serviço para cross-validation
 * 3. httpbin.org — Verificar headers HTTP enviados
 * 4. manus.im (Cloudflare) — Testar se o Cloudflare aceita a requisição
 * 5. api.manus.im — Testar chamada RPC real (getUserPlatforms com email fake)
 */

import * as impers from "impers";
import * as fs from "fs";

const RESULTS = {};
const ISSUES = [];
const PASSES = [];

// Known Chrome 136 reference values
const CHROME_REF = {
  akamai_fp: "1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p",
  http_version: "h2",
  pseudo_header_order: [":method", ":authority", ":scheme", ":path"],
  settings: {
    HEADER_TABLE_SIZE: 65536,
    ENABLE_PUSH: 0,
    INITIAL_WINDOW_SIZE: 6291456,
    MAX_HEADER_LIST_SIZE: 262144,
  },
  window_update_increment: 15663105,
};

// Simulated GhostPanel headers (exactly what rpc.ts sends)
function getGhostPanelHeaders() {
  return {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    "Content-Type": "application/json",
    "Accept": "*/*",
    "Origin": "https://manus.im",
    "Referer": "https://manus.im/",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-Language": "en-US,en;q=0.9",
    "sec-ch-ua": '"Google Chrome";v="136", "Chromium";v="136", "Not A(Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "Sec-Fetch-Site": "same-site",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    "Connect-Protocol-Version": "1",
    "x-client-type": "web",
    "x-client-version": "2.3.1",
    "x-client-locale": "en",
    "x-client-timezone": "America/New_York",
    "x-client-timezone-offset": "240",
    "x-client-id": "aBcDeFgHiJkLmNoPqRsT12",
    "x-client-dcr": "eyJ1YSI6InRlc3QifQ==",  // Dummy DCR for testing
  };
}

function log(icon, msg) {
  console.log(`  ${icon} ${msg}`);
}

function pass(msg) {
  log("✅", msg);
  PASSES.push(msg);
}

function fail(msg) {
  log("❌", msg);
  ISSUES.push(msg);
}

function warn(msg) {
  log("⚠️", msg);
  ISSUES.push(`[WARN] ${msg}`);
}

function info(msg) {
  log("ℹ️", msg);
}

// ============================================================
// TEST 1: tls.peet.ws — Full TLS + HTTP/2 analysis
// ============================================================
async function testPeetWs() {
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║  TEST 1: tls.peet.ws — TLS + HTTP/2 Fingerprint Analysis   ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  try {
    // Test with impers (Chrome impersonation)
    const r = await impers.get("https://tls.peet.ws/api/all", {
      impersonate: "chrome136",
      headers: getGhostPanelHeaders(),
    });
    const d = r.json();
    RESULTS.peetws = d;

    info(`HTTP Version: ${d.http_version}`);
    info(`JA3 Hash: ${d.tls?.ja3_hash}`);
    info(`JA4: ${d.tls?.ja4}`);
    info(`Akamai FP: ${d.http2?.akamai_fingerprint}`);
    info(`Cipher Suites: ${d.tls?.ciphers?.length}`);
    info(`TLS Extensions: ${d.tls?.extensions?.length}`);

    // Validate HTTP/2
    if (d.http_version === "h2") {
      pass("HTTP/2 ativo (não HTTP/1.1)");
    } else {
      fail(`HTTP Version é ${d.http_version}, deveria ser h2`);
    }

    // Validate Akamai fingerprint
    if (d.http2?.akamai_fingerprint === CHROME_REF.akamai_fp) {
      pass("Akamai FP idêntico ao Chrome");
    } else {
      fail(`Akamai FP diferente: ${d.http2?.akamai_fingerprint}`);
    }

    // Validate SETTINGS frame
    const settingsFrame = d.http2?.sent_frames?.find(f => f.frame_type === "SETTINGS");
    if (settingsFrame) {
      const hasCorrectWindow = settingsFrame.settings?.some(s => s.includes("6291456"));
      if (hasCorrectWindow) {
        pass("INITIAL_WINDOW_SIZE = 6291456 (Chrome)");
      } else {
        fail("INITIAL_WINDOW_SIZE incorreto");
      }

      const hasHeaderTableSize = settingsFrame.settings?.some(s => s.includes("65536"));
      if (hasHeaderTableSize) {
        pass("HEADER_TABLE_SIZE = 65536 (Chrome)");
      } else {
        fail("HEADER_TABLE_SIZE incorreto");
      }
    }

    // Validate WINDOW_UPDATE
    const windowFrame = d.http2?.sent_frames?.find(f => f.frame_type === "WINDOW_UPDATE");
    if (windowFrame?.increment === CHROME_REF.window_update_increment) {
      pass("WINDOW_UPDATE increment = 15663105 (Chrome)");
    } else {
      fail(`WINDOW_UPDATE increment = ${windowFrame?.increment}, esperado 15663105`);
    }

    // Validate pseudo-header order
    const headersFrame = d.http2?.sent_frames?.find(f => f.frame_type === "HEADERS");
    if (headersFrame) {
      const pseudos = headersFrame.headers
        ?.filter(h => h.startsWith(":"))
        ?.map(h => ":" + h.split(": ")[0].substring(1));
      
      const expectedOrder = CHROME_REF.pseudo_header_order.join(",");
      const actualOrder = pseudos?.join(",");
      if (actualOrder === expectedOrder) {
        pass("Pseudo-header order = :method,:authority,:scheme,:path (Chrome)");
      } else {
        fail(`Pseudo-header order: ${actualOrder}, esperado: ${expectedOrder}`);
      }
    }

    // Check sent headers
    if (headersFrame) {
      const sentHeaders = headersFrame.headers || [];
      const hasOrigin = sentHeaders.some(h => h.includes("origin: https://manus.im"));
      const hasReferer = sentHeaders.some(h => h.includes("referer: https://manus.im/"));
      const hasSecChUa = sentHeaders.some(h => h.includes("sec-ch-ua:"));
      const hasClientType = sentHeaders.some(h => h.includes("x-client-type: web"));

      if (hasOrigin) pass("Header Origin: https://manus.im presente");
      else fail("Header Origin ausente");

      if (hasReferer) pass("Header Referer: https://manus.im/ presente");
      else fail("Header Referer ausente");

      if (hasSecChUa) pass("Header sec-ch-ua presente");
      else fail("Header sec-ch-ua ausente");

      if (hasClientType) pass("Header x-client-type: web presente");
      else fail("Header x-client-type ausente");
    }

    // Compare with Node.js fetch
    console.log("\n  --- Comparação com Node.js fetch nativo ---");
    const r2 = await fetch("https://tls.peet.ws/api/all");
    const d2 = await r2.json();
    RESULTS.peetws_fetch = d2;

    info(`fetch JA3: ${d2.tls?.ja3_hash}`);
    info(`fetch HTTP: ${d2.http_version}`);

    if (d.tls?.ja3_hash !== d2.tls?.ja3_hash) {
      pass(`JA3 diferente do Node.js (impers=${d.tls?.ja3_hash?.substring(0,12)}... vs fetch=${d2.tls?.ja3_hash?.substring(0,12)}...)`);
    } else {
      fail("JA3 IGUAL ao Node.js — impersonation não está funcionando!");
    }

  } catch (e) {
    fail(`Erro no teste: ${e.message}`);
  }
}

// ============================================================
// TEST 2: tls.browserleaks.com — Cross-validation
// ============================================================
async function testBrowserLeaks() {
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║  TEST 2: tls.browserleaks.com — Cross-validation TLS       ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  try {
    const r = await impers.get("https://tls.browserleaks.com/json", {
      impersonate: "chrome136",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
        "Accept": "application/json",
      },
    });
    const d = r.json();
    RESULTS.browserleaks = d;

    info(`JA3 Hash: ${d.ja3_hash}`);
    info(`JA3 Text length: ${d.ja3_text?.length || 'N/A'}`);
    info(`Protocol: ${d.protocol}`);
    info(`User-Agent: ${d.user_agent}`);

    if (d.user_agent?.includes("Chrome/136")) {
      pass("User-Agent recebido corretamente pelo servidor");
    } else {
      warn(`User-Agent recebido: ${d.user_agent}`);
    }

    if (d.ja3_hash) {
      pass(`JA3 Hash obtido: ${d.ja3_hash}`);
    }

    // Check if protocol is TLS 1.3
    if (d.protocol?.includes("TLSv1.3") || d.protocol?.includes("1.3")) {
      pass("TLS 1.3 ativo");
    } else {
      info(`Protocol: ${d.protocol}`);
    }

  } catch (e) {
    warn(`browserleaks falhou (pode estar bloqueando): ${e.message}`);
  }
}

// ============================================================
// TEST 3: httpbin.org — Verify HTTP headers
// ============================================================
async function testHttpbin() {
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║  TEST 3: httpbin.org — Verificar headers HTTP recebidos     ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  try {
    const headers = getGhostPanelHeaders();
    const r = await impers.get("https://httpbin.org/headers", {
      impersonate: "chrome136",
      headers,
    });
    const d = r.json();
    RESULTS.httpbin = d;

    const received = d.headers || {};

    // Check critical headers
    const checks = [
      ["User-Agent", "Chrome/136"],
      ["Origin", "https://manus.im"],
      ["Referer", "https://manus.im/"],
      ["Sec-Ch-Ua", "Chrome"],
      ["Sec-Ch-Ua-Platform", "Windows"],
      ["X-Client-Type", "web"],
      ["X-Client-Version", "2.3.1"],
      ["X-Client-Locale", "en"],
      ["X-Client-Timezone", "America/New_York"],
      ["Connect-Protocol-Version", "1"],
    ];

    for (const [header, expectedContains] of checks) {
      // httpbin normalizes header names
      const key = Object.keys(received).find(k => k.toLowerCase() === header.toLowerCase());
      const value = key ? received[key] : null;

      if (value && value.includes(expectedContains)) {
        pass(`${header}: "${value.substring(0, 60)}${value.length > 60 ? '...' : ''}"`);
      } else if (value) {
        warn(`${header} presente mas inesperado: "${value}"`);
      } else {
        fail(`${header} AUSENTE na requisição`);
      }
    }

    // Check that no Node.js-specific headers leak
    const nodeHeaders = Object.keys(received).filter(k =>
      k.toLowerCase().includes("node") ||
      k.toLowerCase().includes("undici") ||
      k.toLowerCase().includes("fetch")
    );
    if (nodeHeaders.length === 0) {
      pass("Nenhum header Node.js/undici/fetch vazando");
    } else {
      fail(`Headers Node.js detectados: ${nodeHeaders.join(", ")}`);
    }

  } catch (e) {
    fail(`Erro no httpbin: ${e.message}`);
  }
}

// ============================================================
// TEST 4: manus.im — Cloudflare acceptance test
// ============================================================
async function testManusCloudflare() {
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║  TEST 4: manus.im — Teste de aceitação do Cloudflare       ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  try {
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Encoding": "gzip, deflate, br, zstd",
      "Accept-Language": "en-US,en;q=0.9",
      "sec-ch-ua": '"Google Chrome";v="136", "Chromium";v="136", "Not A(Brand";v="24"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-User": "?1",
      "Upgrade-Insecure-Requests": "1",
    };

    const r = await impers.get("https://manus.im/", {
      impersonate: "chrome136",
      headers,
    });

    RESULTS.manus_cf = { status: r.status, textLength: r.text?.length };

    info(`Status: ${r.status}`);
    info(`Response size: ${r.text?.length || 0} bytes`);

    if (r.status === 200) {
      pass("Cloudflare aceitou a requisição (HTTP 200)");

      // Check if it's a real page or a challenge
      if (r.text?.includes("Checking your browser") || r.text?.includes("cf-challenge")) {
        fail("Cloudflare retornou challenge page (bot detectado!)");
      } else if (r.text?.includes("manus") || r.text?.includes("Manus")) {
        pass("Página real do manus.im retornada (sem challenge)");
      }
    } else if (r.status === 403) {
      fail(`Cloudflare bloqueou (403 Forbidden) — TLS fingerprint pode estar sendo rejeitado`);
    } else if (r.status === 503) {
      fail(`Cloudflare challenge (503) — bot detectado`);
    } else {
      warn(`Status inesperado: ${r.status}`);
    }

    // Compare with Node.js fetch
    console.log("\n  --- Comparação com Node.js fetch nativo ---");
    try {
      const r2 = await fetch("https://manus.im/", {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
        },
      });
      const text2 = await r2.text();
      info(`fetch Status: ${r2.status}`);
      info(`fetch Response size: ${text2.length} bytes`);

      if (r2.status === 403 || text2.includes("cf-challenge") || text2.includes("Checking your browser")) {
        pass("Node.js fetch foi BLOQUEADO pelo Cloudflare (confirma que impersonation é necessário)");
      } else {
        info("Node.js fetch também passou (Cloudflare pode estar relaxado neste endpoint)");
      }
    } catch (e2) {
      info(`Node.js fetch erro: ${e2.message}`);
    }

  } catch (e) {
    fail(`Erro ao acessar manus.im: ${e.message}`);
  }
}

// ============================================================
// TEST 5: api.manus.im — Real RPC call test
// ============================================================
async function testManusApi() {
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║  TEST 5: api.manus.im — Teste de chamada RPC real          ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  try {
    const headers = getGhostPanelHeaders();

    // Call getUserPlatforms with a fake email — this should return an error
    // about missing captcha, NOT a Cloudflare block
    const r = await impers.post("https://api.manus.im/user.v1.UserAuthPublicService/GetUserPlatforms", {
      impersonate: "chrome136",
      headers,
      content: JSON.stringify({
        email: "test-fingerprint-check@example.com",
        cfCaptchaCode: "dummy-token-for-testing",
      }),
    });

    const text = r.text || "";
    RESULTS.manus_api = { status: r.status, text: text.substring(0, 500) };

    info(`Status: ${r.status}`);
    info(`Response: ${text.substring(0, 200)}`);

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }

    if (r.status === 200 && data) {
      // ConnectRPC error response (expected — captcha is invalid)
      if (data.code) {
        pass(`API respondeu com ConnectRPC error: [${data.code}] (esperado — captcha inválido)`);
        info(`Mensagem: ${data.message || data.details?.[0]?.debug?.message || "N/A"}`);

        // This is GOOD — means Cloudflare let us through to the actual API
        pass("Cloudflare NÃO bloqueou — requisição chegou ao backend do manus.im");
      } else {
        pass("API respondeu com JSON válido");
      }
    } else if (r.status === 403) {
      fail("API retornou 403 — Cloudflare ou WAF bloqueou a requisição");
    } else if (r.status === 503) {
      fail("API retornou 503 — Cloudflare challenge (bot detectado!)");
    } else {
      warn(`Status inesperado: ${r.status}`);
      if (text.includes("cf-challenge") || text.includes("Checking your browser")) {
        fail("Cloudflare challenge detectado na resposta");
      }
    }

    // Compare with Node.js fetch
    console.log("\n  --- Comparação com Node.js fetch nativo ---");
    try {
      const r2 = await fetch("https://api.manus.im/user.v1.UserAuthPublicService/GetUserPlatforms", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
          "Origin": "https://manus.im",
          "Referer": "https://manus.im/",
          "Connect-Protocol-Version": "1",
        },
        body: JSON.stringify({
          email: "test-fingerprint-check@example.com",
          cfCaptchaCode: "dummy-token-for-testing",
        }),
      });
      const text2 = await r2.text();
      info(`fetch Status: ${r2.status}`);
      info(`fetch Response: ${text2.substring(0, 200)}`);

      if (r2.status === 403 || r2.status === 503) {
        pass("Node.js fetch foi BLOQUEADO pela API (confirma que impersonation faz diferença)");
      } else {
        info("Node.js fetch também passou (API pode não verificar TLS neste endpoint)");
      }
    } catch (e2) {
      info(`Node.js fetch erro: ${e2.message}`);
    }

  } catch (e) {
    fail(`Erro ao chamar API: ${e.message}`);
  }
}

// ============================================================
// TEST 6: Consistency check — Multiple requests same fingerprint
// ============================================================
async function testConsistency() {
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║  TEST 6: Consistência — Múltiplas requisições, mesmo FP    ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  try {
    const ja3s = [];
    const akamais = [];

    for (let i = 0; i < 5; i++) {
      const r = await impers.get("https://tls.peet.ws/api/all", {
        impersonate: "chrome136",
      });
      const d = r.json();
      ja3s.push(d.tls?.ja3_hash);
      akamais.push(d.http2?.akamai_fingerprint);
    }

    // All JA3 should be identical (same impersonation target)
    const uniqueJa3 = new Set(ja3s);
    if (uniqueJa3.size === 1) {
      pass(`JA3 consistente em 5 requisições: ${ja3s[0]}`);
    } else {
      warn(`JA3 variou entre requisições: ${[...uniqueJa3].join(", ")}`);
    }

    // All Akamai should be identical
    const uniqueAkamai = new Set(akamais);
    if (uniqueAkamai.size === 1) {
      pass(`Akamai FP consistente em 5 requisições`);
    } else {
      warn(`Akamai FP variou entre requisições`);
    }

  } catch (e) {
    fail(`Erro no teste de consistência: ${e.message}`);
  }
}

// ============================================================
// RUN ALL TESTS
// ============================================================
console.log("╔══════════════════════════════════════════════════════════════╗");
console.log("║  GhostPanel v5.0 — Real Fingerprint Tests (sem browser)    ║");
console.log("║  Testando EXATAMENTE o que os servidores veem              ║");
console.log("╚══════════════════════════════════════════════════════════════╝");

await testPeetWs();
await testBrowserLeaks();
await testHttpbin();
await testManusCloudflare();
await testManusApi();
await testConsistency();

// ============================================================
// SUMMARY
// ============================================================
console.log("\n╔══════════════════════════════════════════════════════════════╗");
console.log("║                      RESUMO FINAL                          ║");
console.log("╚══════════════════════════════════════════════════════════════╝\n");

console.log(`  ✅ PASSES: ${PASSES.length}`);
PASSES.forEach(p => console.log(`     ✅ ${p}`));

console.log(`\n  ❌ ISSUES: ${ISSUES.length}`);
if (ISSUES.length === 0) {
  console.log("     Nenhum problema encontrado!");
} else {
  ISSUES.forEach(i => console.log(`     ❌ ${i}`));
}

console.log(`\n  Score: ${PASSES.length}/${PASSES.length + ISSUES.length} (${Math.round(PASSES.length / (PASSES.length + ISSUES.length) * 100)}%)`);

// Save results to JSON
const outputPath = "/home/ubuntu/ghostpanel/ghostpanel-master/scripts/results/real-fingerprint-results.json";
fs.mkdirSync("/home/ubuntu/ghostpanel/ghostpanel-master/scripts/results", { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify({
  timestamp: new Date().toISOString(),
  passes: PASSES,
  issues: ISSUES,
  score: `${PASSES.length}/${PASSES.length + ISSUES.length}`,
  raw: RESULTS,
}, null, 2));
console.log(`\n  Resultados salvos em: ${outputPath}`);
