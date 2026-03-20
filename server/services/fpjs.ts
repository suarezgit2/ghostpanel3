/**
 * FingerprintJS Pro Service — On-Demand Generation (v5.5 — Proxy-Routed)
 *
 * Generates a REAL FPJS Pro requestId for each account creation by running
 * the actual FPJS Pro SDK inside a stealth Puppeteer browser.
 *
 * Architecture (v5.5 — proxy-routed):
 * - Each call to getRequestId() opens a fresh browser page routed through
 *   the SAME proxy used for RPC calls, ensuring IP consistency.
 * - Cookies are cleared between calls to prevent cross-account correlation
 *   via FPJS tracking cookies (_iidt, _vid_t).
 * - Concurrent calls are serialized via a queue to avoid launching too many
 *   Chromium pages simultaneously (memory safety for Railway).
 * - Graceful degradation: if Chromium is not available, throws error
 *   (real IDs are mandatory).
 *
 * Key changes from v5.4:
 * - Browser is launched WITH proxy (--proxy-server flag)
 * - page.authenticate() is called for proxy auth
 * - Cookies are cleared after each ID generation
 * - Browser is re-launched when proxy changes (different job = different proxy)
 *
 * Performance:
 * - Each requestId takes ~5-10s to generate (page load + SDK execution).
 * - The browser instance is kept alive (singleton) per proxy to avoid cold-start.
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
import type { ProxyInfo } from "./proxy";

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

/**
 * Build the proxy URL string for Puppeteer's --proxy-server flag.
 * Format: protocol://host:port (without auth — auth is handled by page.authenticate)
 */
function buildProxyServerArg(proxy: ProxyInfo): string {
  const protocol = proxy.protocol === "socks5" ? "socks5" : "http";
  return `${protocol}://${proxy.host}:${proxy.port}`;
}

/**
 * Build a unique key for a proxy to detect when we need to re-launch the browser.
 */
function proxyKey(proxy?: ProxyInfo | null): string {
  if (!proxy) return "no-proxy";
  return `${proxy.protocol}://${proxy.host}:${proxy.port}`;
}

class FpjsService {
  private browser: Browser | null = null;
  private browserPath: string | null = null;
  private unavailable = false;
  private initialized = false;
  private isReconnecting = false;
  private currentProxyKey = "no-proxy";

  // Concurrency control: queue of pending generation callbacks
  private activeCount = 0;
  private queue: Array<() => void> = [];

  /**
   * Initialize: find Chromium path.
   * Called lazily on first getRequestId() call.
   */
  async init(): Promise<void> {
    if (this.initialized && this.browserPath) return;

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
    this.initialized = true;
  }

  /**
   * Launch (or re-launch) the browser with a specific proxy.
   * If the proxy changes, the browser is closed and re-launched with the new proxy.
   */
  private async launchBrowser(proxy?: ProxyInfo | null): Promise<void> {
    if (this.isReconnecting) return;
    this.isReconnecting = true;

    try {
      // Close existing browser if any
      if (this.browser) {
        try { await this.browser.close(); } catch (e) {}
        this.browser = null;
      }

      const args = [
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
        "--js-flags=--max-old-space-size=512",
      ];

      // KEY CHANGE v5.5: Route Puppeteer through the SAME proxy as RPC calls
      if (proxy) {
        args.push(`--proxy-server=${buildProxyServerArg(proxy)}`);
        await logger.info("fpjs", `Lançando browser com proxy: ${proxy.host}:${proxy.port}`);
      } else {
        await logger.warn("fpjs", "Lançando browser SEM proxy (não recomendado)");
      }

      this.browser = await (puppeteer as any).launch({
        executablePath: this.browserPath!,
        headless: true,
        args,
      });

      // Track which proxy this browser is using
      this.currentProxyKey = proxyKey(proxy);

      // Monitor unexpected disconnections (crash)
      this.browser!.on('disconnected', () => {
        logger.warn("fpjs", "Browser FPJS desconectado inesperadamente. Será recriado no próximo uso.");
        this.browser = null;
      });

      this.isReconnecting = false;
      await logger.info("fpjs", "Browser FPJS inicializado com sucesso");
    } catch (err) {
      this.isReconnecting = false;
      const msg = err instanceof Error ? err.message : String(err);
      await logger.error("fpjs", `Falha ao inicializar browser FPJS: ${msg}`);

      if (!this.browser) {
        throw new Error(`Falha ao inicializar browser FPJS: ${msg}`);
      }
    }
  }

