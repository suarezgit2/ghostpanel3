/**
 * Proxies Router - Sincronização e gerenciamento de proxies
 * Updated: single-use proxy policy with auto-replacement
 */

import { z } from "zod";
import { eq, desc, sql } from "drizzle-orm";
import { router, protectedProcedure } from "../_core/trpc";
import { getDb } from "../db";
import { proxies } from "../../drizzle/schema";
import { proxyService } from "../services/proxy";

export const proxiesRouter = router({
  list: protectedProcedure.query(async () => {
    return await proxyService.listAll();
  }),

  stats: protectedProcedure.query(async () => {
    const details = await proxyService.getDetailedStats();
    return {
      total: details.total,
      active: details.available,
      bad: details.used,
      available: details.available,
      used: details.used,
      isReplacing: details.isReplacing,
      queueLength: details.queueLength,
    };
  }),

  sync: protectedProcedure.mutation(async () => {
    const count = await proxyService.syncFromWebshare();
    return { synced: count };
  }),

  toggle: protectedProcedure
    .input(z.object({ id: z.number(), enabled: z.boolean() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database não disponível");

      await db.update(proxies).set({ enabled: input.enabled }).where(eq(proxies.id, input.id));
      return { success: true };
    }),

  resetFails: protectedProcedure.mutation(async () => {
    const db = await getDb();
    if (!db) throw new Error("Database não disponível");

    // Reset all proxies: enable them and clear lastUsedAt so they can be used again
    await db.update(proxies).set({ failCount: 0, enabled: true, lastUsedAt: null }).where(sql`1=1`);
    return { success: true };
  }),

  replaceAll: protectedProcedure.mutation(async () => {
    const count = await proxyService.replaceAllProxies();
    return { replaced: count };
  }),

  usageStats: protectedProcedure.query(async () => {
    return await proxyService.getDetailedStats();
  }),
});
