/**
 * Dashboard Router - Métricas e status do sistema
 */

import { sql, desc, eq } from "drizzle-orm";
import { router, protectedProcedure } from "../_core/trpc";
import { getDb } from "../db";
import { jobs, accounts, proxies, logs } from "../../drizzle/schema";
import { captchaService } from "../services/captcha";
import { smsService } from "../services/sms";
import { proxyService } from "../services/proxy";

export const dashboardRouter = router({
  stats: protectedProcedure.query(async () => {
    const db = await getDb();
    if (!db) return { totalAccounts: 0, activeAccounts: 0, totalJobs: 0, runningJobs: 0, availableProxies: 0, failedAccounts: 0 };

    const [accountStats] = await db.select({
      total: sql<number>`count(*)`,
      active: sql<number>`sum(case when status = 'active' then 1 else 0 end)`,
      failed: sql<number>`sum(case when status = 'failed' then 1 else 0 end)`,
    }).from(accounts);

    const [jobStats] = await db.select({
      total: sql<number>`count(*)`,
      running: sql<number>`sum(case when status = 'running' then 1 else 0 end)`,
    }).from(jobs);

    const [proxyStats] = await db.select({
      available: sql<number>`sum(case when enabled = true then 1 else 0 end)`,
    }).from(proxies);

    return {
      totalAccounts: accountStats?.total || 0,
      activeAccounts: accountStats?.active || 0,
      failedAccounts: accountStats?.failed || 0,
      totalJobs: jobStats?.total || 0,
      runningJobs: jobStats?.running || 0,
      availableProxies: proxyStats?.available || 0,
    };
  }),

  balances: protectedProcedure.query(async () => {
    let captchaProvider = "capsolver";
    let captchaBalance = 0;
    let smsBowerBalance = 0;

    try {
      const result = await captchaService.getBalance();
      captchaProvider = result.provider;
      captchaBalance = result.balance;
    } catch { /* ignore */ }

    try {
      smsBowerBalance = await smsService.getBalance();
    } catch { /* ignore */ }

    return { captchaProvider, captchaBalance, capsolverBalance: captchaBalance, smsBowerBalance };
  }),

  recentLogs: protectedProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];

    return await db.select().from(logs).orderBy(desc(logs.id)).limit(50);
  }),

  recentJobs: protectedProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];

    return await db.select().from(jobs).orderBy(desc(jobs.createdAt)).limit(10);
  }),
});
