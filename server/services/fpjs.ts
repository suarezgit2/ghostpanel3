/**
 * FingerprintJS Pro Service
 * Generates valid FPJS requestIds by running the real FPJS Pro SDK
 * in a stealth Puppeteer browser instance.
 *
 * The requestId is required in the x-client-dcr header for RegisterByEmail
 * and CheckInvitationCode endpoints. Without a valid requestId, accounts
 * get flagged and suspended by manus.im's anti-fraud system.
 *
 * Architecture:
 * - Maintains a pool of pre-generated requestIds for fast access
 * - Uses puppeteer-extra with stealth plugin to avoid headless detection
 * - Each requestId is generated from a fresh page load on manus.im
 * - Gracefully degrades: if Chromium is not available, returns "" (fallback to synthetic)
 *
 * Docker/Railway compatibility:
 * - Tries multiple Chromium paths (Debian, Ubuntu, Alpine, etc.)
 * - Uses PUPPETEER_EXECUTABLE_PATH env var if set
 * - Falls back gracefully if no browser found
 */

import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, Page } from "puppeteer-core";
import { execSync } from "child_process";
import { logger } from "../utils/helpers";

puppeteer.use(StealthPlugin());

const FPJS_CONFIG = {
  apiKey: "nG226lNwQWNTTWzOzKbF",
  endpoint: "https://metrics.manus.im",
  scriptUrl: "https://files.manuscdn.com/assets/js/fpm_loader_v3.11.8.js",
  pageUrl: "https://manus.im/login",
  timeout: 30000,
  poolSize: 5,          // Pre-generate this many requestIds
  poolRefillAt: 2,      // Refill when pool drops to this level
};

/**
 * Find the Chromium/Chrome executable path.
 * Tries multiple locations in order of preference.
 * Returns null if no browser found.
 */
