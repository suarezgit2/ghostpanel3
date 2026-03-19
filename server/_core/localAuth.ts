/**
 * Ghost Panel - Sistema de Autenticação Local
 * Login por senha com JWT, proteção brute force e logs de acesso
 */
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { Express, Request, Response } from "express";
import { ENV } from "./env";
import * as db from "../db";
import { logger } from "../utils/helpers";

const JWT_SECRET = ENV.cookieSecret || "ghost-panel-secret-change-me";
const JWT_EXPIRES_IN = "7d";
const COOKIE_NAME = "ghost_auth";
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 dias

// Brute force protection: in-memory store
interface BruteForceEntry {
  attempts: number;
  firstAttempt: number;
  lockedUntil?: number;
}
const bruteForceStore = new Map<string, BruteForceEntry>();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutos
const LOCK_MS = 30 * 60 * 1000;   // 30 minutos de bloqueio

function getClientIp(req: Request): string {
  return (
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    "unknown"
  );
}

function checkBruteForce(ip: string): { blocked: boolean; remainingMs?: number } {
  const entry = bruteForceStore.get(ip);
  if (!entry) return { blocked: false };

  const now = Date.now();

  // Se está bloqueado
  if (entry.lockedUntil && now < entry.lockedUntil) {
    return { blocked: true, remainingMs: entry.lockedUntil - now };
  }

  // Resetar se a janela expirou
  if (now - entry.firstAttempt > WINDOW_MS) {
    bruteForceStore.delete(ip);
    return { blocked: false };
  }

  return { blocked: false };
}

function recordFailedAttempt(ip: string): void {
  const now = Date.now();
  const entry = bruteForceStore.get(ip) || { attempts: 0, firstAttempt: now };

  // Resetar janela se expirou
  if (now - entry.firstAttempt > WINDOW_MS) {
    entry.attempts = 0;
    entry.firstAttempt = now;
    entry.lockedUntil = undefined;
  }

  entry.attempts++;

  if (entry.attempts >= MAX_ATTEMPTS) {
    entry.lockedUntil = now + LOCK_MS;
  }

  bruteForceStore.set(ip, entry);
}

function clearBruteForce(ip: string): void {
  bruteForceStore.delete(ip);
}

export function registerLocalAuthRoutes(app: Express) {
  // POST /api/auth/login
  app.post("/api/auth/login", async (req: Request, res: Response) => {
    const ip = getClientIp(req);
    const { password } = req.body as { password?: string };

    // Verificar brute force
    const bruteCheck = checkBruteForce(ip);
    if (bruteCheck.blocked) {
      const minutesLeft = Math.ceil((bruteCheck.remainingMs || 0) / 60000);
      await logger.warn("auth", `Login bloqueado por brute force: IP ${ip}`, { ip });
      res.status(429).json({
        error: `Muitas tentativas. Tente novamente em ${minutesLeft} minutos.`,
        code: "RATE_LIMITED",
      });
      return;
    }

    if (!password) {
      res.status(400).json({ error: "Senha obrigatória", code: "MISSING_PASSWORD" });
      return;
    }

    // Buscar hash da senha no banco
    const storedHash = await getAdminPasswordHash();

    if (!storedHash) {
      // Primeira execução: criar senha padrão
      await logger.warn("auth", "Nenhuma senha configurada. Configure via ADMIN_PASSWORD_HASH.", { ip });
      res.status(503).json({ error: "Sistema não configurado. Defina a senha do admin.", code: "NOT_CONFIGURED" });
      return;
    }

    // Verificar senha
    const isValid = await bcrypt.compare(password, storedHash);

    if (!isValid) {
      recordFailedAttempt(ip);
      await logger.warn("auth", `Tentativa de login falhou: IP ${ip}`, { ip });
      res.status(401).json({
        error: "Credenciais inválidas",
        code: "INVALID_CREDENTIALS",
      });
      return;
    }

    // Login bem-sucedido
    clearBruteForce(ip);
    await logger.info("auth", `Login bem-sucedido: IP ${ip}`, { ip });

    // Garantir que o usuário admin existe no banco
    const localOpenId = "local-dev-admin";
    let user = await db.getUserByOpenId(localOpenId);
    if (!user) {
      await db.upsertUser({
        openId: localOpenId,
        name: "Ghost Admin",
        email: "admin@ghost.local",
        loginMethod: "local",
        role: "admin",
        lastSignedIn: new Date(),
      });
      user = await db.getUserByOpenId(localOpenId);
    } else {
      await db.upsertUser({
        openId: localOpenId,
        name: user.name || "Ghost Admin",
        email: user.email || "admin@ghost.local",
        loginMethod: "local",
        role: "admin",
        lastSignedIn: new Date(),
      });
    }

    // Gerar JWT
    const token = jwt.sign(
      { openId: localOpenId, role: "admin" },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    // Setar cookie httpOnly
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure: ENV.isProduction,
      sameSite: "lax",
      maxAge: COOKIE_MAX_AGE,
      path: "/",
    });

    res.json({ success: true, message: "Login realizado com sucesso" });
  });

  // POST /api/auth/logout
  app.post("/api/auth/logout", (req: Request, res: Response) => {
    const ip = getClientIp(req);
    logger.info("auth", `Logout: IP ${ip}`, { ip }).catch(() => {});
    res.clearCookie(COOKIE_NAME, { path: "/" });
    res.json({ success: true });
  });

  // GET /api/auth/status
  app.get("/api/auth/status", (req: Request, res: Response) => {
    const token = req.cookies?.[COOKIE_NAME];
    if (!token) {
      res.json({ authenticated: false });
      return;
    }
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as { openId: string; role: string };
      res.json({ authenticated: true, role: decoded.role });
    } catch {
      res.clearCookie(COOKIE_NAME, { path: "/" });
      res.json({ authenticated: false });
    }
  });
}

/**
 * Middleware para verificar autenticação via JWT cookie
 */
export function requireLocalAuth(req: Request, res: Response, next: () => void): void {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) {
    res.status(401).json({ error: "Não autenticado", code: "UNAUTHORIZED" });
    return;
  }
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.clearCookie(COOKIE_NAME, { path: "/" });
    res.status(401).json({ error: "Sessão expirada", code: "SESSION_EXPIRED" });
  }
}

/**
 * Extrai o usuário do JWT para uso no contexto tRPC
 */
export function getUserFromRequest(req: Request): { openId: string; role: string } | null {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET) as { openId: string; role: string };
  } catch {
    return null;
  }
}

/**
 * Busca o hash da senha admin no banco de dados
 */
async function getAdminPasswordHash(): Promise<string | null> {
  // Primeiro tenta variável de ambiente (para setup inicial)
  if (ENV.adminPasswordHash) return ENV.adminPasswordHash;

  // Depois tenta no banco
  try {
    const { getSetting } = await import("../utils/settings");
    return await getSetting("admin_password_hash");
  } catch {
    return null;
  }
}

/**
 * Utilitário para gerar hash de senha (uso no setup)
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}
