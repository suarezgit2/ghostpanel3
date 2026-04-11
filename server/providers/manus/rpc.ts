/**
 * Manus.im RPC Client
 * ConnectRPC (connect-es) with TLS/HTTP2 Impersonation
 *
 * Format: POST https://api.manus.im/{package}.{ServiceName}/{MethodName}
 * Headers: Content-Type: application/json, Connect-Protocol-Version: 1
 *
 * ANTI-DETECTION (v11.0 — Synthetic FPJS + TLS v1.5.1 Impersonation):
 * - Uses impers (curl-impersonate v1.5.1) for Chrome-identical TLS/HTTP2 fingerprints
 * - JA3/JA4 TLS fingerprint matches real Chrome 142+ (GREASE, ECH, Kyber768, ALPS)
 * - HTTP/2 SETTINGS, WINDOW_UPDATE, pseudo-header order match real Chrome
 * - DCR is regenerated FRESH on every RPC call (fresh timestamp + fresh fgRequestId)
 * - FPJS requestId is SYNTHETIC (not queryable via Server API) to avoid exposing
 *   fabricated signals to tampering/botd/vpn detection. The Manus backend cannot
 *   verify our fingerprint via FPJS Server API because the requestId doesn't exist.
 * - TLS impersonation ensures RPC calls look like real Chrome at the network level
 * - No browser process, no bot detection, no webdriver flag
 */

import { httpRequest } from "../../services/httpClient";
import { fingerprintService, type BrowserProfile } from "../../services/fingerprint";
// v11.0: getRequestIdDirect DISABLED — real FPJS requestIds expose fabricated signals
// to the FPJS Server API (tampering, botd, vpn), causing instant bans.
// Using synthetic requestIds instead (not queryable via Server API).
// import { getRequestIdDirect } from "../../services/fpjsDirectClient";
import type { ProxyInfo } from "../../services/proxy";

const API_BASE = "https://api.manus.im";

/**
 * EmailVerifyCodeAction enum (protobuf)
 */
export enum EmailVerifyCodeAction {
  UNSPECIFIED = 0,
  REGISTER = 1,
  RESET_PASSWORD = 2,
  LOGOFF = 3,
  DISMISS_TEAM = 4,
  BIND_LOGIN_METHOD = 5,
  UPDATE_EMAIL = 6,
  VERIFY_EMAIL = 7,
}

interface RpcOptions {
  fingerprint: BrowserProfile;
  proxy?: ProxyInfo | null;
  authToken?: string;
  authCommandCmd?: Record<string, unknown>;
  clientId?: string;
  clientDcr?: string;
}

/**
 * v9.0 CHANGES:
 * - CAPTCHA verification failed (code_1015) is now treated as PERMANENT error.
 *   Before: it retried 5x with backoff, wasting ~60s per RPC call.
 *   The root cause of code_1015 is that the FPJS requestId was invalid/expired,
 *   so retrying the same RPC with the same bad requestId is pointless.
 *   Now: it fails immediately and lets the orchestrator retry with a fresh proxy+FPJS.
 * - Need CAPTCHA code (code_1715) is also treated as permanent (FPJS completely failed).
 * - On transient retry, regenerate FPJS + DCR fresh (not reuse the stale one).
 * - Reduced MAX_RETRIES from 5 to 3 (fail fast, let orchestrator handle recovery).
 */
