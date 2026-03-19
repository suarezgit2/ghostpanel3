# Pendências — Correções de TypeScript

> Erros pré-existentes identificados em 19/03/2026. Nenhuma lógica de negócio é afetada.
> Todas as correções são cirúrgicas (apenas tipagem). Aplicar quando conveniente.

---

## 1. `client/src/pages/RedeemKey.tsx` — 3 erros

**Linhas:** 144, 145, 146

**Erro:** O componente acessa `checkQuery.data.label` e `checkQuery.data.expiresAt`, mas o
endpoint `keys.check` retorna apenas `{ valid, credits }` no caso de sucesso — sem esses campos.

**Correção:** Adicionar `label` e `expiresAt` ao retorno de sucesso do endpoint `keys.check`
em `server/routers/keys.ts`:

```ts
// keys.ts — dentro do check endpoint, retorno de sucesso:
return {
  valid: true,
  credits: key.credits,
  label: key.label ?? null,
  expiresAt: key.expiresAt ?? null,
};
```

---

## 2. `server/_core/context.ts` — 2 erros

**Linhas:** 59, 79

**Erro:** `db.getUserByOpenId()` retorna `User | undefined`, mas o tipo `TrpcContext.user`
espera `User | null`. O TypeScript não aceita `undefined` onde `null` é declarado.

**Correção:** Adicionar `?? null` nos dois pontos de chamada:

```ts
// linha 59:
return (await db.getUserByOpenId(localOpenId)) ?? null;

// linha 79:
user = (await db.getUserByOpenId(jwtPayload.openId)) ?? null;
```

---

## 3. `server/_core/security.ts` — 1 erro

**Linha:** 77

**Erro:** `for...of` diretamente em um `Map` gera TS2802 porque o `tsconfig.json` não define
`target` explícito nem `downlevelIteration: true`.

**Correção:** Substituir por `store.forEach()`:

```ts
// Antes:
for (const [key, entry] of store) {
  if (now > entry.resetAt) store.delete(key);
}

// Depois:
store.forEach((entry, key) => {
  if (now > entry.resetAt) store.delete(key);
});
```

---

## 4. `server/services/httpClient.ts` — 4 erros

**Linhas:** 207, 218, 219, 223

**Erro:** A biblioteca `impers` retorna um objeto com shape próprio (`statusCode`, `statusText`,
`text` como string), mas o TypeScript infere o tipo como `Response` nativo do browser/Node,
que não possui esses campos.

**Correção:** Declarar uma interface local `ImpersResponse` e fazer cast do retorno:

```ts
interface ImpersResponse {
  statusCode?: number;
  status?: number;
  statusText?: string;
  text?: string | (() => string);
  headers?: Record<string, unknown> | { data?: Record<string, unknown> };
}

// Nos 4 pontos de chamada (get/post/put/del), adicionar o cast:
const response = (await impers.get(options.url, requestOptions)) as ImpersResponse;
// idem para post, put, del
```

---

## 5. `server/services/sms.ts` — 2 erros

### Erro A — Linha 196

**Erro:** `for...of` em `Map.entries()` — mesmo problema do `security.ts` (TS2802).

**Correção:**

```ts
// Antes:
for (const [id, h] of this.health.entries()) { ... }

// Depois:
this.health.forEach((h, id) => { ... });
```

### Erro B — Linha 598

**Erro:** `onNumberRented` é atribuído como `options.onNumberRented || null`, mas
`_tryProvider()` declara esse campo como `RetryOptions["onNumberRented"]` (que é
`... | undefined`, não `... | null`).

**Correção:**

```ts
// Antes:
const onNumberRented = options.onNumberRented || null;

// Depois:
const onNumberRented = options.onNumberRented ?? undefined;
```

---

## Resumo

| Arquivo | Erros | Tipo de correção |
|---|---|---|
| `client/src/pages/RedeemKey.tsx` | 3 | Adicionar campos ao retorno do endpoint `keys.check` |
| `server/_core/context.ts` | 2 | Coalescer `undefined` para `null` com `?? null` |
| `server/_core/security.ts` | 1 | Trocar `for...of Map` por `Map.forEach` |
| `server/services/httpClient.ts` | 4 | Criar interface `ImpersResponse` e fazer cast |
| `server/services/sms.ts` | 2 | `Map.forEach` + `?? undefined` no callback |
| **Total** | **12** | |
