# Comparação Completa: Master vs feature/tls-impersonation

**Data:** 20 de Março de 2026  
**Objetivo:** Identificar TODAS as diferenças críticas entre as branches

## Resumo Executivo

A branch `feature/tls-impersonation` não é apenas uma correção de SMS. É uma **refatoração completa** que simplifica e melhora vários sistemas:

| Sistema | Master | feature/tls-impersonation | Impacto |
|---------|--------|---------------------------|---------|
| **RPC (Manus)** | Retry com 5 tentativas | Sem retry | ⚠️ Crítico |
| **SMS** | v3.0 complexo (1641 linhas) | v2.1 simples (837 linhas) | ⚠️ Crítico |
| **Proxy** | Com geo-blocking | Sem geo-blocking | ⚠️ Importante |
| **Email** | Retry com 10 tentativas | Retry simples | ⚠️ Importante |
| **Orchestrator** | Com AbortSignal | Sem AbortSignal | ⚠️ Importante |

## Diferenças Críticas por Arquivo

### 1. **server/providers/manus/rpc.ts** (103 linhas de mudança)

#### Master (ATUAL - COM RETRY)
```typescript
const MAX_RETRIES = 5;
let attempt = 1;
let lastError: Error | null = null;

while (attempt <= MAX_RETRIES) {
  try {
    const response = await httpRequest({
      timeout: 45 + (attempt * 15), // Aumenta timeout a cada tentativa
    });
    
    // Diferencia erros permanentes de transitórios
    const permanentErrors = ["invalid_argument", "unauthenticated", "not_found", "already_exists"];
    if (permanentErrors.includes(data.code)) {
      throw err; // Não faz retry
    }
    
    return data; // Sucesso!
  } catch (err) {
    if (lastError.name === "PermanentRpcError") {
      throw lastError; // Não faz retry
    }
    
    // Backoff exponencial: 2s, 4s, 8s, 16s...
    const backoff = Math.min(2000 * Math.pow(2, attempt - 1) + Math.random() * 1000, 30000);
    await new Promise(r => setTimeout(r, backoff));
    attempt++;
  }
}
```

#### feature/tls-impersonation (NOVO - SEM RETRY)
```typescript
const response = await httpRequest({
  timeout: 30, // Timeout fixo
});

// Sem diferenciação de erros permanentes vs transitórios
if (data.code && !["ok", "OK"].includes(data.code)) {
  throw new Error(`RPC error [${data.code}]: ${debugMsg}`);
}

return data;
```

**Impacto:**
- ❌ **Master:** Tenta 5 vezes com backoff exponencial
- ✅ **feature/tls-impersonation:** Falha rápido, deixa SMS Service fazer retry
- **Resultado:** Menos timeout, mais rápido, mas SMS Service precisa fazer retry

---

### 2. **server/services/sms.ts** (1503 linhas de mudança)

#### Master (ATUAL - v3.0 COMPLEXO)
```typescript
// 1641 linhas
// - Multi-país (KNOWN_COUNTRIES)
// - PhoneNumberQualityTracker (7 dias de cache)
// - ProviderHealthTracker v3.0 (target rejections + cooldown agressivo)
// - _getCodeForCountry() com lógica complexa
// - Blacklist automática
// - Auto-remove de provedores ruins
// - Persistência em DB (sms_provider_health)
```

#### feature/tls-impersonation (NOVO - v2.1 SIMPLES)
```typescript
// 837 linhas
// - Um único país (compatibilidade retroativa)
// - ProviderHealthTracker v2.1 (apenas successes/failures)
// - getCodeWithRetry() simples
// - Sem PhoneNumberQualityTracker
// - Sem blacklist automática
// - Sem persistência em DB
```

**Impacto:**
- ❌ **Master:** Muita complexidade, muitos bugs potenciais
- ✅ **feature/tls-impersonation:** Simples, fácil de debugar
- **Resultado:** Menos linhas, menos bugs, mais manutenível

---

### 3. **server/providers/manus/index.ts** (200 linhas de mudança)

#### Diferença 1: Email Retry

**Master (ATUAL):**
```typescript
const MAX_EMAIL_RETRIES = 10;
let attempt = 1;

while (true) {
  try {
    const dynamicTimeout = MANUS_CONFIG.emailTimeout + (attempt - 1) * 30000;
    emailCode = await emailService.waitForVerificationCode(
      email, MANUS_CONFIG.emailFromDomain, dynamicTimeout, jobId
    );
    break;
  } catch (err) {
    if (attempt >= MAX_EMAIL_RETRIES) {
      throw new Error(`Email não recebido após ${MAX_EMAIL_RETRIES} tentativas`);
    }
    
    // Reenviar código com novo Turnstile
    const newTurnstileToken = await solveTurnstileWithRetry(proxy, jobId);
    const { tempToken: newTempToken } = await rpc.getUserPlatforms(email, newTurnstileToken, rpcOptions);
    await rpc.sendEmailVerifyCodeWithCaptcha(email, EmailVerifyCodeAction.REGISTER, newTempToken, rpcOptions);
    attempt++;
  }
}
```

