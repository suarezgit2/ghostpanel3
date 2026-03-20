# Diferenças Chave: master vs feature/tls-impersonation (manus/index.ts)

## 1. SMS: regionCode hardcoded vs dinâmico
- **feature/tls-impersonation**: Usa `MANUS_CONFIG.smsRegionCode` (hardcoded "+62")
- **master**: Usa `regionCode` dinâmico vindo do callback `onNumberRented`

## 2. SMS: callback onNumberRented
- **feature/tls-impersonation**: `onNumberRented: async ({ phoneNumber, activationId, attempt })` - SEM regionCode
- **master**: `onNumberRented: async ({ phoneNumber, activationId, attempt, regionCode })` - COM regionCode

## 3. SMS: formatPhoneForManus
- **feature/tls-impersonation**: `formatPhoneForManus(phoneNumber, MANUS_CONFIG.smsRegionCode)` - sempre "+62"
- **master**: `formatPhoneForManus(phoneNumber, regionCode)` - dinâmico

## 4. SMS: bindPhoneTrait
- **feature/tls-impersonation**: `rpc.bindPhoneTrait(formattedPhone, MANUS_CONFIG.smsRegionCode, ...)`
- **master**: `rpc.bindPhoneTrait(formattedPhone, smsRegionCode, ...)`

## 5. Proxy: Sem health check
- **feature/tls-impersonation**: Sem STEP 0 (proxy health check), sem rotação de proxy
- **master**: STEP 0 com 15 tentativas de proxy health check

## 6. Email: Retry simples
- **feature/tls-impersonation**: 3 retries, timeout fixo 90s
- **master**: 10 retries, timeout dinâmico (90s → 120s → 150s...)

## 7. Step 2: Sem retry
- **feature/tls-impersonation**: Chamada direta sem retry
- **master**: 5 retries com troca de proxy
