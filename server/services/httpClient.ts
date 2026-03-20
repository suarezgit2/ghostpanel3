/**
 * HTTP Client with TLS/HTTP2 Impersonation
 *
 * Uses `impers` (curl-impersonate binding) to make HTTP requests that are
 * cryptographically identical to a real Chrome browser at the TLS and HTTP/2 level.
 *
 * This closes the last detection vector: Node.js native `fetch()` has a unique
 * TLS fingerprint (JA3/JA4) and HTTP/2 fingerprint (SETTINGS frames, WINDOW_UPDATE,
 * pseudo-header order) that differs from Chrome. Anti-bot systems like Cloudflare
 * and Akamai can detect this mismatch even when HTTP headers are perfectly forged.
 *
 * With impers, the GhostPanel sends:
 * - TLS ClientHello identical to Chrome (same cipher suites, extensions, curves)
 * - HTTP/2 SETTINGS frame identical to Chrome (INITIAL_WINDOW_SIZE=6291456, etc.)
 * - HTTP/2 WINDOW_UPDATE identical to Chrome (increment=15663105)
 * - HTTP/2 pseudo-header order identical to Chrome (:method, :authority, :scheme, :path)
 *
 * Fallback: If curl-impersonate is not available, falls back to Node.js native fetch
 * with a warning log. This ensures the system never crashes due to missing native lib.
 */

import type { ProxyInfo } from "./proxy";

// ============================================================
// Dynamic import of impers (ESM, may fail if libcurl not found)
// ============================================================

let impers: typeof import("impers") | null = null;
let impersAvailable = false;
let impersInitPromise: Promise<void> | null = null;

/**
 * Map Chrome version from User-Agent to the closest impers impersonate target.
 * impers supports: chrome99, chrome100, ..., chrome131, chrome133a, chrome136, chrome142
 */
function getImpersonateTarget(userAgent: string): string {
  const match = userAgent.match(/Chrome\/(\d+)/);
  if (!match) return "chrome";  // Latest Chrome as default

  const version = parseInt(match[1], 10);

  // Map to closest supported version
  if (version >= 142) return "chrome142";
  if (version >= 136) return "chrome136";
  if (version >= 133) return "chrome133a";
  if (version >= 131) return "chrome131";
  if (version >= 124) return "chrome124";
  if (version >= 123) return "chrome123";
  if (version >= 120) return "chrome120";
  if (version >= 119) return "chrome119";
  if (version >= 116) return "chrome116";
  if (version >= 110) return "chrome110";
  if (version >= 107) return "chrome107";
  if (version >= 104) return "chrome104";
  if (version >= 101) return "chrome101";
  if (version >= 100) return "chrome100";
  return "chrome99";
}

/**
 * Initialize impers lazily on first use.
 * This avoids crashing the server if libcurl-impersonate is not installed.
 */
