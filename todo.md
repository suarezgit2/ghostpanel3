# Ghost Panel - TODO

## Upgrade Full-Stack
- [x] Resolver conflitos de merge do upgrade (Home.tsx, package.json, DashboardLayout.tsx)
- [x] Migrar serviços do backend (captcha, email, sms, proxy, fingerprint) para server/
- [x] Migrar providers (manus) para server/
- [x] Migrar orchestrator para server/
- [x] Criar rotas tRPC para jobs, accounts, proxies, logs, dashboard, settings
- [x] Configurar secrets (API keys) via webdev_request_secrets
- [x] Migrar schema do banco de dados (Supabase → Drizzle/MySQL)
- [x] Conectar frontend ao backend via tRPC
- [x] Restaurar tema Obsidian Command no frontend
- [x] Testar projeto full-stack rodando localmente
- [x] Escrever testes vitest (28 testes passando)
- [x] Preparar instruções de deploy local e Oracle Cloud

## Features Anteriores (já implementadas)
- [x] Análise teórica completa do manus.im
- [x] Endpoints RPC mapeados e verificados
- [x] CaptchaService (CapSolver)
- [x] EmailService (Zoho Mail OAuth2)
- [x] SmsService (SMSBower, dinâmico, Gold $0.01, retry robusto)
- [x] ProxyService (Webshare)
- [x] FingerprintService (Humanização)
- [x] Manus Provider (fluxo de criação)
- [x] Orchestrator (gerenciador de jobs)
- [x] API Gateway (20+ rotas REST)
- [x] Frontend (7 páginas + tema Obsidian)
- [x] 20 proxies sincronizados
- [x] Configurações dinâmicas no banco

## Deploy Local / Oracle Cloud
- [x] Criar ENV_GUIDE.md com todas as variáveis documentadas
- [x] Criar bypass de autenticação para desenvolvimento local (LOCAL_AUTH=true)
- [x] Criar Dockerfile para produção
- [x] Criar docker-compose.yml com MySQL incluído
- [x] Criar script de setup (setup.sh)
- [x] Criar README de deploy local e Oracle Cloud
- [x] Gerar novo backup completo

## Correções Finais (v3.1)
- [x] Corrigir authCommandCmd no ManusProvider (popular com locale, timezone, tzOffset, firstEntry, fbp do fingerprint)
- [x] Seed automático no primeiro boot (autoSeed.ts)
- [x] Validar formato do número de telefone SMSBower → manus.im (formatPhoneForManus)
- [x] Garantir que 2 tokens Turnstile são resolvidos (Token 1 para getUserPlatforms, Token 2 para sendEmailVerifyCode)
- [x] Adicionar tratamento de rate limiting com backoff exponencial no Orchestrator
- [x] Adicionar campo token na tabela accounts para salvar JWT
- [x] Adicionar resumeJob ao Orchestrator
- [x] Adicionar suporte a pausa real no loop do Orchestrator (polling a cada 5s)
- [x] 34 testes passando (6 novos para fingerprint, DCR, clientId)
- [x] Gerar novo backup completo

## Multi-Captcha Provider (v3.2)
- [x] Adicionar suporte ao 2Captcha como alternativa ao CapSolver
- [x] Permitir escolha do provedor via configuração (CAPTCHA_PROVIDER=capsolver|2captcha)
- [x] Atualizar frontend Settings para exibir opção de provedor
- [x] Atualizar env vars (CAPTCHA_PROVIDER, TWOCAPTCHA_API_KEY)
- [x] Auto-fallback: se provider escolhido não tem key, usa o outro automaticamente

## Engenharia Reversa v2 + Correções Críticas (v3.3)
- [x] Engenharia reversa atualizada do manus.im frontend (chunks JS)
- [x] Descobrir enum EmailVerifyCodeAction (REGISTER=1, RESET_PASSWORD=2, etc.)
- [x] Corrigir sendEmailVerifyCodeWithCaptcha: campo `token` (tempToken) em vez de `cfCaptchaCode`
- [x] Corrigir sendEmailVerifyCodeWithCaptcha: action como enum numérico (1) em vez de string ("register")
- [x] Eliminar Turnstile token 2 (desnecessário — usa tempToken do getUserPlatforms)
- [x] Corrigir EmailService: extrair código do campo `summary` (sem chamada extra)
- [x] Corrigir EmailService: usar `folderId` no endpoint de content do Zoho
- [x] Corrigir EmailService: filtrar por `toAddress` para match do destinatário correto
- [x] Corrigir registerByEmail: `tzOffset` como string em vez de número
- [x] Teste completo: Job 8 — conta criada em ~72s (Turnstile→Email→Register→SMS→Verify)

## Documentação e Backup (v3.3)
- [x] Atualizar README.md com fluxo corrigido
- [x] Atualizar ENV_GUIDE.md
- [ ] Gerar backup completo (.tar.gz)
