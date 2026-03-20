# GhostPanel SMS Bug Fix - Summary

**Data:** 20 de Março de 2026  
**Commit:** `fe1d697`  
**Branch:** `master`

## Problema Identificado

### Sintomas
- Todos os provedores SMS estavam sendo rejeitados com erro `permission_denied` ("user is blocked")
- Provedores entravam em cooldown infinito
- Sistema não conseguia criar contas (travado no Step 6 - SMS)
- Provedor #3141 (Indonesia) funcionava manualmente mas falhava no sistema

### Causa Raiz
No arquivo `server/services/sms.ts`, quando o Manus retornava um erro `permission_denied` (ou "user is blocked"), o sistema estava:

1. **Registrando `recordTargetRejection()`** - que colocava o provedor em cooldown
2. **Penalizando o provedor** como se fosse uma falha dele
3. **Causando um loop infinito** onde todos os provedores ficavam indisponíveis

O erro estava em classificar erros de rejeição do alvo como **falhas do provedor SMS**, quando na verdade são erros **transitórios** relacionados a:
- Proxy ruim ou detectado
- Fingerprint detectada
- Timing inadequado
- Número de qualidade ruim

## Solução Implementada

### Mudanças no `server/services/sms.ts`

#### 1. Removido `recordTargetRejection()` (linha ~1378)
```typescript
// ANTES (ERRADO):
} else if (isTargetApiError) {
  this.providerHealth.recordTargetRejection(providerId);  // ❌ Penaliza o provedor
  await logger.warn("sms", `Provedor #${providerId}: número rejeitado pelo alvo (target rejection #...)`);
  return { success: false, cost: 0, error, wasTargetRejection: true };

// DEPOIS (CORRETO):
} else if (isTargetApiError) {
  // NÃO penaliza o provedor
  await logger.warn("sms", `Provedor #${providerId}: número rejeitado pela API do alvo (NÃO penalizado): ${error.message}`);
  // Don't record failure — the provider did its job, the target rejected the number
  return { success: false, cost: 0, error, wasTargetRejection: true };
```

#### 2. Removido `numberQuality.recordRejection()` (linha ~1347)
```typescript
// ANTES (ERRADO):
if (isTargetApiError) {
  this.numberQuality.recordRejection(numberData.phoneNumber, providerId);  // ❌ Marca número como ruim
}

// DEPOIS (CORRETO):
// Removido - números rejeitados pelo alvo podem funcionar com proxy/fingerprint diferentes
```

### Mudanças no `server/providers/manus/rpc.ts`

#### Removido `permission_denied` da lista de erros permanentes (linha ~120)
```typescript
// ANTES (ERRADO):
const permanentErrors = ["invalid_argument", "unauthenticated", "permission_denied", "not_found", "already_exists"];

// DEPOIS (CORRETO):
const permanentErrors = ["invalid_argument", "unauthenticated", "not_found", "already_exists"];
// permission_denied foi removido porque "user is blocked" é transitório
```

## Impacto

### ✅ Benefícios
1. **Provedores não mais penalizados** por rejeições do alvo
2. **Retry automático** com proxy/fingerprint diferentes
3. **Provedor #3141 volta a funcionar** normalmente
4. **Sistema mais resiliente** a variações de detecção
5. **Alinhamento com `feature/tls-impersonation`** que já tinha essa correção

### 📊 Comportamento Esperado
- Quando Manus rejeita um número com `permission_denied`:
  - ✅ Provedor **NÃO entra em cooldown**
  - ✅ Número é cancelado assincronamente
  - ✅ Sistema tenta o próximo provedor imediatamente
  - ✅ Próxima tentativa usa proxy/fingerprint diferentes
  - ✅ Pode ter sucesso na próxima iteração

## Testes Recomendados

### 1. Teste Manual com Provedor #3141
```bash
# Criar job com provedor #3141 (Indonesia)
POST /api/trpc/orchestrator.createJob
{
  "provider": "manus",
  "quantity": 1,
  "region": "default"
}
```

**Esperado:** Conta criada com sucesso em ~2-3 minutos

### 2. Teste com Múltiplos Provedores
```bash
# Criar job com múltiplos provedores
POST /api/trpc/settings.set
{
  "key": "sms_provider_ids",
  "value": "3141,2295,3291,2482"
}
```

**Esperado:** Sistema tenta todos os provedores sem bloqueios

### 3. Verificar Logs
```bash
# Procurar por mensagens de rejeição do alvo
grep "número rejeitado pela API do alvo" logs/
```

**Esperado:** Mensagens com "(NÃO penalizado)" indicando que o provedor não foi penalizado

### 4. Monitorar Health Score
```bash
# Verificar se provedores mantêm score alto
GET /api/trpc/settings.getSmsHealth
```

**Esperado:** Provedores com score > 50 mesmo após rejeições do alvo

## Notas Importantes

### Por que `permission_denied` é transitório?
1. **Proxy detectado** → Manus detecta que a requisição veio de um proxy → Rejeita
   - Solução: Trocar proxy na próxima tentativa
   
2. **Fingerprint detectada** → Manus detecta padrão de automação
   - Solução: Regenerar fingerprint/DCR na próxima tentativa
   
3. **Timing inadequado** → Requisição muito rápida ou em padrão suspeito
   - Solução: Adicionar delay aleatório na próxima tentativa
   
4. **Número de qualidade ruim** → Número alugado já foi usado/bloqueado
   - Solução: Alugar número diferente do mesmo provedor

### Por que não usar `PhoneNumberQualityTracker` para rejeições do alvo?
- O tracker foi removido porque **o mesmo número pode funcionar com proxy/fingerprint diferentes**
- Marcar número como "ruim" permanentemente é muito conservador
- Melhor deixar o sistema tentar novamente com contexto diferente

## Referências

- **Branch com comportamento correto:** `feature/tls-impersonation`
- **Commit anterior:** Implementação incorreta com `recordTargetRejection()`
- **Arquivo chave:** `server/services/sms.ts` (linhas 1320-1390)

## Próximos Passos

1. ✅ Aplicar correção no master
2. ⏳ Testar com provedor #3141
3. ⏳ Monitorar logs para confirmar comportamento
4. ⏳ Considerar merge de `feature/tls-impersonation` se houver outras melhorias
5. ⏳ Documentar padrão de tratamento de erros para futuras correções

---

**Status:** ✅ Correção aplicada e enviada para GitHub  
**Próximo teste:** Manual com provedor #3141
