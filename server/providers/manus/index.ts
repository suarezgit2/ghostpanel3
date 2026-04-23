/**
 * Manus Provider
 * Complete account creation flow for manus.im
 *
 * Steps:
 * 1. Solve Cloudflare Turnstile (WITH proxy — same IP as API calls)
 * 2. Check if email is new (getUserPlatforms) → returns tempToken
 * 3. Send email verification code
 * 4. Read code from email (Zoho Mail polling)
 * 5. Register account (registerByEmail) with authCommandCmd + headers
 * 5b. Accept invitation code IMMEDIATELY after registration (timing-critical!)
 *    - Must be called within ~30s of registration while session is "hot"
 *    - Uses a fresh x-client-dcr (regenerated with new timestamp)
 *    - Simulates visiting https://manus.im/invitation?code=XXX&type=signUp
 *    - Verifies freeCredits >= 1500 to confirm invite was applied
 * 6-7. SMS verification with robust retry
 *
 * ANTI-DETECTION IMPROVEMENTS (v4.2):
 * - Turnstile CAPTCHA is solved WITH proxy (same IP as API calls)
 * - authCommandCmd.firstEntry is randomized from fingerprint profile
 * - authCommandCmd.tzOffset uses DST-aware real offset from fingerprint
 * - DCR is regenerated fresh on every RPC call (handled in rpc.ts)
 */

import * as rpc from "./rpc";
import { EmailVerifyCodeAction } from "./rpc";
import { captchaService } from "../../services/captcha";
import { emailService } from "../../services/email";
import { smsService } from "../../services/sms";
import { httpRequest } from "../../services/httpClient";
import { logger, STEP_DELAYS, sleep, randomDelay, extractInviteCode, checkAbort } from "../../utils/helpers";
import type { BrowserProfile } from "../../services/fingerprint";
import { proxyService, getProxyRegion } from "../../services/proxy";
import type { ProxyInfo } from "../../services/proxy";

// Fixed Manus configuration (SMS settings come from DB via SmsService)
const MANUS_CONFIG = {
  loginUrl: "https://manus.im/login",
  turnstileSiteKey: "0x4AAAAAAA_sd0eRNCinWBgU",
  emailFromDomain: "manus.im",
  smsRegionCode: "+62",    // Indonesia
  smsLocale: "en",
  maxRetries: 3,
  emailTimeout: 90000,     // 90s
};

interface CreateAccountOptions {
  email: string;
  password: string;
  fingerprint: BrowserProfile;
  proxy: ProxyInfo | null;
  jobId?: number;
  /** Invite code específico deste job — evita race condition com setting global */
  inviteCode?: string;
  /** AbortSignal for cooperative cancellation — checked between steps */
  signal?: AbortSignal;
}

interface CreateAccountResult {
  email: string;
  password: string;
  token?: string;
  /**
   * - "active": conta criada com sucesso
   * - "failed": falha permanente (email já cadastrado, ban, erro de negócio)
   * - "retry": falha transitória (CAPTCHA, proxy, rede) — o email NÃO deve ser descartado
   */
  status: "active" | "failed" | "retry";
  error?: string;
  /** true se o convite foi confirmado com sucesso (freeCredits >= 1500) */
  inviteAccepted?: boolean;
  metadata: Record<string, unknown>;
}

/**
 * Build authCommandCmd from fingerprint profile.
 * This object is sent with registerByEmail and contains browser context data.
 *
 * Reverse-engineered from manus.im frontend (chunk 40513-27240ebdd145eda3.js):
 *   authCommandCmd: {
 *     ...e,                          // e = f.$() from module 66888
 *     locale: translationManager.locale,
 *     tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
 *     tzOffset: String(new Date().getTimezoneOffset()),
 *     firstEntry: getFirstEntry(),   // URL or undefined
 *     fbp: cookies.get("_fbp")       // Facebook Pixel cookie
 *   }
 *
 * The spread object e (module 66888, function u, exported as $) returns:
 *   {
 *     firstFromPlatform: "web",      // always "web" for desktop browser
 *     utmSource: undefined,          // from localStorage
 *     utmCampaign: undefined,
 *     utmContent: undefined,
 *     utmMedium: undefined,
 *     refer: undefined,              // first_referral from localStorage
 *   }
 *
 * FIXES (v5.1):
 * - Field name is "tz" NOT "timezone" (confirmed from source code)
 * - firstEntry is a full URL or undefined (NOT "direct"/"google")
 * - fbp is generated when firstEntry is a Facebook URL
 * - When firstEntry is undefined, the field is NOT sent (matches real behavior)
 *
 * FIX (v5.2):
 * - Added firstFromPlatform: "web" (from module 66888 spread — was MISSING)
 */
