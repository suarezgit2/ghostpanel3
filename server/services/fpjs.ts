/**
 * FingerprintJS Pro Service — On-Demand Generation
 *
 * Generates a REAL FPJS Pro requestId for each account creation by running
 * the actual FPJS Pro SDK inside a stealth Puppeteer browser.
 *
 * Architecture (v2 — no pool):
 * - NO pre-generated pool. Every call to getRequestId() opens a fresh browser
 *   page, loads manus.im/login, runs the FPJS SDK, and returns a brand-new ID.
 * - This eliminates the requestId expiry problem entirely (IDs expire in ~2-5min).
 * - Concurrent calls are serialized via a queue to avoid launching too many
 *   Chromium pages simultaneously (memory safety for Railway).
 * - Graceful degradation: if Chromium is not available, returns "" and the
 *   orchestrator falls back to a synthetic ID.
 *
 * Performance:
 * - Each requestId takes ~5-10s to generate (page load + SDK execution).
 * - With 20 concurrent jobs, they queue up and each gets a fresh ID in order.
 * - The browser instance is kept alive (singleton) to avoid cold-start overhead.
 *
 * Docker/Railway compatibility:
 * - Uses PUPPETEER_EXECUTABLE_PATH env var if set (set in Dockerfile).
 * - Falls back to common Chromium paths on Debian/Ubuntu.
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
  // Max concurrent page generations to avoid OOM on Railway
  maxConcurrent: 3,
};

/**
 * Find the Chromium/Chrome executable path.
 * Tries multiple locations in order of preference.
 * Returns null if no browser found.
 */
function findChromiumPath(): string | null {
  // 1. Environment variable override (highest priority — set in Dockerfile)
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
    const result = execSync(
      "which chromium-browser || which chromium || which google-chrome 2>/dev/null",
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
    if (result) return result;
  } catch {
    // Not found
  }

  return null;
}

class FpjsService {
  private browser: Browser | null = null;
  private browserPath: string | null = null;
  private unavailable = false;
  private initialized = false;
  private isReconnecting = false;

  // Concurrency control: queue of pending generation callbacks
  private activeCount = 0;
  private queue: Array<() => void> = [];

