/**
 * Teste completo de fingerprint nas plataformas de detecção
 * Plataformas testadas:
 *   1. browserscan.net/bot-detection
 *   2. fingerprint.com/demo
 *   3. bot.sannysoft.com (CreepJS-like)
 *   4. abrahamjuliot.github.io/creepjs
 *   5. pixelscan.net
 */

import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

puppeteer.use(StealthPlugin());

const OUT_DIR = "/home/ubuntu/ghostpanel/ghostpanel-master/scripts/results";
mkdirSync(OUT_DIR, { recursive: true });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function launchBrowser() {
  return puppeteer.launch({
    headless: true,
    executablePath: "/usr/bin/chromium-browser",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--window-size=1920,1080",
      "--lang=en-US,en",
      "--disable-blink-features=AutomationControlled",
    ],
    defaultViewport: { width: 1920, height: 989 },
  });
}

// ============================================================
// TEST 1: BrowserScan Bot Detection
// ============================================================
async function testBrowserScan() {
  console.log("\n[1/5] 🔍 BrowserScan Bot Detection...");
  const browser = await launchBrowser();
  const page = await browser.newPage();

  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36");
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

  const result = { platform: "BrowserScan Bot Detection", url: "https://www.browserscan.net/bot-detection" };

  try {
    await page.goto(result.url, { waitUntil: "networkidle2", timeout: 30000 });
    await sleep(6000);

    await page.screenshot({ path: join(OUT_DIR, "01-browserscan-bot.png"), fullPage: true });

    const data = await page.evaluate(() => {
      const body = document.body.innerText || "";
      // Procurar por resultados específicos
      const checks = {};

      // BrowserScan mostra resultados em tabela
      document.querySelectorAll("table tr, .check-item").forEach(row => {
        const cells = row.querySelectorAll("td, th, .label, .value");
        if (cells.length >= 2) {
          const label = cells[0]?.innerText?.trim();
          const value = cells[1]?.innerText?.trim() || cells[cells.length-1]?.innerText?.trim();
          if (label && value && label.length < 60) checks[label] = value;
        }
      });

      // Pegar indicadores de bot/human
      const allElements = document.querySelectorAll("*");
      const verdicts = [];
      allElements.forEach(el => {
        const text = el.innerText?.trim();
        if (text && (
          text.toLowerCase().includes("bot detected") ||
          text.toLowerCase().includes("human") ||
          text.toLowerCase().includes("not a bot") ||
          text.toLowerCase().includes("automation") ||
          text.toLowerCase().includes("webdriver") ||
          text.toLowerCase().includes("headless")
        ) && text.length < 100) {
          verdicts.push(text);
        }
      });

      return {
        checks,
        verdicts: [...new Set(verdicts)].slice(0, 20),
        bodySnippet: body.substring(0, 2000),
        hasWebdriver: body.toLowerCase().includes("webdriver"),
        hasHeadless: body.toLowerCase().includes("headless"),
        hasAutomation: body.toLowerCase().includes("automation"),
        hasBotDetected: body.toLowerCase().includes("bot detected"),
        hasNotBot: body.toLowerCase().includes("not a bot") || body.toLowerCase().includes("human"),
      };
    });

    result.data = data;
    result.status = "ok";
    console.log(`   ✅ Capturado. WebDriver: ${data.hasWebdriver}, Headless: ${data.hasHeadless}, BotDetected: ${data.hasBotDetected}, NotBot: ${data.hasNotBot}`);
  } catch (err) {
    result.status = "error";
    result.error = err.message;
    console.log(`   ❌ Erro: ${err.message}`);
  }

  await browser.close();
  return result;
}

// ============================================================
// TEST 2: BrowserScan Fingerprint
// ============================================================
async function testBrowserScanFingerprint() {
  console.log("\n[2/5] 🔍 BrowserScan Fingerprint...");
  const browser = await launchBrowser();
  const page = await browser.newPage();

  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36");
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

  const result = { platform: "BrowserScan Fingerprint", url: "https://www.browserscan.net" };

  try {
    await page.goto(result.url, { waitUntil: "networkidle2", timeout: 30000 });
    await sleep(6000);

    await page.screenshot({ path: join(OUT_DIR, "02-browserscan-fp.png"), fullPage: true });

    const data = await page.evaluate(() => {
      const body = document.body.innerText || "";
      const checks = {};

      document.querySelectorAll("table tr").forEach(row => {
        const cells = row.querySelectorAll("td");
        if (cells.length >= 2) {
          const label = cells[0]?.innerText?.trim();
          const value = cells[1]?.innerText?.trim();
          if (label && value && label.length < 80) checks[label] = value;
        }
      });

      // Pegar listas de propriedades
      document.querySelectorAll(".item, .property, [class*='info']").forEach(el => {
        const label = el.querySelector(".label, .key, strong")?.innerText?.trim();
        const value = el.querySelector(".value, .val, span:last-child")?.innerText?.trim();
        if (label && value) checks[label] = value;
      });

      return {
        checks,
        bodySnippet: body.substring(0, 3000),
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        languages: navigator.languages,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        timezoneOffset: new Date().getTimezoneOffset(),
        screenWidth: screen.width,
        screenHeight: screen.height,
        colorDepth: screen.colorDepth,
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: navigator.deviceMemory,
        webdriver: navigator.webdriver,
        plugins: navigator.plugins.length,
      };
    });

    result.data = data;
    result.status = "ok";
    console.log(`   ✅ UA: ${data.userAgent?.substring(0, 60)}...`);
    console.log(`   ✅ Platform: ${data.platform}, WebDriver: ${data.webdriver}, Plugins: ${data.plugins}`);
    console.log(`   ✅ Screen: ${data.screenWidth}x${data.screenHeight}, TZ: ${data.timezone} (offset: ${data.timezoneOffset})`);
  } catch (err) {
    result.status = "error";
    result.error = err.message;
    console.log(`   ❌ Erro: ${err.message}`);
  }

  await browser.close();
  return result;
}