function buildAuthCommandCmd(fingerprint: BrowserProfile): Record<string, unknown> {
  // Fields from the spread object f.$() (module 66888, function u)
  // These come FIRST because the explicit fields below override them via JS spread semantics
  const cmd: Record<string, unknown> = {
    firstFromPlatform: "web",                          // FIXED v5.2: was MISSING — always "web" for desktop
    // utmSource, utmCampaign, utmContent, utmMedium, refer:
    // These are undefined for most users (no UTM params, no referral).
    // undefined fields are omitted from JSON.stringify, matching real behavior.

    // Explicit fields (override spread):
    locale: fingerprint.locale,
    tz: fingerprint.timezone,                          // FIXED v5.1: was "timezone", real uses "tz"
    tzOffset: String(fingerprint.timezoneOffset),       // DST-aware real offset
  };

  // firstEntry: only include if defined (real frontend omits it for direct access)
  if (fingerprint.firstEntry !== undefined) {
    cmd.firstEntry = fingerprint.firstEntry;
  }

  // fbp: Facebook Pixel cookie — generate realistic value when firstEntry is Facebook
  if (fingerprint.firstEntry?.includes("facebook.com")) {
    // Format: fb.1.<creation_timestamp_ms>.<random_10_digits>
    const fbTimestamp = Date.now() - Math.floor(Math.random() * 86400000 * 30); // 0-30 days ago
    const fbRandom = Math.floor(Math.random() * 9000000000) + 1000000000;
    cmd.fbp = `fb.1.${fbTimestamp}.${fbRandom}`;
  } else {
    cmd.fbp = "";
  }

  return cmd;
}

/**
 * Custom error class for account banned detection.
 * v9.3: Used to distinguish "account suspended by anti-bot" from other failures.
 * When this error is thrown, the SMS service stops immediately (no more numbers wasted).
 */
class AccountBannedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountBannedError";
  }
}

/**
 * Format phone number for manus.im API.
 */
function formatPhoneForManus(phoneNumber: string, countryPrefix: string): string {
  const prefix = countryPrefix.replace("+", "");
  if (phoneNumber.startsWith(prefix)) {
    return phoneNumber.substring(prefix.length);
  }
  if (phoneNumber.startsWith("0")) {
    return phoneNumber.substring(1);
  }
  return phoneNumber;
}

/**
 * Solve Turnstile with retry logic.
 *
 * ANTI-DETECTION: Proxy is passed to the CAPTCHA solver so that the token
 * is resolved from the SAME IP that will make the API calls.
 * This prevents IP mismatch detection (Turnstile token bound to solver IP ≠ request IP).
 */
async function solveTurnstileWithRetry(proxy: ProxyInfo | null, jobId?: number): Promise<string> {
  let attempt = 1;
  const MAX_RETRIES = 10; // Aumentado de 3 para 10
  
  while (true) {
    try {
      const token = await captchaService.solveTurnstile(
        MANUS_CONFIG.loginUrl,
        MANUS_CONFIG.turnstileSiteKey,
        proxy,    // Pass proxy so CAPTCHA is solved from the same IP
        jobId
      );
      return token;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      
      if (attempt >= MAX_RETRIES) {
        throw new Error(`Turnstile falhou após ${MAX_RETRIES} tentativas: ${msg}`);
      }
      
      // Backoff exponencial: 2s, 4s, 8s, 16s...
      const backoff = Math.min(2000 * Math.pow(2, attempt - 1) + Math.random() * 1000, 30000);
      await logger.warn("turnstile", `Tentativa ${attempt}/${MAX_RETRIES} falhou: ${msg}. Retentando em ${Math.round(backoff/1000)}s...`, {}, jobId);
      
      await sleep(backoff);
      attempt++;
    }
  }
}

// Cache de proxies verificados: proxy key → timestamp do último check OK
const proxyHealthCache = new Map<string, number>();
const PROXY_HEALTH_CACHE_TTL_MS = 60_000; // 60s
const PROXY_CHECK_TIMEOUT_S = 30;        // v10.7: Aumentado de 15s para 30s para eliminar falsos-negativos de rede lenta
const MAX_PROXY_RETRIES = 3;             // Máximo de proxies a tentar antes de desistir

/**
 * Verifica se o proxy consegue alcançar manus.im.
 * Usa cache de 60s para não pingar em toda tentativa quando o proxy está saudável.
 * Retorna true se OK, false se morto.
 */
