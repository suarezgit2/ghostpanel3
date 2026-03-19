/**
 * Manus.im RPC Client
 * ConnectRPC (connect-es) with HTTP proxy support
 *
 * Format: POST https://api.manus.im/{package}.{ServiceName}/{MethodName}
 * Headers: Content-Type: application/json, Connect-Protocol-Version: 1
 */

import { HttpsProxyAgent } from "https-proxy-agent";
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
  const headers = fingerprintService.getOrderedHeaders(options.fingerprint);

  // ConnectRPC required headers
  headers["Connect-Protocol-Version"] = "1";

  if (options.authToken) {
    headers["Authorization"] = `Bearer ${options.authToken}`;
  }

  // Merge extra headers (e.g., x-client-dcr, x-client-id)
  if (extraHeaders) {
    Object.assign(headers, extraHeaders);
  }

  const fetchOptions: RequestInit & { agent?: unknown } = {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  };

  // Proxy support
  if (options.proxy) {
    const proxyUrl = `http://${options.proxy.username}:${options.proxy.password}@${options.proxy.host}:${options.proxy.port}`;
    fetchOptions.agent = new HttpsProxyAgent(proxyUrl);
  }

  const resp = await fetch(url, fetchOptions as RequestInit);
  const text = await resp.text();

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`RPC ${servicePath} (${resp.status}): resposta não-JSON: ${text.substring(0, 200)}`);
  }

  // ConnectRPC returns errors with "code" field
  if (data.code && !["ok", "OK"].includes(data.code as string)) {
    const details = data.details as Array<{ debug?: { message?: string } }> | undefined;
    const debugMsg = details?.[0]?.debug?.message || (data.message as string) || "";
    throw new Error(`RPC ${servicePath} error [${data.code}]: ${debugMsg}`);
  }

  if (!resp.ok && !data.code) {
    throw new Error(`RPC ${servicePath} (${resp.status}): ${text.substring(0, 200)}`);
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
 * timestamp and fgRequestId. We regenerate the DCR here to match this behavior.
 *
 * The call signature in the real frontend:
 *   await UserService.checkInvitationCode({ code }, { headers: { "x-client-dcr": freshDcr } })
 */
export async function checkInvitationCode(code: string, options: RpcOptions) {
  // Generate a fresh DCR with updated timestamp (matches real browser behavior)
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
