# Relatório de Testes de Diagnóstico — permission_denied: user is blocked

**Commit de teste:** `f77657f`
**Branch:** `master`
**Data:** 20/03/2026
**Objetivo:** Alinhar o master com o comportamento do `feature/tls-impersonation` (que funciona) para identificar qual diferença causa o erro `permission_denied: user is blocked` no SMS.

---

## Contexto do Problema

O fluxo de criação de conta no master falha consistentemente no step 6 (SMS verification) com o erro `RPC user.v1.UserService/SendPhoneVerificationCode error [permission_denied]: user is blocked`. O mesmo fluxo funciona normalmente na branch `feature/tls-impersonation`. O registro, email e Turnstile funcionam em ambas as branches — o problema é exclusivo do SMS.

---

## Suspeitas Desativadas

Todas as mudanças estão marcadas com `[TESTE]` no código e incluem comentário `Para REVERTER:` com instruções específicas.

| # | Suspeita | Arquivo | Risco |
|---|----------|---------|-------|
| 1 | FPJS real ID vs sintético | `fingerprint.ts` | Alto |
| 2 | DCR timestamp com skew de 1-10s | `fingerprint.ts` | Médio |
| 3 | Timezone offset com jitter ±15min | `fingerprint.ts` | Médio |
| 4 | Proxy health check (GET manus.im/login com UA genérico) | `manus/index.ts` | Alto |
| 5 | Step 2 retry com troca de proxy | `manus/index.ts` | Baixo |
| 6 | Email retry 10x com dynamic timeout | `manus/index.ts` | Baixo |
| 7 | RPC retry 5x com backoff exponencial | `rpc.ts` | Médio |
| 8 | httpClient recusa funcionar sem curl-impersonate | `httpClient.ts` | Baixo |

---

## Detalhamento de Cada Suspeita

### Suspeita 1 — FPJS Real ID vs Sintético

**Arquivo:** `server/services/fingerprint.ts`

**O que mudou:** O master exigia um `realFgRequestId` obtido via Puppeteer/FPJS Pro. Se não tivesse, lançava erro CRÍTICO. Agora, se não tiver ID real, gera um ID sintético no formato `{timestamp}.{random6chars}` (idêntico ao feature/tls-impersonation).

**Por que é suspeito:** O `realFgRequestId` é gerado uma vez no início do job e reutilizado em TODAS as chamadas RPC (register, sendEmail, sendSMS). No feature/tls-impersonation, um ID novo é gerado em cada `regenerateDcr()`. Se o Manus detecta que o mesmo fgRequestId está sendo reutilizado, pode bloquear.

**Também desativado no orchestrator.ts:** A chamada `fpjsService.getRequestId(jobId)` foi comentada. O fingerprint agora é gerado sem ID real.

**Para REVERTER (fingerprint.ts):**
1. Remover a função `generateFgRequestId()` (linhas 36-46)
2. Restaurar o throw: `throw new Error("CRÍTICO: realFgRequestId é obrigatório para gerar o DCR...")`
3. Restaurar o throw no `generateProfile()`: `throw new Error("CRÍTICO: realFgRequestId é obrigatório para gerar o perfil...")`
4. Restaurar o throw no `regenerateDcr()`: `throw new Error("CRÍTICO: realFgRequestId é obrigatório para regenerar o DCR.")`

**Para REVERTER (orchestrator.ts):**
1. Descomentar: `const realFgRequestId = await fpjsService.getRequestId(jobId);`
2. Descomentar: `const fingerprint = fingerprintService.generateProfile(proxyRegion, realFgRequestId);`
3. Remover: `const fingerprint = fingerprintService.generateProfile(proxyRegion);`
4. Restaurar: `fpjsReal: !!realFgRequestId,`

---

### Suspeita 2 — DCR Timestamp com Skew

**Arquivo:** `server/services/fingerprint.ts` (função `buildDcrPayload`)

**O que mudou:** O master subtraía 1-10 segundos do `Date.now()` para simular latência de DNS/DSL. Agora usa `Date.now()` direto (como no feature/tls-impersonation).

**Por que é suspeito:** Se o Manus compara o timestamp do DCR com o timestamp de recebimento do request, um skew de 1-10s pode parecer anômalo. O feature/tls-impersonation não faz nenhum skew.

**Para REVERTER:**
Substituir `timestamp: Date.now(),` por `timestamp: Date.now() - (1000 + Math.floor(Math.random() * 9000)),`

---

### Suspeita 3 — Timezone Offset com Jitter ±15min

**Arquivo:** `server/services/fingerprint.ts` (função `generateProfile`)

**O que mudou:** O master adicionava um jitter de -15 a +15 minutos ao timezone offset real. Agora usa o offset real sem jitter (como no feature/tls-impersonation).

**Por que é suspeito:** Um offset de timezone que não é múltiplo de 30 minutos é extremamente raro e pode ser um sinal de bot. Por exemplo, se o timezone real é UTC+7 (offset -420), um jitter de +13 daria -407, que não existe em nenhum fuso horário real.

