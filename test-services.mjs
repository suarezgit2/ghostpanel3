/**
 * Script de teste individual dos serviços do Ghost Panel
 * Roda fora do servidor para testar cada serviço isoladamente
 * 
 * Uso: node test-services.mjs [servico]
 *   node test-services.mjs captcha    - Testa resolução Turnstile
 *   node test-services.mjs balance    - Verifica saldo do captcha solver
 *   node test-services.mjs sms        - Testa obter número SMS
 *   node test-services.mjs proxy      - Testa listar proxies do Webshare
 *   node test-services.mjs email      - Testa conexão com Zoho Mail
 *   node test-services.mjs all        - Testa todos
 */

// Carregar env vars do processo (já injetadas pelo Manus)
const ENV = {
  capsolverApiKey: process.env.CAPSOLVER_API_KEY || "",
  twocaptchaApiKey: process.env.TWOCAPTCHA_API_KEY || "",
  captchaProvider: process.env.CAPTCHA_PROVIDER || "2captcha",
  smsbowerApiKey: process.env.SMSBOWER_API_KEY || "",
  webshareApiKey: process.env.WEBSHARE_API_KEY || "",
  zohoClientId: process.env.ZOHO_CLIENT_ID || "",
  zohoClientSecret: process.env.ZOHO_CLIENT_SECRET || "",
  zohoRefreshToken: process.env.ZOHO_REFRESH_TOKEN || "",
  zohoAccountId: process.env.ZOHO_ACCOUNT_ID || "",
};

const CAPSOLVER_API = "https://api.capsolver.com";
const TWOCAPTCHA_API = "https://api.2captcha.com";
const SMSBOWER_API = "https://smsbower.com/stubs/handler_api.php";
const WEBSHARE_API = "https://proxy.webshare.io/api/v2";
const ZOHO_TOKEN_URL = "https://accounts.zoho.com/oauth/v2/token";

const TURNSTILE_SITE_KEY = "0x4AAAAAAA_sd0eRNCinWBgU";
const TURNSTILE_URL = "https://manus.im/login";

function log(emoji, msg) {
  console.log(`${emoji} ${msg}`);
}

// ========== CAPTCHA BALANCE ==========
async function testBalance() {
  log("💰", "=== Teste de Saldo do Captcha ===");
  
  const provider = ENV.captchaProvider;
  log("🔧", `Provider configurado: ${provider}`);
  
  if (provider === "2captcha" || !ENV.capsolverApiKey) {
    if (!ENV.twocaptchaApiKey) {
      log("❌", "2Captcha API key não configurada");
      return false;
    }
    try {
      const resp = await fetch(`${TWOCAPTCHA_API}/getBalance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: ENV.twocaptchaApiKey }),
      });
      const data = await resp.json();
      log("✅", `2Captcha saldo: $${data.balance}`);
      return true;
    } catch (e) {
      log("❌", `2Captcha erro: ${e.message}`);
      return false;
    }
  } else {
    if (!ENV.capsolverApiKey) {
      log("❌", "CapSolver API key não configurada");
      return false;
    }
    try {
      const resp = await fetch(`${CAPSOLVER_API}/getBalance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: ENV.capsolverApiKey }),
      });
      const data = await resp.json();
      log("✅", `CapSolver saldo: $${data.balance}`);
      return true;
    } catch (e) {
      log("❌", `CapSolver erro: ${e.message}`);
      return false;
    }
  }
}