  /**
   * Initialize the browser singleton.
   * Called lazily on first getRequestId() call.
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    this.browserPath = findChromiumPath();

    if (!this.browserPath) {
      await logger.error(
        "fpjs",
        "CRÍTICO: Chromium não encontrado. FPJS Pro não pode gerar IDs reais. " +
        "Para ativar, defina PUPPETEER_EXECUTABLE_PATH ou instale chromium."
      );
      this.unavailable = true;
      this.initialized = true;
      throw new Error("Chromium não encontrado. IDs reais são obrigatórios.");
    }

    await logger.info("fpjs", `Chromium encontrado em: ${this.browserPath}`);
    await this.launchBrowser();
    
    // Inicia health check periódico para detectar crashes do browser
    setInterval(() => this.healthCheck(), 60000);
  }

  private async launchBrowser(): Promise<void> {
    if (this.isReconnecting) return;
    this.isReconnecting = true;

    try {
      if (this.browser) {
        try { await this.browser.close(); } catch (e) {}
      }

      this.browser = await (puppeteer as any).launch({
        executablePath: this.browserPath!,
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
          "--js-flags=--max-old-space-size=512", // Limita uso de memória do V8
        ],
      });

      // Monitora desconexões inesperadas (crash)
      this.browser!.on('disconnected', () => {
        logger.warn("fpjs", "Browser FPJS desconectado inesperadamente. Será recriado no próximo uso.");
        this.browser = null;
      });

      this.initialized = true;
      this.isReconnecting = false;
      await logger.info("fpjs", "Browser FPJS inicializado com sucesso");
    } catch (err) {
      this.isReconnecting = false;
      const msg = err instanceof Error ? err.message : String(err);
      await logger.error("fpjs", `Falha ao inicializar browser FPJS: ${msg}`);
      
      if (!this.initialized) {
        this.unavailable = true;
        this.initialized = true;
        throw new Error(`Falha ao inicializar browser FPJS: ${msg}`);
      }
    }
  }

  private async healthCheck(): Promise<void> {
    if (!this.initialized || this.unavailable || this.isReconnecting) return;
    
    try {
      if (!this.browser || !this.browser.isConnected()) {
        await logger.warn("fpjs", "Health check falhou: browser não conectado. Recriando...");
        await this.launchBrowser();
        return;
      }
      
      // Tenta pegar a versão para confirmar que o processo do browser está vivo
      await this.browser.version();
    } catch (err) {
      await logger.warn("fpjs", `Health check falhou: ${err}. Recriando browser...`);
      await this.launchBrowser();
    }
  }

  /**
   * Acquire a concurrency slot. Waits if maxConcurrent is reached.
   */
  private acquireSlot(): Promise<void> {
    if (this.activeCount < FPJS_CONFIG.maxConcurrent) {
      this.activeCount++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.activeCount++;
        resolve();
      });
    });
  }

  /**
   * Release a concurrency slot and unblock the next queued request.
   */
  private releaseSlot(): void {
    this.activeCount--;
    const next = this.queue.shift();
    if (next) next();
  }

  /**
   * Generate a single fresh FPJS requestId from a new browser page.
   * This is the core operation — opens manus.im/login, runs the FPJS SDK,
   * captures the requestId, and closes the page.
   */
  private async generateFresh(jobId?: number): Promise<string> {
    // Garante que o browser está vivo antes de tentar usar
    if (!this.browser || !this.browser.isConnected()) {
      await logger.warn("fpjs", "Browser não disponível ou desconectado. Tentando recriar...", {}, jobId);
      await this.launchBrowser();
      if (!this.browser) throw new Error("Falha ao recriar browser FPJS");
    }

    await this.acquireSlot();
    let page: Page | null = null;

    try {
      page = await this.browser.newPage();
      
      // Otimização: intercepta e bloqueia recursos desnecessários para economizar memória e CPU
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const resourceType = req.resourceType();
        if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
          req.abort();
        } else {
          req.continue();
        }
      });

      await page.setViewport({ width: 1920, height: 1080 });
      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
      );

      await page.goto(FPJS_CONFIG.pageUrl, {
        waitUntil: "domcontentloaded", // Mais rápido que networkidle2 e suficiente para injetar script
        timeout: FPJS_CONFIG.timeout,
      });

      // Brief pause for FPJS to initialize on the page
      await new Promise((r) => setTimeout(r, 1500));

      const requestId = await page.evaluate(
        async (config: { apiKey: string; endpoint: string; scriptUrl: string }) => {
          return new Promise<string>((resolve) => {
            const timer = setTimeout(() => resolve(""), 15000);

            const script = document.createElement("script");
            script.src = config.scriptUrl;
            script.onload = async () => {
              try {
                const FP = (window as any).__fpjs_p_l_b;
                if (!FP) { clearTimeout(timer); resolve(""); return; }

                const loadFn = FP.load || FP.Ay?.load || FP.default?.load;
                if (!loadFn) { clearTimeout(timer); resolve(""); return; }

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
            script.onerror = () => { clearTimeout(timer); resolve(""); };
            document.head.appendChild(script);
          });
        },
        { apiKey: FPJS_CONFIG.apiKey, endpoint: FPJS_CONFIG.endpoint, scriptUrl: FPJS_CONFIG.scriptUrl }
      );

      if (requestId) {
        await logger.info("fpjs", `RequestId gerado: ${requestId}`, {}, jobId);
        return requestId;
      } else {
        await logger.error("fpjs", "FPJS SDK retornou vazio", {}, jobId);
        throw new Error("FPJS SDK retornou vazio");
      }
    } finally {
      if (page) {
        try { await page.close(); } catch { /* ignore */ }
      }
      this.releaseSlot();
    }
  }

  /**
   * Get a fresh, valid FPJS requestId for this account creation.
   *
   * - Always generates a new ID (never reuses old ones).
   * - Concurrent calls are serialized up to maxConcurrent=3 at a time.
   * - Resilient: Retries infinitely with backoff until a real ID is generated.
   * - Throws error ONLY if Chromium is completely missing from the system.
   */
  async getRequestId(jobId?: number): Promise<string> {
    let attempt = 1;
    const maxBackoff = 30000; // Max 30s between retries

    while (true) {
      // Lazy init
      if (!this.initialized) {
        await this.init();
      }

      if (this.unavailable) {
        throw new Error("CRÍTICO: Chromium não encontrado no sistema. Instale o Chromium para gerar IDs reais.");
      }

      if (!this.browser) {
        await logger.warn("fpjs", "Browser não inicializado, tentando novamente em 5s...", {}, jobId);
        await new Promise(r => setTimeout(r, 5000));
        this.initialized = false;
        continue;
      }

      try {
        const id = await this.generateFresh(jobId);
        if (id) return id;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await logger.warn("fpjs", `Falha ao gerar requestId (tentativa ${attempt}): ${msg}`, {}, jobId);

        // If browser crashed or is unresponsive, force restart
        if (msg.includes("Target closed") || msg.includes("Session closed") || msg.includes("Protocol error") || msg.includes("timeout")) {
          await logger.warn("fpjs", "Browser FPJS instável — forçando reinicialização...", {}, jobId);
          try {
            if (this.browser) await this.browser.close().catch(() => {});
          } catch (e) { /* ignore */ }
          this.browser = null;
          this.initialized = false;
        }
      }

      // Exponential backoff with jitter
      const backoff = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 1000, maxBackoff);
      await logger.info("fpjs", `Aguardando ${Math.round(backoff/1000)}s antes de tentar novamente...`, {}, jobId);
      await new Promise(r => setTimeout(r, backoff));
      attempt++;
    }
  }

  /**
   * Returns 0 — no pool in on-demand mode.
   * Kept for UI compatibility.
   */
  getPoolSize(): number {
    return 0;
  }

  /**
   * Check if FPJS service is available (Chromium found and browser running).
   */
  isAvailable(): boolean {
    return !this.unavailable && this.initialized && this.browser !== null;
  }

  /**
   * Cleanup browser resources.
   */
  async destroy(): Promise<void> {
    if (this.browser) {
      try { await this.browser.close(); } catch { /* ignore */ }
      this.browser = null;
      this.initialized = false;
    }
  }
}

export const fpjsService = new FpjsService();
