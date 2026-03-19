/**
 * GhostPanel v5.0 — Deep Manus API Test
 *
 * Testa detalhadamente a interação com a API real do manus.im:
 * 1. Investiga o status code do impers (undefined bug)
 * 2. Compara response headers entre impers e fetch
 * 3. Testa se o Cloudflare diferencia os dois
 * 4. Verifica se há rate limiting ou fingerprint checking
 */

import * as impers from "impers";

console.log("╔══════════════════════════════════════════════════════════════╗");
console.log("║  GhostPanel v5.0 — Deep Manus API Analysis                 ║");
console.log("╚══════════════════════════════════════════════════════════════╝\n");

// ============================================================
// TEST A: Investigate impers response object
// ============================================================
console.log("━━━ TEST A: Investigar objeto de resposta do impers ━━━\n");

try {
  const r = await impers.get("https://httpbin.org/status/200", { impersonate: "chrome136" });
  console.log("  Keys do response:", Object.keys(r));
  console.log("  r.status:", r.status);
  console.log("  r.statusText:", r.statusText);
  console.log("  r.statusCode:", r.statusCode);
  console.log("  r.ok:", r.ok);
  console.log("  typeof r.text:", typeof r.text);
  console.log("  typeof r.json:", typeof r.json);
  console.log("  typeof r.headers:", typeof r.headers);
  if (r.headers) {
    console.log("  Response headers keys:", Object.keys(r.headers).slice(0, 10));
  }

  // Try different status codes
  for (const code of [200, 201, 400, 403, 500]) {
    const r2 = await impers.get(`https://httpbin.org/status/${code}`, { impersonate: "chrome136" });
    console.log(`  Status ${code}: r.status=${r2.status}, r.statusCode=${r2.statusCode}, r.ok=${r2.ok}`);
  }
} catch (e) {
  console.log("  ERROR:", e.message);
}

// ============================================================
// TEST B: Real API call — detailed analysis
// ============================================================
console.log("\n━━━ TEST B: Chamada real ao api.manus.im — análise detalhada ━━━\n");

const rpcHeaders = {
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
};

try {
  // impers call
  console.log("  [impers] Enviando requisição...");
  const r1 = await impers.post("https://api.manus.im/user.v1.UserAuthPublicService/GetUserPlatforms", {
    impersonate: "chrome136",
    headers: rpcHeaders,
    content: JSON.stringify({
      email: "fingerprint-test-12345@example.com",
      cfCaptchaCode: "test-token-invalid",
    }),
  });

  console.log("  [impers] Response object keys:", Object.keys(r1));
  console.log("  [impers] status:", r1.status);
  console.log("  [impers] statusCode:", r1.statusCode);
  console.log("  [impers] ok:", r1.ok);

  let text1;
  if (typeof r1.text === "function") {
    text1 = r1.text();
  } else {
    text1 = r1.text;
  }
  console.log("  [impers] text type:", typeof text1);
  console.log("  [impers] text (first 300):", typeof text1 === "string" ? text1.substring(0, 300) : JSON.stringify(text1)?.substring(0, 300));

  if (r1.headers) {
    console.log("  [impers] Response headers:");
    const headerObj = typeof r1.headers === "object" ? r1.headers : {};
    for (const [k, v] of Object.entries(headerObj)) {
      if (k.toLowerCase().includes("cf-") || k.toLowerCase().includes("server") || 
          k.toLowerCase().includes("content-type") || k.toLowerCase().includes("x-")) {
        console.log(`    ${k}: ${v}`);
      }
    }
  }

  // Parse response
  let data1;
  try {
    const textStr = typeof text1 === "string" ? text1 : JSON.stringify(text1);
    data1 = JSON.parse(textStr);
    console.log("\n  [impers] Parsed response:");
    console.log("    code:", data1.code);
    console.log("    message:", data1.message);
    if (data1.details?.[0]?.debug) {
      console.log("    debug.code:", data1.details[0].debug.code);
      console.log("    debug.message:", data1.details[0].debug.message);
    }
  } catch {
    console.log("  [impers] Response is not JSON");
  }

  // fetch call for comparison
  console.log("\n  [fetch] Enviando requisição...");
  const r2 = await fetch("https://api.manus.im/user.v1.UserAuthPublicService/GetUserPlatforms", {
    method: "POST",
    headers: rpcHeaders,
    body: JSON.stringify({
      email: "fingerprint-test-12345@example.com",
      cfCaptchaCode: "test-token-invalid",
    }),
  });

  const text2 = await r2.text();
  console.log("  [fetch] status:", r2.status);
  console.log("  [fetch] statusText:", r2.statusText);
  console.log("  [fetch] text (first 300):", text2.substring(0, 300));

  // Compare response headers
  console.log("\n  [fetch] Response headers:");
  r2.headers.forEach((v, k) => {
    if (k.includes("cf-") || k.includes("server") || k.includes("content-type") || k.includes("x-")) {
      console.log(`    ${k}: ${v}`);
    }
  });

  let data2;
  try {
    data2 = JSON.parse(text2);
    console.log("\n  [fetch] Parsed response:");
    console.log("    code:", data2.code);
    console.log("    message:", data2.message);
    if (data2.details?.[0]?.debug) {
      console.log("    debug.code:", data2.details[0].debug.code);
      console.log("    debug.message:", data2.details[0].debug.message);
    }
  } catch {
    console.log("  [fetch] Response is not JSON");
  }

  // Compare
  console.log("\n━━━ COMPARAÇÃO ━━━");
  console.log(`  Mesmo erro retornado? ${data1?.code === data2?.code ? "SIM" : "NÃO"}`);
  console.log(`  impers code: ${data1?.code}, fetch code: ${data2?.code}`);
  console.log(`  Ambos chegaram ao backend? ${data1?.code && data2?.code ? "SIM — Cloudflare não bloqueou nenhum" : "VERIFICAR"}`);

} catch (e) {
  console.log("  ERROR:", e.message);
  console.log("  Stack:", e.stack);
}

