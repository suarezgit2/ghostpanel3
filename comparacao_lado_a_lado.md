# Comparação Lado a Lado dos Logs

## feature/tls-impersonation (FUNCIONA)
- 17:46:54 Proxy alocado
- 17:46:54 Turnstile...
- 17:47:06 Turnstile resolvido (14s)
- 17:47:08 Check email
- 17:47:11 Send email
- 17:47:18 Email code found
- 17:47:22 Register... sucesso!
- 17:47:26 SMS fila: [3141, 2263] (2 disponíveis)
- 17:47:27 Número alugado +6285950215331 (provider 3141)
- 17:47:27 [Tentativa 1] Enviando SMS para +6285950215331
- 17:47:29 Aguardando SMS (timeout 180s)
- 17:47:51 Aguardando SMS... 21s
- 17:48:12 Aguardando SMS... 43s
- 17:48:33 Aguardando SMS... 64s
- (continua aguardando... SMS recebido eventualmente)

## master (NÃO FUNCIONA)
- 17:29:48 Proxy OK
- 17:29:49 Turnstile...
- 17:29:58 Turnstile resolvido (11s)
- 17:29:59 Check email
- 17:30:01 Send email
- 17:30:10 Email code found
- 17:30:14 Register... sucesso!
- 17:30:25 SMS fila: [3291, 3141, 1507, 1329, 3290] (5 disponíveis)
- 17:30:26 Número alugado +6285821531474 (provider 3291)
- 17:30:26 [Tentativa 1] Enviando SMS para +6285821531474
- 17:31:00 ERRO: permission_denied: user is blocked (34s depois!)
- 17:31:08 Tentativa 2 com provider 3141
- 17:31:42 ERRO: permission_denied: user is blocked (34s depois!)
- ... repete para TODOS os provedores e TODOS os países

## Diferenças Críticas

### 1. Tempo entre envio e resposta
- feature/tls-impersonation: Envia SMS e ESPERA o código (180s timeout)
- master: Envia SMS e recebe ERRO em ~34s (retry do RPC)

### 2. O que acontece no sendPhoneVerificationCode
- feature/tls-impersonation: SUCESSO imediato, depois aguarda SMS
- master: FALHA com permission_denied em TODAS as tentativas

### 3. A conta FOI registrada com sucesso em ambos
- Registro funciona em ambos
- O bloqueio acontece APENAS no sendPhoneVerificationCode

### 4. Diferenças de código entre os branches
- FPJS: master usa realFgRequestId, feature usa sintético
- DCR timestamp: master tem skew de 1-10s, feature usa Date.now()
- DCR timezone offset: master tem jitter ±15min, feature não
- Proxy health check: master faz step_0, feature não
- RPC retry: master 5x com backoff, feature sem retry
- httpClient: master recusa funcionar sem curl-impersonate, feature faz fallback
