import express, { type Express } from "express";
import fs from "fs";
import { type Server } from "http";
import path from "path";

/**
 * setupVite — APENAS DESENVOLVIMENTO
 * Importa o módulo de dev separado para evitar que o esbuild
 * inclua vite.config.ts e todas as dependências do Vite no bundle de produção.
 */
export async function setupVite(app: Express, server: Server) {
  // O import dinâmico de um path construído em runtime impede o esbuild
  // de resolver e incluir o módulo no bundle estático.
  const devModulePath = "./vite.dev" + ".js";
  const { setupViteDev } = await import(devModulePath);
  await setupViteDev(app, server);
}

/**
 * serveStatic — APENAS PRODUÇÃO
 * Serve os arquivos estáticos compilados pelo Vite durante o build.
 * NÃO importa vite nem vite.config — usa o caminho fixo.
 */
export function serveStatic(app: Express) {
  // Em produção, o dist/index.js roda de dentro de /app/dist/
  // Os assets do frontend ficam em /app/dist/public/
  const distPath = path.resolve(import.meta.dirname, "public");

  if (!fs.existsSync(distPath)) {
    console.error(
      `[serveStatic] Diretório de build não encontrado: ${distPath}. Execute 'pnpm build' primeiro.`
    );
  } else {
    console.log(`[serveStatic] Servindo frontend de: ${distPath}`);
  }

  app.use(express.static(distPath));

  // SPA fallback: qualquer rota não encontrada retorna o index.html
  app.use("*", (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