**feature/tls-impersonation (NOVO):**
```typescript
let retries = 0;

while (true) {
  try {
    emailCode = await emailService.waitForVerificationCode(
      email, MANUS_CONFIG.emailFromDomain, MANUS_CONFIG.emailTimeout, jobId
    );
    break;
  } catch (err) {
    retries++;
    if (retries >= MANUS_CONFIG.maxRetries) {
      throw new Error(`Email não recebido após ${retries} tentativas`);
    }
    
    // Reenviar código simples
    const newTurnstileToken = await solveTurnstileWithRetry(proxy, jobId);
    const { tempToken: newTempToken } = await rpc.getUserPlatforms(email, newTurnstileToken, rpcOptions);
    await rpc.sendEmailVerifyCodeWithCaptcha(email, EmailVerifyCodeAction.REGISTER, newTempToken, rpcOptions);
  }
}
```

**Impacto:**
- ❌ **Master:** Timeout dinâmico (90s → 120s → 150s)
- ✅ **feature/tls-impersonation:** Timeout fixo (mais simples)
- **Resultado:** Menos complexidade, mesmo resultado

---

#### Diferença 2: SMS regionCode

**Master (ATUAL):**
```typescript
onNumberRented: async ({ phoneNumber, activationId, attempt, regionCode }) => {
  const formattedPhone = formatPhoneForManus(phoneNumber, regionCode);
  
  await rpc.sendPhoneVerificationCode(
    formattedPhone,
    regionCode,  // ← Vem do SMS Service
    MANUS_CONFIG.smsLocale,
    authedRpcOptions
  );
}
```

**feature/tls-impersonation (NOVO):**
```typescript
onNumberRented: async ({ phoneNumber, activationId, attempt }) => {
  const formattedPhone = formatPhoneForManus(phoneNumber, MANUS_CONFIG.smsRegionCode);
  
  await rpc.sendPhoneVerificationCode(
    formattedPhone,
    MANUS_CONFIG.smsRegionCode,  // ← Fixo na config
    MANUS_CONFIG.smsLocale,
    authedRpcOptions
  );
}
```

**Impacto:**
- ❌ **Master:** SMS Service retorna regionCode (multi-país)
- ✅ **feature/tls-impersonation:** Fixo na config (um único país)
- **Resultado:** Menos flexibilidade, mas mais simples

---

### 4. **server/services/proxy.ts** (92 linhas de mudança)

#### Diferença: Geo-blocking Removido

**Master (ATUAL):**
```typescript
// Obter a blacklist de países bloqueados (ex: "ID,BR,US")
const blockedCountriesStr = await getSetting("proxy_blocked_countries") || "";
const blockedCountries = blockedCountriesStr
  .split(",")
  .map(c => c.trim().toUpperCase())
  .filter(c => c.length > 0);

// Filtrar proxies de países bloqueados
const conditions = and(
  eq(proxies.enabled, true),
  isNull(proxies.lastUsedAt),
  sql`${proxies.country} IS NULL OR ${proxies.country} NOT IN (${sql.raw(blockedList)})`
);
```

**feature/tls-impersonation (NOVO):**
```typescript
// Sem geo-blocking
const result = await db
  .select()
  .from(proxies)
  .where(
    and(
      eq(proxies.enabled, true),
      isNull(proxies.lastUsedAt)
    )
  )
```

**Impacto:**
- ❌ **Master:** Pode bloquear países específicos
- ✅ **feature/tls-impersonation:** Usa todos os proxies disponíveis
- **Resultado:** Menos filtros, mais proxies disponíveis

#### Diferença: Geo-coherent Fingerprint Removido

**Master (ATUAL):**
```typescript
// Função getProxyRegion() com 60+ linhas
// - Resolve região do proxy via ipinfo.io
// - Cache 24h em memória
// - Gera fingerprint geo-coerente (locale, timezone, tzOffset)

const proxyRegion = proxy ? await getProxyRegion(proxy.host) : region;
const fingerprint = fingerprintService.generateProfile(proxyRegion, realFgRequestId);
```

**feature/tls-impersonation (NOVO):**
```typescript
// Sem resolução de região
const fingerprint = fingerprintService.generateProfile(region);
```