// ============================================================
// TEST 3: Fingerprint.com Demo
// ============================================================
async function testFingerprintDemo() {
  console.log("\n[3/5] 🔍 Fingerprint.com/demo...");
  const browser = await launchBrowser();
  const page = await browser.newPage();

  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36");
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

  const result = { platform: "Fingerprint.com Demo", url: "https://fingerprint.com/demo" };

  try {
    await page.goto(result.url, { waitUntil: "networkidle2", timeout: 30000 });
    await sleep(8000); // FP Pro precisa de mais tempo para processar

    await page.screenshot({ path: join(OUT_DIR, "03-fingerprintjs-demo.png"), fullPage: true });

    const data = await page.evaluate(() => {
      const body = document.body.innerText || "";
      const checks = {};

      // Fingerprint.com mostra visitorId e dados
      const allText = body;

      // Procurar por visitorId
      const visitorIdMatch = allText.match(/visitor[_\s]?id[:\s]+([a-zA-Z0-9]+)/i);
      if (visitorIdMatch) checks.visitorId = visitorIdMatch[1];

      // Procurar por bot/incognito signals
      const incognitoMatch = allText.match(/incognito[:\s]+(true|false)/i);
      if (incognitoMatch) checks.incognito = incognitoMatch[1];

      const botMatch = allText.match(/bot[:\s]+(true|false)/i);
      if (botMatch) checks.bot = botMatch[1];

      const vpnMatch = allText.match(/vpn[:\s]+(true|false)/i);
      if (vpnMatch) checks.vpn = vpnMatch[1];

      // Pegar dados de tabelas/listas
      document.querySelectorAll("[class*='signal'], [class*='result'], [class*='data']").forEach(el => {
        const label = el.querySelector("[class*='label'], [class*='key'], strong")?.innerText?.trim();
        const value = el.querySelector("[class*='value'], span:last-child")?.innerText?.trim();
        if (label && value && label.length < 60) checks[label] = value;
      });

      return {
        checks,
        bodySnippet: body.substring(0, 3000),
        hasBotSignal: body.toLowerCase().includes("bot"),
        hasIncognito: body.toLowerCase().includes("incognito"),
        hasVPN: body.toLowerCase().includes("vpn"),
        hasVisitorId: body.toLowerCase().includes("visitor"),
        webdriver: navigator.webdriver,
      };
    });

    result.data = data;
    result.status = "ok";
    console.log(`   ✅ Capturado. Bot: ${data.hasBotSignal}, Incognito: ${data.hasIncognito}, VPN: ${data.hasVPN}`);
    console.log(`   ✅ WebDriver: ${data.webdriver}`);
  } catch (err) {
    result.status = "error";
    result.error = err.message;
    console.log(`   ❌ Erro: ${err.message}`);
  }

  await browser.close();
  return result;
}