  /**
   * Ensure the browser is alive and using the correct proxy.
   * Re-launches if the proxy changed or the browser crashed.
   */
  private async ensureBrowser(proxy?: ProxyInfo | null): Promise<void> {
    const requiredKey = proxyKey(proxy);

    // Re-launch if: no browser, browser disconnected, or proxy changed
    if (!this.browser || !this.browser.isConnected() || this.currentProxyKey !== requiredKey) {
      if (this.currentProxyKey !== requiredKey && this.browser) {
        await logger.info("fpjs", `Proxy mudou (${this.currentProxyKey} → ${requiredKey}). Relançando browser...`);
      }
      await this.launchBrowser(proxy);
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
   *
   * v5.5: Proxy authentication is done via page.authenticate().
   * Cookies are cleared after each generation to prevent cross-account correlation.
   */
  private async generateFresh(proxy?: ProxyInfo | null, jobId?: number): Promise<string> {
    await this.ensureBrowser(proxy);
    if (!this.browser) throw new Error("Falha ao garantir browser FPJS");

    await this.acquireSlot();
    let page: Page | null = null;

    try {
      page = await this.browser.newPage();

      // v5.5: Authenticate with proxy credentials if provided
      if (proxy?.username && proxy?.password) {
        await page.authenticate({
          username: proxy.username,
          password: proxy.password,
        });
      }

      // Optimize: intercept and block unnecessary resources
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
        waitUntil: "domcontentloaded",
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

      // v5.5: Clear cookies after generation to prevent cross-account correlation
      // The FPJS cookies (_iidt, _vid_t) would link multiple accounts to the same visitorId
      try {
        const client = await page.createCDPSession();
        await client.send('Network.clearBrowserCookies');
        await client.send('Storage.clearDataForOrigin', {
          origin: 'https://manus.im',
          storageTypes: 'cookies,local_storage,session_storage',
        });
        await client.detach();
      } catch (cookieErr) {
        // Non-fatal: log and continue
        await logger.warn("fpjs", `Falha ao limpar cookies: ${cookieErr}`, {}, jobId);
      }

      if (requestId) {
        await logger.info("fpjs", `RequestId gerado via proxy ${proxy ? `${proxy.host}:${proxy.port}` : 'direto'}: ${requestId}`, {}, jobId);
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
   * v5.5: Now accepts an optional proxy parameter to route the Puppeteer
   * browser through the SAME proxy used for RPC calls. This ensures IP
   * consistency between FPJS identification and RPC requests, preventing
   * the "user is blocked" error.
   *
   * - Always generates a new ID (never reuses old ones).
   * - Concurrent calls are serialized up to maxConcurrent=3 at a time.
   * - Resilient: Retries with backoff until a real ID is generated.
   */
  async getRequestId(jobId?: number, proxy?: ProxyInfo | null): Promise<string> {
    let attempt = 1;
    const maxAttempts = 5;
    const maxBackoff = 30000;

    while (attempt <= maxAttempts) {
      // Lazy init
      if (!this.initialized) {
        await this.init();
      }

      if (this.unavailable) {
        throw new Error("CRÍTICO: Chromium não encontrado no sistema. Instale o Chromium para gerar IDs reais.");
      }

      try {
        const id = await this.generateFresh(proxy, jobId);
        if (id) return id;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await logger.warn("fpjs", `Falha ao gerar requestId (tentativa ${attempt}/${maxAttempts}): ${msg}`, {}, jobId);

        // If browser crashed or is unresponsive, force restart
        if (msg.includes("Target closed") || msg.includes("Session closed") || msg.includes("Protocol error") || msg.includes("timeout") || msg.includes("net::ERR_")) {
          await logger.warn("fpjs", "Browser FPJS instável — forçando reinicialização...", {}, jobId);
          try {
            if (this.browser) await this.browser.close().catch(() => {});
          } catch (e) { /* ignore */ }
          this.browser = null;
        }
      }

      // Exponential backoff with jitter
      const backoff = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 1000, maxBackoff);
      await logger.info("fpjs", `Aguardando ${Math.round(backoff/1000)}s antes de tentar novamente...`, {}, jobId);
      await new Promise(r => setTimeout(r, backoff));
      attempt++;
    }

    throw new Error(`FPJS falhou após ${maxAttempts} tentativas. Verifique o proxy e a conectividade.`);
  }

  /**
   * Returns 0 — no pool in on-demand mode.
   * Kept for UI compatibility.
   */
  getPoolSize(): number {
    return 0;
  }

  /**
   * Check if FPJS service is available (Chromium found).
   */
  isAvailable(): boolean {
    return !this.unavailable && this.initialized;
  }

  /**
   * Cleanup browser resources.
   */
  async destroy(): Promise<void> {
    if (this.browser) {
      try { await this.browser.close(); } catch { /* ignore */ }
      this.browser = null;
    }
  }
}

export const fpjsService = new FpjsService();
