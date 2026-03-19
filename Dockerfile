# ============================================================
# Ghost Panel - Dockerfile (Otimizado)
# Build multi-stage para produção
# ============================================================

# ---------- Stage 1: Build ----------
FROM node:22-alpine AS builder

WORKDIR /app

# Instalar pnpm
RUN corepack enable && corepack prepare pnpm@10.4.1 --activate

# Copiar arquivos de dependência
COPY package.json pnpm-lock.yaml ./
COPY patches/ ./patches/

# Instalar TODAS as dependências (dev + prod) para o build
RUN pnpm install --frozen-lockfile

# Copiar código-fonte
COPY . .

# Build do frontend (Vite) e backend (esbuild)
RUN pnpm build

# ---------- Stage 2: Production ----------
FROM node:22-alpine AS runner

WORKDIR /app

# Instalar pnpm
RUN corepack enable && corepack prepare pnpm@10.4.1 --activate

# Copiar arquivos de dependência
COPY package.json pnpm-lock.yaml ./
COPY patches/ ./patches/

# Instalar APENAS dependências de produção (sem vite, tailwind, etc.)
RUN pnpm install --frozen-lockfile --prod

# Copiar build do stage anterior
# Frontend compilado: dist/public/ (HTML, CSS, JS estáticos)
# Backend compilado: dist/index.js (bundle ESM)
COPY --from=builder /app/dist ./dist

# Copiar migrações do Drizzle
COPY drizzle/ ./drizzle/

# Variáveis de ambiente padrão
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/ || exit 1

CMD ["node", "dist/index.js"]