async function rpcCall(
  servicePath: string,
  payload: Record<string, unknown>,
  options: RpcOptions,
  extraHeaders?: Record<string, string>
): Promise<Record<string, unknown>> {
  const url = `${API_BASE}/${servicePath}`;

  // RPC retry 3x com backoff exponencial e PermanentRpcError
  // v9.0: Reduced from 5 to 3 — fail fast, let orchestrator handle recovery with fresh proxy
  const MAX_RETRIES = 3;
  let attempt = 1;
  let lastError: Error | null = null;

  while (attempt <= MAX_RETRIES) {
    // v11.0: Use SYNTHETIC FPJS requestId instead of real one.
    // Real requestIds (from getRequestIdDirect) allow the Manus backend to query
    // the FPJS Server API and discover that our signals are fabricated:
    //   - tampering.anomaly_score > 0.5 (canvas/audio/webgl don't match real browsers)
    //   - botd = "bad" (automation patterns detected)
    //   - vpn.os_mismatch (TLS OS vs profile OS mismatch)
    // With synthetic requestIds, the Manus backend CANNOT verify via FPJS Server API
    // because the requestId doesn't exist in the FPJS database.
    // Format: {timestamp}.{6 random alphanumeric chars} — matches real FPJS format.
    const ALPHANUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    // v10.8: Reduced pageLoadDelay to 5-10s. 
    // 20-40s was too long and might make the requestId look "stale" to the Manus backend.
    const ts = Date.now() - (5000 + Math.floor(Math.random() * 5000));
    let rand = '';
    for (let i = 0; i < 6; i++) {
      rand += ALPHANUM[Math.floor(Math.random() * ALPHANUM.length)];
    }
    const freshFgRequestId = `${ts}.${rand}`;

    // Regenerate DCR fresh with the new FPJS requestId
    const freshDcr = fingerprintService.regenerateDcr(options.fingerprint, freshFgRequestId);
    const profileWithFreshDcr = {
      ...options.fingerprint,
      headers: {
        ...options.fingerprint.headers,
        "x-client-dcr": freshDcr,
      },
    };

    const headers = fingerprintService.getOrderedHeaders(profileWithFreshDcr);
    headers["Connect-Protocol-Version"] = "1";

    if (options.authToken) {
      headers["Authorization"] = `Bearer ${options.authToken}`;
    }

    if (extraHeaders) {
      Object.assign(headers, extraHeaders);
    }

    try {
      const response = await httpRequest({
        method: "POST",
        url,
        headers,
        body: JSON.stringify(payload),
        proxy: options.proxy,
        userAgent: options.fingerprint.userAgent,
        timeout: 45 + (attempt * 15),
      });

      const text = response.text;

      let data: Record<string, unknown>;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`RPC ${servicePath} (${response.status}): resposta não-JSON: ${text.substring(0, 200)}`);
      }

      if (data.code && !["ok", "OK"].includes(data.code as string)) {
        const details = data.details as Array<{ debug?: { message?: string } }> | undefined;
        const debugMsg = details?.[0]?.debug?.message || (data.message as string) || "";
        
        // v9.0: Expanded permanent errors list
        const permanentErrors = ["invalid_argument", "unauthenticated", "not_found", "already_exists", "permission_denied"];
        if (permanentErrors.includes(data.code as string)) {
          const err = new Error(`RPC ${servicePath} error [${data.code}]: ${debugMsg}`);
          err.name = "PermanentRpcError";
          throw err;
        }

        // v9.0: CAPTCHA-related errors are now PERMANENT.
        // code_1015 = "CAPTCHA verification failed" (invalid/expired FPJS requestId)
        // code_1715 = "Need CAPTCHA code!" (FPJS completely failed, no requestId at all)
        // Retrying with the same proxy+profile won't fix these — the orchestrator
        // needs to allocate a fresh proxy and generate a new FPJS requestId.
        const captchaErrorCodes = ["code_1015", "code_1715"];
        if (captchaErrorCodes.some(code => debugMsg.includes(code) || (data.code as string).includes(code))) {
          const err = new Error(`RPC ${servicePath} error [${data.code}]: ${debugMsg}`);
          err.name = "PermanentRpcError";
          throw err;
        }
        
        throw new Error(`RPC ${servicePath} error [${data.code}]: ${debugMsg}`);
      }

      if (response.status >= 400 && !data.code) {
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          const err = new Error(`RPC ${servicePath} (${response.status}): ${text.substring(0, 200)}`);
          err.name = "PermanentRpcError";
          throw err;
        }
        throw new Error(`RPC ${servicePath} (${response.status}): ${text.substring(0, 200)}`);
      }

      return data;
      
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      
      if (lastError.name === "PermanentRpcError") {
        throw lastError;
      }
      
      if (attempt === MAX_RETRIES) {
        break;
      }
      
      const backoff = Math.min(3000 * Math.pow(2, attempt - 1) + Math.random() * 2000, 30000);
      console.warn(`[RPC] Falha transitória em ${servicePath} (tentativa ${attempt}/${MAX_RETRIES}): ${lastError.message}. Retentando em ${Math.round(backoff/1000)}s...`);
      
      await new Promise(r => setTimeout(r, backoff));
      attempt++;
    }
  }

  throw lastError || new Error(`RPC ${servicePath} falhou após ${MAX_RETRIES} tentativas`);
}

