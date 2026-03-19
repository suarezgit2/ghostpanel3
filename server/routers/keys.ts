/**
 * Keys Router - Geração e gerenciamento de chaves de acesso
 */

import { z } from "zod";
import { eq, desc, sql } from "drizzle-orm";
import { router, protectedProcedure, publicProcedure } from "../_core/trpc";
import { getDb } from "../db";
import { keys } from "../../drizzle/schema";
import crypto from "crypto";
import { extractInviteCode } from "../utils/helpers";

function generateKeyCode(): string {
  // Format: GHOST-XXXX-XXXX-XXXX (uppercase alphanumeric, no ambiguous chars)
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const segment = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return `GHOST-${segment()}-${segment()}-${segment()}`;
}

export const keysRouter = router({
  list: protectedProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    return await db.select().from(keys).orderBy(desc(keys.createdAt)).limit(500);
  }),

  stats: protectedProcedure.query(async () => {
    const db = await getDb();
    if (!db) return { total: 0, active: 0, redeemed: 0, expired: 0 };

    const [result] = await db.select({
      total: sql<number>`count(*)`,
      active: sql<number>`sum(case when status = 'active' then 1 else 0 end)`,
      redeemed: sql<number>`sum(case when status = 'redeemed' then 1 else 0 end)`,
      expired: sql<number>`sum(case when status = 'expired' then 1 else 0 end)`,
      totalCreditsActive: sql<number>`sum(case when status = 'active' then credits else 0 end)`,
      totalCreditsRedeemed: sql<number>`sum(case when status = 'redeemed' then credits else 0 end)`,
    }).from(keys);

    return {
      total: result?.total || 0,
      active: result?.active || 0,
      redeemed: result?.redeemed || 0,
      expired: result?.expired || 0,
      totalCreditsActive: result?.totalCreditsActive || 0,
      totalCreditsRedeemed: result?.totalCreditsRedeemed || 0,
    };
  }),

  generate: protectedProcedure
    .input(z.object({
      credits: z.number().min(500).max(1000000),
      quantity: z.number().min(1).max(100).default(1),
      label: z.string().max(256).optional(),
      expiresInDays: z.number().min(1).max(365).optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database não disponível");

      const expiresAt = input.expiresInDays
        ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000)
        : null;

      const newKeys: Array<{ code: string; credits: number; label?: string | null; expiresAt?: Date | null }> = [];

      for (let i = 0; i < input.quantity; i++) {
        // Ensure unique code
        let code: string;
        let attempts = 0;
        do {
          code = generateKeyCode();
          attempts++;
          if (attempts > 10) throw new Error("Não foi possível gerar código único");
          const existing = await db.select({ id: keys.id }).from(keys).where(eq(keys.code, code)).limit(1);
          if (existing.length === 0) break;
        } while (true);

        newKeys.push({
          code,
          credits: input.credits,
          label: input.label || null,
          expiresAt,
        });
      }

      await db.insert(keys).values(newKeys);

      return { codes: newKeys.map(k => k.code), count: newKeys.length };
    }),

  revoke: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database não disponível");

      await db.update(keys).set({ status: "cancelled" }).where(eq(keys.id, input.id));
      return { success: true };
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database não disponível");

      await db.delete(keys).where(eq(keys.id, input.id));
      return { success: true };
    }),

  /**
   * Endpoint público para verificar uma key (sem autenticação)
   * Retorna mensagens genéricas para não permitir enumeração de chaves
   */
  check: publicProcedure
    .input(z.object({ code: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { valid: false, error: "Serviço indisponível" };

      const result = await db.select().from(keys).where(eq(keys.code, input.code.toUpperCase())).limit(1);

      if (result.length === 0) {
        return { valid: false, error: "Chave inválida ou não encontrada" };
      }

      const key = result[0];

      if (key.status === "redeemed") {
        return { valid: false, error: "Esta chave já foi utilizada" };
      }

      if (key.status === "cancelled" || key.status === "expired" || (key.expiresAt && new Date(key.expiresAt) < new Date())) {
        return { valid: false, error: "Chave inválida ou expirada" };
      }

      return {
        valid: true,
        credits: key.credits,
      };
    }),

  /**
   * Endpoint público para resgatar uma key
   */
  redeem: publicProcedure
    .input(z.object({
      code: z.string(),
      inviteCode: z.string().min(1, "Código de convite obrigatório"),
      name: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Serviço indisponível");

      const result = await db.select().from(keys).where(eq(keys.code, input.code.toUpperCase())).limit(1);

      if (result.length === 0) {
        throw new Error("Chave não encontrada");
      }

      const key = result[0];

      if (key.status !== "active") {
        if (key.status === "redeemed") throw new Error("Chave já foi resgatada");
        if (key.status === "cancelled") throw new Error("Chave cancelada");
        if (key.status === "expired") throw new Error("Chave expirada");
        throw new Error("Chave inválida");
      }

      if (key.expiresAt && new Date(key.expiresAt) < new Date()) {
        await db.update(keys).set({ status: "expired" }).where(eq(keys.id, key.id));
        throw new Error("Chave expirada");
      }

      // Mark as redeemed
      await db.update(keys).set({
        status: "redeemed",
        redeemedAt: new Date(),
        redeemedBy: input.name ? `${input.name} (${input.inviteCode})` : input.inviteCode,
      }).where(eq(keys.id, key.id));

      // Trigger quick job to send credits
      const { orchestrator } = await import("../core/orchestrator");
      const CREDITS_PER_ACCOUNT = 500;
      const quantity = Math.max(1, Math.floor(key.credits / CREDITS_PER_ACCOUNT));

      const cleanInviteCode = extractInviteCode(input.inviteCode);

      const jobId = await orchestrator.createJob({
        provider: "manus",
        quantity,
        inviteCode: cleanInviteCode,
        label: `Key ${key.code} → ${cleanInviteCode}`,
      });

      return {
        success: true,
        credits: key.credits,
      };
    }),
});
