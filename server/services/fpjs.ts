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
 */

import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, Page } from "puppeteer-core";
import { logger } from "../utils/helpers";

puppeteer.use(StealthPlugin());

const FPJS_CONFIG = {
  apiKey: "nG226lNwQWNTTWzOzKbF",
  endpoint: "https://metrics.manus.im",
  scriptUrl: "https://files.manuscdn.com/assets/js/fpm_loader_v3.11.8.js",
  pageUrl: "https://manus.im/login",
  timeout: 20000,
  poolSize: 5,          // Pre-generate this many requestIds
  poolRefillAt: 2,      // Refill when pool drops to this level
  browserPath: "/usr/bin/chromium-browser",
};

class FpjsService {
  private browser: Browser | null = null;
  private requestIdPool: string[] = [];
  private isRefilling = false;
  private initialized = false;

  /**
   * Initialize the browser instance
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    try {
      this.browser = await (puppeteer as any).launch({
        executablePath: FPJS_CONFIG.browserPath,
        headless: "new",
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--window-size=1920,1080",
          "--disable-blink-features=AutomationControlled",
        ],
      });
      this.initialized = true;
      await logger.info("fpjs", "Browser FPJS inicializado com sucesso");

      // Pre-fill the pool
      await this.refillPool();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logger.error("fpjs", `Falha ao inicializar browser FPJS: ${msg}`);
    }
  }

  /**
   * Generate a single FPJS requestId from a fresh page
   */
  private async generateRequestId(): Promise<string> {
    if (!this.browser) {
      await this.init();
    }
    if (!this.browser) {
      throw new Error("Browser FPJS não disponível");
    }

    let page: Page | null = null;
    try {
      page = await this.browser.newPage();
      await page.setViewport({ width: 1920, height: 1080 });

      // Navigate to manus.im login page
      await page.goto(FPJS_CONFIG.pageUrl, {
        waitUntil: "networkidle2",
        timeout: FPJS_CONFIG.timeout,
      });

      // Wait a moment for FPJS to initialize
      await new Promise((r) => setTimeout(r, 2000));

      // Inject the FPJS loader script and call it to get a requestId
      const requestId = await page.evaluate(
        async (config: typeof FPJS_CONFIG) => {
          return new Promise<string>((resolve) => {
            // Timeout fallback
            const timer = setTimeout(() => resolve(""), 15000);

            const script = document.createElement("script");
            script.src = config.scriptUrl;
            script.onload = async () => {
              try {
                const FP = (window as any).__fpjs_p_l_b;
                if (!FP) {
                  resolve("");
                  return;
                }

                const loadFn = FP.load || FP.Ay?.load || FP.default?.load;
                if (!loadFn) {
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
        FPJS_CONFIG
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
    if (this.isRefilling) return;
    this.isRefilling = true;

    try {
      const needed = FPJS_CONFIG.poolSize - this.requestIdPool.length;
      await logger.info("fpjs", `Gerando ${needed} requestIds para o pool...`);

      for (let i = 0; i < needed; i++) {
        try {
          const requestId = await this.generateRequestId();
          if (requestId) {
            this.requestIdPool.push(requestId);
            await logger.info("fpjs", `RequestId gerado: ${requestId} (pool: ${this.requestIdPool.length}/${FPJS_CONFIG.poolSize})`);
          } else {
            await logger.warn("fpjs", `Falha ao gerar requestId ${i + 1}/${needed}`);
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
   * Get a requestId from the pool (or generate one on demand)
   */
  async getRequestId(jobId?: number): Promise<string> {
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
    await logger.warn("fpjs", "Pool vazio, gerando requestId sob demanda...", {}, jobId);
    const requestId = await this.generateRequestId();

    if (!requestId) {
      await logger.error("fpjs", "Falha ao gerar requestId sob demanda!", {}, jobId);
      return "";
    }

    // Trigger background refill
    this.refillPool().catch(() => {});

    return requestId;
  }

  /**
   * Get the current pool size
   */
  getPoolSize(): number {
    return this.requestIdPool.length;
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