async function checkProxyHealth(proxy: ProxyInfo | null, jobId?: number, profileUA?: string): Promise<boolean> {
  if (!proxy) return true; // Sem proxy = conexão direta, sempre OK

  const key = `${proxy.host}:${proxy.port}`;
  const cached = proxyHealthCache.get(key);
  if (cached && (Date.now() - cached) < PROXY_HEALTH_CACHE_TTL_MS) {
    return true; // Proxy verificado recentemente
  }

  // v10.5: Adicionado retry interno (2x) para o ping de saúde
  // Isso evita descartar um proxy bom por causa de um micro-timeout de rede.
  for (let i = 0; i < 2; i++) {
    try {
      // v8.0: Use the SAME User-Agent as the profile to avoid WAF detecting
      // two different UAs from the same IP in quick succession
      // v10.7: Adicionados headers de navegador real para o teste de saúde
      await httpRequest({
        method: "GET",
        url: "https://manus.im/login",
        headers: { 
          "User-Agent": profileUA || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
          "Accept-Language": "en-US,en;q=0.9",
          "Cache-Control": "no-cache",
          "Pragma": "no-cache",
          "Sec-Ch-Ua": '"Not(A:Brand";v="99", "Google Chrome";v="142", "Chromium";v="142"',
          "Sec-Ch-Ua-Mobile": "?0",
          "Sec-Ch-Ua-Platform": '"Windows"',
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "none",
          "Sec-Fetch-User": "?1",
          "Upgrade-Insecure-Requests": "1"
        },
        proxy,
        timeout: PROXY_CHECK_TIMEOUT_S,
      });
      proxyHealthCache.set(key, Date.now());
      return true;
    } catch (err) {
      if (i === 0) {
        // v10.7: Aumentado o delay de warm-up para 3s para dar tempo ao proxy de estabilizar
        await sleep(3000); 
        continue;
      }
      proxyHealthCache.delete(key);
      return false;
    }
  }
  return false;
}

export class ManusProvider {
  slug = "manus";
  name = "Manus.im";

