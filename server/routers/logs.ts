/**
 * Logs Router - Consulta e filtragem de logs
 */

import { z } from "zod";
import { eq, desc, sql, and, like } from "drizzle-orm";
import { router, protectedProcedure } from "../_core/trpc";
import { getDb } from "../db";
import { logs } from "../../drizzle/schema";

export const logsRouter = router({
  list: protectedProcedure
    .input(z.object({
      page: z.number().min(1).default(1),
      limit: z.number().min(1).max(200).default(100),
      level: z.enum(["info", "warn", "error", "debug"]).optional(),
      source: z.string().optional(),
      jobId: z.number().optional(),
      search: z.string().optional(),
    }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { logs: [], total: 0 };

      const page = input?.page || 1;
      const limit = input?.limit || 100;
      const offset = (page - 1) * limit;

      const conditions = [];
      if (input?.level) conditions.push(eq(logs.level, input.level));
      if (input?.source) conditions.push(eq(logs.source, input.source));
      if (input?.jobId) conditions.push(eq(logs.jobId, input.jobId));
      if (input?.search) conditions.push(like(logs.message, `%${input.search}%`));

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const [totalResult] = await db
        .select({ count: sql<number>`count(*)` })
        .from(logs)
        .where(whereClause);

      const rows = await db
        .select()
        .from(logs)
        .where(whereClause)
        .orderBy(desc(logs.id))
        .limit(limit)
        .offset(offset);

      return {
        logs: rows,
        total: totalResult?.count || 0,
      };
    }),

  clear: protectedProcedure.mutation(async () => {
    const db = await getDb();
    if (!db) throw new Error("Database não disponível");

    await db.delete(logs).where(sql`1=1`);
    return { success: true };
  }),
});
