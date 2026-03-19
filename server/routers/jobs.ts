/**
 * Jobs Router - Criação e gerenciamento de jobs
 */

import { z } from "zod";
import { eq, desc, sql, inArray } from "drizzle-orm";
import { router, protectedProcedure } from "../_core/trpc";
import { getDb } from "../db";
import { jobs, accounts, jobFolders } from "../../drizzle/schema";
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

      // Get folder info if job belongs to a folder
      let folder = null;
      if (result[0].folderId) {
        const folderRows = await db.select().from(jobFolders).where(eq(jobFolders.id, result[0].folderId)).limit(1);
        if (folderRows.length > 0) folder = folderRows[0];
      }

      return { ...result[0], accounts: jobAccounts, folder };
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
   * Suporta jobCount > 1 para criar múltiplos jobs agrupados em pasta por cliente
   */
  quickJob: protectedProcedure
    .input(z.object({
      recipients: z.array(z.object({
        inviteCode: z.string().min(1, "Código de convite obrigatório"),
        credits: z.number().min(500, "Mínimo 500 créditos").max(500000),
        label: z.string().optional(),
        jobCount: z.number().min(1).max(20).optional().default(1),
      })).min(1).max(50),
    }))
    .mutation(async ({ input }) => {
      const result = await orchestrator.createQuickJobs(input.recipients);
      return result;
    }),

  /**
   * Folders - Lista todas as pastas de jobs agrupados
   */
  listFolders: protectedProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];

    const folders = await db.select().from(jobFolders).orderBy(desc(jobFolders.createdAt));

    // For each folder, get the jobs inside it
    const foldersWithJobs = await Promise.all(
      folders.map(async (folder) => {
        const folderJobs = await db
          .select()
          .from(jobs)
          .where(eq(jobs.folderId, folder.id))
          .orderBy(desc(jobs.createdAt));
        return { ...folder, jobs: folderJobs };
      })
    );

    return foldersWithJobs;
  }),

  /**
   * deleteFolder - Remove uma pasta e todos os jobs dentro dela
   */
  deleteFolder: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database não disponível");

      // Get all jobs in this folder
      const folderJobs = await db.select({ id: jobs.id, status: jobs.status }).from(jobs).where(eq(jobs.folderId, input.id));

      // Check if any job is running or paused
      const activeJob = folderJobs.find(j => j.status === "running" || j.status === "paused");
      if (activeJob) {
        throw new Error(`Não é possível deletar a pasta: Job #${activeJob.id} está ${activeJob.status}. Cancele-o primeiro.`);
      }

      const jobIds = folderJobs.map(j => j.id);

      if (jobIds.length > 0) {
        await db.delete(accounts).where(inArray(accounts.jobId, jobIds));
        await db.delete(jobs).where(inArray(jobs.id, jobIds));
      }

      await db.delete(jobFolders).where(eq(jobFolders.id, input.id));

      return { success: true, deletedJobs: jobIds.length };
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

  /**
   * Resume - Retoma um job pausado
   */
  resume: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database não disponível");

      const result = await db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, input.id)).limit(1);
      if (result.length === 0) throw new Error(`Job ${input.id} não encontrado`);

      const currentStatus = result[0].status;
      if (currentStatus !== "paused") {
        throw new Error(`Job ${input.id} não está pausado (status atual: ${currentStatus})`);
      }

      await orchestrator.resumeJob(input.id);
      return { success: true };
    }),

  getActive: protectedProcedure.query(async () => {
    return { activeJobIds: orchestrator.getActiveJobs() };
  }),

  /**
   * Delete - Remove um job específico (apenas concluído, falhou ou cancelado)
   */
  delete: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database não disponível");

      const result = await db.select({ status: jobs.status, folderId: jobs.folderId }).from(jobs).where(eq(jobs.id, input.id)).limit(1);
      if (result.length === 0) throw new Error(`Job ${input.id} não encontrado`);

      const { status, folderId } = result[0];
      if (status === "running" || status === "paused") {
        throw new Error(`Não é possível deletar um job com status "${status}". Cancele-o primeiro.`);
      }

      // Deleta contas associadas e depois o job
      await db.delete(accounts).where(eq(accounts.jobId, input.id));
      await db.delete(jobs).where(eq(jobs.id, input.id));

      // If job belonged to a folder, check if folder is now empty and clean up
      if (folderId) {
        const remainingJobs = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.folderId, folderId));
        if (remainingJobs.length === 0) {
          await db.delete(jobFolders).where(eq(jobFolders.id, folderId));
        }
      }

      return { success: true };
    }),

  /**
   * deleteCompleted - Remove todos os jobs com status completed, failed ou cancelled
   */
  deleteCompleted: protectedProcedure
    .input(z.object({
      statuses: z.array(z.enum(["completed", "failed", "cancelled"])).min(1).default(["completed", "failed", "cancelled"]),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database não disponível");

      // Busca IDs dos jobs a deletar
      const toDelete = await db
        .select({ id: jobs.id, folderId: jobs.folderId })
        .from(jobs)
        .where(inArray(jobs.status, input.statuses));

      if (toDelete.length === 0) return { deleted: 0 };

      const ids = toDelete.map((j) => j.id);
      const folderIdSet = new Set(toDelete.map(j => j.folderId).filter(Boolean));
      const folderIds = Array.from(folderIdSet) as number[];

      // Deleta contas associadas e depois os jobs
      await db.delete(accounts).where(inArray(accounts.jobId, ids));
      await db.delete(jobs).where(inArray(jobs.id, ids));

      // Clean up empty folders
      for (const folderId of folderIds) {
        const remainingJobs = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.folderId, folderId));
        if (remainingJobs.length === 0) {
          await db.delete(jobFolders).where(eq(jobFolders.id, folderId));
        }
      }

      return { deleted: ids.length };
    }),

  fixStaleJobs: protectedProcedure.mutation(async () => {
    const db = await getDb();
    if (!db) throw new Error("Database não disponível");

    const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutos
    const cutoffDate = new Date(Date.now() - STALE_THRESHOLD_MS);

    // Busca jobs com status "running" que foram atualizados há mais de 30 minutos
    // e que NÃO estão na lista de jobs ativos em memória
    const activeJobIds = orchestrator.getActiveJobs();

    const runningJobs = await db
      .select({ id: jobs.id, updatedAt: jobs.updatedAt, startedAt: jobs.startedAt })
      .from(jobs)
      .where(eq(jobs.status, "running"));

    const staleJobs = runningJobs.filter((job) => {
      const isActiveInMemory = activeJobIds.includes(job.id);
      if (isActiveInMemory) return false; // Job está rodando normalmente

      const lastActivity = job.updatedAt || job.startedAt;
      if (!lastActivity) return true;
      return lastActivity < cutoffDate;
    });

    if (staleJobs.length === 0) {
      return { fixed: 0, message: "Nenhum job travado encontrado" };
    }

    // Marcar jobs travados como failed
    for (const staleJob of staleJobs) {
      await db.update(jobs).set({
        status: "failed",
        error: "Job travado detectado automaticamente (sem progresso por 30+ minutos)",
        completedAt: new Date(),
      }).where(eq(jobs.id, staleJob.id));
    }

    return {
      fixed: staleJobs.length,
      message: `${staleJobs.length} job(s) travado(s) marcado(s) como falha`,
      jobIds: staleJobs.map((j) => j.id),
    };
  }),
});
