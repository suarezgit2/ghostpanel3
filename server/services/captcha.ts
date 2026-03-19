/**
 * CaptchaService - Multi-Provider Captcha Solver
 * Suporta CapSolver e 2Captcha para resolver Cloudflare Turnstile
 * 
 * Configuração via settings no banco ou env vars:
 *   captcha_provider = "capsolver" | "2captcha"  (default: capsolver)
 *   capsolver_api_key = "CAP-xxx"
 *   twocaptcha_api_key = "xxx"
 */

import { getSetting } from "../utils/settings";
import { sleep, logger } from "../utils/helpers";
import { ENV } from "../_core/env";

const CAPSOLVER_API = "https://api.capsolver.com";
const TWOCAPTCHA_API = "https://api.2captcha.com";

type CaptchaProvider = "capsolver" | "2captcha";

interface ProxyInfo {
  host: string;
  port: number;
  username?: string | null;
  password?: string | null;
}

class CaptchaService {
  private capsolverKey = "";
  private twocaptchaKey = "";
  private provider: CaptchaProvider = "capsolver";

  async init(): Promise<void> {
    // Determinar provider (settings do banco tem prioridade sobre env)
    let providerSetting = (await getSetting("captcha_provider")) || ENV.captchaProvider || "capsolver";
    // Normalizar: aceitar "twocaptcha" como alias de "2captcha"
    if (providerSetting === "twocaptcha") providerSetting = "2captcha";
    this.provider = providerSetting as CaptchaProvider;

    // Carregar API keys
    this.capsolverKey = (await getSetting("capsolver_api_key")) || ENV.capsolverApiKey || "";
    this.twocaptchaKey = (await getSetting("twocaptcha_api_key")) || ENV.twocaptchaApiKey || "";

    // Se o provider escolhido não tem key, tentar o outro automaticamente
    if (this.provider === "capsolver" && !this.capsolverKey && this.twocaptchaKey) {
      this.provider = "2captcha";
      await logger.info("captcha", "CapSolver sem API key, usando 2Captcha automaticamente");
    } else if (this.provider === "2captcha" && !this.twocaptchaKey && this.capsolverKey) {
      this.provider = "capsolver";
      await logger.info("captcha", "2Captcha sem API key, usando CapSolver automaticamente");
    }
  }

  getProvider(): CaptchaProvider {
    return this.provider;
  }

  async solveTurnstile(
    websiteURL: string,
    websiteKey: string,
    proxy?: ProxyInfo | null,
    jobId?: number
  ): Promise<string> {
    await this.init();

    if (this.provider === "2captcha") {
      return this.solveTurnstile2Captcha(websiteURL, websiteKey, proxy, jobId);
    }
    return this.solveTurnstileCapSolver(websiteURL, websiteKey, proxy, jobId);
  }

  // ================================================================
  // CapSolver Implementation
  // ================================================================