// ============================================================
// TEST C: Check if Cloudflare returns different cf-ray for each
// ============================================================
console.log("\n━━━ TEST C: Cloudflare cf-ray e server headers ━━━\n");

try {
  // GET to manus.im with impers
  const r1 = await impers.get("https://manus.im/login", {
    impersonate: "chrome136",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  const text1 = typeof r1.text === "string" ? r1.text : (typeof r1.text === "function" ? r1.text() : "");

  console.log("  [impers] /login status:", r1.status || r1.statusCode);
  console.log("  [impers] Response size:", text1.length, "bytes");
  console.log("  [impers] Contains 'Checking your browser':", text1.includes("Checking your browser"));
  console.log("  [impers] Contains 'cf-challenge':", text1.includes("cf-challenge"));
  console.log("  [impers] Contains 'login' or 'sign':", text1.includes("login") || text1.includes("sign") || text1.includes("Login") || text1.includes("Sign"));

  // GET with fetch
  const r2 = await fetch("https://manus.im/login", {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  const text2 = await r2.text();

  console.log("\n  [fetch] /login status:", r2.status);
  console.log("  [fetch] Response size:", text2.length, "bytes");
  console.log("  [fetch] Contains 'Checking your browser':", text2.includes("Checking your browser"));
  console.log("  [fetch] Contains 'cf-challenge':", text2.includes("cf-challenge"));
  console.log("  [fetch] Contains 'login' or 'sign':", text2.includes("login") || text2.includes("sign") || text2.includes("Login") || text2.includes("Sign"));

  // Check cf-ray headers
  console.log("\n  [fetch] cf-ray:", r2.headers.get("cf-ray"));
  console.log("  [fetch] server:", r2.headers.get("server"));

  if (r1.headers) {
    console.log("  [impers] cf-ray:", r1.headers["cf-ray"]);
    console.log("  [impers] server:", r1.headers["server"]);
  }

} catch (e) {
  console.log("  ERROR:", e.message);
}

// ============================================================
// TEST D: Rate limiting check — rapid requests
// ============================================================
console.log("\n━━━ TEST D: Rate limiting — 3 requisições rápidas ao API ━━━\n");

try {
  for (let i = 1; i <= 3; i++) {
    const r = await impers.post("https://api.manus.im/user.v1.UserAuthPublicService/GetUserPlatforms", {
      impersonate: "chrome136",
      headers: rpcHeaders,
      content: JSON.stringify({
        email: `rate-limit-test-${i}@example.com`,
        cfCaptchaCode: "test-token",
      }),
    });
    const text = typeof r.text === "string" ? r.text : (typeof r.text === "function" ? r.text() : "");
    let code = "N/A";
    try { code = JSON.parse(text).code; } catch {}
    console.log(`  Request ${i}: status=${r.status || r.statusCode}, code=${code}, size=${text.length}b`);
  }
} catch (e) {
  console.log("  ERROR:", e.message);
}

console.log("\n╔══════════════════════════════════════════════════════════════╗");
console.log("║                    Testes concluídos!                       ║");
console.log("╚══════════════════════════════════════════════════════════════╝");