// ============================================================
// TEST 4: CreepJS
// ============================================================
async function testCreepJS() {
  console.log("\n[4/5] 🔍 CreepJS (abrahamjuliot.github.io)...");
  const browser = await launchBrowser();
  const page = await browser.newPage();

  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36");
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

  const result = { platform: "CreepJS", url: "https://abrahamjuliot.github.io/creepjs/" };

  try {
    await page.goto(result.url, { waitUntil: "networkidle2", timeout: 30000 });
    await sleep(10000); // CreepJS precisa de tempo para rodar todos os testes

    await page.screenshot({ path: join(OUT_DIR, "04-creepjs.png"), fullPage: true });

    const data = await page.evaluate(() => {
      const body = document.body.innerText || "";

      // CreepJS mostra trust score e fingerprint hash
      const trustMatch = body.match(/trust\s*score[:\s]+([0-9.]+%?)/i);
      const hashMatch = body.match(/fingerprint[:\s]+([a-f0-9]{8,})/i);
      const liesMatch = body.match(/lies[:\s]+(\d+)/i);
      const botMatch = body.match(/bot[:\s]+(true|false|yes|no)/i);

      // Pegar todos os "lies" detectados
      const lies = [];
      document.querySelectorAll("[class*='lie'], [class*='fail'], [class*='red']").forEach(el => {
        const text = el.innerText?.trim();
        if (text && text.length < 100) lies.push(text);
      });

      // Pegar scores
      const scores = {};
      document.querySelectorAll("[class*='score'], [class*='grade'], [class*='trust']").forEach(el => {
        const text = el.innerText?.trim();
        if (text && text.length < 50) scores[el.className] = text;
      });

      return {
        trustScore: trustMatch?.[1] || "não encontrado",
        fingerprintHash: hashMatch?.[1] || "não encontrado",
        liesCount: liesMatch?.[1] || "não encontrado",
        botDetected: botMatch?.[1] || "não encontrado",
        lies: [...new Set(lies)].slice(0, 20),
        scores,
        bodySnippet: body.substring(0, 3000),
        hasLies: body.toLowerCase().includes("lie") || body.toLowerCase().includes("lies"),
        hasBot: body.toLowerCase().includes("bot"),
        webdriver: navigator.webdriver,
      };
    });

    result.data = data;
    result.status = "ok";
    console.log(`   ✅ Trust Score: ${data.trustScore}`);
    console.log(`   ✅ Lies: ${data.liesCount}, Bot: ${data.botDetected}, WebDriver: ${data.webdriver}`);
  } catch (err) {
    result.status = "error";
    result.error = err.message;
    console.log(`   ❌ Erro: ${err.message}`);
  }

  await browser.close();
  return result;
}

// ============================================================
// TEST 5: PixelScan
// ============================================================
async function testPixelScan() {
  console.log("\n[5/5] 🔍 PixelScan.net...");
  const browser = await launchBrowser();
  const page = await browser.newPage();

  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36");
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

  const result = { platform: "PixelScan", url: "https://pixelscan.net" };

  try {
    await page.goto(result.url, { waitUntil: "networkidle2", timeout: 30000 });
    await sleep(8000);

    await page.screenshot({ path: join(OUT_DIR, "05-pixelscan.png"), fullPage: true });

    const data = await page.evaluate(() => {
      const body = document.body.innerText || "";

      const checks = {};
      document.querySelectorAll("tr").forEach(row => {
        const cells = row.querySelectorAll("td");
        if (cells.length >= 2) {
          const label = cells[0]?.innerText?.trim();
          const value = cells[cells.length - 1]?.innerText?.trim();
          if (label && value && label.length < 80) checks[label] = value;
        }
      });

      // Pegar resultado geral
      const consistentMatch = body.match(/consistent[:\s]+(true|false|yes|no)/i);
      const suspiciousMatch = body.match(/suspicious[:\s]+(true|false|yes|no)/i);

      return {
        checks,
        consistent: consistentMatch?.[1] || "não encontrado",
        suspicious: suspiciousMatch?.[1] || "não encontrado",
        bodySnippet: body.substring(0, 2000),
        hasConsistent: body.toLowerCase().includes("consistent"),
        hasSuspicious: body.toLowerCase().includes("suspicious"),
        hasBot: body.toLowerCase().includes("bot"),
        webdriver: navigator.webdriver,
      };
    });

    result.data = data;
    result.status = "ok";
    console.log(`   ✅ Consistent: ${data.consistent}, Suspicious: ${data.suspicious}, Bot: ${data.hasBot}`);
  } catch (err) {
    result.status = "error";
    result.error = err.message;
    console.log(`   ❌ Erro: ${err.message}`);
  }

  await browser.close();
  return result;
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log("=== GHOST PANEL — TESTES DE FINGERPRINT NAS PLATAFORMAS ===");
  console.log(`Resultados serão salvos em: ${OUT_DIR}\n`);

  const results = [];

  results.push(await testBrowserScan());
  results.push(await testBrowserScanFingerprint());
  results.push(await testFingerprintDemo());
  results.push(await testCreepJS());
  results.push(await testPixelScan());

  // Salvar resultados completos
  const outputFile = join(OUT_DIR, "all-results.json");
  writeFileSync(outputFile, JSON.stringify(results, null, 2));
  console.log(`\n✅ Todos os testes concluídos! Resultados: ${outputFile}`);

  // Resumo
  console.log("\n=== RESUMO ===");
  results.forEach(r => {
    const status = r.status === "ok" ? "✅" : "❌";
    console.log(`${status} ${r.platform}: ${r.status === "error" ? r.error : "OK"}`);
  });
}

main().catch(console.error);
