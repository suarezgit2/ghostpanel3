# Ghost Panel v5.2+

Sistema de automação para criação de contas manus.im em lote, com dashboard completo, gerenciamento de jobs, proxies, SMS e captcha. O fluxo completo de criação de conta (Turnstile, verificação de email, registro, verificação SMS) leva aproximadamente 72 segundos por conta.

## Stack Tecnológica

| Camada | Tecnologia |
|--------|-----------|
| Frontend | React 19 + Tailwind CSS 4 + shadcn/ui |
| Backend | Express 4 + tRPC 11 + SuperJSON |
| Banco de dados | MySQL 8 (TiDB) + Drizzle ORM |
| Runtime | Node.js 22 |
| Autenticação | Manus OAuth ou LOCAL_AUTH bypass |

## Fluxo de Criação de Conta (v5.2+)

O fluxo foi validado por engenharia reversa direta do frontend manus.im. Cada conta passa pelas seguintes etapas:

| Etapa | Descrição | Tempo Médio |
|-------|-----------|-------------|
| 0. Proxy Health Check | Verifica se proxy consegue alcançar manus.im (até 3 retries) | ~2s |
| 1. Turnstile | Resolver CAPTCHA Cloudflare **COM proxy** (mesmo IP das chamadas API) | ~10s |
| 2. getUserPlatforms | Verificar se email é novo + obter `tempToken` | ~2s |
| 3. sendEmailVerifyCodeWithCaptcha | Enviar código de verificação (usa `tempToken`, não Turnstile) | ~3s |
| 4. Zoho Mail polling | Ler código de 6 dígitos do campo `summary` | ~10s |
| 5. registerByEmail | Registrar conta com `authCommandCmd` (inclui `firstFromPlatform: "web"`) | ~1s |
| 5b. Aplicar Invite Code | Aceita código de convite (timing-crítico, dentro de ~30s) | ~2s |
| 6. SMS (SMSBower) | Alugar número indonésio e receber código (retry robusto) | ~25s |
| 7. bindPhoneTrait | Vincular telefone à conta | ~1s |

**Tempo total estimado:** ~72 segundos por conta. Custo estimado: ~$0.02/conta (captcha + SMS).

### Detalhes Técnicos Importantes

- **Turnstile:** Resolvido COM proxy para evitar detecção de IP mismatch.
- **Email Verification:** O campo `action` é um **enum numérico protobuf** (REGISTER = 1). O campo de captcha é `token` (recebe o `tempToken` do passo 2).
- **Registration:** O campo `tzOffset` deve ser uma **string** (ex: `"300"`). O campo `tz` é usado (não `timezone`). O campo `name` deve ser `""`.
- **FingerprintJS Pro:** RequestIds gerados on-demand via Puppeteer/Chromium, **nunca** sintéticos.
- **TLS Impersonation:** Usa `curl-impersonate` para fingerprint TLS/HTTP2 idêntico ao Chrome real.

## Estrutura do Projeto

```
server/
  _core/              ← Infraestrutura (auth, context, server, OAuth)
  services/
    captcha.ts        ← CaptchaService (CapSolver + 2Captcha, auto-fallback)
    email.ts          ← EmailService (Zoho Mail OAuth2, summary extraction)
    sms.ts            ← SmsService (SMSBower, retry robusto, multi-país)
    proxy.ts          ← ProxyService (Webshare, sync automático)
    fingerprint.ts    ← FingerprintService (geo-coherent profiles)
    fpjs.ts           ← FingerprintJS Pro (Puppeteer on-demand)
    httpClient.ts     ← HTTP Client (TLS/HTTP2 Impersonation)
  providers/
    manus/
      index.ts        ← ManusProvider (fluxo completo de criação)
      rpc.ts          ← ConnectRPC client (payloads validados por eng. reversa)
  core/
    orchestrator.ts   ← Orchestrator v2 (Quick Jobs, Job Folders, backoff inteligente)
  routers/            ← tRPC routers (dashboard, jobs, accounts, proxies, logs, settings, keys)
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
    SettingsPage.tsx  ← Configurações dinâmicas
    RedeemKey.tsx     ← Resgate de chaves (público)
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
| Microsoft Graph | Leitura de emails de verificação | `MS_CLIENT_ID`, `MS_CLIENT_SECRET` + contas via painel | Gratuito |

O provedor de captcha pode ser selecionado em **Configurações > Provedor de Captcha**. Se o provedor selecionado não tiver API key configurada, o sistema automaticamente usa o outro como fallback.

## Histórico de Versões

| Versão | Data | Mudanças Principais |
|--------|------|---------------------|
| **v5.2+** | 20/03/2026 | SMS cancel queue, FPJS on-demand com retry robusto, anti-ban improvements |
| v5.2 | 13/03/2026 | Adicionado `firstFromPlatform: "web"` ao authCommandCmd |
| v5.1 | 13/03/2026 | Engenharia reversa v2: corrigido `tz` (não timezone), `tzOffset` como string, `name: ""` |
| v5.0 | 12/03/2026 | TLS/HTTP2 Impersonation via curl-impersonate |
| v4.2 | 12/03/2026 | Turnstile resolvido COM proxy (mesmo IP das chamadas API) |
| v4.1 | 11/03/2026 | Multi-captcha provider com auto-fallback |
| v4.0 | 11/03/2026 | Orchestrator v2 com Quick Jobs e Job Folders |
| v3.3 | 13/03/2026 | Engenharia reversa completa, 7 passos validados |
