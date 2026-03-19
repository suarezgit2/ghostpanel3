/**
 * Jobs Router - Criação e gerenciamento de jobs
 */

import { z } from "zod";
import { eq, desc, sql } from "drizzle-orm";
import { router, protectedProcedure } from "../_core/trpc";
import { getDb } from "../db";
import { jobs, accounts } from "../../drizzle/schema";
import { orchestrator } from "../core/orchestrator";

export const jobsRouter = router({
  list: protectedProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];

    return await db.select().from(jobs).orderBy(desc(jobs.createdAt)).limit(100);
  }),

  getById: protectedProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return null;

      const result = await db.select().from(jobs).where(eq(jobs.id, input.id)).limit(1);
      if (result.length === 0) return null;

      // Get accounts for this job
      const jobAccounts = await db.select().from(accounts).where(eq(accounts.jobId, input.id)).orderBy(desc(accounts.createdAt));

      return { ...result[0], accounts: jobAccounts };
    }),

  create: protectedProcedure
    .input(z.object({
      provider: z.string().default("manus"),
      quantity: z.number().min(1).max(1000),
      password: z.string().optional(),
      region: z.string().optional(),
      concurrency: z.number().min(1).max(5).optional(),
      inviteCode: z.string().optional(),
      label: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const jobId = await orchestrator.createJob({
        provider: input.provider,
        quantity: input.quantity,
        password: input.password,
        region: input.region,
        concurrency: input.concurrency,
        inviteCode: input.inviteCode,
        label: input.label,
      });

      return { jobId };
    }),

  /**
   * Job Rápido - Envio de créditos para múltiplos destinatários
   * Cada conta envia 500 créditos. Cria jobs independentes por destinatário.
   */
  quickJob: protectedProcedure
    .input(z.object({
      recipients: z.array(z.object({
        inviteCode: z.string().min(1, "Código de convite obrigatório"),
        credits: z.number().min(500, "Mínimo 500 créditos").max(500000),
        label: z.string().optional(),
      })).min(1).max(50),
    }))
    .mutation(async ({ input }) => {
      const result = await orchestrator.createQuickJobs(input.recipients);
      return result;
    }),

  cancel: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      await orchestrator.cancelJob(input.id);
      return { success: true };
    }),

  pause: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      await orchestrator.pauseJob(input.id);
      return { success: true };
    }),

  getActive: protectedProcedure.query(async () => {
    return { activeJobIds: orchestrator.getActiveJobs() };
  }),
});