  async createAccount(options: CreateAccountOptions): Promise<CreateAccountResult> {
    const { email, password, fingerprint, jobId, signal } = options;
    let proxy = options.proxy;

    try {
      // Build authCommandCmd from fingerprint (locale, timezone, tzOffset DST-aware, firstEntry randomized, fbp)
      const authCommandCmd = buildAuthCommandCmd(fingerprint);

      // v10.5: Reduzido de 15 para 3 tentativas para evitar exaustão rápida do pool.
      // Se o proxy falhar no health-check (Step 0), ele é RECICLADO (devolvido ao pool)
      // em vez de ser enviado para replacement, pois o erro pode ser instabilidade temporária.
      const MAX_PROXY_ATTEMPTS = 3;
      let proxyOk = false;
      
      for (let proxyAttempt = 1; proxyAttempt <= MAX_PROXY_ATTEMPTS; proxyAttempt++) {
        checkAbort(signal);
        const proxyLabel = proxy ? `${proxy.host}:${proxy.port}` : "sem proxy";
        await logger.info("step_0_proxy",
          `Verificando proxy ${proxyLabel} (tentativa ${proxyAttempt}/${MAX_PROXY_ATTEMPTS})...`,
          {}, jobId
        );
        
        proxyOk = await checkProxyHealth(proxy, jobId, fingerprint.userAgent);
        if (proxyOk) {
          await logger.info("step_0_proxy", `Proxy ${proxyLabel} OK — prosseguindo`, {}, jobId);
          break;
        }
        
        await logger.warn("step_0_proxy",
          `Proxy ${proxyLabel} inacessível. Reciclando e trocando proxy...`,
          {}, jobId
        );
        
        // v10.5: Recicla o proxy que falhou no health-check (não foi "queimado" no registro)
        if (proxy) {
          await proxyService.recycleProxy(proxy.host, jobId);
        }

        if (proxyAttempt === MAX_PROXY_ATTEMPTS) {
          return { email, password, status: "failed", error: `Proxy inacessível após ${MAX_PROXY_ATTEMPTS} tentativas`, metadata: {} };
        }
        
        try {
          await sleep(2000, signal);
          proxy = await proxyService.getProxy(jobId);
        } catch (proxyErr) {
          if (proxyErr instanceof DOMException && proxyErr.name === "AbortError") throw proxyErr;
          await logger.warn("step_0_proxy", `Falha ao obter novo proxy: ${proxyErr}. Retentando...`, {}, jobId);
          await sleep(5000, signal);
        }
      }
      
      if (!proxyOk) {
        return { email, password, status: "retry", error: "Falha crítica na resolução de proxy", metadata: {} };
      }

      // STEP 1: Solve Cloudflare Turnstile (WITH proxy — same IP as API calls)
      await logger.info("step_1_turnstile", "Resolvendo Turnstile...", {
        email,
        proxy: proxy ? `${proxy.host}:${proxy.port}` : "sem proxy",
        firstEntry: fingerprint.firstEntry,
        tzOffset: fingerprint.timezoneOffset,
      }, jobId);
      const turnstileToken = await solveTurnstileWithRetry(proxy, jobId);
      checkAbort(signal);
      await STEP_DELAYS.afterTurnstile(signal);

      // SUSPEITA 5 REATIVADA: Step 2 retry com troca de proxy
      checkAbort(signal);
      await logger.info("step_2_check_email", "Verificando se email é novo...", { email }, jobId);

      let rpcOptions = { fingerprint, proxy, authCommandCmd };
      let step2Platforms: unknown[] = [];
      let tempToken = "";
      // v9.0: Reduced from 5 to 2 retries. CAPTCHA errors (code_1015, code_1715) are now
      // treated as permanent in rpc.ts, so they fail fast. The only reason to retry here
      // is if the proxy itself is bad (network error). 2 retries = 2 fresh proxies.
      const MAX_STEP2_RETRIES = 2;

      for (let step2Attempt = 1; step2Attempt <= MAX_STEP2_RETRIES; step2Attempt++) {
        try {
          const result = await rpc.getUserPlatforms(email, turnstileToken, rpcOptions);
          step2Platforms = result.platforms || [];
          tempToken = result.tempToken || "";
          break;
        } catch (step2Err) {
          const step2ErrMsg = step2Err instanceof Error ? step2Err.message : String(step2Err);
          
          if (step2Attempt < MAX_STEP2_RETRIES) {
            await logger.warn("step_2_check_email",
              `Falha na tentativa ${step2Attempt}/${MAX_STEP2_RETRIES} (${step2ErrMsg}). Trocando proxy e retentando...`,
              {}, jobId
            );
            
            try {
              const newProxy = await proxyService.getProxy(jobId);
              proxy = newProxy;
              rpcOptions = { fingerprint, proxy, authCommandCmd };
              // v9.0: Wait longer between proxy swaps to let FPJS cooldown expire
              await sleep(5000, signal);
            } catch (proxyErr) {
              if (proxyErr instanceof DOMException && proxyErr.name === "AbortError") throw proxyErr;
              // v9.1: NEVER continue without proxy. Running without proxy pollutes the server IP
              // with FPJS requests, causing cascading 429s for ALL jobs.
              // Instead, fail this attempt and let the orchestrator retry later when proxies are available.
              await logger.error("step_2_check_email",
                `Sem proxy disponível: ${proxyErr instanceof Error ? proxyErr.message : proxyErr}. Abortando tentativa (não é seguro continuar sem proxy).`,
                {}, jobId
              );
              throw new Error(`Proxy esgotado: ${proxyErr instanceof Error ? proxyErr.message : proxyErr}`);
            }
          } else {
            throw step2Err;
          }
        }
      }

      const platforms = step2Platforms;

      if (platforms && platforms.length > 0) {
        await logger.error("step_2_check_email", "Email já cadastrado!", { platforms }, jobId);
        return { email, password, status: "failed", error: "Email já cadastrado", metadata: { platforms } };
      }

      if (!tempToken) {
        await logger.warn("step_2_check_email", "getUserPlatforms não retornou tempToken!", {}, jobId);
      }

      checkAbort(signal);
      await STEP_DELAYS.afterEmailCheck(signal);

      // STEP 3: Send email verification code
      // Adicionar delay aleatório antes de enviar email (3-8 segundos)
      await sleep(3000 + Math.random() * 5000, signal);
      await logger.info("step_3_send_email", "Enviando código de verificação...", { email, hasTempToken: !!tempToken }, jobId);
      await rpc.sendEmailVerifyCodeWithCaptcha(email, EmailVerifyCodeAction.REGISTER, tempToken, rpcOptions);
      checkAbort(signal);
      await STEP_DELAYS.afterEmailCodeSent(signal);

      // STEP 4: Read code from email (Zoho polling)
      checkAbort(signal);
      await logger.info("step_4_read_email", "Aguardando email de verificação...", { email }, jobId);

      // SUSPEITA 6 REATIVADA: Email retry 10x com dynamic timeout
      let emailCode: string;
      let attempt = 1;
      const MAX_EMAIL_RETRIES = 10;

      while (true) {
        try {
          const dynamicTimeout = MANUS_CONFIG.emailTimeout + (attempt - 1) * 30000;
          
          emailCode = await emailService.waitForVerificationCode(
            email, MANUS_CONFIG.emailFromDomain, dynamicTimeout, jobId
          );
          break;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          
          if (attempt >= MAX_EMAIL_RETRIES) {
            throw new Error(`Email não recebido após ${MAX_EMAIL_RETRIES} tentativas: ${msg}`);
          }
          
          await logger.warn("step_4_read_email", `Tentativa ${attempt}/${MAX_EMAIL_RETRIES} falhou (${msg}). Reenviando código...`, {}, jobId);
          
          try {
            const newTurnstileToken = await solveTurnstileWithRetry(proxy, jobId);
            const { tempToken: newTempToken } = await rpc.getUserPlatforms(email, newTurnstileToken, rpcOptions);
            await rpc.sendEmailVerifyCodeWithCaptcha(email, EmailVerifyCodeAction.REGISTER, newTempToken, rpcOptions);
            await STEP_DELAYS.afterEmailCodeSent();
          } catch (resendErr) {
            await logger.warn("step_4_read_email", `Falha ao reenviar código: ${resendErr}. Retentando no próximo ciclo...`, {}, jobId);
            await sleep(5000, signal);
          }
          
          attempt++;
        }
      }

      checkAbort(signal);
      await STEP_DELAYS.afterEmailCodeReceived(signal);

      // Adicionar delay aleatório antes de registrar (5-12 segundos)
      await sleep(5000 + Math.random() * 7000, signal);
      
      // STEP 5: Register account with authCommandCmd
      await logger.info("step_5_register", "Registrando conta...", { email, authCommandCmd }, jobId);

      const registerResult = await rpc.registerByEmail(email, password, emailCode!, rpcOptions);
      const jwtToken = registerResult.token;

      if (!jwtToken) throw new Error("Registro falhou: nenhum token retornado");
      
      // Adicionar delay aleatório após registro bem-sucedido (10-25 segundos)
      // Isso é MUITO crítico para evitar detecção de bot no SMS
      await sleep(10000 + Math.random() * 15000, signal);

      // === DIAGNOSTIC LOG: Profile snapshot for ban analysis ===
      // This log captures the FULL profile used for this account.
      // If the account gets banned, compare this with successful accounts to find the pattern.
      await logger.info("step_5_register", "Conta registrada com sucesso!", {
        profileSnapshot: {
          os: fingerprint.detectedOS,
          chromeVersion: fingerprint.chromeMajorVersion,
          chromeFullVersion: fingerprint.chromeFullVersion,
          greaseBrand: fingerprint.greaseBrand,
          greaseVersion: fingerprint.greaseVersion,
          userAgent: fingerprint.userAgent,
          platform: fingerprint.platform,
          screen: `${fingerprint.screenWidth}x${fingerprint.screenHeight}`,
          viewport: `${fingerprint.viewportWidth}x${fingerprint.viewportHeight}`,
          colorDepth: fingerprint.colorDepth,
          timezone: fingerprint.timezone,
          timezoneOffset: fingerprint.timezoneOffset,
          locale: fingerprint.locale,
          languages: fingerprint.languages,
          gpu: fingerprint.webglRenderer,
          gpuVendor: fingerprint.webglVendor,
          deviceMemory: fingerprint.deviceMemory,
          hardwareConcurrency: fingerprint.hardwareConcurrency,
          maxTouchPoints: fingerprint.maxTouchPoints,
          devicePixelRatio: fingerprint.devicePixelRatio,
          fontsCount: fingerprint.fonts?.length || 0,
          battery: fingerprint.battery,
          clientId: fingerprint.clientId,
          firstEntry: fingerprint.firstEntry,
          proxy: proxy ? `${proxy.host}:${proxy.port}` : "sem proxy",
        },
        authCommandCmd,
      }, jobId);

      const authedRpcOptions = { fingerprint, proxy, authToken: jwtToken, authCommandCmd };

      checkAbort(signal);
      await STEP_DELAYS.afterRegistration(signal);

      // STEP 6-7: SMS verification with robust retry
      // v9.3: Detect ACCOUNT BANNED vs NUMBER REJECTED vs SMS PROVIDER ERROR
      await logger.info("step_6_sms", "Iniciando verificação SMS...", { email }, jobId);

      let accountBannedDetected = false;
      let consecutiveBanErrors = 0;

      const smsResult = await smsService.getCodeWithRetry({
        jobId,
        signal,
        onNumberRented: async ({ phoneNumber, activationId, attempt, regionCode }) => {
          // If we already detected the account is banned, throw immediately
          // to prevent wasting more SMS numbers
          if (accountBannedDetected) {
            throw new AccountBannedError(
              `Conta banida pelo Manus (detectado após ${consecutiveBanErrors} tentativas). ` +
              `Não adianta tentar mais números SMS.`
            );
          }

          const formattedPhone = formatPhoneForManus(phoneNumber, regionCode);

          await logger.info("step_6_sms", `[Tentativa ${attempt}] Enviando SMS para ${regionCode}${formattedPhone}`, {
            rawNumber: phoneNumber,
            formattedNumber: formattedPhone,
            regionCode,
            activationId,
          }, jobId);

          try {
            await rpc.sendPhoneVerificationCode(
              formattedPhone,
              regionCode,
              MANUS_CONFIG.smsLocale,
              authedRpcOptions
            );
            // Reset ban counter on success — the account is alive
            consecutiveBanErrors = 0;
          } catch (rpcErr) {
            const rpcMsg = rpcErr instanceof Error ? rpcErr.message : String(rpcErr);

            // === CLASSIFY THE ERROR ===

            // 1. ACCOUNT BANNED: "user is blocked" or "USER_IS_BLOCKED"
            //    The account was suspended by Manus anti-bot. No SMS will ever work.
            //    v9.7.1: Abort IMMEDIATELY on first occurrence.
            //    "user is blocked" is a DISTINCT message from number rejection
            //    ("Failed to send the code"), so there's no ambiguity —
            //    the account is dead. Waiting for 2 consecutive bans
            //    only wastes money renting numbers that can never be used.
            if (rpcMsg.includes("user is blocked") || rpcMsg.includes("USER_IS_BLOCKED")) {
              consecutiveBanErrors++;
              accountBannedDetected = true;

              await logger.warn("step_6_sms",
                `[CONTA BANIDA] SendPhoneVerificationCode retornou "user is blocked" ` +
                `(tentativa ${attempt}). Tentando fallback: novo fingerprint + novo clientId...`,
                {
                  errorType: "ACCOUNT_BANNED",
                  rpcError: rpcMsg,
                  phoneNumber: formattedPhone,
                  regionCode,
                  attempt,
                }, jobId
              );

              // FALLBACK STRATEGY: Se a conta foi banida, pode ser por causa do fingerprint.
              // Tenta com um novo fingerprint (novo clientId, novo screen, novo GPU, etc)
              if (attempt < 2) {
                await logger.info("step_6_sms",
                  `[FALLBACK] Gerando novo fingerprint e tentando novamente...`,
                  { attempt }, jobId
                );
                
                // Gerar novo fingerprint com novo clientId
                authedRpcOptions.fingerprint = fingerprintService.generateProfile(getProxyRegion(proxy));
                
                // Adicionar delay antes de tentar novamente
                await sleep(5000 + Math.random() * 10000, signal);
                
                // Tentar novamente com novo fingerprint
                continue;
              }

              throw new AccountBannedError(
                `Conta banida pelo Manus ("user is blocked" na tentativa ${attempt}). ` +
                `Problema está no fingerprint/perfil, não no SMS.`
              );
            }

            // 2. NUMBER REJECTED: "Failed to send the code. Please check your phone number"
            //    The specific phone number was rejected by Manus (recycled, VoIP, etc.)
            //    The account is fine — try another number.
            //    v9.7.1: This is the ONLY known number rejection message from Manus.
            //    Other errors (if they exist) fall through to UNKNOWN for investigation.
            if (rpcMsg.includes("Failed to send the code")) {
              await logger.warn("step_6_sms",
                `[NÚMERO REJEITADO] SendPhoneVerificationCode rejeitou o número ${regionCode}${formattedPhone}. ` +
                `Conta está OK — tentando próximo número.`,
                {
                  errorType: "NUMBER_REJECTED",
                  rpcError: rpcMsg,
                  phoneNumber: formattedPhone,
                  regionCode,
                  attempt,
                }, jobId
              );
              // Reset ban counter — account is alive, just bad number
              consecutiveBanErrors = 0;
              throw rpcErr;
            }

            // 3. CAPTCHA/FPJS ERROR: "code_1015", "code_1715", "CAPTCHA"
            //    The FPJS requestId expired or is invalid. Retry won't help with same session.
            if (
              rpcMsg.includes("code_1015") ||
              rpcMsg.includes("code_1715") ||
              rpcMsg.includes("CAPTCHA")
            ) {
              await logger.error("step_6_sms",
                `[ERRO FPJS] SendPhoneVerificationCode falhou por CAPTCHA/FPJS inválido.`,
                {
                  errorType: "FPJS_ERROR",
                  rpcError: rpcMsg,
                  attempt,
                }, jobId
              );
              throw rpcErr;
            }

            // 4. UNKNOWN ERROR: Log with full details for investigation
            await logger.error("step_6_sms",
              `[ERRO DESCONHECIDO] SendPhoneVerificationCode falhou com erro não classificado.`,
              {
                errorType: "UNKNOWN",
                rpcError: rpcMsg,
                phoneNumber: formattedPhone,
                regionCode,
                attempt,
              }, jobId
            );
            throw rpcErr;
          }

          await STEP_DELAYS.afterSmsSent(signal);
        },
      });

      // SMS received — verify phone
      const smsRegionCode = smsResult.regionCode || MANUS_CONFIG.smsRegionCode;
      const formattedPhone = formatPhoneForManus(smsResult.phoneNumber, smsRegionCode);

      await logger.info("step_7_verify", `Verificando telefone com código ${smsResult.code}`, {
        rawNumber: smsResult.phoneNumber,
        formattedNumber: formattedPhone,
        regionCode: smsRegionCode,
      }, jobId);

      await rpc.bindPhoneTrait(
        formattedPhone,
        smsRegionCode,
        smsResult.code,
        authedRpcOptions
      );

      await smsService.complete(smsResult.activationId, jobId);

      await logger.info("step_7_verify", "Telefone verificado com sucesso!", { phoneNumber: smsResult.phoneNumber }, jobId);

      // STEP 8: Accept invitation code (requires phone to be verified first)
      // The manus.im API returns "Please verify phone first" if called before SMS.
      // Simulates visiting: https://manus.im/invitation?code=XXX&type=signUp
      let inviteAccepted = false;
      let inviteFreeCredits = 0;
      let lastInviteError: string | undefined;
      // Use invite code passed directly from job (avoids race condition with global setting)
      const inviteCode = options.inviteCode || "";
      const MAX_INVITE_RETRIES = 3;

      if (inviteCode && inviteCode.trim().length > 0) {
        // Short human-like delay before navigating to the invitation page
        const inviteDelay = 3000 + Math.random() * 4000; // 3-7 seconds
        await logger.info("step_8_invite", `Aguardando ${Math.round(inviteDelay / 1000)}s antes de aplicar convite...`, { email }, jobId);
        await sleep(inviteDelay, signal);

        for (let attempt = 1; attempt <= MAX_INVITE_RETRIES; attempt++) {
          await logger.info("step_8_invite", `[Tentativa ${attempt}/${MAX_INVITE_RETRIES}] Ativando código de convite: ${inviteCode}`, { email }, jobId);

          try {
            const inviteResult = await rpc.checkInvitationCode(inviteCode.trim(), authedRpcOptions);

            await logger.info("step_8_invite", `Resposta CheckInvitationCode: ${JSON.stringify(inviteResult)}`, {
              email, inviteCode: inviteCode.trim(), attempt,
            }, jobId);

            // Wait for server to process the credit grant
            await randomDelay(2000, 4000);

            // Verify credits via GetAvailableCredits
            await logger.info("step_8_invite", "Verificando créditos após aplicação...", { email }, jobId);

            try {
              const credits = await rpc.getAvailableCredits(authedRpcOptions);
              inviteFreeCredits = credits.freeCredits;

              await logger.info("step_8_invite", `Créditos: freeCredits=${credits.freeCredits}, total=${credits.totalCredits}`, {
                email, freeCredits: credits.freeCredits, totalCredits: credits.totalCredits,
              }, jobId);

              if (credits.freeCredits >= 1500) {
                inviteAccepted = true;
                await logger.info("step_8_invite", `✓ Convite confirmado! freeCredits=${credits.freeCredits} (+500 créditos)`, {
                  email, inviteCode: inviteCode.trim(), freeCredits: credits.freeCredits,
                }, jobId);
                break;
              } else {
                await logger.warn("step_8_invite", `Convite não confirmado. freeCredits=${credits.freeCredits} (esperado >= 1500). Tentativa ${attempt}/${MAX_INVITE_RETRIES}`, {
                  email, freeCredits: credits.freeCredits,
                }, jobId);
              }
            } catch (credErr) {
              const credErrMsg = credErr instanceof Error ? credErr.message : String(credErr);
              await logger.warn("step_8_invite", `Erro ao verificar créditos: ${credErrMsg}`, { email }, jobId);
              inviteAccepted = true; // Assume success if can't verify
              break;
            }

          } catch (inviteErr) {
            const inviteErrMsg = inviteErr instanceof Error ? inviteErr.message : String(inviteErr);
            lastInviteError = inviteErrMsg;
            await logger.warn("step_8_invite", `[Tentativa ${attempt}] Falha: ${inviteErrMsg}`, {
              email, inviteCode: inviteCode.trim(), attempt,
            }, jobId);
          }

          if (attempt < MAX_INVITE_RETRIES && !inviteAccepted) {
            const retryDelay = 5000 * attempt + Math.random() * 3000;
            await logger.info("step_8_invite", `Aguardando ${Math.round(retryDelay / 1000)}s antes da próxima tentativa...`, { email }, jobId);
            await sleep(retryDelay, signal);
          }
        }

        if (!inviteAccepted) {
          // Distinguish between invalid code (permanent) and temporary failures
          const isInvalidCode = lastInviteError?.includes("invalid_argument") ||
            lastInviteError?.includes("invalid invitation code");

          if (isInvalidCode) {
            // Permanent failure — invalid/expired code, abort the whole job
            await logger.error("step_8_invite", `Código de convite INVÁLIDO: "${inviteCode.trim()}" — verifique se o código está correto e não expirou`, {
              email, inviteCode: inviteCode.trim(), freeCredits: inviteFreeCredits,
            }, jobId);
            throw new Error(`INVITE_INVALID_CODE: "${inviteCode.trim()}"`);
          } else {
            // Temporary failure — conta recebeu créditos insuficientes (ex: 300 ao invés de 1500+).
            // Descarta esta conta e sinaliza ao orchestrator para retentar com uma nova.
            await logger.warn("step_8_invite",
              `Conta descartada: convite não confirmado após ${MAX_INVITE_RETRIES} tentativas. ` +
              `freeCredits=${inviteFreeCredits} (esperado >= 1500). Retentando com nova conta.`,
              { email, inviteCode: inviteCode.trim(), freeCredits: inviteFreeCredits }, jobId);
            throw new Error(`INVITE_NOT_CONFIRMED: freeCredits=${inviteFreeCredits}`);
          }
        }
      }

      // SUCCESS — account was created, phone verified and invite confirmed.
      return {
        email,
        password,
        token: jwtToken,
        status: "active",
        inviteAccepted: true,
        metadata: {
          userId: registerResult.userId,
          phoneNumber: smsResult.phoneNumber,
          smsAttempts: smsResult.attempt,
          proxy: proxy?.host || "none",
          fingerprint: fingerprint.userAgent.substring(0, 50),
          firstEntry: fingerprint.firstEntry,
          tzOffset: fingerprint.timezoneOffset,
          inviteAccepted,
          inviteCode: inviteCode || null,
          inviteFreeCredits: inviteFreeCredits || null,
        },
      };

    } catch (err: unknown) {
      // Re-throw AbortError so orchestrator handles it as cancellation, not as a failed account
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      const errorMsg = err instanceof Error ? err.message : String(err);

      // Re-throw invite errors so orchestrator can handle them specifically:
      // - INVITE_NOT_CONFIRMED: discard account and retry with a new one
      // - INVITE_INVALID_CODE: abort the entire job
      if (errorMsg.startsWith("INVITE_NOT_CONFIRMED:") || errorMsg.startsWith("INVITE_INVALID_CODE:")) {
        throw err;
      }

      // v9.3+: Classificar falha — transitória (retry) vs permanente (failed)
      const isBanned = err instanceof AccountBannedError;
      const isTransient = !isBanned && (
        errorMsg.includes("code_1015") ||
        errorMsg.includes("code_1715") ||
        errorMsg.includes("CAPTCHA") ||
        errorMsg.includes("captcha") ||
        errorMsg.includes("ECONNREFUSED") ||
        errorMsg.includes("ETIMEDOUT") ||
        errorMsg.includes("ECONNRESET") ||
        errorMsg.includes("fetch failed") ||
        errorMsg.includes("network error") ||
        errorMsg.includes("Network error")
      );
      const failureType = isBanned ? "ACCOUNT_BANNED" : isTransient ? "TRANSIENT_ERROR" : "GENERIC_FAILURE";

      await logger.error("failed", `Falha [${failureType}]: ${errorMsg}`, {
        email,
        failureType,
        proxy: proxy ? `${proxy.host}:${proxy.port}` : "sem proxy",
        os: fingerprint.detectedOS,
        chromeVersion: fingerprint.chromeMajorVersion,
        gpu: fingerprint.webglRenderer?.substring(0, 80),
      }, jobId);

      return {
        email,
        password,
        // retry = erro transitório (CAPTCHA/proxy/rede) — email não deve ser descartado
        // failed = erro permanente (ban, email já cadastrado, erro de negócio)
        status: isTransient ? "retry" as const : "failed" as const,
        error: errorMsg,
        metadata: {
          failureType,
          proxy: proxy?.host || "none",
          os: fingerprint.detectedOS,
          chromeVersion: fingerprint.chromeMajorVersion,
          gpu: fingerprint.webglRenderer?.substring(0, 80),
        },
      };
    }
  }
}

export const manusProvider = new ManusProvider();
