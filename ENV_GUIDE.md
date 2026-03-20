# Ghost Panel v5.2+ - Guia de Variáveis de Ambiente

Para rodar o projeto localmente ou em produção, crie um arquivo `.env` na raiz do projeto com as variáveis abaixo. Todas as variáveis são lidas pelo servidor no boot e ficam disponíveis via `process.env`.

## Variáveis Obrigatórias

Estas variáveis são necessárias para o funcionamento básico do sistema.

| Variável | Descrição | Exemplo |
|----------|-----------|---------|
| `DATABASE_URL` | Connection string MySQL/TiDB | `mysql://ghost:ghost123@localhost:3306/ghost_panel` |
| `JWT_SECRET` | Segredo para assinar cookies JWT (gere com `openssl rand -hex 32`) | `a1b2c3d4e5f6...` |
| `LOCAL_AUTH` | Ativa bypass de autenticação local (sem OAuth) | `true` |

## Captcha (pelo menos um é obrigatório)

O sistema suporta dois provedores de captcha com auto-fallback. Se o provedor selecionado não tiver API key, o outro é usado automaticamente.

| Variável | Serviço | Onde obter |
|----------|---------|------------|
| `CAPTCHA_PROVIDER` | Provedor preferido (`2captcha` ou `capsolver`) | Padrão: `capsolver` |
| `TWOCAPTCHA_API_KEY` | 2Captcha (recomendado, mais estável) | https://2captcha.com/ |
| `CAPSOLVER_API_KEY` | CapSolver (alternativa) | https://www.capsolver.com/ |

## SMS

| Variável | Serviço | Onde obter |
|----------|---------|------------|
| `SMSBOWER_API_KEY` | SMSBower (números virtuais para SMS) | https://smsbower.com/ |

O serviço usa números da Indonésia (país 6, serviço "ot") com preço máximo de $0.01 por número. Configurações avançadas (país, serviço, preço máximo) podem ser alteradas na página de Configurações do painel.

## Proxies

| Variável | Serviço | Onde obter |
|----------|---------|------------|
| `WEBSHARE_API_KEY` | Webshare (proxies rotativos) | https://www.webshare.io/ |

Os proxies são sincronizados automaticamente do Webshare. Use o botão "Sincronizar" na página de Proxies para importar manualmente.

## Zoho Mail (Email catch-all)

O Zoho Mail é usado para ler os emails de verificação enviados pelo manus.im. É necessário configurar um domínio catch-all (ex: `@lojasmesh.com`) no Zoho para receber emails de qualquer endereço nesse domínio.

| Variável | Descrição |
|----------|-----------|
| `ZOHO_CLIENT_ID` | Client ID do OAuth2 |
| `ZOHO_CLIENT_SECRET` | Client Secret do OAuth2 |
| `ZOHO_REFRESH_TOKEN` | Refresh Token do OAuth2 (escopo: `ZohoMail.messages.READ ZohoMail.accounts.READ`) |
| `ZOHO_ACCOUNT_ID` | ID numérico da conta Zoho Mail |

Para configurar o OAuth2 do Zoho, acesse https://api-console.zoho.com/ e crie um "Self Client" com os escopos `ZohoMail.messages.READ` e `ZohoMail.accounts.READ`. Gere um refresh token com esses escopos.

## TLS Impersonation (opcional, recomendado)

O sistema usa `impers` (curl-impersonate) para fazer requisições HTTP com fingerprint TLS/HTTP2 idêntico ao Google Chrome real. Isso impede que o Cloudflare ou o servidor do manus.im detecte que as requisições vêm de Node.js.

| Variável | Descrição |
|----------|----------|
| `LIBCURL_IMPERSONATE_PATH` | Caminho para `libcurl-impersonate-chrome.so`. Se não definida, o impers tenta baixar automaticamente. Se falhar, o sistema usa `fetch` nativo (sem impersonation). |

Para instalar manualmente:
```bash
# Baixar curl-impersonate para Linux x64
wget https://github.com/lexiforest/curl-impersonate/releases/download/v0.8.0/libcurl-impersonate-v0.8.0.x86_64-linux-gnu.tar.gz
mkdir -p /opt/curl-impersonate
tar xzf libcurl-impersonate-v0.8.0.x86_64-linux-gnu.tar.gz -C /opt/curl-impersonate/

# Adicionar ao .env
echo 'LIBCURL_IMPERSONATE_PATH=/opt/curl-impersonate/libcurl-impersonate-chrome.so' >> .env
```

## Puppeteer (FPJS Pro on-demand)

O sistema usa Puppeteer para gerar requestIds autênticos do FingerprintJS Pro, evitando detecção por IDs sintéticos.

| Variável | Descrição |
|----------|----------|
| `PUPPETEER_EXECUTABLE_PATH` | Caminho para o executável do Chromium (ex: `/usr/bin/chromium`) |
| `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD` | Define como `true` se já tiver o Chromium instalado no sistema |

## Manus OAuth (opcional)

Estas variáveis só são necessárias se `LOCAL_AUTH=false` (modo produção com autenticação Manus).

| Variável | Descrição |
|----------|-----------|
| `VITE_APP_ID` | ID do app Manus |
| `OAUTH_SERVER_URL` | URL do servidor OAuth Manus |
| `VITE_OAUTH_PORTAL_URL` | URL do portal de login Manus |
| `OWNER_OPEN_ID` | OpenID do dono da aplicação |
| `OWNER_NAME` | Nome do dono |

## Exemplo de .env Completo

```env
# === Obrigatórias ===
DATABASE_URL=mysql://ghost:ghost123@localhost:3306/ghost_panel
JWT_SECRET=seu-segredo-aleatorio-aqui-gere-com-openssl
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
ZOHO_CLIENT_ID=1000.XXXX
ZOHO_CLIENT_SECRET=xxxx
ZOHO_REFRESH_TOKEN=1000.xxxx.xxxx
ZOHO_ACCOUNT_ID=1410307000000008002

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

## Notas Importantes

O `DATABASE_URL` deve apontar para um MySQL 8+ ou TiDB. Para desenvolvimento local, o `docker-compose.yml` inclui um container MySQL pronto para uso.

O `JWT_SECRET` deve ser uma string aleatória longa (mínimo 32 caracteres). Nunca compartilhe ou commite este valor.

O `ZOHO_REFRESH_TOKEN` expira se não for usado por um período longo. Se o serviço de email parar de funcionar, gere um novo refresh token no console do Zoho.

As configurações de SMS (país, serviço, preço máximo, número de retries) podem ser ajustadas dinamicamente pela interface web em **Configurações**, sem necessidade de reiniciar o servidor.
