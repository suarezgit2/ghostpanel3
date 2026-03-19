# Ghost Panel v3.3

Sistema de automação para criação de contas manus.im em lote, com dashboard completo, gerenciamento de jobs, proxies, SMS e captcha. O fluxo completo de criação de conta (Turnstile, verificação de email, registro, verificação SMS) leva aproximadamente 72 segundos por conta.

## Stack Tecnológica

| Camada | Tecnologia |
|--------|-----------|
| Frontend | React 19 + Tailwind CSS 4 + shadcn/ui |
| Backend | Express 4 + tRPC 11 + SuperJSON |
| Banco de dados | MySQL 8 (TiDB) + Drizzle ORM |
| Runtime | Node.js 22 |
| Autenticação | Manus OAuth ou LOCAL_AUTH bypass |

## Fluxo de Criação de Conta (v3.3)

O fluxo foi validado por engenharia reversa direta do frontend manus.im em 13/03/2026. Cada conta passa pelas seguintes etapas:

| Etapa | Descrição | Tempo Médio |
|-------|-----------|-------------|
| 1. Turnstile | Resolver CAPTCHA Cloudflare via 2Captcha ou CapSolver | ~10s |
| 2. getUserPlatforms | Verificar se email é novo + obter `tempToken` | ~2s |
| 3. sendEmailVerifyCodeWithCaptcha | Enviar código de verificação (usa `tempToken`, não Turnstile) | ~3s |
| 4. Zoho Mail polling | Ler código de 6 dígitos do campo `summary` | ~10s |
| 5. registerByEmail | Registrar conta com `authCommandCmd` | ~1s |
| 6. SMS (SMSBower) | Alugar número indonésio e receber código | ~25s |
| 7. bindPhoneTrait | Vincular telefone à conta | ~1s |

**Tempo total estimado:** ~72 segundos por conta. Custo estimado: ~$0.02/conta (captcha + SMS).

### Detalhes Técnicos Importantes

O campo `action` em `sendEmailVerifyCodeWithCaptcha` é um **enum numérico protobuf** (REGISTER = 1), não uma string. O campo de captcha neste endpoint é `token` (que recebe o `tempToken` do passo 2), diferente do `cfCaptchaCode` usado em `getUserPlatforms`. O campo `tzOffset` em `registerByEmail` deve ser uma **string** (ex: `"300"`), não um número.

## Estrutura do Projeto

```
server/
  _core/              ← Infraestrutura (auth, context, server, OAuth)
  services/
    captcha.ts        ← CaptchaService (CapSolver + 2Captcha, auto-fallback)
    email.ts          ← EmailService (Zoho Mail OAuth2, summary extraction)
    sms.ts            ← SmsService (SMSBower, retry robusto, Gold $0.01)
    proxy.ts          ← ProxyService (Webshare, sync automático)
    fingerprint.ts    ← FingerprintService (humanização de headers/UA)
  providers/
    manus/
      index.ts        ← ManusProvider (fluxo completo de criação)
      rpc.ts          ← ConnectRPC client (payloads validados por eng. reversa)
  core/
    orchestrator.ts   ← Gerenciador de jobs (paralelo, pause/resume, rate limit)
  routers/            ← tRPC routers (dashboard, jobs, accounts, proxies, logs, settings)
  utils/
    helpers.ts        ← Logger estruturado, delays, helpers
    settings.ts       ← Cache de configurações do banco
    autoSeed.ts       ← Seed automático no primeiro boot
client/src/
  pages/
    Dashboard.tsx     ← Métricas, jobs recentes, contas recentes
    CreateJob.tsx     ← Formulário de criação de job
    Jobs.tsx          ← Lista de jobs com status
    JobDetail.tsx     ← Detalhes do job com logs em tempo real
    Accounts.tsx      ← Lista de contas criadas
    Proxies.tsx       ← Gerenciamento de proxies
    Logs.tsx          ← Logs do sistema
    SettingsPage.tsx  ← Configurações (API keys, captcha provider, etc.)
  components/         ← DashboardLayout, MetricCard, StatusBadge, shadcn/ui
drizzle/              ← Schema + migrações SQL
```

## Setup Rápido (Recomendado)

```bash
# 1. Clonar/extrair e entrar no diretório
cd ghost-panel

# 2. Rodar o script de setup
chmod +x setup.sh
./setup.sh

# 3. Iniciar em modo desenvolvimento
pnpm dev
```

O script de setup automaticamente verifica Node.js e pnpm, cria o arquivo `.env` com JWT_SECRET gerado, instala dependências, inicia MySQL via Docker (se disponível) e roda migrações do banco.

## Setup Manual

### Pré-requisitos

- Node.js 22+
- pnpm 10+
- MySQL 8+ (local ou remoto)

### Passo a passo