  private async solveTurnstileCapSolver(
    websiteURL: string,
    websiteKey: string,
    proxy?: ProxyInfo | null,
    jobId?: number
  ): Promise<string> {
    if (!this.capsolverKey) throw new Error("CapSolver API key não configurada");

    await logger.info("captcha", "Iniciando resolução do Turnstile via CapSolver", { websiteURL, websiteKey }, jobId);

    const taskPayload: Record<string, unknown> = {
      type: proxy ? "AntiTurnstileTask" : "AntiTurnstileTaskProxyLess",
      websiteURL,
      websiteKey,
    };

    if (proxy) {
      taskPayload.proxyType = "http";
      taskPayload.proxyAddress = proxy.host;
      taskPayload.proxyPort = proxy.port;
      if (proxy.username) taskPayload.proxyLogin = proxy.username;
      if (proxy.password) taskPayload.proxyPassword = proxy.password;
    }

    const createResp = await fetch(`${CAPSOLVER_API}/createTask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: this.capsolverKey, task: taskPayload }),
    });

    const createData = (await createResp.json()) as Record<string, unknown>;

    if (createData.errorId !== 0) {
      throw new Error(`CapSolver createTask: ${createData.errorCode} - ${createData.errorDescription}`);
    }

    // CapSolver pode retornar resultado instantâneo
    const solution = createData.solution as Record<string, unknown> | undefined;
    if (createData.status === "ready" && solution?.token) {
      await logger.info("captcha", "Turnstile resolvido instantaneamente (CapSolver)", {}, jobId);
      return solution.token as string;
    }

    const taskId = createData.taskId as string;
    await logger.info("captcha", `CapSolver task criada: ${taskId}, aguardando...`, {}, jobId);

    for (let attempt = 0; attempt < 60; attempt++) {
      await sleep(2000);

      const resultResp = await fetch(`${CAPSOLVER_API}/getTaskResult`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: this.capsolverKey, taskId }),
      });

      const resultData = (await resultResp.json()) as Record<string, unknown>;

      if (resultData.errorId !== 0) {
        throw new Error(`CapSolver getTaskResult: ${resultData.errorCode} - ${resultData.errorDescription}`);
      }

      const sol = resultData.solution as Record<string, unknown> | undefined;
      if (resultData.status === "ready" && sol?.token) {
        await logger.info("captcha", `Turnstile resolvido em ${(attempt + 1) * 2}s (CapSolver)`, {}, jobId);
        return sol.token as string;
      }

      if (resultData.status === "failed") {
        throw new Error("CapSolver task failed");
      }
    }

    throw new Error("CapSolver timeout: 120s");
  }

  // ================================================================
  // 2Captcha Implementation
  // ================================================================

  private async solveTurnstile2Captcha(
    websiteURL: string,
    websiteKey: string,
    proxy?: ProxyInfo | null,
    jobId?: number
  ): Promise<string> {
    if (!this.twocaptchaKey) throw new Error("2Captcha API key não configurada");

    await logger.info("captcha", "Iniciando resolução do Turnstile via 2Captcha", { websiteURL, websiteKey }, jobId);

    const taskPayload: Record<string, unknown> = {
      type: proxy ? "TurnstileTask" : "TurnstileTaskProxyless",
      websiteURL,
      websiteKey,
    };

    if (proxy) {
      taskPayload.proxyType = "http";
      taskPayload.proxyAddress = proxy.host;
      taskPayload.proxyPort = proxy.port;
      if (proxy.username) taskPayload.proxyLogin = proxy.username;
      if (proxy.password) taskPayload.proxyPassword = proxy.password;
    }

    const createResp = await fetch(`${TWOCAPTCHA_API}/createTask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: this.twocaptchaKey, task: taskPayload }),
    });

    const createData = (await createResp.json()) as Record<string, unknown>;

    if (createData.errorId !== 0) {
      throw new Error(`2Captcha createTask: ${createData.errorCode} - ${createData.errorDescription}`);
    }

    const taskId = createData.taskId as string;
    await logger.info("captcha", `2Captcha task criada: ${taskId}, aguardando...`, {}, jobId);

    // 2Captcha recomenda esperar 5s antes do primeiro polling
    await sleep(5000);

    for (let attempt = 0; attempt < 60; attempt++) {
      const resultResp = await fetch(`${TWOCAPTCHA_API}/getTaskResult`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: this.twocaptchaKey, taskId }),
      });

      const resultData = (await resultResp.json()) as Record<string, unknown>;

      if (resultData.errorId !== 0) {
        throw new Error(`2Captcha getTaskResult: ${resultData.errorCode} - ${resultData.errorDescription}`);
      }

      if (resultData.status === "ready") {
        const sol = resultData.solution as Record<string, unknown>;
        const token = sol?.token as string;
        if (token) {
          const totalTime = 5 + (attempt + 1) * 3;
          await logger.info("captcha", `Turnstile resolvido em ~${totalTime}s (2Captcha)`, {}, jobId);
          return token;
        }
      }

      // 2Captcha recomenda polling a cada 3-5s
      await sleep(3000);
    }

    throw new Error("2Captcha timeout: 185s");
  }

  // ================================================================
  // Balance (ambos os providers)
  // ================================================================

  async getBalance(): Promise<{ provider: string; balance: number }> {
    await this.init();

    if (this.provider === "2captcha") {
      return { provider: "2captcha", balance: await this.getBalance2Captcha() };
    }
    return { provider: "capsolver", balance: await this.getBalanceCapSolver() };
  }

  private async getBalanceCapSolver(): Promise<number> {
    if (!this.capsolverKey) return 0;

    try {
      const resp = await fetch(`${CAPSOLVER_API}/getBalance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: this.capsolverKey }),
      });
      const data = (await resp.json()) as Record<string, unknown>;
      return (data.balance as number) || 0;
    } catch {
      return 0;
    }
  }

  private async getBalance2Captcha(): Promise<number> {
    if (!this.twocaptchaKey) return 0;

    try {
      const resp = await fetch(`${TWOCAPTCHA_API}/getBalance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: this.twocaptchaKey }),
      });
      const data = (await resp.json()) as Record<string, unknown>;
      return (data.balance as number) || 0;
    } catch {
      return 0;
    }
  }
}

export const captchaService = new CaptchaService();