**Impacto:**
- ❌ **Master:** Fingerprint geo-coerente (mais realista)
- ✅ **feature/tls-impersonation:** Fingerprint simples (menos API calls)
- **Resultado:** Menos chamadas externas, mas fingerprint menos realista

---

### 5. **server/core/orchestrator.ts** (101 linhas de mudança)

#### Diferença: AbortSignal Removido

**Master (ATUAL):**
```typescript
// Usa AbortSignal para cancelamento imediato
const controller = new AbortController();
this.activeJobs.set(jobId, controller);

// No loop:
if (signal?.aborted) {
  const abortErr = new Error(`Job ${jobId} abortado`);
  abortErr.name = "AbortError";
  throw abortErr;
}

// Ao cancelar:
async cancelJob(jobId: number): Promise<void> {
  const controller = this.activeJobs.get(jobId);
  if (controller) {
    controller.abort();  // ← Sinal imediato
  }
}
```

**feature/tls-impersonation (NOVO):**
```typescript
// Sem AbortSignal, apenas polling de status no DB
// No loop:
const currentJob = await db.select({ status: jobs.status }).from(jobs).where(...);
if (currentJob[0]?.status === "cancelled") {
  break;
}

// Ao cancelar:
async cancelJob(jobId: number): Promise<void> {
  await db.update(jobs).set({ status: "cancelled" }).where(...);
  // ← Apenas marca no DB, sem sinal imediato
}
```

**Impacto:**
- ❌ **Master:** Cancelamento imediato (mais responsivo)
- ✅ **feature/tls-impersonation:** Cancelamento por polling (mais simples)
- **Resultado:** Menos responsivo, mas sem AbortSignal complexity

#### Diferença: FPJS Real ID Removido

**Master (ATUAL):**
```typescript
// Obtém real FPJS Pro requestId
const realFgRequestId = await fpjsService.getRequestId(jobId);
const fingerprint = fingerprintService.generateProfile(proxyRegion, realFgRequestId);
```

**feature/tls-impersonation (NOVO):**
```typescript
// Sem FPJS real ID
const fingerprint = fingerprintService.generateProfile(region);
```

**Impacto:**
- ❌ **Master:** FPJS real ID (mais realista, mas mais lento)
- ✅ **feature/tls-impersonation:** Sem FPJS (mais rápido)
- **Resultado:** Mais rápido, mas fingerprint menos realista

---

## Resumo das Diferenças

### 🔴 Mudanças Críticas (Afetam Funcionamento)

| Mudança | Master | feature/tls-impersonation | Impacto |
|---------|--------|---------------------------|---------|
| **RPC Retry** | 5 tentativas com backoff | Sem retry | SMS Service faz retry |
| **SMS Service** | v3.0 complexo | v2.1 simples | Menos bugs, mais manutenível |
| **Email Timeout** | Dinâmico (90s-150s) | Fixo (90s) | Mais rápido, menos timeout |
| **Cancelamento** | AbortSignal imediato | Polling no DB | Menos responsivo |

### 🟡 Mudanças Importantes (Afetam Performance)

| Mudança | Master | feature/tls-impersonation | Impacto |
|---------|--------|---------------------------|---------|
| **Geo-blocking** | Com filtro de países | Sem filtro | Mais proxies disponíveis |
| **Geo-coherent FP** | Com resolução ipinfo.io | Sem resolução | Menos API calls |
| **FPJS Real ID** | Com real ID | Sem real ID | Mais rápido, menos realista |

### 🟢 Mudanças Menores (Afetam Código)

| Mudança | Master | feature/tls-impersonation | Impacto |
|---------|--------|---------------------------|---------|
| **SMS regionCode** | Dinâmico (multi-país) | Fixo (um país) | Menos flexibilidade |
| **Health Persistence** | Com DB | Sem DB | Menos dados persistidos |

---

## Conclusão

A branch `feature/tls-impersonation` **não é apenas uma correção de SMS**. É uma **simplificação arquitetural completa** que:

1. ✅ **Remove complexidade desnecessária** (v3.0 → v2.1)
2. ✅ **Melhora performance** (menos API calls, menos retry)
3. ✅ **Mantém funcionalidade** (SMS ainda funciona)
4. ❌ **Sacrifica alguns recursos** (geo-coherent FP, FPJS real ID)

### Recomendação

Para o master, precisamos:

1. ✅ **Aplicar correção de SMS** (já feito)
2. ⚠️ **Considerar simplificação de RPC** (remover retry complexo?)
3. ⚠️ **Considerar simplificação de Email** (timeout fixo?)
4. ⚠️ **Considerar remoção de Geo-blocking** (mais proxies disponíveis?)

---

**Status:** Análise completa  
**Próximo:** Decidir quais mudanças aplicar além do SMS fix