// ========== CAPTCHA SOLVE ==========
async function testCaptcha() {
  log("🔐", "=== Teste de Resolução Turnstile ===");
  
  let provider = ENV.captchaProvider;
  // Normalizar nome do provider
  if (provider === "twocaptcha") provider = "2captcha";
  const apiKey = provider === "2captcha" ? ENV.twocaptchaApiKey : ENV.capsolverApiKey;
  const apiUrl = provider === "2captcha" ? TWOCAPTCHA_API : CAPSOLVER_API;
  
  if (!apiKey) {
    log("❌", `${provider} API key não configurada`);
    return false;
  }
  
  log("🔧", `Usando ${provider} para resolver Turnstile...`);
  log("🔧", `SiteKey: ${TURNSTILE_SITE_KEY}`);
  log("🔧", `URL: ${TURNSTILE_URL}`);
  
  const startTime = Date.now();
  
  try {
    // Criar task
    const taskType = provider === "2captcha" ? "TurnstileTaskProxyless" : "AntiTurnstileTaskProxyLess";
    
    const createResp = await fetch(`${apiUrl}/createTask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientKey: apiKey,
        task: {
          type: taskType,
          websiteURL: TURNSTILE_URL,
          websiteKey: TURNSTILE_SITE_KEY,
        },
      }),
    });
    
    const createData = await createResp.json();
    
    if (createData.errorId !== 0) {
      log("❌", `createTask erro: ${createData.errorCode} - ${createData.errorDescription}`);
      return false;
    }
    
    // CapSolver pode retornar resultado instantâneo
    if (createData.status === "ready" && createData.solution?.token) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      log("✅", `Turnstile resolvido instantaneamente em ${elapsed}s!`);
      log("🔑", `Token (primeiros 50 chars): ${createData.solution.token.substring(0, 50)}...`);
      return true;
    }
    
    const taskId = createData.taskId;
    log("⏳", `Task criada: ${taskId}, fazendo polling...`);
    
    // Polling
    const firstWait = provider === "2captcha" ? 5000 : 2000;
    const pollInterval = provider === "2captcha" ? 3000 : 2000;
    
    await new Promise(r => setTimeout(r, firstWait));
    
    for (let i = 0; i < 60; i++) {
      const resultResp = await fetch(`${apiUrl}/getTaskResult`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: apiKey, taskId }),
      });
      
      const resultData = await resultResp.json();
      
      if (resultData.errorId !== 0) {
        log("❌", `getTaskResult erro: ${resultData.errorCode} - ${resultData.errorDescription}`);
        return false;
      }
      
      if (resultData.status === "ready" && resultData.solution?.token) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        log("✅", `Turnstile resolvido em ${elapsed}s!`);
        log("🔑", `Token (primeiros 50 chars): ${resultData.solution.token.substring(0, 50)}...`);
        return true;
      }
      
      if (resultData.status === "failed") {
        log("❌", "Task falhou");
        return false;
      }
      
      process.stdout.write(".");
      await new Promise(r => setTimeout(r, pollInterval));
    }
    
    log("❌", "Timeout");
    return false;
  } catch (e) {
    log("❌", `Erro: ${e.message}`);
    return false;
  }
}

// ========== SMS (SMSBower) ==========
async function testSms() {
  log("📱", "=== Teste SMSBower ===");
  
  if (!ENV.smsbowerApiKey) {
    log("❌", "SMSBower API key não configurada");
    return false;
  }
  
  try {
    // Verificar saldo
    const balanceUrl = `${SMSBOWER_API}?api_key=${ENV.smsbowerApiKey}&action=getBalance`;
    const balanceResp = await fetch(balanceUrl);
    const balanceText = await balanceResp.text();
    log("💰", `SMSBower resposta saldo: ${balanceText}`);
    
    if (balanceText.startsWith("ACCESS_BALANCE:")) {
      const balance = parseFloat(balanceText.split(":")[1]);
      log("✅", `SMSBower saldo: $${balance.toFixed(4)}`);
    } else {
      log("⚠️", `Resposta inesperada: ${balanceText}`);
    }
    
    // Verificar preços para Indonesia / Any service
    const pricesUrl = `${SMSBOWER_API}?api_key=${ENV.smsbowerApiKey}&action=getPricesV2&country=6`;
    const pricesResp = await fetch(pricesUrl);
    const pricesData = await pricesResp.json();
    
    // Procurar "any" service
    const anyService = pricesData?.["6"]?.["any"];
    if (anyService) {
      log("✅", `Indonesia 'any' service: custo=$${anyService.cost}, disponível=${anyService.count}`);
    } else {
      log("⚠️", "Serviço 'any' não encontrado para Indonesia, verificando outros...");
      const services = Object.keys(pricesData?.["6"] || {}).slice(0, 5);
      log("📋", `Serviços disponíveis (primeiros 5): ${services.join(", ")}`);
    }
    
    return true;
  } catch (e) {
    log("❌", `SMSBower erro: ${e.message}`);
    return false;
  }
}

// ========== PROXY (Webshare) ==========
async function testProxy() {
  log("🌐", "=== Teste Webshare Proxies ===");
  
  if (!ENV.webshareApiKey) {
    log("❌", "Webshare API key não configurada");
    return false;
  }
  
  try {
    const resp = await fetch(`${WEBSHARE_API}/proxy/list/?mode=direct&page=1&page_size=5`, {
      headers: { Authorization: `Token ${ENV.webshareApiKey}` },
    });
    
    const data = await resp.json();
    
    if (data.count !== undefined) {
      log("✅", `Webshare: ${data.count} proxies disponíveis`);
      
      if (data.results && data.results.length > 0) {
        const first = data.results[0];
        log("📋", `Primeiro proxy: ${first.proxy_address}:${first.port} (${first.country_code})`);
      }
      return true;
    } else {
      log("❌", `Resposta inesperada: ${JSON.stringify(data).substring(0, 200)}`);
      return false;
    }
  } catch (e) {
    log("❌", `Webshare erro: ${e.message}`);
    return false;
  }
}

// ========== EMAIL (Zoho Mail) ==========
async function testEmail() {
  log("📧", "=== Teste Zoho Mail ===");
  
  if (!ENV.zohoClientId || !ENV.zohoRefreshToken) {
    log("❌", "Zoho Mail credenciais não configuradas");
    return false;
  }
  
  try {
    // Renovar access token
    const tokenResp = await fetch(ZOHO_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: ENV.zohoClientId,
        client_secret: ENV.zohoClientSecret,
        refresh_token: ENV.zohoRefreshToken,
      }),
    });
    
    const tokenData = await tokenResp.json();
    
    if (tokenData.access_token) {
      log("✅", `Zoho access token obtido: ${tokenData.access_token.substring(0, 20)}...`);
      
      // Listar mensagens recentes
      const messagesResp = await fetch(
        `https://mail.zoho.com/api/accounts/${ENV.zohoAccountId}/messages/view?limit=3&sortorder=false`,
        {
          headers: { Authorization: `Zoho-oauthtoken ${tokenData.access_token}` },
        }
      );
      
      const messagesData = await messagesResp.json();
      
      if (messagesData.data) {
        log("✅", `Zoho Mail: ${messagesData.data.length} mensagens recentes encontradas`);
        if (messagesData.data.length > 0) {
          const first = messagesData.data[0];
          log("📋", `Última mensagem: de=${first.fromAddress}, assunto=${first.subject?.substring(0, 50)}`);
        }
      } else {
        log("⚠️", `Resposta: ${JSON.stringify(messagesData).substring(0, 200)}`);
      }
      
      return true;
    } else {
      log("❌", `Zoho token erro: ${JSON.stringify(tokenData)}`);
      return false;
    }
  } catch (e) {
    log("❌", `Zoho erro: ${e.message}`);
    return false;
  }
}

