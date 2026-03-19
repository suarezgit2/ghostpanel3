/**
 * Manus.im RPC Client
 * ConnectRPC (connect-es) with TLS/HTTP2 Impersonation
 *
 * Format: POST https://api.manus.im/{package}.{ServiceName}/{MethodName}
 * Headers: Content-Type: application/json, Connect-Protocol-Version: 1
 *
 * ANTI-DETECTION (v5.0 — TLS Impersonation):
 * - Uses impers (curl-impersonate) for Chrome-identical TLS/HTTP2 fingerprints
 * - JA3/JA4 TLS fingerprint matches real Chrome (not Node.js)
 * - HTTP/2 SETTINGS, WINDOW_UPDATE, pseudo-header order match real Chrome
 * - DCR is regenerated FRESH on every RPC call (fresh timestamp + fgRequestId)
 * - Falls back to native fetch if curl-impersonate is not available
 */

import { httpRequest } from "../../services/httpClient";
import { fingerprintService, type BrowserProfile } from "../../services/fingerprint";
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

  // ANTI-DETECTION: Regenerate DCR fresh on EVERY call (fresh timestamp + fgRequestId)
  // This matches real browser behavior — getDCR(true) is called before each API request
  const freshDcr = fingerprintService.regenerateDcr(options.fingerprint);

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

  // Use httpClient with TLS impersonation (impers) instead of native fetch
  // The httpClient automatically:
  // - Impersonates Chrome's TLS fingerprint (JA3/JA4)
  // - Impersonates Chrome's HTTP/2 fingerprint (Akamai)
  // - Routes through proxy if provided
  // - Falls back to native fetch if curl-impersonate is not available
  const response = await httpRequest({
    method: "POST",
    url,
    headers,
    body: JSON.stringify(payload),
    proxy: options.proxy,
    userAgent: options.fingerprint.userAgent,
    timeout: 30,
  });

  const text = response.text;

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`RPC ${servicePath} (${response.status}): resposta não-JSON: ${text.substring(0, 200)}`);
  }

  // ConnectRPC returns errors with "code" field
  if (data.code && !["ok", "OK"].includes(data.code as string)) {
    const details = data.details as Array<{ debug?: { message?: string } }> | undefined;
    const debugMsg = details?.[0]?.debug?.message || (data.message as string) || "";
    throw new Error(`RPC ${servicePath} error [${data.code}]: ${debugMsg}`);
  }

  if (response.status >= 400 && !data.code) {
    throw new Error(`RPC ${servicePath} (${response.status}): ${text.substring(0, 200)}`);
  }

  return data;
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

  const result = await rpcCall(
    "user.v1.UserAuthPublicService/RegisterByEmail",
    { email, password, verifyCode, authCommandCmd: options.authCommandCmd || {} },
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
 * regenerating DCR on every call, but we keep explicit regeneration here for clarity.
 */
export async function checkInvitationCode(code: string, options: RpcOptions) {
  // DCR is already regenerated inside rpcCall(), but we explicitly pass a fresh one
  // to make the intent clear and ensure the header override takes effect
  const freshDcr = fingerprintService.regenerateDcr(options.fingerprint);

  const result = await rpcCall(
    "user.v1.UserService/CheckInvitationCode",
    { code },
    options,
    { "x-client-dcr": freshDcr }
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