// ============================================================
// UserAuthPublicService (public - no auth)
// ============================================================

export async function getUserPlatforms(email: string, cfCaptchaCode: string, options: RpcOptions) {
  const result = await rpcCall(
    "user.v1.UserAuthPublicService/GetUserPlatforms",
    { email, cfCaptchaCode },
    options
  );
  return {
    platforms: (result.platforms as unknown[]) || [],
    tempToken: (result.tempToken as string) || "",
  };
}

export async function sendEmailVerifyCodeWithCaptcha(
  email: string,
  action: EmailVerifyCodeAction,
  tempToken: string,
  options: RpcOptions
) {
  await rpcCall(
    "user.v1.UserAuthPublicService/SendEmailVerifyCodeWithCaptcha",
    { email, action, token: tempToken },
    options
  );
}

export async function registerByEmail(email: string, password: string, verifyCode: string, options: RpcOptions) {
  const extraHeaders: Record<string, string> = {};
  if (options.clientDcr) {
    extraHeaders["x-client-dcr"] = options.clientDcr;
  }
  if (options.clientId) {
    extraHeaders["x-client-id"] = options.clientId;
  }

  // IMPORTANT: The real frontend always sends name: "" in the payload.
  // Reverse-engineered from chunk 40513: registerByEmail({verifyCode:D, name:"", email:V||"", password:P||"", authCommandCmd:{...}})
  const result = await rpcCall(
    "user.v1.UserAuthPublicService/RegisterByEmail",
    { verifyCode, name: "", email, password, authCommandCmd: options.authCommandCmd || {} },
    options,
    extraHeaders
  );

  return {
    token: (result.token as string) || (result.accessToken as string) || "",
    userId: (result.userId as string) || ((result.user as Record<string, unknown>)?.id as string) || "",
  };
}

// ============================================================
// UserService (authenticated - requires Bearer token)
// ============================================================

export async function sendPhoneVerificationCode(phoneNumber: string, regionCode: string, locale: string, options: RpcOptions) {
  await rpcCall(
    "user.v1.UserService/SendPhoneVerificationCode",
    { phoneNumber, regionCode, locale },
    options
  );
}

export async function bindPhoneTrait(phoneNumber: string, regionCode: string, phoneVerifyCode: string, options: RpcOptions) {
  await rpcCall(
    "user.v1.UserService/BindPhoneTrait",
    { phoneNumber, regionCode, phoneVerifyCode },
    options
  );
}

/**
 * Accept an invitation code to receive bonus credits (+500 for both parties).
 *
 * IMPORTANT: The real manus.im frontend (invitation/page.js) always generates a
 * FRESH x-client-dcr for this call via getDCR(true). The DCR includes a fresh
 * timestamp and fgRequestId. The rpcCall() function already handles this by
 * generating a fresh FPJS ID and regenerating DCR on every call.
 */
export async function checkInvitationCode(code: string, options: RpcOptions) {
  // rpcCall() already generates a fresh FPJS ID and regenerates DCR,
  // so no need for explicit regeneration here anymore
  const result = await rpcCall(
    "user.v1.UserService/CheckInvitationCode",
    { code },
    options
  );
  return result;
}

/**
 * Get available credits for the authenticated user.
 * Used to verify if an invitation code was successfully applied.
 *
 * Response fields:
 *   - freeCredits: number   (1000 without invite, 1500 with invite)
 *   - totalCredits: number  (freeCredits + refreshCredits)
 *   - refreshCredits: number (daily renewable, typically 300)
 *   - maxRefreshCredits: number
 *   - nextRefreshTime: string (ISO date)
 *   - refreshInterval: string ("daily")
 */
export async function getAvailableCredits(options: RpcOptions): Promise<{
  freeCredits: number;
  totalCredits: number;
  refreshCredits: number;
  maxRefreshCredits: number;
}> {
  const result = await rpcCall(
    "user.v1.UserService/GetAvailableCredits",
    {},
    options
  );
  return {
    freeCredits: (result.freeCredits as number) || 0,
    totalCredits: (result.totalCredits as number) || 0,
    refreshCredits: (result.refreshCredits as number) || 0,
    maxRefreshCredits: (result.maxRefreshCredits as number) || 0,
  };
}
