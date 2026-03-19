# ============================================================
# Ghost Panel - Dockerfile (Otimizado)
# Build multi-stage para produção
# Includes curl-impersonate for TLS/HTTP2 fingerprint impersonation
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

# ---------- Stage 2: Download curl-impersonate ----------
FROM alpine:3.20 AS curl-dl

RUN apk add --no-cache wget tar gzip

# Download curl-impersonate for Linux x64 (Chrome variant)
RUN mkdir -p /opt/curl-impersonate && \
    wget -q "https://github.com/lexiforest/curl-impersonate/releases/download/v0.8.0/libcurl-impersonate-v0.8.0.x86_64-linux-gnu.tar.gz" \
      -O /tmp/curl-impersonate.tar.gz && \
    tar xzf /tmp/curl-impersonate.tar.gz -C /opt/curl-impersonate/ && \
    rm /tmp/curl-impersonate.tar.gz

# ---------- Stage 3: Production ----------
FROM node:22-alpine AS runner

WORKDIR /app

# Install glibc compatibility layer (curl-impersonate is built against glibc)
# Alpine uses musl, so we need gcompat for the .so to load
RUN apk add --no-cache gcompat libstdc++

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

# Copiar curl-impersonate library
COPY --from=curl-dl /opt/curl-impersonate /opt/curl-impersonate

# Copiar migrações do Drizzle
COPY drizzle/ ./drizzle/

# Variáveis de ambiente padrão
ENV NODE_ENV=production
ENV PORT=3000
ENV LIBCURL_IMPERSONATE_PATH=/opt/curl-impersonate/libcurl-impersonate-chrome.so

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/ || exit 1

CMD ["node", "dist/index.js"]