// ========== MAIN ==========
async function main() {
  const target = process.argv[2] || "all";
  
  console.log("\n🔬 Ghost Panel - Teste de Serviços");
  console.log("=".repeat(50));
  console.log(`Provider captcha: ${ENV.captchaProvider}`);
  console.log(`Keys configuradas: CapSolver=${ENV.capsolverApiKey ? "SIM" : "NÃO"}, 2Captcha=${ENV.twocaptchaApiKey ? "SIM" : "NÃO"}, SMSBower=${ENV.smsbowerApiKey ? "SIM" : "NÃO"}, Webshare=${ENV.webshareApiKey ? "SIM" : "NÃO"}, Zoho=${ENV.zohoClientId ? "SIM" : "NÃO"}`);
  console.log("=".repeat(50) + "\n");
  
  const results = {};
  
  if (target === "all" || target === "balance") {
    results.balance = await testBalance();
    console.log("");
  }
  
  if (target === "all" || target === "proxy") {
    results.proxy = await testProxy();
    console.log("");
  }
  
  if (target === "all" || target === "sms") {
    results.sms = await testSms();
    console.log("");
  }
  
  if (target === "all" || target === "email") {
    results.email = await testEmail();
    console.log("");
  }
  
  if (target === "captcha") {
    results.captcha = await testCaptcha();
    console.log("");
  }
  
  // Resumo
  if (Object.keys(results).length > 1) {
    console.log("\n📊 RESUMO");
    console.log("=".repeat(50));
    for (const [service, ok] of Object.entries(results)) {
      console.log(`  ${ok ? "✅" : "❌"} ${service}`);
    }
    console.log("=".repeat(50));
  }
}

main().catch(e => {
  console.error("Erro fatal:", e);
  process.exit(1);
});
