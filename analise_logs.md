# Análise: Log Funcional (feature/tls-impersonation) vs Log Quebrado (master)

## Log Funcional (feature/tls-impersonation)
- Provedor #3208 falhou: "Sem números disponíveis" → passou pro próximo
- Provedor #1329: alugou +6285602253478, SMS recebido em 16s, código 395907
- sendPhoneVerificationCode: SEM ERRO, funcionou de primeira
- bindPhoneTrait: funcionou
- Convite: funcionou, 1500 créditos

## Log Quebrado (master) - do pasted_content_7.txt anterior
- Provedor #3291: permission_denied: user is blocked
- Provedor #3141: permission_denied: user is blocked
- Provedor #1507: Job cancelado
- TODOS os provedores recebem permission_denied

## Diferença CHAVE
No log funcional, sendPhoneVerificationCode FUNCIONA sem erro.
No log quebrado, sendPhoneVerificationCode SEMPRE retorna permission_denied.

Isso NÃO é problema do SMS Service. O problema é que o Manus está rejeitando
a chamada sendPhoneVerificationCode com "user is blocked".

## Possíveis causas (baseado no diff dos branches)
1. rpc.ts: retry de 5x no master vs sem retry no feature/tls-impersonation
2. httpClient: curl-impersonate (TLS fingerprint) pode ser diferente
3. Proxy health check no master pode estar causando algum side effect
4. regionCode dinâmico vs hardcoded "+62"
