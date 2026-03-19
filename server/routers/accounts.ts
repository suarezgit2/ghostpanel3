/**
 * Accounts Router - Listagem e gerenciamento de contas criadas
 */

import { z } from "zod";
import { eq, desc, sql, like } from "drizzle-orm";
import { router, protectedProcedure } from "../_core/trpc";
import { getDb } from "../db";
import { accounts } from "../../drizzle/schema";

export const accountsRouter = router({
  list: protectedProcedure
    .input(z.object({
      page: z.number().min(1).default(1),
      limit: z.number().min(1).max(100).default(50),
      status: z.enum(["active", "banned", "suspended", "unverified", "failed"]).optional(),
      search: z.string().optional(),
      jobId: z.number().optional(),
    }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { accounts: [], total: 0 };

      const page = input?.page || 1;
      const limit = input?.limit || 50;
      const offset = (page - 1) * limit;

      let query = db.select().from(accounts);
      let countQuery = db.select({ count: sql<number>`count(*)` }).from(accounts);

      if (input?.status) {
        query = query.where(eq(accounts.status, input.status)) as typeof query;
        countQuery = countQuery.where(eq(accounts.status, input.status)) as typeof countQuery;
      }

      if (input?.search) {
        query = query.where(like(accounts.email, `%${input.search}%`)) as typeof query;
        countQuery = countQuery.where(like(accounts.email, `%${input.search}%`)) as typeof countQuery;
      }

      if (input?.jobId) {
        query = query.where(eq(accounts.jobId, input.jobId)) as typeof query;
        countQuery = countQuery.where(eq(accounts.jobId, input.jobId)) as typeof countQuery;
      }

      const [totalResult] = await countQuery;
      const rows = await query.orderBy(desc(accounts.createdAt)).limit(limit).offset(offset);

      return {
        accounts: rows,
        total: totalResult?.count || 0,
      };
    }),

  getById: protectedProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return null;

      const result = await db.select().from(accounts).where(eq(accounts.id, input.id)).limit(1);
      return result[0] || null;
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database não disponível");

      await db.delete(accounts).where(eq(accounts.id, input.id));
      return { success: true };
    }),

  exportAll: protectedProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];

    return await db
      .select({
        email: accounts.email,
        password: accounts.password,
        phone: accounts.phone,
        status: accounts.status,
        createdAt: accounts.createdAt,
      })
      .from(accounts)
      .where(eq(accounts.status, "active"))
      .orderBy(desc(accounts.createdAt));
  }),
});
