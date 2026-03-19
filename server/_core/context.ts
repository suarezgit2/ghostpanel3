import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import type { User } from "../../drizzle/schema";
import { ENV } from "./env";
import { sdk } from "./sdk";
import * as db from "../db";
import { getUserFromRequest } from "./localAuth";
import { hashToken } from "../routers/apiTokens";
import { getDb } from "../db";
import { apiTokens } from "../../drizzle/schema";
import { eq, and } from "drizzle-orm";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: User | null;
};

/**
 * Valida um Bearer Token contra o banco de dados
 * Retorna o usuário admin se o token for válido
 */
async function getUserFromBearerToken(req: CreateExpressContextOptions["req"]): Promise<User | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return null;

  const rawToken = authHeader.slice(7).trim();
  if (!rawToken || !rawToken.startsWith("gp_")) return null;

  try {
    const tokenHash = hashToken(rawToken);
    const database = await getDb();
    if (!database) return null;

    const [token] = await database
      .select()
      .from(apiTokens)
      .where(
        and(
          eq(apiTokens.tokenHash, tokenHash),
          eq(apiTokens.revoked, false)
        )
      )
      .limit(1);

    if (!token) return null;

    // Verificar expiração
    if (token.expiresAt && new Date(token.expiresAt) < new Date()) return null;

    // Atualizar lastUsedAt (fire-and-forget)
    database
      .update(apiTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiTokens.id, token.id))
      .catch(() => {});

    // Retornar o usuário admin (API tokens sempre autenticam como admin)
    const localOpenId = "local-dev-admin";
    return await db.getUserByOpenId(localOpenId);
  } catch {
    return null;
  }
}

export async function createContext(
  opts: CreateExpressContextOptions
): Promise<TrpcContext> {
  let user: User | null = null;

  // 1. Tentar Bearer Token primeiro (acesso programático)
  user = await getUserFromBearerToken(opts.req);

  // 2. Se não tem Bearer Token, tentar autenticação normal
  if (!user) {
    if (ENV.localAuth) {
      // Modo LOCAL_AUTH: autenticação via JWT cookie (login por senha)
      const jwtPayload = getUserFromRequest(opts.req);
      if (jwtPayload) {
        user = await db.getUserByOpenId(jwtPayload.openId);
      }
    } else {
      // Modo normal: autenticação via Manus OAuth
      try {
        user = await sdk.authenticateRequest(opts.req);
      } catch {
        user = null;
      }
    }
  }

  return {
    req: opts.req,
    res: opts.res,
    user,
  };
}
