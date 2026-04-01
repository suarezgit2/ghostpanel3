# Documentação Completa: Ghost Panel v5.2+

**Data de Atualização:** 20 de Março de 2026
**Versão do Projeto:** v5.2+ (baseado no commit 201a520)
**Status:** Sincronizado com código-fonte real
**Repositório:** https://github.com/Siieg-bit/ghostpanel (privado)

---

## Índice

1. [Visão Geral](#1-visão-geral)
2. [Filosofia de Resiliência (NOVO)](#2-filosofia-de-resiliência)
3. [Stack Tecnológica](#3-stack-tecnológica)
4. [Fluxo de Criação de Conta](#4-fluxo-de-criação-de-conta)
5. [Estrutura do Projeto](#5-estrutura-do-projeto)
6. [Banco de Dados](#6-banco-de-dados)
7. [Variáveis de Ambiente](#7-variáveis-de-ambiente)
8. [Setup e Instalação](#8-setup-e-instalação)
9. [Autenticação](#9-autenticação)
10. [Serviços Integrados](#10-serviços-integrados)
11. [Orchestrator v2](#11-orchestrator-v2)
12. [Arquitetura Anti-Detecção](#12-arquitetura-anti-detecção)
13. [Roteadores tRPC](#13-roteadores-trpc)
14. [Configurações Dinâmicas](#14-configurações-dinâmicas)
15. [Deploy](#15-deploy)
16. [Troubleshooting](#16-troubleshooting)
17. [Histórico de Versões](#17-histórico-de-versões)

---

## Diagramas Visuais

### Diagrama de Arquitetura do Sistema

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Frontend (React + TailwindCSS)                       │
│  ┌──────────────┬──────────────┬──────────────┬──────────────┬────────────┐ │
│  │ Painel de    │ Dashboard /  │ Lista de     │ Gerenciar    │ Resgate de │ │
│  │ Controle     │ Métricas     │ Contas       │ Configurações│ Chaves    │ │
│  └──────────────┴──────────────┴──────────────┴──────────────┴────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ▲
                                    │ tRPC
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Backend (Express + tRPC + Node.js 22)                    │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                         API Gateway                                 │   │
│  │  • Autenticação (JWT + Cookies)                                    │   │
│  │  • Roteadores: jobs, accounts, proxies, logs, settings, keys, etc. │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                      Core Engine                                     │   │
│  │  ┌──────────────────────────────────────────────────────────────┐   │   │
│  │  │                   Orchestrator v2                           │   │   │
│  │  │  • Gerencia fila de jobs                                   │   │   │
│  │  │  • Controla concorrência                                  │   │   │
│  │  │  • Executa até atingir sucesso (não apenas N tentativas) │   │   │
│  │  │  • Backoff inteligente após falhas                       │   │   │
│  │  │  • Suporta Quick Jobs e Job Folders                      │   │   │
│  │  └──────────────────────────────────────────────────────────┘   │   │
│  │  ┌──────────────────────────────────────────────────────────┐   │   │
│  │  │                 Provider Registry                        │   │   │
│  │  │  • Manus Provider (atual)                               │   │   │
│  │  │  • Extensível para novos sites                          │   │   │
│  │  └──────────────────────────────────────────────────────────┘   │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                    Serviços Compartilhados                          │   │
│  │  ┌──────────┬──────────┬──────────┬──────────┬──────────────────┐  │   │
│  │  │ Captcha  │ Email    │ SMS      │ Proxy    │ Fingerprint      │  │   │
│  │  │ Service  │ Service  │ Service  │ Service  │ Service          │  │   │
│  │  │ (2Cap/   │ (Zoho)   │ (SMS     │ (Web     │ (UA, TZ, DCR)    │  │   │
│  │  │ CapSolv) │          │ Bower)   │ share)   │                  │  │   │
│  │  └──────────┴──────────┴──────────┴──────────┴──────────────────┘  │   │
│  │  ┌──────────────────────────────────────────────────────────────┐  │   │
│  │  │  FPJS Service (Puppeteer)  │  HTTP Client (TLS Impersonate) │  │   │
│  │  │  • On-demand requestIds    │  • JA3/JA4 Chrome fingerprint  │  │   │
│  │  │  • Retry robusto (5x)      │  • HTTP/2 impersonation       │  │   │
│  │  │  • Nunca sintético         │  • Proxy support              │  │   │
│  │  └──────────────────────────────────────────────────────────────┘  │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ▲
                                    │ HTTP/REST
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Serviços Externos                                    │
│  ┌──────────────┬──────────────┬──────────────┬──────────────────────────┐ │
│  │ 2Captcha API │ CapSolver    │ Zoho Mail    │ SMSBower API             │ │
│  │ (Turnstile)  │ (Turnstile)  │ (Email)      │ (SMS Números)            │ │
│  └──────────────┴──────────────┴──────────────┴──────────────────────────┘ │
│  ┌──────────────┬──────────────┬──────────────────────────────────────────┐ │
│  │ Webshare API │ manus.im API │ Chromium (Puppeteer)                     │ │
│  │ (Proxies)    │ (ConnectRPC) │ (FPJS Pro requestIds)                    │ │
│  └──────────────┴──────────────┴──────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ▲
                                    │ SQL
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Banco de Dados (MySQL 8 / TiDB)                         │
│  ┌──────────────┬──────────────┬──────────────┬──────────────────────────┐ │
│  │ users        │ providers    │ job_folders  │ jobs                     │ │
│  └──────────────┴──────────────┴──────────────┴──────────────────────────┘ │
│  ┌──────────────┬──────────────┬──────────────┬──────────────────────────┐ │
│  │ accounts     │ proxies      │ logs         │ settings                 │ │
│  └──────────────┴──────────────┴──────────────┴──────────────────────────┘ │
│  ┌──────────────┬──────────────┐                                            │
│  │ keys         │ api_tokens   │                                            │
│  └──────────────┴──────────────┘                                            │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Diagrama de Fluxo de Criação de Conta

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     FLUXO DE CRIAÇÃO DE CONTA (v5.2+)                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  INÍCIO DO JOB                                                              │
│  └─► Orchestrator recebe solicitação de N contas                            │
│      └─► Cria job com status "running"                                     │
│                                                                             │
│  PARA CADA CONTA:                                                           │
│                                                                             │
│  ┌─► STEP 0: Proxy Health Check (~2s)                                      │
│  │   └─► Verifica se proxy consegue alcançar manus.im                       │
│  │   └─► Cache 60s; até 3 retries com troca de proxy                       │
│  │                                                                         │
│  ├─► STEP 1: Turnstile CAPTCHA (~10s)                                      │
│  │   └─► Resolve com 2Captcha ou CapSolver                                 │
│  │   └─► **Crítico:** Resolvido COM proxy (mesmo IP das chamadas API)      │
│  │   └─► Retorna token Turnstile                                           │
│  │                                                                         │
│  ├─► STEP 2: getUserPlatforms (~2s)                                        │
│  │   └─► POST https://api.manus.im/user.v1.UserAuthPublicService/...      │
│  │   └─► Payload: { email, cfCaptchaCode: turnstileToken }                 │
│  │   └─► Resposta: { platforms, tempToken }                                │
│  │                                                                         │
│  ├─► STEP 3: sendEmailVerifyCodeWithCaptcha (~3s)                          │
│  │   └─► POST https://api.manus.im/user.v1.UserAuthPublicService/...      │
│  │   └─► **Importante:** Usa tempToken (não Turnstile)                     │
│  │   └─► Payload: { email, action: 1, token: tempToken }                   │
│  │   └─► Envia código de verificação por email                             │
│  │                                                                         │
│  ├─► STEP 4: Email Polling (Zoho Mail) (~10s)                              │
│  │   └─► Polling com timeout 90s                                           │
│  │   └─► Extrai código 6 dígitos do campo "summary"                        │
│  │   └─► Retry automático se falhar                                        │
│  │                                                                         │
│  ├─► STEP 5: registerByEmail (~1s)                                         │
│  │   └─► POST https://api.manus.im/user.v1.UserAuthPublicService/...      │
│  │   └─► Payload: {                                                        │
│  │   │     email,                                                          │
│  │   │     password,                                                       │
│  │   │     verifyCode,                                                     │
│  │   │     authCommandCmd: {                                               │
│  │   │       firstFromPlatform: "web",                                     │
│  │   │       locale: "en-US",                                              │
│  │   │       tz: "America/New_York",                                       │
│  │   │       tzOffset: "300",                                              │
│  │   │       firstEntry: "https://...",                                    │
│  │   │       fbp: "fb.1.xxx.xxx"                                           │
│  │   │     },                                                              │
│  │   │     name: ""                                                        │
│  │   │   }                                                                 │
│  │   └─► Resposta: { token: JWT }                                          │
│  │                                                                         │
│  ├─► STEP 5b: Aplicar Invite Code (~2s) [TIMING-CRÍTICO]                   │
│  │   └─► **Timing:** Deve ser chamado dentro de ~30s após registro         │
│  │   └─► POST CheckInvitationCode (autenticado)                            │
│  │   └─► Verifica freeCredits >= 1500                                      │
│  │   └─► Se falhar, marca conta como "partial"                             │
│  │                                                                         │
│  ├─► STEP 6: SMS (SMSBower) (~25s)                                         │
│  │   └─► Aluga número indonésio (+62)                                      │
│  │   └─► POST sendPhoneVerificationCode (autenticado)                      │
│  │   └─► Aguarda código SMS (timeout 120s)                                 │
│  │   └─► Retry robusto; múltiplos provedores                               │
│  │   └─► Preço máximo $0.01                                                │
│  │                                                                         │
│  └─► STEP 7: bindPhoneTrait (~1s)                                          │
│      └─► POST bindPhoneTrait (autenticado)                                 │
│      └─► Vincula telefone à conta                                          │
│      └─► Finaliza verificação SMS                                          │
│                                                                             │
│  ✅ CONTA CRIADA COM SUCESSO                                                │
│     └─► INSERT INTO accounts (email, password, token, phone, status)       │
│     └─► status = "active"                                                  │
│     └─► metadata contém detalhes da criação                                │
│                                                                             │
│  ⏱️  TEMPO TOTAL: ~72 segundos por conta                                    │
│  💰 CUSTO TOTAL: ~$0.02 por conta (CAPTCHA + SMS)                           │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Diagrama de Banco de Dados (ER)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                         MODELO DE DADOS (v5.2+)                             │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                           users                                     │   │
│  ├─────────────────────────────────────────────────────────────────────┤   │
│  │ id (PK)          │ int                                              │   │
│  │ openId (UK)      │ varchar(64)                                      │   │
│  │ name             │ text                                             │   │
│  │ email            │ varchar(320)                                     │   │
│  │ loginMethod      │ varchar(64)                                      │   │
│  │ role             │ enum('user', 'admin')                            │   │
│  │ createdAt        │ timestamp                                        │   │
│  │ updatedAt        │ timestamp                                        │   │
│  │ lastSignedIn     │ timestamp                                        │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                        providers                                    │   │
│  ├─────────────────────────────────────────────────────────────────────┤   │
│  │ id (PK)          │ int                                              │   │
│  │ slug (UK)        │ varchar(64)                                      │   │
│  │ name             │ varchar(128)                                     │   │
│  │ baseUrl          │ varchar(512)                                     │   │
│  │ enabled          │ boolean                                          │   │
│  │ config           │ json                                             │   │
│  │ createdAt        │ timestamp                                        │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                         │
│                            (1:N) has                                         │
│                                    │                                         │
│                    ┌───────────────┴────────────────┐                       │
│                    ▼                                ▼                       │
│  ┌──────────────────────────────┐  ┌──────────────────────────────┐        │
│  │      job_folders             │  │         jobs                 │        │
│  ├──────────────────────────────┤  ├──────────────────────────────┤        │
│  │ id (PK)                      │  │ id (PK)                      │        │
│  │ clientName                   │  │ providerId (FK)              │        │
│  │ inviteCode                   │  │ status (enum)                │        │
│  │ totalJobs                    │  │ totalAccounts                │        │
│  │ createdAt                    │  │ completedAccounts            │        │
│  │ updatedAt                    │  │ failedAccounts               │        │
│  └──────────────────────────────┘  │ concurrency                  │        │
│                                     │ folderId (FK)                │        │
│                                     │ config (json)                │        │
│                                     │ error                        │        │
│                                     │ startedAt                    │        │
│                                     │ completedAt                  │        │
│                                     │ createdAt                    │        │
│                                     │ updatedAt                    │        │
│                                     └──────────────────────────────┘        │
│                                                │                            │
│                                        (1:N) creates                        │
│                                                │                            │
│                                                ▼                            │
│  ┌──────────────────────────────────────────────────────────────────┐     │
│  │                         accounts                                 │     │
│  ├──────────────────────────────────────────────────────────────────┤     │
│  │ id (PK)                  │ int                                    │     │
│  │ jobId (FK)               │ int                                    │     │
│  │ providerId (FK)          │ int                                    │     │
│  │ email                    │ varchar(320)                           │     │
│  │ password                 │ varchar(256)                           │     │
│  │ token                    │ text (JWT)                             │     │
│  │ phone                    │ varchar(32)                            │     │
│  │ status                   │ enum('active', 'banned', ...)          │     │
│  │ metadata                 │ json                                   │     │
│  │ createdAt                │ timestamp                              │     │
│  │ updatedAt                │ timestamp                              │     │
│  └──────────────────────────────────────────────────────────────────┘     │
│                                                │                            │
│                                        (1:N) generates                      │
│                                                │                            │
│                                                ▼                            │
│  ┌──────────────────────────────────────────────────────────────────┐     │
│  │                          logs                                     │     │
│  ├──────────────────────────────────────────────────────────────────┤     │
│  │ id (PK)                  │ int                                    │     │
│  │ jobId (FK)               │ int                                    │     │
│  │ level                    │ enum('info', 'warn', 'error', 'debug') │     │
│  │ source                   │ varchar(64)                            │     │
│  │ message                  │ text                                   │     │
│  │ details                  │ json                                   │     │
│  │ createdAt                │ timestamp                              │     │
│  └──────────────────────────────────────────────────────────────────┘     │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────┐     │
│  │                        proxies                                    │     │
│  ├──────────────────────────────────────────────────────────────────┤     │
│  │ id (PK)                  │ int                                    │     │
│  │ host                     │ varchar(256)                           │     │
│  │ port                     │ int                                    │     │
│  │ username                 │ varchar(128)                           │     │
│  │ password                 │ varchar(256)                           │     │
│  │ protocol                 │ enum('http', 'https', 'socks5')        │     │
│  │ country                  │ varchar(4)                             │     │
│  │ enabled                  │ boolean                                │     │
│  │ failCount                │ int                                    │     │
│  │ lastUsedAt               │ timestamp                              │     │
│  │ createdAt                │ timestamp                              │     │
│  └──────────────────────────────────────────────────────────────────┘     │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────┐     │
│  │                       settings                                    │     │
│  ├──────────────────────────────────────────────────────────────────┤     │
│  │ id (PK)                  │ int                                    │     │
│  │ settingKey (UK)          │ varchar(128)                           │     │
│  │ value                    │ text                                   │     │
│  │ description              │ text                                   │     │
│  │ updatedAt                │ timestamp                              │     │
│  └──────────────────────────────────────────────────────────────────┘     │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────┐     │
│  │                         keys                                      │     │
│  ├──────────────────────────────────────────────────────────────────┤     │
│  │ id (PK)                  │ int                                    │     │
│  │ code (UK)                │ varchar(64)                            │     │
│  │ credits                  │ int                                    │     │
│  │ status                   │ enum('active', 'redeemed', ...)        │     │
│  │ label                    │ varchar(256)                           │     │
│  │ redeemedAt               │ timestamp                              │     │
│  │ redeemedBy               │ varchar(256)                           │     │
│  │ expiresAt                │ timestamp                              │     │
│  │ createdAt                │ timestamp                              │     │
│  │ updatedAt                │ timestamp                              │     │
│  └──────────────────────────────────────────────────────────────────┘     │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────┐     │
│  │                      api_tokens                                   │     │
│  ├──────────────────────────────────────────────────────────────────┤     │
│  │ id (PK)                  │ int                                    │     │
│  │ name                     │ varchar(128)                           │     │
│  │ tokenHash (UK)           │ varchar(128)                           │     │
│  │ tokenPrefix              │ varchar(16)                            │     │
│  │ permissions              │ enum('full', 'read', 'jobs_only')      │     │
│  │ lastUsedAt               │ timestamp                              │     │
│  │ expiresAt                │ timestamp                              │     │
│  │ revoked                  │ boolean                                │     │
│  │ createdAt                │ timestamp                              │     │
│  └──────────────────────────────────────────────────────────────────┘     │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 1. Visão Geral

O **Ghost Panel** é um sistema de automação completo para criação em lote de contas no manus.im. Combina um frontend React moderno com um backend Node.js robusto, gerenciamento de proxies, resolução de CAPTCHAs, verificação por SMS e email, tudo orquestrado por um engine sofisticado que suporta múltiplos jobs em paralelo com retry automático e fallbacks inteligentes.

**Características principais:**
- Dashboard completo com métricas em tempo real
- Criação de contas com bypass de 5 camadas de proteção (Turnstile, hCaptcha, FingerprintJS Pro, DCR, Client ID)
- Gerenciamento de jobs com suporte a Quick Jobs (múltiplos destinatários) e Job Folders (agrupamento por cliente)
- Rotação automática de proxies, emails e fingerprints
- Geração on-demand de FingerprintJS Pro requestIds via Puppeteer
- TLS/HTTP2 Impersonation para evitar detecção por WAF
- Autenticação local ou via Manus OAuth
- Logs estruturados em tempo real
- Configurações dinâmicas sem necessidade de restart

**Tempo estimado por conta:** ~72 segundos
**Custo estimado:** ~$0.02 por conta (CAPTCHA + SMS)

---

## 2. Filosofia de Resiliência

A partir da versão v5.2+, o Ghost Panel adotou uma nova filosofia de engenharia focada em **Resiliência Estrutural**. 

**A Regra de Ouro:** *Nunca "jogue a toalha". Estruture o sistema para que a falha seja impossível ou automaticamente recuperável.*

### O Problema Anterior (Mentalidade de Falha Rápida)
Nas versões anteriores, o sistema tratava erros de forma reativa:
- Se o Puppeteer crashasse → Lançava erro → Job falhava.
- Se o SMS fosse bloqueado → Lançava erro → Job falhava.
- Se a API de proxy demorasse → Lançava erro → Job falhava.
Isso resultava em perda de créditos, tempo desperdiçado e necessidade de intervenção manual.

### A Nova Abordagem (Estrutura Resiliente)
O código agora é desenhado para **resolver a causa raiz em tempo de execução**:

1. **Auto-Recuperação (Self-Healing):**
   - O `FPJS Service` possui um *BrowserPool* com health checks a cada 60s. Se o Chromium crashar, o sistema detecta o evento `disconnected`, limpa a memória e recria a instância de forma transparente. O Orchestrator nunca recebe um erro de "browser morto".

2. **Memória de Qualidade (Quality Tracking):**
   - O `SMS Service` não apenas tenta números aleatórios. Ele possui um `PhoneNumberQualityTracker` com cache de 7 dias. Se o alvo (Manus) rejeitar um número com `permission_denied`, esse número entra na "lista negra". O sistema **nunca** tentará alugar o mesmo número ruim duas vezes.

3. **Controle de Recursos (Resource Management):**
   - Filas assíncronas (como a de cancelamento de SMS) não crescem infinitamente. Elas usam `Map` para deduplicação, possuem limite máximo (500 itens) e processam em batches controlados (3 por vez) com backoff exponencial. Isso previne *memory leaks* e *race conditions*.

4. **Retry Infinito com Backoff:**
   - Erros transitórios (timeout, rede, rate limit) nunca cancelam um job. O sistema aplica *backoff exponencial* (ex: 2s → 4s → 8s → 16s) e tenta novamente até conseguir. Apenas erros permanentes (ex: credenciais inválidas) causam falha imediata.

**Como aplicar esta filosofia ao desenvolver novos recursos:**
- *Pergunte-se:* "O que acontece se a API externa cair por 5 minutos?" (Resposta correta: O sistema deve pausar, acumular na fila e retomar sozinho).
- *Pergunte-se:* "O que acontece se o recurso acabar?" (Resposta correta: O sistema deve ter limites rígidos de concorrência e limpar lixo automaticamente).
- *Nunca use:* `throw new Error()` para problemas de rede ou instabilidade de terceiros. Use retries.

---

## 3. Stack Tecnológica

| Camada | Tecnologia | Versão | Propósito |
|--------|-----------|--------|----------|
| **Frontend** | React + Vite | 19 + 7.1.7 | Interface reativa com hot reload |
| **UI Components** | shadcn/ui + Radix | - | Componentes acessíveis e customizáveis |
| **Styling** | Tailwind CSS | 4.1.14 | Utility-first CSS framework |
| **Backend** | Express | 4.21.2 | Servidor HTTP minimalista |
| **API Type-Safe** | tRPC | 11.6.0 | RPC type-safe entre frontend e backend |
| **ORM** | Drizzle ORM | 0.44.5 | Query builder type-safe para MySQL |
| **Banco de Dados** | MySQL 8 / TiDB | - | Armazenamento persistente |
| **Runtime** | Node.js | 22+ | Execução do backend |
| **Build Tool** | Vite + esbuild | 7.1.7 + 0.25.0 | Build otimizado para produção |
| **Autenticação** | JWT + Cookies | - | Sessões seguras com httpOnly cookies |
| **Gerenciador de Pacotes** | pnpm | 10.4.1+ | Gerenciador rápido e eficiente |

---

## 3. Fluxo de Criação de Conta

O fluxo foi validado por engenharia reversa direta do frontend manus.im (13/03/2026). Cada conta passa por **7 etapas principais**:

### 3.1 Etapas Detalhadas

| # | Etapa | Descrição | Tempo | Detalhes |
|---|-------|-----------|-------|----------|
| **0** | Proxy Health Check | Verifica se proxy consegue alcançar manus.im | ~2s | Cache de 60s; até 3 retries com troca de proxy |
| **1** | Turnstile CAPTCHA | Resolve Cloudflare Turnstile via 2Captcha/CapSolver | ~10s | **Crítico:** Resolvido COM proxy (mesmo IP das chamadas API) |
| **2** | getUserPlatforms | Verifica se email é novo, obtém tempToken | ~2s | Usa Turnstile token; retorna tempToken para próxima etapa |
| **3** | sendEmailVerifyCodeWithCaptcha | Envia código de verificação por email | ~3s | **Importante:** Usa tempToken, não Turnstile; action é enum numérico (REGISTER=1) |
| **4** | Email Polling (Zoho) | Lê código de 6 dígitos do email | ~10s | Polling com timeout de 90s; extrai do campo `summary` |
| **5** | registerByEmail | Registra conta com authCommandCmd | ~1s | **Crítico:** Inclui `name: ""`, `tz` (não timezone), `tzOffset` como string |
| **5b** | Aplicar Invite Code | Aceita código de convite (timing-crítico!) | ~2s | **Timing:** Deve ser chamado dentro de ~30s após registro; verifica freeCredits >= 1500 |
| **6** | SMS (SMSBower) | Aluga número indonésio e recebe código | ~25s | Retry robusto; múltiplos provedores; preço máximo $0.01 |
| **7** | bindPhoneTrait | Vincula telefone à conta | ~1s | Finaliza verificação de SMS |

**Tempo total estimado:** ~72 segundos por conta

### 3.2 Detalhes Técnicos Críticos

#### 3.2.1 Turnstile (Etapa 1)
- **SiteKey:** `0x4AAAAAAA_sd0eRNCinWBgU`
- **Tipo:** Managed (invisível)
- **Proxy:** Resolvido COM proxy (mesmo IP das chamadas API posteriores)
- **Provedores:** 2Captcha (primário) ou CapSolver (fallback)
- **Custo:** ~$0.003 por resolução

#### 3.2.2 Email Verification (Etapa 3)
- **Campo de captcha:** `token` (recebe o `tempToken` obtido em getUserPlatforms)
- **Action:** Enum numérico protobuf (REGISTER = 1, não string)
- **Diferença crítica:** Usa `tempToken`, não `cfCaptchaCode`

#### 3.2.3 Registration (Etapa 5)
- **authCommandCmd obrigatório:**
  ```json
  {
    "firstFromPlatform": "web",
    "locale": "en-US",
    "tz": "America/New_York",
    "tzOffset": "300",
    "firstEntry": "https://facebook.com/..." (ou undefined),
    "fbp": "fb.1.1234567890.1234567890" (se Facebook)
  }
  ```
- **Campos importantes:**
  - `tz` (não `timezone`)
  - `tzOffset` como **string** (não número)
  - `name: ""` (sempre vazio, obrigatório)
  - `firstEntry` é URL completa ou `undefined` (não "direct"/"google")
  - `fbp` gerado apenas se `firstEntry` contém "facebook.com"

#### 3.2.4 Invite Code (Etapa 5b)
- **Timing:** Deve ser chamado dentro de ~30s após registro
- **Verificação:** Confirma que `freeCredits >= 1500`
- **Crítico:** Se falhar, a conta é marcada como `status: "partial"`

#### 3.2.5 SMS (Etapa 6)
- **País:** Indonésia (+62)
- **Provedor:** SMSBower
- **Preço:** $0.01 por número
- **Retry:** Até 3 tentativas; timeout de 120s por tentativa
- **Auto-discover:** Descobre provedores SMS disponíveis antes de usar

---

## 4. Estrutura do Projeto

```
ghost-panel/
├── server/                          # Backend Node.js + Express
│   ├── _core/                       # Infraestrutura
│   │   ├── index.ts                 # Ponto de entrada do servidor
│   │   ├── context.ts               # Contexto do tRPC (injeção de user)
│   │   ├── localAuth.ts             # Sistema de autenticação local
│   │   ├── oauth.ts                 # Rotas OAuth Manus
│   │   ├── security.ts              # Middleware de segurança
│   │   ├── env.ts                   # Mapeamento de variáveis de ambiente
│   │   ├── trpc.ts                  # Inicialização do tRPC
│   │   ├── vite.ts                  # Integração com Vite (dev/prod)
│   │   ├── cookies.ts               # Gerenciamento de cookies
│   │   ├── llm.ts                   # Integração com LLM
│   │   ├── imageGeneration.ts       # Geração de imagens
│   │   ├── voiceTranscription.ts    # Transcrição de voz
│   │   ├── notification.ts          # Sistema de notificações
│   │   ├── dataApi.ts               # API de dados
│   │   ├── sdk.ts                   # SDK interno
│   │   └── systemRouter.ts          # Rotas do sistema
│   ├── services/                    # Serviços reutilizáveis
│   │   ├── captcha.ts               # CaptchaService (2Captcha + CapSolver)
│   │   ├── email.ts                 # EmailService (Zoho Mail OAuth2)
│   │   ├── sms.ts                   # SmsService (SMSBower com retry robusto)
│   │   ├── proxy.ts                 # ProxyService (Webshare com sync automático)
│   │   ├── fingerprint.ts           # FingerprintService (geração de profiles)
│   │   ├── fpjs.ts                  # FingerprintJS Pro (Puppeteer on-demand)
│   │   └── httpClient.ts            # HTTP client com TLS impersonation
│   ├── providers/                   # Provedores de sites alvo
│   │   └── manus/
│   │       ├── index.ts             # ManusProvider (fluxo completo)
│   │       └── rpc.ts               # ConnectRPC client (payloads validados)
│   ├── core/                        # Core da automação
│   │   └── orchestrator.ts          # Orchestrator v2 (gerenciador de jobs)
│   ├── routers/                     # tRPC routers
│   │   ├── jobs.ts                  # Criação/gerenciamento de jobs
│   │   ├── accounts.ts              # Listagem/exportação de contas
│   │   ├── proxies.ts               # Gerenciamento de proxies
│   │   ├── logs.ts                  # Visualização de logs
│   │   ├── settings.ts              # Configurações dinâmicas
│   │   ├── keys.ts                  # Gerenciamento de chaves de resgate
│   │   ├── apiTokens.ts             # Tokens programáticos
│   │   ├── dashboard.ts             # Métricas do dashboard
│   │   └── auth.ts                  # Autenticação (login/logout)
│   ├── utils/                       # Utilitários
│   │   ├── helpers.ts               # Logger, delays, helpers
│   │   ├── settings.ts              # Cache de configurações
│   │   ├── autoSeed.ts              # Seed automático no boot
│   │   └── map.ts                   # Processamento paralelo
│   ├── db.ts                        # Conexão e migrações do banco
│   └── index.ts                     # Agregador de routers
├── client/                          # Frontend React
│   ├── src/
│   │   ├── pages/
│   │   │   ├── Dashboard.tsx        # Métricas e jobs recentes
│   │   │   ├── CreateJob.tsx        # Formulário de criação
│   │   │   ├── Jobs.tsx             # Lista de jobs
│   │   │   ├── JobDetail.tsx        # Detalhes com logs em tempo real
│   │   │   ├── Accounts.tsx         # Lista de contas
│   │   │   ├── Proxies.tsx          # Gerenciamento de proxies
│   │   │   ├── Logs.tsx             # Logs do sistema
│   │   │   ├── SettingsPage.tsx     # Configurações
│   │   │   └── RedeemKey.tsx        # Resgate de chaves (público)
│   │   ├── components/              # Componentes reutilizáveis
│   │   ├── hooks/                   # Custom hooks
│   │   ├── App.tsx                  # Componente raiz
│   │   └── main.tsx                 # Ponto de entrada
│   └── index.html                   # HTML template
├── drizzle/                         # Schema e migrações do banco
│   ├── schema.ts                    # Definição de tabelas
│   └── migrations/                  # Arquivos de migração
├── Dockerfile                       # Build multi-stage para produção
├── docker-compose.yml               # Orquestração local (MySQL + app)
├── package.json                     # Dependências e scripts
├── pnpm-lock.yaml                   # Lock file
├── drizzle.config.ts                # Configuração do Drizzle
├── vite.config.ts                   # Configuração do Vite
├── tsconfig.json                    # Configuração do TypeScript
├── README.md                        # (desatualizado — v3.3)
├── ENV_GUIDE.md                     # Guia de variáveis de ambiente
├── PENDENCIAS.md                    # Tarefas futuras
└── setup.sh                         # Script de setup automático
```

---

## 5. Banco de Dados

O banco de dados MySQL/TiDB possui **9 tabelas** com relacionamentos bem definidos:

### 5.1 Tabelas Principais

#### users
Usuários do sistema com autenticação.

```sql
CREATE TABLE users (
  id INT PRIMARY KEY AUTO_INCREMENT,
  openId VARCHAR(64) UNIQUE NOT NULL,
  name TEXT,
  email VARCHAR(320),
  loginMethod VARCHAR(64),
  role ENUM('user', 'admin') DEFAULT 'user',
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  lastSignedIn TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

#### providers
Sites alvo para criação de contas.

```sql
CREATE TABLE providers (
  id INT PRIMARY KEY AUTO_INCREMENT,
  slug VARCHAR(64) UNIQUE NOT NULL,
  name VARCHAR(128) NOT NULL,
  baseUrl VARCHAR(512) NOT NULL,
  enabled BOOLEAN DEFAULT TRUE,
  config JSON,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

#### job_folders
Agrupa múltiplos jobs de um mesmo cliente (Quick Jobs).

```sql
CREATE TABLE job_folders (
  id INT PRIMARY KEY AUTO_INCREMENT,
  clientName VARCHAR(256) NOT NULL,
  inviteCode VARCHAR(128) NOT NULL,
  totalJobs INT DEFAULT 0,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

#### jobs
Tarefas de criação de contas em lote.

```sql
CREATE TABLE jobs (
  id INT PRIMARY KEY AUTO_INCREMENT,
  providerId INT NOT NULL,
  status ENUM('pending', 'running', 'paused', 'completed', 'partial', 'failed', 'cancelled') DEFAULT 'pending',
  totalAccounts INT NOT NULL,
  completedAccounts INT DEFAULT 0,
  failedAccounts INT DEFAULT 0,
  concurrency INT DEFAULT 1,
  folderId INT,
  config JSON,
  error TEXT,
  startedAt TIMESTAMP,
  completedAt TIMESTAMP,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

**Status possíveis:**
- `pending` — Aguardando execução
- `running` — Executando
- `paused` — Pausado manualmente
- `completed` — Todas as contas criadas com sucesso
- `partial` — Algumas contas criadas, mas não todas (ex: invite code falhou)
- `failed` — Falha crítica ou travado por 30+ minutos
- `cancelled` — Cancelado pelo usuário

#### accounts
Contas criadas com sucesso.

```sql
CREATE TABLE accounts (
  id INT PRIMARY KEY AUTO_INCREMENT,
  jobId INT,
  providerId INT NOT NULL,
  email VARCHAR(320) NOT NULL,
  password VARCHAR(256) NOT NULL,
  token TEXT,
  phone VARCHAR(32),
  status ENUM('active', 'banned', 'suspended', 'unverified', 'failed') DEFAULT 'active',
  metadata JSON,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

**Status possíveis:**
- `active` — Conta funcional
- `banned` — Banida pelo site
- `suspended` — Suspensa temporariamente
- `unverified` — Não completou verificação
- `failed` — Falha na criação

#### proxies
Pool de proxies para rotação.

```sql
CREATE TABLE proxies (
  id INT PRIMARY KEY AUTO_INCREMENT,
  host VARCHAR(256) NOT NULL,
  port INT NOT NULL,
  username VARCHAR(128),
  password VARCHAR(256),
  protocol ENUM('http', 'https', 'socks5') DEFAULT 'http',
  country VARCHAR(4),
  enabled BOOLEAN DEFAULT TRUE,
  failCount INT DEFAULT 0,
  lastUsedAt TIMESTAMP,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

#### logs
Registro estruturado de operações.

```sql
CREATE TABLE logs (
  id INT PRIMARY KEY AUTO_INCREMENT,
  jobId INT,
  level ENUM('info', 'warn', 'error', 'debug') DEFAULT 'info',
  source VARCHAR(64),
  message TEXT NOT NULL,
  details JSON,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

#### settings
Configurações dinâmicas (sem restart necessário).

```sql
CREATE TABLE settings (
  id INT PRIMARY KEY AUTO_INCREMENT,
  settingKey VARCHAR(128) UNIQUE NOT NULL,
  value TEXT NOT NULL,
  description TEXT,
  updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

#### keys
Chaves de resgate de créditos.

```sql
CREATE TABLE keys (
  id INT PRIMARY KEY AUTO_INCREMENT,
  code VARCHAR(64) UNIQUE NOT NULL,
  credits INT NOT NULL,
  status ENUM('active', 'redeemed', 'expired', 'cancelled') DEFAULT 'active',
  label VARCHAR(256),
  redeemedAt TIMESTAMP,
  redeemedBy VARCHAR(256),
  expiresAt TIMESTAMP,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

#### api_tokens
Tokens para acesso programático.

```sql
CREATE TABLE api_tokens (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(128) NOT NULL,
  tokenHash VARCHAR(128) UNIQUE NOT NULL,
  tokenPrefix VARCHAR(16) NOT NULL,
  permissions ENUM('full', 'read', 'jobs_only') DEFAULT 'full',
  lastUsedAt TIMESTAMP,
  expiresAt TIMESTAMP,
  revoked BOOLEAN DEFAULT FALSE,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### 5.2 Relacionamentos

```
users (1) ──── (N) jobs
providers (1) ──── (N) jobs
providers (1) ──── (N) accounts
jobs (1) ──── (N) accounts
jobs (1) ──── (N) logs
job_folders (1) ──── (N) jobs
```

---

## 6. Variáveis de Ambiente

### 6.1 Obrigatórias

| Variável | Descrição | Exemplo |
|----------|-----------|---------|
| `DATABASE_URL` | Connection string MySQL/TiDB | `mysql://ghost:ghost123@localhost:3306/ghost_panel` |
| `JWT_SECRET` | Segredo para assinar cookies JWT | `a1b2c3d4e5f6...` (gere com `openssl rand -hex 32`) |
| `LOCAL_AUTH` | Ativa autenticação local (sem OAuth) | `true` |

### 6.2 Captcha (pelo menos um)

| Variável | Serviço | Exemplo |
|----------|---------|---------|
| `CAPTCHA_PROVIDER` | Provedor preferido | `2captcha` ou `capsolver` |
| `TWOCAPTCHA_API_KEY` | 2Captcha (recomendado) | `sua-chave-2captcha` |
| `CAPSOLVER_API_KEY` | CapSolver (fallback) | `sua-chave-capsolver` |

### 6.3 SMS

| Variável | Serviço | Exemplo |
|----------|---------|---------|
| `SMSBOWER_API_KEY` | SMSBower (números virtuais) | `sua-chave-smsbower` |

### 6.4 Proxies

| Variável | Serviço | Exemplo |
|----------|---------|---------|
| `WEBSHARE_API_KEY` | Webshare (proxies rotativos) | `sua-chave-webshare` |

### 6.5 Zoho Mail (Email catch-all)

| Variável | Descrição | Exemplo |
|----------|-----------|---------|
| `MS_CLIENT_ID` | Client ID do App Azure | `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` |
| `MS_CLIENT_SECRET` | Client Secret do App Azure | `xxxx~xxxx` |

Contas Outlook são adicionadas via painel (Configurações → Contas Outlook Autorizadas).

### 6.6 TLS Impersonation (opcional, recomendado)

| Variável | Descrição | Exemplo |
|----------|-----------|---------|
| `LIBCURL_IMPERSONATE_PATH` | Caminho para libcurl-impersonate-chrome.so | `/opt/curl-impersonate/libcurl-impersonate-chrome.so` |

Se não definida, o sistema tenta baixar automaticamente. Se falhar, usa `fetch` nativo (sem impersonation).

### 6.7 Puppeteer (FPJS Pro on-demand)

| Variável | Descrição | Exemplo |
|----------|-----------|---------|
| `PUPPETEER_EXECUTABLE_PATH` | Caminho para Chromium | `/usr/bin/chromium` |
| `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD` | Pula download automático | `true` |

### 6.8 Manus OAuth (opcional, só se LOCAL_AUTH=false)

| Variável | Descrição | Exemplo |
|----------|-----------|---------|
| `VITE_APP_ID` | ID do app Manus | `seu-app-id` |
| `OAUTH_SERVER_URL` | URL do servidor OAuth | `https://oauth.manus.im` |
| `VITE_OAUTH_PORTAL_URL` | URL do portal de login | `https://manus.im` |
| `OWNER_OPEN_ID` | OpenID do dono | `seu-open-id` |
| `OWNER_NAME` | Nome do dono | `Seu Nome` |

### 6.9 Exemplo de .env Completo

```env
# === Obrigatórias ===
DATABASE_URL=mysql://ghost:ghost123@localhost:3306/ghost_panel
JWT_SECRET=a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0
LOCAL_AUTH=true

# === Captcha (pelo menos um) ===
CAPTCHA_PROVIDER=2captcha
TWOCAPTCHA_API_KEY=sua-chave-2captcha
CAPSOLVER_API_KEY=sua-chave-capsolver

# === SMS ===
SMSBOWER_API_KEY=sua-chave-smsbower

# === Proxies ===
WEBSHARE_API_KEY=sua-chave-webshare

# === Zoho Mail ===
MS_CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
MS_CLIENT_SECRET=xxxx~xxxx

# === TLS Impersonation (opcional, recomendado) ===
LIBCURL_IMPERSONATE_PATH=/opt/curl-impersonate/libcurl-impersonate-chrome.so

# === Puppeteer (FPJS Pro) ===
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# === Manus OAuth (opcional, só se LOCAL_AUTH=false) ===
# VITE_APP_ID=
# OAUTH_SERVER_URL=
# VITE_OAUTH_PORTAL_URL=
# OWNER_OPEN_ID=
# OWNER_NAME=
```

---

## 7. Setup e Instalação

### 7.1 Pré-requisitos

- Node.js 22+
- pnpm 10.4.1+
- MySQL 8+ ou TiDB Cloud
- Docker e Docker Compose (opcional, para ambiente local)

### 7.2 Setup Rápido (Recomendado)

```bash
# 1. Clonar repositório
git clone https://github.com/Siieg-bit/ghostpanel.git
cd ghost-panel

# 2. Rodar script de setup
chmod +x setup.sh
./setup.sh

# 3. Iniciar em modo desenvolvimento
pnpm dev
```

O script automaticamente:
- Verifica Node.js e pnpm
- Cria arquivo `.env` com JWT_SECRET gerado
- Instala dependências
- Inicia MySQL via Docker (se disponível)
- Roda migrações do banco

### 7.3 Setup Manual

```bash
# 1. Instalar dependências
pnpm install

# 2. Criar .env (copie do exemplo acima)
cp .env.example .env
nano .env  # Edite com suas API keys

# 3. Iniciar MySQL (via Docker Compose)
docker compose up -d db

# 4. Rodar migrações
pnpm db:push

# 5. Iniciar servidor
pnpm dev
```

Acesse `http://localhost:3000`.

### 7.4 Comandos Disponíveis

| Comando | Descrição |
|---------|-----------|
| `pnpm dev` | Inicia em modo desenvolvimento (hot reload) |
| `pnpm build` | Build de produção (frontend + backend) |
| `pnpm start` | Inicia em modo produção (requer build) |
| `pnpm test` | Roda testes Vitest |
| `pnpm db:push` | Gera e aplica migrações do banco |
| `pnpm check` | Verifica tipos TypeScript |
| `pnpm format` | Formata código com Prettier |

---

## 8. Autenticação

### 8.1 Modo Local (LOCAL_AUTH=true)

Recomendado para desenvolvimento e servidores privados.

- Cria um admin local automaticamente
- Sem necessidade de OAuth
- Senha configurável via `ADMIN_PASSWORD_HASH` (bcrypt)

**Padrão:** admin / senha aleatória (gerada no primeiro boot)

### 8.2 Modo Manus OAuth (LOCAL_AUTH=false)

Para produção com autenticação centralizada.

- Requer `VITE_APP_ID`, `OAUTH_SERVER_URL`, etc.
- Suporta múltiplos usuários com roles (user, admin)
- Integração com sistema Manus

---

## 9. Serviços Integrados

### 9.1 CaptchaService (captcha.ts)

Resolve Cloudflare Turnstile com auto-fallback.

**Provedores:**
- 2Captcha (primário, recomendado)
- CapSolver (fallback)

**Custo:** ~$0.003 por resolução

**Retry:** Automático com backoff exponencial

### 9.2 EmailService (email.ts)

Lê emails de verificação via Zoho Mail OAuth2.

**Funcionalidades:**
- Polling com timeout configurável
- Extração de código do campo `summary`
- Suporte a múltiplos domínios catch-all
- Retry automático

### 9.3 SmsService (sms.ts)

Aluga números virtuais via SMSBower com retry robusto.

**Funcionalidades:**
- Multi-país (Indonésia por padrão)
- Auto-discover de provedores
- Fila de cancelamento assíncrona
- Detecção de erros de rede vs. provedor
- Retry com backoff inteligente
- Preço máximo configurável

### 9.4 ProxyService (proxy.ts)

Gerencia pool de proxies do Webshare.

**Funcionalidades:**
- Sincronização automática
- Rotação com health check
- Detecção de falhas
- Substituição automática
- Cache de regiões geográficas

### 9.5 FingerprintService (fingerprint.ts)

Gera profiles realistas de navegador.

**Funcionalidades:**
- UA profiles variados (Windows, macOS, Linux)
- Timezones e locales realistas
- Geo-coherent profiles baseados em IP do proxy
- Geração de DCR (Device Client Report) com ROT3 encoding
- Campos de authCommandCmd corretos

### 9.6 FingerprintJS Pro Service (fpjs.ts)

Gera requestIds autênticos via Puppeteer on-demand.

**Funcionalidades:**
- Singleton browser com Chromium
- Geração fresh de requestId por conta
- Retry robusto (até 5 tentativas)
- Limite de concorrência (máximo 3 simultâneas)
- Restart automático em caso de crash
- **Nunca** usa ID sintético como fallback

### 9.7 HTTP Client (httpClient.ts)

Cliente HTTP com TLS/HTTP2 Impersonation.

**Funcionalidades:**
- TLS fingerprint idêntico ao Chrome (JA3/JA4)
- HTTP/2 fingerprint idêntico ao Chrome (Akamai)
- Suporte a proxies
- Timeout configurável
- Fallback para `fetch` nativo se curl-impersonate indisponível

---

## 10. Orchestrator v2

O Orchestrator é o coração da automação. Versão 2 introduz lógica sofisticada de execução:

### 10.1 Características Principais

**Execução até sucesso:** Job roda até atingir a **quantidade de SUCESSO** solicitada, não apenas N tentativas.

**Limite de segurança:** `maxAttempts = quantity * 5` (evita loop infinito).

**Backoff inteligente:** Após 3 falhas consecutivas, aumenta delay progressivamente (30s → 300s máximo).

**Cancelamento imediato:** AbortController para parar job instantaneamente.

**Concorrência configurável:** Suporte a múltiplos jobs em paralelo.

### 10.2 Quick Jobs (Múltiplos Destinatários)

Permite criar múltiplos jobs para diferentes clientes com invite codes diferentes.

```typescript
interface QuickJobRecipient {
  inviteCode: string;      // Código de convite do cliente
  credits: number;         // Créditos a enviar (500 = 1 conta)
  label?: string;          // Nome do cliente
  jobCount?: number;       // Quantidade de jobs (padrão: 1)
}
```

**Exemplo:** 1500 créditos = 3 contas. Se `jobCount: 2`, cria 2 jobs de 2 contas cada (total 4 contas).

### 10.3 Job Folders (Agrupamento por Cliente)

Agrupa múltiplos jobs de um mesmo cliente em uma pasta.

```typescript
interface CreateJobOptions {
  provider: string;
  quantity: number;
  folderId?: number;       // ID da pasta de agrupamento
  inviteCode?: string;     // Override do invite code global
  label?: string;          // Label do job
  concurrency?: number;    // Concorrência (padrão: 1)
}
```

### 10.4 Monitoramento de Jobs Travados

Monitor automático que roda a cada 10 minutos:
- Detecta jobs com status "running" sem progresso há 30+ minutos
- Marca como "failed" automaticamente
- Emite warning nos logs

---

## 11. Arquitetura Anti-Detecção

A versão v5.2+ implementa múltiplas camadas de proteção contra detecção:

### 11.1 TLS/HTTP2 Impersonation

Usa `curl-impersonate` para fingerprint TLS/HTTP2 idêntico ao Chrome real.

**Benefício:** Impede detecção por WAF (Cloudflare, Akamai).

### 11.2 FingerprintJS Pro On-Demand

Gera requestIds autênticos via Puppeteer, não sintéticos.

**Benefício:** Evita detecção server-side de IDs inválidos.

### 11.3 Rotação de Múltiplos Domínios de Email

Campo `email_domain` aceita lista de domínios separados por vírgula.

**Benefício:** Dilui padrão de agrupamento por domínio.

### 11.4 Correções de Payload (Engenharia Reversa)

- `tz` (não `timezone`)
- `tzOffset` como string
- `name: ""` (obrigatório)
- `firstEntry` como URL completa ou undefined
- `fbp` gerado quando relevante
- `firstFromPlatform: "web"` (v5.2+)

**Benefício:** Payloads idênticos ao frontend real.

### 11.5 Proxy com Mesmo IP para CAPTCHA

Turnstile resolvido COM proxy (mesmo IP das chamadas API).

**Benefício:** Evita detecção de IP mismatch (token Turnstile bound a IP diferente).

### 11.6 DCR Regenerado a Cada Chamada

Device Client Report regenerado fresh com novo timestamp e requestId FPJS real.

**Benefício:** Evita detecção de padrão de DCR repetido.

---

## 12. Roteadores tRPC

### 12.1 Jobs Router (jobs.ts)

| Método | Descrição |
|--------|-----------|
| `list` | Listar todos os jobs com paginação |
| `getById` | Detalhes de um job específico |
| `create` | Criar novo job |
| `quickJob` | Criar múltiplos jobs para destinatários |
| `listFolders` | Listar pastas de agrupamento |
| `deleteFolder` | Deletar pasta |
| `cancel` | Cancelar job em execução |
| `pause` | Pausar job |
| `resume` | Retomar job pausado |
| `getActive` | Listar jobs ativos |
| `delete` | Deletar job |
| `deleteCompleted` | Deletar todos os jobs completados |
| `fixStaleJobs` | Reparar jobs travados |

### 12.2 Accounts Router (accounts.ts)

| Método | Descrição |
|--------|-----------|
| `list` | Listar contas com filtros |
| `getById` | Detalhes de uma conta |
| `delete` | Remover conta |
| `export` | Exportar em formato email:senha |

### 12.3 Proxies Router (proxies.ts)

| Método | Descrição |
|--------|-----------|
| `list` | Listar proxies |
| `sync` | Sincronizar com Webshare |
| `delete` | Remover proxy |

### 12.4 Logs Router (logs.ts)

| Método | Descrição |
|--------|-----------|
| `list` | Listar logs com filtros |
| `stream` | Stream em tempo real |

### 12.5 Settings Router (settings.ts)

| Método | Descrição |
|--------|-----------|
| `list` | Listar configurações |
| `getAll` | Obter todas (com masking de chaves sensíveis) |
| `set` | Definir uma configuração |
| `setBulk` | Definir múltiplas |
| `delete` | Deletar configuração |
| `seedDefaults` | Seed com valores padrão |

### 12.6 Keys Router (keys.ts)

| Método | Descrição |
|--------|-----------|
| `list` | Listar chaves |
| `create` | Criar nova chave |
| `redeem` | Resgatar chave |
| `delete` | Deletar chave |

### 12.7 API Tokens Router (apiTokens.ts)

| Método | Descrição |
|--------|-----------|
| `list` | Listar tokens |
| `create` | Criar novo token |
| `revoke` | Revogar token |
| `delete` | Deletar token |

### 12.8 Dashboard Router (dashboard.ts)

| Método | Descrição |
|--------|-----------|
| `stats` | Estatísticas gerais |
| `recentJobs` | Jobs recentes |
| `recentAccounts` | Contas recentes |

### 12.9 Auth Router (auth.ts)

| Método | Descrição |
|--------|-----------|
| `me` | Informações do usuário atual |
| `logout` | Fazer logout |

---

## 13. Configurações Dinâmicas

Todas as configurações abaixo podem ser alteradas via painel em **Configurações** sem necessidade de restart.

| Chave | Tipo | Descrição | Padrão |
|-------|------|-----------|--------|
| `email_domain` | string | Domínios para criação de emails (separados por vírgula) | `lojasmesh.com` |
| `sms_country` | number | Código do país para SMS | `6` (Indonésia) |
| `sms_service` | string | Código do serviço SMS no SMSBower | `ot` (Other) |
| `sms_max_price` | number | Preço máximo em USD por número | `0.01` |
| `sms_provider_ids` | string | IDs dos provedores preferenciais (separados por vírgula) | `2295,3291,2482` |
| `sms_max_retries` | number | Máximo de tentativas para obter código SMS | `3` |
| `sms_wait_time` | number | Tempo de espera pelo código SMS em segundos | `120` |
| `sms_poll_interval` | number | Intervalo de polling em ms | `2000` |
| `sms_retry_delay_min` | number | Delay mínimo entre retries em ms | `5000` |
| `sms_retry_delay_max` | number | Delay máximo entre retries em ms | `15000` |
| `sms_cancel_wait` | number | Tempo de espera antes de cancelar número em ms | `10000` |
| `sms_auto_discover` | boolean | Auto-discover de provedores SMS | `true` |
| `invite_code` | string | Código de convite padrão | `DLCRTDCDYVCSMOK` |
| `proxy_auto_replace` | boolean | Substituição automática de proxies ruins | `true` |
| `captcha_provider` | string | Provedor de CAPTCHA preferido | `2captcha` |

---

## 14. Deploy

### 14.1 Docker Compose (Local ou Servidor)

```bash
# 1. Criar .env com suas API keys
nano .env

# 2. Subir tudo (MySQL + Ghost Panel)
docker compose up -d

# 3. Verificar logs
docker compose logs -f app

# 4. Parar
docker compose down
```

### 14.2 Oracle Cloud Free Tier

```bash
# 1. Criar instância Always Free (ARM Ampere A1 ou AMD)
# Ubuntu 22.04, abrir porta 3000

# 2. Instalar Docker
ssh -i sua-chave.pem ubuntu@ip-da-instancia
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
sudo apt install docker-compose-plugin -y

# 3. Upload e iniciar
scp -i sua-chave.pem ghost-panel.tar.gz ubuntu@ip-da-instancia:~/
tar xzf ghost-panel.tar.gz
cd ghost-panel
nano .env  # Preencher com suas API keys
docker compose up -d

# 4. Nginx reverso (opcional, para porta 80)
sudo apt install nginx -y
# ... (configurar nginx conforme README.md)
```

### 14.3 Railway

1. Conectar repositório GitHub
2. Configurar variáveis de ambiente no painel
3. Deploy automático a cada push para `master`

**Dockerfile:** Multi-stage otimizado com curl-impersonate + Chromium

---

## 16. Troubleshooting

### Problema: Jobs travados com status "running"

**Causa:** Crash do processo ou timeout durante execução.

**Solução:** Monitor automático marca como "failed" após 30+ minutos sem progresso. Ou use `fixStaleJobs` manualmente.

### Problema: FPJS Pro falha repetidamente

**Causa:** Chromium crashando por falta de memória ou timeout.

**Solução:** O sistema agora possui auto-recuperação. Se o problema persistir, verifique se a máquina tem pelo menos 1GB de RAM livre. O limite de memória do V8 está configurado para 512MB (`--max-old-space-size=512`).

### Problema: SMS bloqueado ("user is blocked")

**Causa:** O Manus detectou um padrão suspeito e bloqueou o número de telefone.

**Solução:** O sistema agora usa o `PhoneNumberQualityTracker` para colocar números rejeitados em quarentena por 7 dias. Se o problema for frequente, aumente o delay entre contas (`STEP_DELAYS.betweenAccounts`) para diluir o padrão de requisições.

### Problema: Fila de SMS congestionada

**Causa:** Muitos cancelamentos em background.

**Solução:** O sistema agora limita a fila a 500 itens e processa em batches de 3. Se a fila estiver sempre cheia, verifique a qualidade dos provedores de SMS configurados.

### Problema: Proxy inacessível

**Causa:** Proxy morto ou bloqueado.

**Solução:** Sincronizar proxies com Webshare, aumentar `MAX_PROXY_RETRIES`, ou usar `proxy_auto_replace: true`.

### Problema: Turnstile falha

**Causa:** CAPTCHA provider indisponível ou rate limited.

**Solução:** Verificar API keys, usar fallback automático, ou aumentar delay entre tentativas.

---

## 17. Histórico de Versões

| Versão | Data | Mudanças Principais |
|--------|------|---------------------|
| **v5.2+** | 20/03/2026 | Versão atual — Estrutura resiliente, BrowserPool, PhoneQualityTracker, Fila de cancelamento controlada |
| v5.2 | 13/03/2026 | Adicionado `firstFromPlatform: "web"` ao authCommandCmd |
| v5.1 | 13/03/2026 | Engenharia reversa v2: corrigido `tz` (não timezone), `tzOffset` como string, `name: ""` |
| v5.0 | 12/03/2026 | TLS/HTTP2 Impersonation via curl-impersonate |
| v4.2 | 12/03/2026 | Turnstile resolvido COM proxy (mesmo IP das chamadas API) |
| v4.1 | 11/03/2026 | Multi-captcha provider com auto-fallback |
| v4.0 | 11/03/2026 | Orchestrator v2 com Quick Jobs e Job Folders |
| v3.3 | 13/03/2026 | Engenharia reversa completa, 7 passos validados |
| v3.2 | 13/03/2026 | Multi-captcha provider |
| v3.1 | 13/03/2026 | Correções de authCommandCmd |
| v3.0 | 13/03/2026 | Migração para full-stack (tRPC + Drizzle + MySQL) |
| v2.0 | 12/03/2026 | Frontend completo, API Gateway |
| v1.0 | 11/03/2026 | Análise teórica, endpoints RPC |

---

## Conclusão

O Ghost Panel v5.2+ é um sistema robusto e bem arquitetado para automação de criação de contas. Com implementações avançadas de anti-detecção, orchestração sofisticada, e suporte a múltiplos jobs em paralelo, está pronto para produção.

**Próximos passos:**
1. Configurar variáveis de ambiente
2. Rodar setup.sh ou setup manual
3. Testar criação de 1 conta
4. Monitorar logs para validar fluxo
5. Escalar para múltiplas contas

Para dúvidas ou issues, consulte PENDENCIAS.md ou abra uma issue no repositório.
