#!/bin/bash
# ============================================================
# Ghost Panel - Script de Setup
# Configura o ambiente local para desenvolvimento
# ============================================================

set -e

echo "╔══════════════════════════════════════════╗"
echo "║       Ghost Panel - Setup Local          ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ---------- Verificar Node.js ----------
if ! command -v node &> /dev/null; then
    echo "❌ Node.js não encontrado. Instale Node.js 22+ primeiro."
    echo "   https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
    echo "❌ Node.js $NODE_VERSION detectado. Versão 20+ é necessária."
    exit 1
fi
echo "✅ Node.js $(node -v)"

# ---------- Verificar pnpm ----------
if ! command -v pnpm &> /dev/null; then
    echo "📦 Instalando pnpm..."
    npm install -g pnpm
fi
echo "✅ pnpm $(pnpm -v)"

# ---------- Criar .env se não existir ----------
if [ ! -f .env ]; then
    echo ""
    echo "📝 Criando arquivo .env..."

    JWT_SECRET=$(openssl rand -hex 32 2>/dev/null || echo "troque-por-um-segredo-aleatorio-$(date +%s)")

    cat > .env << EOF
# Ghost Panel - Configuração Local
# Gerado automaticamente em $(date)

DATABASE_URL=mysql://ghost:ghost123@localhost:3306/ghost_panel
JWT_SECRET=$JWT_SECRET
LOCAL_AUTH=true
PORT=3000
NODE_ENV=development

# API Keys (preencha com seus valores)
CAPSOLVER_API_KEY=
SMSBOWER_API_KEY=
WEBSHARE_API_KEY=

# Zoho Mail (opcional)
ZOHO_CLIENT_ID=
ZOHO_CLIENT_SECRET=
ZOHO_REFRESH_TOKEN=
ZOHO_ACCOUNT_ID=
EOF

    echo "✅ Arquivo .env criado com JWT_SECRET gerado automaticamente"
    echo "   ⚠️  Edite o .env para adicionar suas API keys"
else
    echo "✅ Arquivo .env já existe"
fi

# ---------- Instalar dependências ----------
echo ""
echo "📦 Instalando dependências..."
pnpm install

# ---------- Verificar MySQL ----------
echo ""
echo "🔍 Verificando conexão com MySQL..."

if command -v docker &> /dev/null; then
    # Verificar se o container MySQL já está rodando
    if docker ps --format '{{.Names}}' | grep -q ghost-mysql; then
        echo "✅ Container ghost-mysql já está rodando"
    else
        echo "🐳 Iniciando MySQL via Docker..."
        docker compose up -d db
        echo "⏳ Aguardando MySQL ficar pronto..."
        sleep 10

        # Esperar health check
        for i in {1..30}; do
            if docker compose exec db mysqladmin ping -h localhost -u ghost -pghost123 &>/dev/null 2>&1; then
                echo "✅ MySQL pronto!"
                break
            fi
            sleep 2
        done
    fi
else
    echo "⚠️  Docker não encontrado."
    echo "   Opções:"
    echo "   1. Instale Docker e rode: docker compose up -d db"
    echo "   2. Use um MySQL existente e ajuste DATABASE_URL no .env"
fi

# ---------- Rodar migrações ----------
echo ""
echo "🗃️  Rodando migrações do banco de dados..."
if pnpm db:push 2>/dev/null; then
    echo "✅ Migrações aplicadas com sucesso"
else
    echo "⚠️  Falha nas migrações. Verifique se o MySQL está rodando e DATABASE_URL está correto."
fi

# ---------- Pronto ----------
echo ""
echo "╔══════════════════════════════════════════╗"
echo "║          Setup Concluído! 🎉             ║"
echo "╠══════════════════════════════════════════╣"
echo "║                                          ║"
echo "║  Para iniciar em modo desenvolvimento:   ║"
echo "║    pnpm dev                               ║"
echo "║                                          ║"
echo "║  Para build de produção:                 ║"
echo "║    pnpm build && pnpm start              ║"
echo "║                                          ║"
echo "║  Para rodar tudo via Docker:             ║"
echo "║    docker compose up -d                  ║"
echo "║                                          ║"
echo "║  Acesse: http://localhost:3000            ║"
echo "║                                          ║"
echo "╚══════════════════════════════════════════╝"
