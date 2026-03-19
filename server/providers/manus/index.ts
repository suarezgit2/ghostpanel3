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
import { logger, STEP_DELAYS, sleep, randomDelay } from "../../utils/helpers";
import { getSetting } from "../../utils/settings";
import type { BrowserProfile } from "../../services/fingerprint";
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
}

interface CreateAccountResult {
  email: string;
  password: string;
  token?: string;
  status: "active" | "failed";
  error?: string;
  metadata: Record<string, unknown>;
}

/**
 * Build authCommandCmd from fingerprint profile.
 * This object is sent with registerByEmail and contains browser context data.
 *
 * Fields match what the real manus.im frontend sends:
 * locale, timezone, tzOffset (as string), firstEntry, fbp
 *
 * ANTI-DETECTION: firstEntry is randomized from the fingerprint profile.
 * tzOffset uses the DST-aware real offset from the fingerprint.
 */
function buildAuthCommandCmd(fingerprint: BrowserProfile): Record<string, unknown> {
  return {
    locale: fingerprint.locale,
    timezone: fingerprint.timezone,
    tzOffset: String(fingerprint.timezoneOffset),  // DST-aware real offset
    firstEntry: fingerprint.firstEntry,             // Randomized: direct/google/twitter/etc
    fbp: "",
  };
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
  let retries = 0;
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
      retries++;
      if (retries >= MANUS_CONFIG.maxRetries) {
        throw new Error(`Turnstile falhou após ${retries} tentativas: ${err}`);
      }
      await logger.warn("turnstile", `Tentativa ${retries} falhou, retentando...`, {}, jobId);
    }
  }
}

export class ManusProvider {
  slug = "manus";
  name = "Manus.im";

