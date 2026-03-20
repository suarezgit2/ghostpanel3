# ============================================================
# Ghost Panel - Dockerfile (Otimizado)
# Build multi-stage para produção
# Includes:
#   - curl-impersonate for TLS/HTTP2 fingerprint impersonation
#   - Chromium for FingerprintJS Pro real requestId generation (Puppeteer)
# ============================================================

# ---------- Stage 1: Build ----------
FROM node:22-slim AS builder

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
FROM debian:bookworm-slim AS curl-dl

RUN apt-get update && apt-get install -y --no-install-recommends wget ca-certificates && rm -rf /var/lib/apt/lists/*

# Download curl-impersonate for Linux x64 (Chrome variant)
RUN mkdir -p /opt/curl-impersonate && \
    wget -q "https://github.com/lexiforest/curl-impersonate/releases/download/v0.8.0/libcurl-impersonate-v0.8.0.x86_64-linux-gnu.tar.gz" \
      -O /tmp/curl-impersonate.tar.gz && \
    tar xzf /tmp/curl-impersonate.tar.gz -C /opt/curl-impersonate/ && \
    rm /tmp/curl-impersonate.tar.gz

# ---------- Stage 3: Production ----------
FROM node:22-slim AS runner

WORKDIR /app

# Instalar dependências de sistema:
#   - curl-impersonate: libstdc++6
#   - Puppeteer/Chromium: chromium + todas as suas dependências de sistema
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      wget \
      ca-certificates \
      libstdc++6 \
      # Chromium browser for Puppeteer (FPJS Pro requestId generation)
      chromium \
      # Chromium runtime dependencies
      fonts-liberation \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libcups2 \
      libdbus-1-3 \
      libdrm2 \
      libgbm1 \
      libglib2.0-0 \
      libgtk-3-0 \
      libnspr4 \
      libnss3 \
      libx11-6 \
      libxcb1 \
      libxcomposite1 \
      libxdamage1 \
      libxext6 \
      libxfixes3 \
      libxkbcommon0 \
      libxrandr2 \
      xdg-utils \
    && rm -rf /var/lib/apt/lists/*

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
ENV LD_LIBRARY_PATH=/opt/curl-impersonate
# Chromium path for Puppeteer (FPJS Pro service)
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
# Disable Puppeteer's auto-download of Chrome (we use system Chromium)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/ || exit 1

CMD ["node", "dist/index.js"]
