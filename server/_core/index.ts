import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerLocalAuthRoutes } from "./localAuth";
import { registerSecurityMiddleware } from "./security";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { ENV } from "./env";
import { autoSeedDefaults } from "../utils/autoSeed";
import { runMigrations } from "../db";
import { proxyService } from "../services/proxy";
import { getDb } from "../db";
import { jobs } from "../../drizzle/schema";
import { eq } from "drizzle-orm";
import { orchestrator } from "../core/orchestrator";
// v6.0: Puppeteer-based FPJS replaced by fpjsDirectClient (HTTP POST direto)
// import { fpjsService } from "../services/fpjs";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

/**
 * Monitor de jobs travados.
 * Roda a cada 10 minutos e marca como "failed" qualquer job com status "running"
 * que não esteja na memória ativa do orchestrator e não tenha progresso há 30+ minutos.
 */
function startStaleJobsMonitor(): void {
  const INTERVAL_MS = 10 * 60 * 1000;       // Checar a cada 10 minutos
  const STALE_THRESHOLD_MS = 30 * 60 * 1000; // Job travado = sem progresso há 30+ min

  const check = async () => {
    try {
      const db = await getDb();
      if (!db) return;

      const cutoffDate = new Date(Date.now() - STALE_THRESHOLD_MS);
      const activeJobIds = orchestrator.getActiveJobs();

      const runningJobs = await db
        .select({ id: jobs.id, updatedAt: jobs.updatedAt, startedAt: jobs.startedAt })
        .from(jobs)
        .where(eq(jobs.status, "running"));

      const staleJobs = runningJobs.filter((job) => {
        if (activeJobIds.includes(job.id)) return false;
        const lastActivity = job.updatedAt || job.startedAt;
        if (!lastActivity) return true;
        return lastActivity < cutoffDate;
      });

      if (staleJobs.length > 0) {
        console.warn(`[StaleJobsMonitor] ${staleJobs.length} job(s) travado(s) detectado(s): ${staleJobs.map(j => j.id).join(", ")}`);
        for (const staleJob of staleJobs) {
          await db.update(jobs).set({
            status: "failed",
            error: "Job travado detectado automaticamente (sem progresso por 30+ minutos)",
            completedAt: new Date(),
          }).where(eq(jobs.id, staleJob.id));
          console.warn(`[StaleJobsMonitor] Job ${staleJob.id} marcado como failed`);
        }
      }
    } catch (err) {
      console.warn("[StaleJobsMonitor] Erro ao verificar jobs travados:", err);
    }
  };

  // Rodar a primeira verificação após 2 minutos do boot (dar tempo ao orchestrator de inicializar)
  setTimeout(() => {
    check();
    setInterval(check, INTERVAL_MS);
  }, 2 * 60 * 1000);

  console.log("[StaleJobsMonitor] Monitor de jobs travados iniciado (intervalo: 10min, threshold: 30min)");
}

async function startServer() {
  const app = express();
  const server = createServer(app);

  // Security middleware PRIMEIRO (headers, CORS, rate limiting)
  const productionUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : undefined;
  registerSecurityMiddleware(app, productionUrl);

  // Cookie parser (necessário para JWT auth)
  app.use(cookieParser());

  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  // Auth routes
  if (ENV.localAuth) {
    console.log("[Auth] LOCAL_AUTH=true — Sistema de login por senha ativado");
    registerLocalAuthRoutes(app);
  } else {
    registerOAuthRoutes(app);
  }

  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );

  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, async () => {
    console.log(`Server running on http://localhost:${port}/`);

    // Aplicar migrations pendentes antes de qualquer outra operação no banco
    try {
      await runMigrations();
    } catch (err) {
      console.warn("[Migrations] Falhou (não-crítico):", err);
    }

    // Auto-seed defaults on first boot (provider + settings)
    try {
      await autoSeedDefaults();
    } catch (err) {
      console.warn("[AutoSeed] Falhou (não-crítico):", err);
    }

    // Recovery de proxies usados: recoloca na fila de replace após reinicialização
    try {
      await proxyService.recoverUsedProxies();
    } catch (err) {
      console.warn("[ProxyRecovery] Falhou (não-crítico):", err);
    }

    // v10.4: Recovery de jobs interrompidos por restart do servidor.
    // Retoma imediatamente qualquer job que estava em execução quando o processo morreu,
    // do ponto onde parou (usando completedAccounts como checkpoint).
    // Isso substitui a detecção tardia do StaleJobsMonitor (que esperava 30min).
    try {
      await orchestrator.recoverInterruptedJobs();
    } catch (err) {
      console.warn("[JobRecovery] Falhou (não-crítico):", err);
    }

    // v6.0: FPJS Direct Client (HTTP POST) não precisa de inicialização.
    // Puppeteer-based fpjsService desativado — sem overhead de browser.
    // O fpjsDirectClient gera requestIds reais via HTTP POST sob demanda.

    // Iniciar monitor de jobs travados (agora como rede de segurança secundária)
    startStaleJobsMonitor();
  });
}

startServer().catch(console.error);
