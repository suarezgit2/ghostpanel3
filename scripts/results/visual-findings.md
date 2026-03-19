# Achados Visuais — Testes de Fingerprint nas Plataformas

## 1. BrowserScan Bot Detection
- **Resultado Geral:** "Test Results: 🔴 Robot"
- **WebDriver:** DETECTADO (vermelho) — CDP (Chrome DevTools Protocol) detectado
- **User-Agent:** Normal ✅
- **Navigator:** Normal ✅
- **Problema crítico:** Chrome DevTools Protocol Detection — "Failed" (vermelho)
  - O Puppeteer usa CDP para controlar o browser, e o BrowserScan detecta isso
  - Mesmo com stealth plugin, o CDP leak é detectado neste ambiente headless

## 2. BrowserScan Fingerprint (página principal)
- **Bot Cursor:** ⚠️ Detectado como problemático
- **Different browser version:** ⚠️ Detectado — "The browser version set by your browser does not match your actual browser version"
  - UA diz Chrome 136 mas o Chromium real é uma versão diferente
- **Platform:** Linux x86_64 (vazando — UA diz Windows!)
- **Screen:** 800x600 (padrão headless — vazando!)
- **WebDriver:** false ✅ (stealth funcionou aqui)
- **Plugins:** 5 ✅
- **Timezone:** America/New_York ✅
- **Timezone Offset:** 240 (EDT correto) ✅
- **Remote Browsing Solution:** Detectado ⚠️

## 3. Fingerprint.com Demo
- Gerou um visitorId único: 9tnS5mew1107xpa892c
- Chrome 136 detectado ✅
- IP: 54.209.231.240 (AWS/Amazon)
- Sem sinais de bot visíveis na demo

## 4. CreepJS
- **Headless:** DETECTADO — "53% like headless @platform"
  - platform: Linux x86_64 (vazando — UA diz Win32!)
  - screen: 800x600 (headless padrão!)
- **Timezone:** America/New_York ✅, Intl correto ✅
- **WebGL:** Detectado como problemático (software renderer)
- **Screen:** 800x600 (PROBLEMA — headless default)
- **Navigator.platform:** Linux x86_64 (PROBLEMA — UA diz Windows)
- **Canvas fingerprint:** gerado ✅

## 5. PixelScan
- Não completou o scan automático (precisa de clique manual)

## PROBLEMAS IDENTIFICADOS (para o GhostPanel)

### CRÍTICO: Platform/Screen inconsistência
- O Puppeteer headless expõe `navigator.platform = "Linux x86_64"` e `screen = 800x600`
- O UA diz "Windows NT 10.0; Win64; x64" mas o platform real é Linux
- **Impacto no GhostPanel:** O GhostPanel NÃO usa Puppeteer para as chamadas API!
  - Ele usa `fetch()` direto com headers customizados
  - O DCR é construído com os valores corretos (Win32, 1920x1080)
  - Portanto este problema NÃO afeta o GhostPanel

### CRÍTICO: CDP (Chrome DevTools Protocol) Detection
- O Puppeteer usa CDP que é detectável
- **Impacto no GhostPanel:** Afeta apenas o fpjs.ts (geração de requestId real)
  - O stealth plugin já mitiga parcialmente
  - O GhostPanel usa fgRequestId sintético como fallback

### NOTA IMPORTANTE:
Os testes acima são do BROWSER PUPPETEER (ambiente de teste), não do GhostPanel em si.
O GhostPanel faz chamadas API diretas com fetch() + headers customizados.
As plataformas de detecção testam o BROWSER, não as chamadas HTTP.