**Para REVERTER:**
Substituir:
```typescript
const timezoneOffset = getRealTimezoneOffset(timezone);
```
Por:
```typescript
const baseOffset = getRealTimezoneOffset(timezone);
const jitterMinutes = Math.floor(Math.random() * 31) - 15;
const timezoneOffset = baseOffset + jitterMinutes;
```

---

### Suspeita 4 — Proxy Health Check (step_0)

**Arquivo:** `server/providers/manus/index.ts`

**O que mudou:** O master fazia um `GET https://manus.im/login` com User-Agent genérico `"Mozilla/5.0"` antes de iniciar o fluxo. Isso foi completamente removido (como no feature/tls-impersonation que não tem step_0).

**Por que é suspeito (ALTA PROBABILIDADE):** O Manus pode estar registrando que o IP do proxy fez uma request com UA genérico "Mozilla/5.0" e depois, quando o mesmo IP faz requests com UA Chrome completo, detecta a inconsistência e bloqueia. Isso explicaria por que TODOS os provedores SMS falham — o proxy já está "queimado" antes do SMS.

**Para REVERTER:**
Restaurar o bloco completo de proxy health check com 15 tentativas, `checkProxyHealth()`, troca de proxy, etc. O código original está no git history (commit anterior a f77657f).

---

### Suspeita 5 — Step 2 Retry com Troca de Proxy

**Arquivo:** `server/providers/manus/index.ts`

**O que mudou:** O master tinha um loop de 5 tentativas no step 2 (getUserPlatforms) que trocava de proxy a cada falha. Agora faz uma chamada direta sem retry (como no feature/tls-impersonation).

**Por que é suspeito:** A troca de proxy no meio do fluxo pode causar inconsistência de IP (Turnstile resolvido com IP A, getUserPlatforms com IP B).

**Para REVERTER:**
Restaurar o loop de 5 tentativas com `MAX_STEP2_RETRIES`, troca de proxy via `proxyService.getProxy()`, e backoff de 3s.

---

### Suspeita 6 — Email Retry com Dynamic Timeout

**Arquivo:** `server/providers/manus/index.ts`

**O que mudou:** O master tinha 10 tentativas com timeout dinâmico (90s → 120s → 150s...) e try/catch no reenvio. Agora tem 3 tentativas com timeout fixo de 90s (como no feature/tls-impersonation).

**Por que é suspeito (BAIXA PROBABILIDADE):** Provavelmente não é a causa do permission_denied, mas o comportamento diferente pode afetar o timing do fluxo.

**Para REVERTER:**
Restaurar o loop de 10 tentativas com `MAX_EMAIL_RETRIES`, `dynamicTimeout`, e try/catch no reenvio de código.

---

### Suspeita 7 — RPC Retry 5x com Backoff

**Arquivo:** `server/providers/manus/rpc.ts`

**O que mudou:** O master tinha retry de 5 tentativas com backoff exponencial (2s, 4s, 8s, 16s) e classificação de erros permanentes vs transitórios. Agora faz uma chamada direta sem retry (como no feature/tls-impersonation).

**Por que é suspeito:** O retry de 5x para erros transitórios (resource_exhausted, internal, unavailable) pode estar causando rate limiting no Manus. Além disso, o timeout dinâmico (45s + 15s por tentativa) pode estar causando delays excessivos.

**Para REVERTER:**
Restaurar o loop `while (attempt <= MAX_RETRIES)` com backoff exponencial, classificação de `PermanentRpcError`, e timeout dinâmico.

---

### Suspeita 8 — httpClient Recusa sem curl-impersonate

**Arquivo:** `server/services/httpClient.ts`

**O que mudou:** O master lançava erro CRÍTICO se curl-impersonate não estivesse disponível. Agora faz fallback para fetch nativo com warning (como no feature/tls-impersonation).

**Por que é suspeito (BAIXA PROBABILIDADE):** Se curl-impersonate está instalado e funcionando, essa mudança não tem efeito. Mas se por algum motivo curl-impersonate falha intermitentemente, o master travava enquanto o feature/tls-impersonation continuava com fetch nativo.

**Para REVERTER:**
Substituir o `console.warn` + `return nativeFetchRequest(options)` por `throw new Error("CRÍTICO: curl-impersonate não está disponível...")`.

---

## Estratégia de Teste

O commit atual desativa TODAS as suspeitas simultaneamente. Se o SMS funcionar:

1. **Reativar uma suspeita por vez** (começando pelas de maior risco)
2. **Testar após cada reativação** para isolar qual causa o problema
3. **Ordem sugerida de reativação:**
   - Primeiro: Suspeita 5, 6, 8 (baixo risco)
   - Depois: Suspeita 7 (RPC retry)
   - Depois: Suspeita 2, 3 (timestamp/timezone)
   - Depois: Suspeita 4 (proxy health check)
   - Por último: Suspeita 1 (FPJS real ID)

---

## Como Reverter TUDO de Uma Vez

```bash
git revert f77657f
git push
```

Isso reverte todas as mudanças de teste e restaura o comportamento original do master.