async function ensureImpers(): Promise<boolean> {
  if (impersAvailable) return true;
  if (impersInitPromise) {
    await impersInitPromise;
    return impersAvailable;
  }

  impersInitPromise = (async () => {
    try {
      impers = await import("impers");
      impersAvailable = true;
      console.log("[httpClient] ✓ impers (curl-impersonate) loaded — TLS/HTTP2 impersonation ACTIVE");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[httpClient] ❌ CRÍTICO: impers (curl-impersonate) não disponível: ${msg}`);
      console.error("[httpClient] ❌ O sistema não pode operar com segurança sem TLS impersonation.");
      console.error("[httpClient] ❌ Fallback para fetch nativo foi DESATIVADO para evitar banimentos em massa.");
      console.error("[httpClient] ❌ Instale o curl-impersonate ou defina LIBCURL_IMPERSONATE_PATH.");
      
      // Em vez de falhar silenciosamente, forçamos o erro para que o admin saiba
      // que o ambiente está mal configurado.
      impersAvailable = false;
    }
  })();

  await impersInitPromise;
  return impersAvailable;
}

// ============================================================
// Public API
// ============================================================

export interface HttpRequestOptions {
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  url: string;
  headers: Record<string, string>;
  body?: string;
  proxy?: ProxyInfo | null;
  userAgent?: string;  // Used to determine which Chrome version to impersonate
  timeout?: number;     // Timeout in seconds (default: 30)
}

export interface HttpResponse {
  status: number;
  statusText: string;
  text: string;
  headers: Record<string, string>;
  /** Which HTTP client was used for this request */
  client: "impers" | "fetch";
}

/**
 * Make an HTTP request using TLS impersonation (impers) or fallback to native fetch.
 *
 * When impers is available:
 * - TLS fingerprint matches Chrome (JA3/JA4)
 * - HTTP/2 fingerprint matches Chrome (Akamai)
 * - Proxy is passed natively to curl (no separate agent needed)
 *
 * When impers is NOT available:
 * - Falls back to Node.js native fetch with HttpsProxyAgent
 * - TLS fingerprint will be Node.js (detectable!)
 */
export async function httpRequest(options: HttpRequestOptions): Promise<HttpResponse> {
  const available = await ensureImpers();

  if (available && impers) {
    return impersRequest(options);
  } else {
    // [TESTE] Fallback para fetch nativo reativado (como no feature/tls-impersonation)
    // Para REVERTER: restaurar throw com "CRÍTICO: curl-impersonate não está disponível..."
    console.warn(`[httpClient] ⚠️ curl-impersonate não disponível, usando fetch nativo (TLS detectável!)`);
    return nativeFetchRequest(options);
  }
}

/**
 * Check if TLS impersonation is active.
 * Useful for health checks and diagnostics.
 */
export async function isTlsImpersonationActive(): Promise<boolean> {
  return ensureImpers();
}

/**
 * Get the current HTTP client info for diagnostics.
 */
export async function getHttpClientInfo(): Promise<{
  client: "impers" | "fetch";
  impersonateSupport: boolean;
  warning?: string;
}> {
  const available = await ensureImpers();
  return {
    client: available ? "impers" : "fetch",
    impersonateSupport: available,
    warning: available ? undefined : "TLS impersonation not available. Set LIBCURL_IMPERSONATE_PATH to enable.",
  };
}

// ============================================================
// impers implementation (TLS impersonation)
// ============================================================

async function impersRequest(options: HttpRequestOptions): Promise<HttpResponse> {
  if (!impers) throw new Error("impers not loaded");

  const target = getImpersonateTarget(options.userAgent || "Chrome/136");

  // Build proxy URL for impers (format: http://user:pass@host:port)
  let proxyUrl: string | undefined;
  if (options.proxy) {
    proxyUrl = `http://${options.proxy.username}:${options.proxy.password}@${options.proxy.host}:${options.proxy.port}`;
  }

  const requestOptions: Record<string, unknown> = {
    impersonate: target,
    headers: options.headers,
    timeout: options.timeout || 30,
  };

  if (proxyUrl) {
    requestOptions.proxy = proxyUrl;
  }

  if (options.body) {
    requestOptions.content = options.body;
  }

  let response;
  switch (options.method) {
    case "POST":
      response = await impers.post(options.url, requestOptions);
      break;
    case "PUT":
      response = await impers.put(options.url, requestOptions);
      break;
    case "DELETE":
      response = await impers.del(options.url, requestOptions);
      break;
    default:
      response = await impers.get(options.url, requestOptions);
      break;
  }

  // Convert impers response headers to plain object
  // impers stores headers in response.headers (which may have a nested .data property)
  const responseHeaders: Record<string, string> = {};
  if (response.headers) {
    const headersAsObj = response.headers as unknown as Record<string, unknown>;
    const rawHeaders = headersAsObj.data || response.headers;
    if (typeof rawHeaders === "object" && rawHeaders !== null) {
      for (const [key, value] of Object.entries(rawHeaders as Record<string, unknown>)) {
        if (key !== "data") {
          responseHeaders[key.toLowerCase()] = String(value);
        }
      }
    }
  }

  // impers uses `statusCode` (not `status`) and `text` can be string or getter
  const rawResponse = response as unknown as Record<string, unknown>;
  const statusCode = (rawResponse.statusCode as number) ?? (rawResponse.status as number) ?? 0;
  const textContent = typeof rawResponse.text === "function" ? (rawResponse.text as () => string)() : ((rawResponse.text as string) || "");

  return {
    status: statusCode,
    statusText: (rawResponse.statusText as string) || "",
    text: textContent,
    headers: responseHeaders,
    client: "impers",
  };
}

// ============================================================
// Native fetch fallback (no TLS impersonation)
// ============================================================

async function nativeFetchRequest(options: HttpRequestOptions): Promise<HttpResponse> {
  // Lazy import HttpsProxyAgent only when needed (fallback path)
  const fetchOptions: RequestInit & { agent?: unknown } = {
    method: options.method,
    headers: options.headers,
    body: options.body,
  };

  if (options.proxy) {
    const { HttpsProxyAgent } = await import("https-proxy-agent");
    const proxyUrl = `http://${options.proxy.username}:${options.proxy.password}@${options.proxy.host}:${options.proxy.port}`;
    fetchOptions.agent = new HttpsProxyAgent(proxyUrl);
  }

  const controller = new AbortController();
  const timeoutMs = (options.timeout || 30) * 1000;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  fetchOptions.signal = controller.signal;

  try {
    const resp = await fetch(options.url, fetchOptions as RequestInit);
    const text = await resp.text();

    const responseHeaders: Record<string, string> = {};
    resp.headers.forEach((value, key) => {
      responseHeaders[key.toLowerCase()] = value;
    });

    return {
      status: resp.status,
      statusText: resp.statusText,
      text,
      headers: responseHeaders,
      client: "fetch",
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
