/**
 * API Tokens Router - Geração e gerenciamento de tokens para acesso programático
 */

import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import crypto from "crypto";
import { router, protectedProcedure } from "../_core/trpc";
import { getDb } from "../db";
import { apiTokens } from "../../drizzle/schema";

/**
 * Gera um token seguro no formato: gp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
 * Retorna { raw, hash, prefix }
 */
function generateApiToken(): { raw: string; hash: string; prefix: string } {
  const randomBytes = crypto.randomBytes(32).toString("hex");
  const raw = `gp_${randomBytes}`;
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  const prefix = `gp_${randomBytes.slice(0, 8)}...`;
  return { raw, hash, prefix };
}

/**
 * Verifica um token raw contra o hash armazenado
 */
export function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export const apiTokensRouter = router({
  list: protectedProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    const tokens = await db.select({
      id: apiTokens.id,
      name: apiTokens.name,
      tokenPrefix: apiTokens.tokenPrefix,
      permissions: apiTokens.permissions,
      lastUsedAt: apiTokens.lastUsedAt,
      expiresAt: apiTokens.expiresAt,
      revoked: apiTokens.revoked,
      createdAt: apiTokens.createdAt,
    }).from(apiTokens).orderBy(desc(apiTokens.createdAt));
    return tokens;
  }),

  generate: protectedProcedure
    .input(z.object({
      name: z.string().min(1).max(128),
      permissions: z.enum(["full", "read", "jobs_only"]).default("full"),
      expiresInDays: z.number().min(1).max(365).optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database não disponível");

      const { raw, hash, prefix } = generateApiToken();

      const expiresAt = input.expiresInDays
        ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000)
        : null;

      await db.insert(apiTokens).values({
        name: input.name,
        tokenHash: hash,
        tokenPrefix: prefix,
        permissions: input.permissions,
        expiresAt,
      });

      // Retorna o token raw APENAS neste momento — nunca mais será exibido
      return {
        token: raw,
        prefix,
        name: input.name,
        permissions: input.permissions,
        expiresAt,
        warning: "Copie este token agora. Ele não será exibido novamente.",
      };
    }),

  revoke: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database não disponível");

      await db.update(apiTokens).set({ revoked: true }).where(eq(apiTokens.id, input.id));
      return { success: true };
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database não disponível");

      await db.delete(apiTokens).where(eq(apiTokens.id, input.id));
      return { success: true };
    }),
});
