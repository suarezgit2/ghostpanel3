/**
 * Manus.im RPC Client
 * ConnectRPC (connect-es) with TLS/HTTP2 Impersonation
 *
 * Format: POST https://api.manus.im/{package}.{ServiceName}/{MethodName}
 * Headers: Content-Type: application/json, Connect-Protocol-Version: 1
 *
 * ANTI-DETECTION (v6.0 — FPJS Direct POST):
 * - Uses impers (curl-impersonate) for Chrome-identical TLS/HTTP2 fingerprints
 * - JA3/JA4 TLS fingerprint matches real Chrome (not Node.js)
 * - HTTP/2 SETTINGS, WINDOW_UPDATE, pseudo-header order match real Chrome
 * - DCR is regenerated FRESH on every RPC call (fresh timestamp + fresh fgRequestId)
 * - Each RPC call generates a FRESH real FPJS Pro requestId via HTTP POST direto
 *   (reverse-engineered FPJS XOR obfuscation — NO Puppeteer needed)
 * - FPJS POST is routed through the SAME proxy as RPC calls (IP consistency)
 * - No browser process, no bot detection, no webdriver flag
 * - ~100-500ms per requestId instead of 5-10s with Puppeteer
 * - Falls back to native fetch if curl-impersonate is not available
 */

import { httpRequest } from "../../services/httpClient";
import { fingerprintService, type BrowserProfile } from "../../services/fingerprint";
import { getRequestIdDirect } from "../../services/fpjsDirectClient";
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

async function rpcCall(
  servicePath: string,
  payload: Record<string, unknown>,
  options: RpcOptions,
  extraHeaders?: Record<string, string>
): Promise<Record<string, unknown>> {
  const url = `${API_BASE}/${servicePath}`;

  // v6.0: Generate a FRESH real FPJS Pro requestId via HTTP POST direto.
  // Reverse-engineered FPJS XOR obfuscation — NO Puppeteer/browser needed.
  // Uses the SAME proxy as RPC calls for IP consistency.
  // ~100-500ms per call vs 5-10s with Puppeteer.
  let freshFgRequestId: string | undefined;
  try {
    freshFgRequestId = await getRequestIdDirect(options.fingerprint, options.proxy);
  } catch (err) {
    // If FPJS Direct fails, regenerateDcr will fall back to synthetic ID via generateFgRequestId()
    console.warn(`[RPC] Falha ao gerar FPJS Direct ID para ${servicePath}: ${err instanceof Error ? err.message : err}`);
  }

  // ANTI-DETECTION: Regenerate DCR fresh on EVERY call (fresh timestamp + fresh fgRequestId)
  // This matches real browser behavior — getDCR(true) is called before each API request
  const freshDcr = fingerprintService.regenerateDcr(options.fingerprint, freshFgRequestId);

  // Update the profile's DCR header with the fresh value
  const profileWithFreshDcr = {
    ...options.fingerprint,
    headers: {
      ...options.fingerprint.headers,
      "x-client-dcr": freshDcr,
    },
  };

  const headers = fingerprintService.getOrderedHeaders(profileWithFreshDcr);

  // ConnectRPC required headers
  headers["Connect-Protocol-Version"] = "1";

  if (options.authToken) {
    headers["Authorization"] = `Bearer ${options.authToken}`;
  }

  // Merge extra headers (e.g., explicit x-client-dcr override, x-client-id)
  if (extraHeaders) {
    Object.assign(headers, extraHeaders);
  }

  // RPC retry 5x com backoff exponencial e PermanentRpcError
  const MAX_RETRIES = 5;
  let attempt = 1;
  let lastError: Error | null = null;

  while (attempt <= MAX_RETRIES) {
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
        
        const permanentErrors = ["invalid_argument", "unauthenticated", "not_found", "already_exists", "permission_denied"];
        if (permanentErrors.includes(data.code as string)) {
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
      
      const backoff = Math.min(2000 * Math.pow(2, attempt - 1) + Math.random() * 1000, 30000);
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
