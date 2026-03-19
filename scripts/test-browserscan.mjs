/**
 * Teste de fingerprint no BrowserScan.net
 * Usa puppeteer-extra com stealth plugin (mesmo setup do fpjs.ts)
 * Coleta resultados de detecção de bot/automação
 */

import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { writeFileSync } from "fs";

puppeteer.use(StealthPlugin());

const RESULTS_FILE = "/home/ubuntu/ghostpanel/ghostpanel-master/scripts/browserscan-results.json";
const SCREENSHOT_FILE = "/home/ubuntu/ghostpanel/ghostpanel-master/scripts/browserscan-screenshot.png";

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function testBrowserScan() {
  console.log("[BrowserScan] Iniciando teste...");

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--window-size=1920,1080",
      "--lang=en-US",
    ],
    defaultViewport: { width: 1920, height: 989 },
  });

  const page = await browser.newPage();

  // Configurar User-Agent e locale
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
  );
  await page.setExtraHTTPHeaders({
    "Accept-Language": "en-US,en;q=0.9",
  });

  // Interceptar console do browser
  const consoleLogs = [];
  page.on("console", msg => consoleLogs.push(msg.text()));

  try {
    console.log("[BrowserScan] Navegando para browserscan.net...");
    await page.goto("https://www.browserscan.net/bot-detection", {
      waitUntil: "networkidle2",
      timeout: 30000,
    });

    // Aguardar os testes carregarem
    await sleep(5000);

    // Tirar screenshot
    await page.screenshot({ path: SCREENSHOT_FILE, fullPage: true });
    console.log(`[BrowserScan] Screenshot salvo: ${SCREENSHOT_FILE}`);

    // Coletar resultados da página
    const results = await page.evaluate(() => {
      const data = {};

      // Tentar coletar todos os resultados visíveis
      const rows = document.querySelectorAll("tr, .result-row, .test-item, [class*='result'], [class*='test']");
      const texts = [];
      rows.forEach(row => {
        const text = row.innerText?.trim();
        if (text && text.length > 2 && text.length < 200) texts.push(text);
      });
      data.rows = texts.slice(0, 50);

      // Tentar pegar o resultado principal (bot/human)
      const botIndicators = document.querySelectorAll("[class*='bot'], [class*='human'], [class*='detect'], [id*='bot'], [id*='result']");
      const indicators = [];
      botIndicators.forEach(el => {
        indicators.push({ class: el.className, text: el.innerText?.trim()?.substring(0, 100) });
      });
      data.indicators = indicators;

      // Pegar todo o texto da página
      data.bodyText = document.body.innerText?.substring(0, 3000);

      // Tentar pegar dados estruturados
      const allText = document.body.innerText || "";
      data.hasBot = allText.toLowerCase().includes("bot");
      data.hasHuman = allText.toLowerCase().includes("human");
      data.hasAutomation = allText.toLowerCase().includes("automation") || allText.toLowerCase().includes("automated");
      data.hasHeadless = allText.toLowerCase().includes("headless");
      data.hasWebdriver = allText.toLowerCase().includes("webdriver");
      data.hasPuppeteer = allText.toLowerCase().includes("puppeteer");
      data.hasChrome = allText.toLowerCase().includes("chrome");

      // Pegar título
      data.title = document.title;
      data.url = window.location.href;

      return data;
    });

    results.consoleLogs = consoleLogs;

    console.log("[BrowserScan] Resultados coletados:");
    console.log(`  URL: ${results.url}`);
    console.log(`  Title: ${results.title}`);
    console.log(`  hasBot: ${results.hasBot}`);
    console.log(`  hasHuman: ${results.hasHuman}`);
    console.log(`  hasAutomation: ${results.hasAutomation}`);
    console.log(`  hasHeadless: ${results.hasHeadless}`);
    console.log(`  hasWebdriver: ${results.hasWebdriver}`);
    console.log(`  hasPuppeteer: ${results.hasPuppeteer}`);

    writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
    console.log(`[BrowserScan] Resultados salvos: ${RESULTS_FILE}`);

    return results;
  } catch (err) {
    console.error("[BrowserScan] Erro:", err.message);
    return { error: err.message };
  } finally {
    await browser.close();
  }
}

testBrowserScan().then(r => {
  if (r.error) {
    console.error("FALHOU:", r.error);
    process.exit(1);
  }
  console.log("\n[BrowserScan] Teste concluído!");
});
