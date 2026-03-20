/**
 * CaptchaService - Multi-Provider Captcha Solver
 * Suporta CapSolver e 2Captcha para resolver Cloudflare Turnstile
 * 
 * Configuração via settings no banco ou env vars:
 *   captcha_provider = "capsolver" | "2captcha"  (default: capsolver)
 *   capsolver_api_key = "CAP-xxx"
 *   twocaptcha_api_key = "xxx"
 *
 * FIX (v5.3): Safe JSON parsing — quando a API retorna HTML (502/503 temporário)
 * em vez de JSON, o erro é tratado graciosamente com retry em vez de crash.
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

/**
 * Safely parse a fetch response as JSON.
 * If the response is HTML (e.g., 502/503 gateway error), throws a descriptive error
 * instead of a cryptic "Unexpected token '<'" SyntaxError.
 */
async function safeJsonParse(resp: Response, context: string): Promise<Record<string, unknown>> {
  const text = await resp.text();

  if (!resp.ok && text.trimStart().startsWith("<!")) {
    throw new Error(`${context}: API retornou HTTP ${resp.status} (HTML) — provável erro temporário do servidor`);
  }

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Truncar a resposta para log legível
    const preview = text.substring(0, 150).replace(/\n/g, " ");
    throw new Error(`${context}: resposta não-JSON (HTTP ${resp.status}): ${preview}`);
  }
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

    const createData = await safeJsonParse(createResp, "CapSolver createTask");

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

    let consecutiveApiErrors = 0;
    const MAX_POLLING_ATTEMPTS = 150; // Aumentado de 60 para 150 (300s)

    for (let attempt = 0; attempt < MAX_POLLING_ATTEMPTS; attempt++) {
      await sleep(2000);

      try {
        const resultResp = await fetch(`${CAPSOLVER_API}/getTaskResult`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientKey: this.capsolverKey, taskId }),
        });

        const resultData = await safeJsonParse(resultResp, "CapSolver getTaskResult");
        consecutiveApiErrors = 0; // Reset on success

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
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        // Se é erro de API temporário (HTML/502), tolerar até 10 consecutivos (aumentado de 3)
        if (msg.includes("HTML") || msg.includes("não-JSON") || msg.includes("fetch failed") || msg.includes("timeout")) {
          consecutiveApiErrors++;
          await logger.warn("captcha", `CapSolver API temporariamente indisponível (${consecutiveApiErrors}/10): ${msg}`, {}, jobId);
          if (consecutiveApiErrors >= 10) {
            throw new Error(`CapSolver API indisponível após 10 tentativas consecutivas: ${msg}`);
          }
          await sleep(3000); // Extra wait before retry
          continue;
        }

        // Outros erros (task failed, error code) — propagar
        throw err;
      }
    }

    throw new Error(`CapSolver timeout: ${MAX_POLLING_ATTEMPTS * 2}s`);
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

    const createData = await safeJsonParse(createResp, "2Captcha createTask");

    if (createData.errorId !== 0) {
      throw new Error(`2Captcha createTask: ${createData.errorCode} - ${createData.errorDescription}`);
    }

    const taskId = createData.taskId as string;
    await logger.info("captcha", `2Captcha task criada: ${taskId}, aguardando...`, {}, jobId);

    // 2Captcha recomenda esperar 5s antes do primeiro polling
    await sleep(5000);

    let consecutiveApiErrors = 0;
    const MAX_POLLING_ATTEMPTS = 100; // Aumentado de 60 para 100 (300s)

    for (let attempt = 0; attempt < MAX_POLLING_ATTEMPTS; attempt++) {
      try {
        const resultResp = await fetch(`${TWOCAPTCHA_API}/getTaskResult`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientKey: this.twocaptchaKey, taskId }),
        });

        const resultData = await safeJsonParse(resultResp, "2Captcha getTaskResult");
        consecutiveApiErrors = 0; // Reset on success

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
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        // Se é erro de API temporário (HTML/502), tolerar até 10 consecutivos (aumentado de 3)
        if (msg.includes("HTML") || msg.includes("não-JSON") || msg.includes("fetch failed") || msg.includes("timeout")) {
          consecutiveApiErrors++;
          await logger.warn("captcha", `2Captcha API temporariamente indisponível (${consecutiveApiErrors}/10): ${msg}`, {}, jobId);
          if (consecutiveApiErrors >= 10) {
            throw new Error(`2Captcha API indisponível após 10 tentativas consecutivas: ${msg}`);
          }
          await sleep(3000); // Extra wait before retry
          continue;
        }

        // Outros erros — propagar
        throw err;
      }

      // 2Captcha recomenda polling a cada 3-5s
      await sleep(3000);
    }

    throw new Error(`2Captcha timeout: ${MAX_POLLING_ATTEMPTS * 3}s`);
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
      const data = await safeJsonParse(resp, "CapSolver getBalance");
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
      const data = await safeJsonParse(resp, "2Captcha getBalance");
      return (data.balance as number) || 0;
    } catch {
      return 0;
    }
  }
}

export const captchaService = new CaptchaService();
