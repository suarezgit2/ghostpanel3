/**
 * Ghost Panel - Security Middleware
 * Headers de segurança, rate limiting para endpoints públicos e CORS
 */

import type { Express, Request, Response, NextFunction } from "express";

// ============================================================
// 1. SECURITY HEADERS
// ============================================================

export function securityHeaders() {
  return (_req: Request, res: Response, next: NextFunction) => {
    // Previne MIME type sniffing
    res.setHeader("X-Content-Type-Options", "nosniff");

    // Previne clickjacking (iframe embedding)
    res.setHeader("X-Frame-Options", "DENY");

    // Ativa XSS filter do navegador (legacy, mas não custa)
    res.setHeader("X-XSS-Protection", "1; mode=block");

    // Impede que o Referrer vaze informações sensíveis
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

    // Desabilita cache em respostas de API
    if (_req.path.startsWith("/api/")) {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
      res.setHeader("Pragma", "no-cache");
    }

    // Remove header que expõe a tecnologia do servidor
    res.removeHeader("X-Powered-By");

    next();
  };
}

// ============================================================
// 2. RATE LIMITING (in-memory, por IP)
// ============================================================

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimitStores = new Map<string, Map<string, RateLimitEntry>>();

function getRateLimitStore(name: string): Map<string, RateLimitEntry> {
  if (!rateLimitStores.has(name)) {
    rateLimitStores.set(name, new Map());
  }
  return rateLimitStores.get(name)!;
}

function getClientIp(req: Request): string {
  return (
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    "unknown"
  );
}

/**
 * Rate limiter genérico por IP
 * @param name - Nome do store (para separar limites por endpoint)
 * @param maxRequests - Máximo de requests por janela
 * @param windowMs - Tamanho da janela em ms
 */
export function rateLimit(name: string, maxRequests: number, windowMs: number) {
  const store = getRateLimitStore(name);

  // Cleanup periódico a cada 5 minutos
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of Array.from(store.entries())) {
      if (now > entry.resetAt) store.delete(key);
    }
  }, 5 * 60 * 1000);

  return (req: Request, res: Response, next: NextFunction) => {
    const ip = getClientIp(req);
    const now = Date.now();
    const entry = store.get(ip);

    if (!entry || now > entry.resetAt) {
      store.set(ip, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    entry.count++;

    if (entry.count > maxRequests) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({
        error: "Muitas requisições. Tente novamente mais tarde.",
        code: "RATE_LIMITED",
        retryAfterSeconds: retryAfter,
      });
      return;
    }

    next();
  };
}

// ============================================================
// 3. CORS RESTRITIVO
// ============================================================

export function restrictiveCors(allowedOrigins: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;

    // Se não tem origin (request direto, não cross-origin), permite
    if (!origin) {
      next();
      return;
    }

    // Verifica se o origin é permitido
    if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    }

    // Preflight
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }

    next();
  };
}

// ============================================================
// 4. REGISTRAR TODOS OS MIDDLEWARES
// ============================================================

export function registerSecurityMiddleware(app: Express, productionUrl?: string) {
  // Security headers em todas as respostas
  app.use(securityHeaders());

  // NOTA: CORS não é aplicado aqui pois o frontend e backend rodam na mesma origem.
  // O Express serve o frontend estático e a API no mesmo processo/porta,
  // então não há cross-origin requests em produção.

  // Rate limiting nos endpoints públicos
  // Login: 10 tentativas por 15 minutos (brute force já trata, mas isso é uma camada extra)
  app.use("/api/auth/login", rateLimit("auth-login", 10, 15 * 60 * 1000));

  // Keys check: 30 requests por minuto por IP
  app.use("/api/trpc/keys.check", rateLimit("keys-check", 30, 60 * 1000));

  // Keys redeem: 5 requests por 10 minutos por IP
  app.use("/api/trpc/keys.redeem", rateLimit("keys-redeem", 5, 10 * 60 * 1000));

  // Rate limiting global na API: 200 requests por minuto por IP
  app.use("/api/", rateLimit("api-global", 200, 60 * 1000));
}