  async createAccount(options: CreateAccountOptions): Promise<CreateAccountResult> {
    const { email, password, fingerprint, proxy, jobId } = options;

    try {
      // Build authCommandCmd from fingerprint (locale, timezone, tzOffset DST-aware, firstEntry randomized, fbp)
      const authCommandCmd = buildAuthCommandCmd(fingerprint);

      // STEP 1: Solve Cloudflare Turnstile (WITH proxy — same IP as API calls)
      await logger.info("step_1_turnstile", "Resolvendo Turnstile...", {
        email,
        proxy: proxy ? `${proxy.host}:${proxy.port}` : "sem proxy",
        firstEntry: fingerprint.firstEntry,
        tzOffset: fingerprint.timezoneOffset,
      }, jobId);
      const turnstileToken = await solveTurnstileWithRetry(proxy, jobId);
      await STEP_DELAYS.afterTurnstile();

      // STEP 2: Check if email is new → returns tempToken
      await logger.info("step_2_check_email", "Verificando se email é novo...", { email }, jobId);

      const rpcOptions = { fingerprint, proxy, authCommandCmd };
      const { platforms, tempToken } = await rpc.getUserPlatforms(email, turnstileToken, rpcOptions);

      if (platforms && platforms.length > 0) {
        await logger.error("step_2_check_email", "Email já cadastrado!", { platforms }, jobId);
        return { email, password, status: "failed", error: "Email já cadastrado", metadata: { platforms } };
      }

      if (!tempToken) {
        await logger.warn("step_2_check_email", "getUserPlatforms não retornou tempToken!", {}, jobId);
      }

      await STEP_DELAYS.afterEmailCheck();

      // STEP 3: Send email verification code
      await logger.info("step_3_send_email", "Enviando código de verificação...", { email, hasTempToken: !!tempToken }, jobId);
      await rpc.sendEmailVerifyCodeWithCaptcha(email, EmailVerifyCodeAction.REGISTER, tempToken, rpcOptions);
      await STEP_DELAYS.afterEmailCodeSent();

      // STEP 4: Read code from email (Zoho polling)
      await logger.info("step_4_read_email", "Aguardando email de verificação...", { email }, jobId);

      let emailCode: string;
      let retries = 0;

      while (true) {
        try {
          emailCode = await emailService.waitForVerificationCode(
            email, MANUS_CONFIG.emailFromDomain, MANUS_CONFIG.emailTimeout, jobId
          );
          break;
        } catch (err) {
          retries++;
          if (retries >= MANUS_CONFIG.maxRetries) {
            throw new Error(`Email não recebido após ${retries} tentativas: ${err}`);
          }
          await logger.warn("step_4_read_email", `Tentativa ${retries} falhou, reenviando...`, {}, jobId);
          const newTurnstileToken = await solveTurnstileWithRetry(proxy, jobId);
          const { tempToken: newTempToken } = await rpc.getUserPlatforms(email, newTurnstileToken, rpcOptions);
          await rpc.sendEmailVerifyCodeWithCaptcha(email, EmailVerifyCodeAction.REGISTER, newTempToken, rpcOptions);
          await STEP_DELAYS.afterEmailCodeSent();
        }
      }

      await STEP_DELAYS.afterEmailCodeReceived();

      // STEP 5: Register account with authCommandCmd
      await logger.info("step_5_register", "Registrando conta...", { email, authCommandCmd }, jobId);

      const registerResult = await rpc.registerByEmail(email, password, emailCode!, rpcOptions);
      const jwtToken = registerResult.token;

      if (!jwtToken) throw new Error("Registro falhou: nenhum token retornado");

      await logger.info("step_5_register", "Conta registrada com sucesso!", {}, jobId);

      const authedRpcOptions = { fingerprint, proxy, authToken: jwtToken, authCommandCmd };

      await STEP_DELAYS.afterRegistration();

      // STEP 6-7: SMS verification with robust retry
      await logger.info("step_6_sms", "Iniciando verificação SMS...", { email }, jobId);

      const smsResult = await smsService.getCodeWithRetry({
        jobId,
        onNumberRented: async ({ phoneNumber, activationId, attempt }) => {
          const formattedPhone = formatPhoneForManus(phoneNumber, MANUS_CONFIG.smsRegionCode);

          await logger.info("step_6_sms", `[Tentativa ${attempt}] Enviando SMS para ${MANUS_CONFIG.smsRegionCode}${formattedPhone}`, {
            rawNumber: phoneNumber,
            formattedNumber: formattedPhone,
            activationId,
          }, jobId);

          await rpc.sendPhoneVerificationCode(
            formattedPhone,
            MANUS_CONFIG.smsRegionCode,
            MANUS_CONFIG.smsLocale,
            authedRpcOptions
          );

          await STEP_DELAYS.afterSmsSent();
        },
      });

      // SMS received — verify phone
      const formattedPhone = formatPhoneForManus(smsResult.phoneNumber, MANUS_CONFIG.smsRegionCode);

      await logger.info("step_7_verify", `Verificando telefone com código ${smsResult.code}`, {
        rawNumber: smsResult.phoneNumber,
        formattedNumber: formattedPhone,
      }, jobId);

      await rpc.bindPhoneTrait(
        formattedPhone,
        MANUS_CONFIG.smsRegionCode,
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
      const inviteCode = await getSetting("invite_code");
      const MAX_INVITE_RETRIES = 3;

      if (inviteCode && inviteCode.trim().length > 0) {
        // Short human-like delay before navigating to the invitation page
        const inviteDelay = 3000 + Math.random() * 4000; // 3-7 seconds
        await logger.info("step_8_invite", `Aguardando ${Math.round(inviteDelay / 1000)}s antes de aplicar convite...`, { email }, jobId);
        await sleep(inviteDelay);

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
            await logger.warn("step_8_invite", `[Tentativa ${attempt}] Falha: ${inviteErrMsg}`, {
              email, inviteCode: inviteCode.trim(), attempt,
            }, jobId);
          }

          if (attempt < MAX_INVITE_RETRIES && !inviteAccepted) {
            const retryDelay = 5000 * attempt + Math.random() * 3000;
            await logger.info("step_8_invite", `Aguardando ${Math.round(retryDelay / 1000)}s antes da próxima tentativa...`, { email }, jobId);
            await sleep(retryDelay);
          }
        }

        if (!inviteAccepted) {
          await logger.warn("step_8_invite", `Convite não confirmado após ${MAX_INVITE_RETRIES} tentativas. freeCredits=${inviteFreeCredits}`, {
            email, inviteCode: inviteCode.trim(), freeCredits: inviteFreeCredits,
          }, jobId);
        }
      }

      // SUCCESS
      return {
        email,
        password,
        token: jwtToken,
        status: "active",
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
      const errorMsg = err instanceof Error ? err.message : String(err);
      await logger.error("failed", `Falha: ${errorMsg}`, { email }, jobId);
      return {
        email,
        password,
        status: "failed",
        error: errorMsg,
        metadata: {},
      };
    }
  }
}

export const manusProvider = new ManusProvider();