```bash
# 1. Instalar dependências
pnpm install

# 2. Criar arquivo .env (veja ENV_GUIDE.md para detalhes completos)
# Configuração mínima:
# DATABASE_URL=mysql://ghost:ghost123@localhost:3306/ghost_panel
# JWT_SECRET=seu-segredo-aqui
# LOCAL_AUTH=true

# 3. Iniciar MySQL (via Docker ou instalação local)
docker compose up -d db

# 4. Rodar migrações
pnpm db:push

# 5. Iniciar o servidor
pnpm dev
```

Acesse `http://localhost:3000`.

## Deploy com Docker Compose

A forma mais simples de rodar em produção (local ou servidor):

```bash
# 1. Criar .env com suas API keys (veja ENV_GUIDE.md)

# 2. Subir tudo (MySQL + Ghost Panel)
docker compose up -d

# 3. Verificar logs
docker compose logs -f app

# 4. Parar
docker compose down
```

## Deploy no Oracle Cloud Free Tier

### 1. Criar instância

Acesse o Oracle Cloud e crie uma instância **Always Free** (ARM Ampere A1 ou AMD). Escolha Ubuntu 22.04 como sistema operacional e configure as regras de segurança para abrir a porta 3000 (ou 80/443 com Nginx).

### 2. Instalar Docker

```bash
ssh -i sua-chave.pem ubuntu@ip-da-instancia
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
sudo apt install docker-compose-plugin -y
```

### 3. Upload e iniciar

```bash
# Na sua máquina local
scp -i sua-chave.pem ghost-panel-v3.3.tar.gz ubuntu@ip-da-instancia:~/

# No servidor Oracle
tar xzf ghost-panel-v3.3.tar.gz
cd ghost-panel
nano .env  # preencher com suas API keys
docker compose up -d
```

### 4. Nginx reverso (opcional, para porta 80)

```bash
sudo apt install nginx -y
sudo tee /etc/nginx/sites-available/ghost-panel << 'EOF'
server {
    listen 80;
    server_name _;
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }
}
EOF
sudo ln -sf /etc/nginx/sites-available/ghost-panel /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

## Autenticação

| Modo | Variável | Descrição |
|------|----------|-----------|
| Local | `LOCAL_AUTH=true` | Cria um admin local automaticamente, sem OAuth |
| Manus | `LOCAL_AUTH=false` | Usa Manus OAuth (requer VITE_APP_ID, OAUTH_SERVER_URL, etc.) |

Para uso local e Oracle Cloud, use `LOCAL_AUTH=true`.

## Comandos

| Comando | Descrição |
|---------|-----------|
| `pnpm dev` | Inicia em modo desenvolvimento (hot reload) |
| `pnpm build` | Build de produção (frontend + backend) |
| `pnpm start` | Inicia em modo produção (requer build) |
| `pnpm test` | Roda testes Vitest |
| `pnpm db:push` | Gera e aplica migrações do banco |
| `pnpm check` | Verifica tipos TypeScript |

## Serviços Integrados

| Serviço | Finalidade | Configuração | Custo Estimado |
|---------|-----------|--------------|----------------|
| 2Captcha | Resolver Turnstile (primário) | `TWOCAPTCHA_API_KEY` | ~$0.003/solve |
| CapSolver | Resolver Turnstile (fallback) | `CAPSOLVER_API_KEY` | ~$0.003/solve |
| SMSBower | Receber códigos SMS (Indonésia) | `SMSBOWER_API_KEY` | $0.01/número |
| Webshare | Pool de proxies rotativos | `WEBSHARE_API_KEY` | Plano variável |
| Zoho Mail | Leitura de emails (catch-all) | `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`, `ZOHO_ACCOUNT_ID` | Gratuito |

O provedor de captcha pode ser selecionado em **Configurações > Provedor de Captcha**. Se o provedor selecionado não tiver API key configurada, o sistema automaticamente usa o outro como fallback.

## Primeiro Uso

Após o setup, acesse `http://localhost:3000` e:

1. Vá em **Configurações** e verifique se as API keys estão configuradas (ou clique **Seed Defaults** se for a primeira vez)
2. Vá em **Proxies** e clique **Sincronizar** para importar proxies do Webshare
3. Vá em **Criar Job** para criar seu primeiro job de teste (comece com 1 conta para validar)

## Histórico de Versões

| Versão | Data | Mudanças Principais |
|--------|------|---------------------|
| v3.3 | 13/03/2026 | Engenharia reversa v2: corrigido sendEmailVerifyCodeWithCaptcha (token/action enum), EmailService (summary extraction + folderId), registerByEmail (tzOffset string). Primeira conta criada com sucesso! |
| v3.2 | 13/03/2026 | Multi-captcha provider (2Captcha + CapSolver com auto-fallback) |
| v3.1 | 13/03/2026 | Correções de authCommandCmd, autoSeed, formatPhoneForManus, rate limiting |
| v3.0 | 13/03/2026 | Migração para full-stack (tRPC + Drizzle + MySQL), 34 testes |
| v2.0 | 12/03/2026 | Frontend completo, API Gateway, Orchestrator |
| v1.0 | 11/03/2026 | Análise teórica, endpoints RPC, serviços base |