function findChromiumPath(): string | null {
  // 1. Environment variable override (highest priority)
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  // 2. Common paths on various Linux distros
  const candidates = [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/local/bin/chromium",
    "/snap/bin/chromium",
    "/opt/google/chrome/chrome",
    "/usr/bin/chromium-browser",
  ];

  for (const candidate of candidates) {
    try {
      execSync(`test -f "${candidate}"`, { stdio: "ignore" });
      return candidate;
    } catch {
      // Not found, try next
    }
  }

  // 3. Try `which` command
  try {
    const result = execSync("which chromium-browser || which chromium || which google-chrome 2>/dev/null", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (result) return result;
  } catch {
    // Not found
  }

  return null;
}

class FpjsService {
  private browser: Browser | null = null;
  private requestIdPool: string[] = [];
  private isRefilling = false;
  private initialized = false;
  private browserPath: string | null = null;
  private unavailable = false; // Set to true if Chromium not found

  /**
   * Initialize the browser instance
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    this.browserPath = findChromiumPath();

    if (!this.browserPath) {
      await logger.warn("fpjs", "Chromium não encontrado no sistema. FPJS Pro desativado — usando IDs sintéticos como fallback. Para ativar, instale chromium-browser ou defina PUPPETEER_EXECUTABLE_PATH.");
      this.unavailable = true;
      this.initialized = true;
      return;
    }

    await logger.info("fpjs", `Chromium encontrado em: ${this.browserPath}`);

    try {
      this.browser = await (puppeteer as any).launch({
        executablePath: this.browserPath,
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--disable-software-rasterizer",
          "--window-size=1920,1080",
          "--disable-blink-features=AutomationControlled",
          "--disable-extensions",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-background-timer-throttling",
          "--disable-backgrounding-occluded-windows",
          "--disable-renderer-backgrounding",
        ],
      });
      this.initialized = true;
      await logger.info("fpjs", "Browser FPJS inicializado com sucesso");

      // Pre-fill the pool in background (don't await — non-blocking)
      this.refillPool().catch((err) => {
        logger.warn("fpjs", `Erro ao pré-carregar pool FPJS: ${err}`).catch(() => {});
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logger.error("fpjs", `Falha ao inicializar browser FPJS: ${msg}. Usando IDs sintéticos como fallback.`);
      this.unavailable = true;
      this.initialized = true;
    }
  }

  /**
   * Generate a single FPJS requestId from a fresh page
   */
  private async generateRequestId(): Promise<string> {
    if (!this.browser) {
      throw new Error("Browser FPJS não disponível");
    }

    let page: Page | null = null;
    try {
      page = await this.browser.newPage();
      await page.setViewport({ width: 1920, height: 1080 });

      // Set a realistic User-Agent
      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
      );

      // Navigate to manus.im login page
      await page.goto(FPJS_CONFIG.pageUrl, {
        waitUntil: "networkidle2",
        timeout: FPJS_CONFIG.timeout,
      });

      // Wait a moment for FPJS to initialize
      await new Promise((r) => setTimeout(r, 2000));

      // Inject the FPJS loader script and call it to get a requestId
      const requestId = await page.evaluate(
        async (config: { apiKey: string; endpoint: string; scriptUrl: string }) => {
          return new Promise<string>((resolve) => {
            // Timeout fallback
            const timer = setTimeout(() => resolve(""), 15000);

            const script = document.createElement("script");
            script.src = config.scriptUrl;
            script.onload = async () => {
              try {
                const FP = (window as any).__fpjs_p_l_b;
                if (!FP) {
                  clearTimeout(timer);
                  resolve("");
                  return;
                }

                const loadFn = FP.load || FP.Ay?.load || FP.default?.load;
                if (!loadFn) {
                  clearTimeout(timer);
                  resolve("");
                  return;
                }

                const agent = await loadFn({
                  apiKey: config.apiKey,
                  endpoint: [config.endpoint],
                  scriptUrlPattern: config.scriptUrl,
                });

                const result = await agent.get();
                clearTimeout(timer);
                resolve(result.requestId || "");
              } catch {
                clearTimeout(timer);
                resolve("");
              }
            };
            script.onerror = () => {
              clearTimeout(timer);
              resolve("");
            };
            document.head.appendChild(script);
          });
        },
        { apiKey: FPJS_CONFIG.apiKey, endpoint: FPJS_CONFIG.endpoint, scriptUrl: FPJS_CONFIG.scriptUrl }
      );

      return requestId;
    } finally {
      if (page) {
        try {
          await page.close();
        } catch {
          // Ignore close errors
        }
      }
    }
  }

  /**
   * Refill the requestId pool in the background
   */
  private async refillPool(): Promise<void> {
    if (this.isRefilling || this.unavailable || !this.browser) return;
    this.isRefilling = true;

    try {
      const needed = FPJS_CONFIG.poolSize - this.requestIdPool.length;
      if (needed <= 0) return;

      await logger.info("fpjs", `Gerando ${needed} requestIds para o pool...`);

      for (let i = 0; i < needed; i++) {
        try {
          const requestId = await this.generateRequestId();
          if (requestId) {
            this.requestIdPool.push(requestId);
            await logger.info("fpjs", `RequestId gerado: ${requestId} (pool: ${this.requestIdPool.length}/${FPJS_CONFIG.poolSize})`);
          } else {
            await logger.warn("fpjs", `Falha ao gerar requestId ${i + 1}/${needed} (retornou vazio)`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await logger.warn("fpjs", `Erro ao gerar requestId: ${msg}`);
        }
      }

      await logger.info("fpjs", `Pool FPJS: ${this.requestIdPool.length} requestIds disponíveis`);
    } finally {
      this.isRefilling = false;
    }
  }

  /**
   * Get a requestId from the pool (or generate one on demand).
   * Returns "" if FPJS service is unavailable (caller uses synthetic fallback).
   */
  async getRequestId(jobId?: number): Promise<string> {
    // If service is unavailable (no Chromium), return "" immediately
    if (this.unavailable) return "";

    // Initialize lazily if not done yet
    if (!this.initialized) {
      await this.init();
      if (this.unavailable) return "";
    }

    // Try to get from pool first
    if (this.requestIdPool.length > 0) {
      const requestId = this.requestIdPool.shift()!;
      await logger.info("fpjs", `RequestId do pool: ${requestId} (restam: ${this.requestIdPool.length})`, {}, jobId);

      // Trigger background refill if pool is low
      if (this.requestIdPool.length <= FPJS_CONFIG.poolRefillAt) {
        this.refillPool().catch(() => {});
      }

      return requestId;
    }

    // Pool empty — generate on demand
    if (!this.browser) {
      await logger.warn("fpjs", "Browser não disponível, retornando vazio", {}, jobId);
      return "";
    }

    await logger.warn("fpjs", "Pool vazio, gerando requestId sob demanda...", {}, jobId);
    try {
      const requestId = await this.generateRequestId();

      if (!requestId) {
        await logger.warn("fpjs", "Falha ao gerar requestId sob demanda (retornou vazio)", {}, jobId);
        return "";
      }

      await logger.info("fpjs", `RequestId gerado sob demanda: ${requestId}`, {}, jobId);

      // Trigger background refill
      this.refillPool().catch(() => {});

      return requestId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logger.error("fpjs", `Falha ao gerar requestId sob demanda: ${msg}`, {}, jobId);
      return "";
    }
  }

  /**
   * Get the current pool size
   */
  getPoolSize(): number {
    return this.requestIdPool.length;
  }

  /**
   * Check if FPJS service is available (Chromium found)
   */
  isAvailable(): boolean {
    return !this.unavailable && this.initialized;
  }

  /**
   * Cleanup browser resources
   */
  async destroy(): Promise<void> {
    if (this.browser) {
      try {
        await this.browser.close();
      } catch {
        // Ignore
      }
      this.browser = null;
      this.initialized = false;
    }
  }
}

export const fpjsService = new FpjsService();
