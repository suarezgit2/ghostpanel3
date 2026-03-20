# Ghost Panel — Pendências e Changelog

**Data:** 20 de março de 2026  
**Última atualização:** 20/03/2026

---

## Correções Aplicadas (v5.2+)

### 1. Fix: Import quebrado no ApiTokens.tsx

**Status:** Corrigido, aguardando commit/deploy  
**Arquivo:** `client/src/pages/ApiTokens.tsx`, linha 2

```diff
- import { trpc } from "../utils/trpc";
+ import { trpc } from "@/lib/trpc";
```

Este era o erro que causava falha nos últimos 5 deploys no Railway.

---

### 2. Orchestrator v2 — Retry até atingir a meta de sucesso

**Status:** Implementado, aguardando commit/deploy  
**Arquivo:** `server/core/orchestrator.ts`

**Problema anterior:** Se o usuário pedia 2 contas, o job iterava exatamente 2 vezes. Se uma falhasse, o job terminava com 1/2 e marcava como "completed".

**Nova lógica:**

| Aspecto | Antes (v1) | Agora (v2) |
|---|---|---|
| Loop principal | `for (i = 0; i < quantity; i++)` — itera N vezes | `while (successCount < quantity && totalAttempts < maxAttempts)` — itera até N sucessos |
| Meta | Tentativas = quantidade | Sucessos = quantidade |
| Limite de segurança | Nenhum | `maxAttempts = quantity * 5` (evita loop infinito) |
| Finalização parcial | Sempre "completed" | Se atingiu maxAttempts sem completar: "completed" se teve algum sucesso, "failed" se zero |
| Logs | `Conta X/N` | `Tentativa X/maxAttempts (sucesso: Y/N, restam Z tentativas)` |
| Backoff | Igual | Igual (30s, 60s, 120s, 300s após 3 falhas consecutivas) |

---

### 3. SMS Service v2 — Rotação Inteligente de Provedores

**Status:** Implementado, aguardando commit/deploy  
**Arquivo:** `server/services/sms.ts`

**Problema anterior:** O `getCodeWithRetry` passava TODOS os provedores de uma vez para o SMSBower em cada tentativa. Se o SMSBower escolhia um provedor ruim, ele repetia o mesmo provedor nas 3 tentativas e falhava.

**Nova arquitetura:**

**Rotação Sequencial:** Cada tentativa usa UM provedor específico, avançando pela lista:
- Tentativa 1 → Provedor #2295
- Tentativa 2 → Provedor #3291
- Tentativa 3 → Provedor #2482
- ...e assim por diante

**Health Tracker (em memória):** Cada provedor tem um perfil de saúde rastreado em tempo real:
- Score dinâmico (0-100): taxa de sucesso (60%), velocidade de resposta (20%), recência (20%)
- Cooldown progressivo: 60s → 120s → 300s → 600s após falhas consecutivas
- Auto-recovery: cooldown expira e o provedor volta a ser elegível
- Ranking: provedores ordenados por score antes de cada tentativa (melhores primeiro)

**Fallback Auto-Discover:** Se TODOS os provedores da lista configurada falharem:
1. Ativa Auto-Discover via `getPricesV3`
2. Busca provedores novos que NÃO estavam na lista original
3. Adiciona ao final da fila e continua tentando

**API exposta:**
- `smsService.getProviderHealthSummary()` — estado de todos os provedores
- `smsService.resetProviderHealth()` — reseta o tracker

---

## Pendências Recomendadas

### Expor health summary na UI

Criar endpoint tRPC para `smsService.getProviderHealthSummary()` e exibir na página de Settings ou em um dashboard de monitoramento.

### Testes com Vitest

Cobertura de testes para o orchestrator v2 e SMS service v2.

### Melhorar UI de Logs

Adicionar filtros por nível de log (info, warn, error) e busca por texto na página de logs.

### Upgrade Railway Pro

Plano atual sofre com cold starts e recursos limitados de RAM/CPU para jobs paralelos.

### Testes com Vitest

Cobertura de testes para o orchestrator v2 e SMS service v2.

---

## Observações Técnicas

### Estado do deploy no Railway

| Informação | Valor |
|---|---|
| **Deploy ativo** | `626916a8` (19/03/2026 08:00 UTC) — SUCCESS |
| **Últimos 5 deploys** | Todos FAILED (erro de build no ApiTokens.tsx) |
| **Fonte do código** | Upload via CLI (`railway up`), sem repositório Git vinculado |
| **Frontend (build local)** | 2995 módulos, ~515kb JS |
| **Backend (build local)** | `dist/index.js` 159.0kb |

### Warning de chunk size

O build do frontend gera um aviso de chunk acima de 500kb. Não é erro, pode ser otimizado com code-splitting.

### Variáveis de analytics

`%VITE_ANALYTICS_ENDPOINT%` e `%VITE_ANALYTICS_WEBSITE_ID%` não configuradas. Não afetam o funcionamento.
