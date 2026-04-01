/**
 * OutlookEmailService — Microsoft Graph API v1.0
 *
 * Substitui o ZohoEmailService. Lê emails de verificação de contas
 * pessoais @outlook.com / @hotmail.com / @live.com via Microsoft Graph API.
 *
 * ARQUITETURA MULTI-CONTA (UM único App Azure para N contas):
 * ────────────────────────────────────────────────────────────
 * Um único App Azure registrado uma vez (tipo "Personal Accounts Only")
 * com o escopo "Mail.Read" pode autorizar MÚLTIPLAS contas pessoais.
 * Cada conta gera seu próprio refresh_token, mas todas usam o mesmo
 * ms_client_id e ms_client_secret do App.
 *
 * As contas são armazenadas no banco como JSON na setting "outlook_accounts":
 *   [
 *     { "email": "conta1@outlook.com", "refreshToken": "M.C3_BAY..." },
 *     { "email": "conta2@hotmail.com", "refreshToken": "M.C3_BAY..." }
 *   ]
 *
 * SELEÇÃO DE CONTA POR EMAIL:
 * - Se o email de destino é uma conta Outlook cadastrada → usa essa conta diretamente
 * - Se o email de destino é de domínio customizado (ex: @lojasmesh.com) → distribui
 *   por hash do email entre as contas disponíveis (consistência por tentativa)
 *
 * RENOVAÇÃO DE TOKEN:
 * - access_token dura 1 hora (renovado automaticamente em memória)
 * - refresh_token dura 90 dias e é renovado a cada uso
 * - Se expirar (90 dias sem uso), o usuário re-autoriza aquela conta no painel
 */

import { getSetting, setSetting } from "../utils/settings";
import { sleep, logger } from "../utils/helpers";

const MS_TOKEN_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
const MS_GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export const MS_OAUTH_SCOPES = "openid profile email Mail.Read offline_access";
export const MS_AUTH_URL_BASE =
  "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize";

export interface OutlookAccount {
  email: string;
  refreshToken: string;
  accessToken?: string;
  accessTokenExpiry?: number;
}

async function loadOutlookAccounts(): Promise<OutlookAccount[]> {
  const raw = await getSetting("outlook_accounts");
  if (!raw) return [];
  try {
    return JSON.parse(raw) as OutlookAccount[];
  } catch {
    return [];
  }
}

async function saveOutlookAccounts(accounts: OutlookAccount[]): Promise<void> {
  // Persistir apenas email + refreshToken (sem access tokens)
  const toSave = accounts.map(({ email, refreshToken }) => ({ email, refreshToken }));
  await setSetting("outlook_accounts", JSON.stringify(toSave));
}

// Cache em memória dos access_tokens (evita refresh a cada chamada)
const tokenCache = new Map<string, OutlookAccount>();

async function refreshAccessToken(
  account: OutlookAccount,
  clientId: string,
  clientSecret: string,
  jobId?: number
): Promise<OutlookAccount> {
  await logger.info("email", `Renovando token para ${account.email}...`, {}, jobId);

  const resp = await fetch(MS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: account.refreshToken,
      scope: MS_OAUTH_SCOPES,
    }),
  });

  const text = await resp.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `MS token refresh retornou resposta inválida (${resp.status}): ${text.substring(0, 200)}`
    );
  }

  if (data.error) {
    throw new Error(
      `MS token refresh error [${data.error}]: ${data.error_description || ""}`
    );
  }

  const updated: OutlookAccount = {
    ...account,
    accessToken: data.access_token as string,
    accessTokenExpiry: Date.now() + ((data.expires_in as number) - 60) * 1000,
    // Microsoft pode retornar um novo refresh_token — sempre salvar se vier
    refreshToken: (data.refresh_token as string) || account.refreshToken,
  };

  // Persistir o refresh_token atualizado no banco
  const allAccounts = await loadOutlookAccounts();
  const idx = allAccounts.findIndex(
    (a) => a.email.toLowerCase() === account.email.toLowerCase()
  );
  if (idx >= 0) {
    allAccounts[idx] = { email: updated.email, refreshToken: updated.refreshToken };
    await saveOutlookAccounts(allAccounts);
  }

  await logger.info("email", `Token renovado para ${account.email}`, {}, jobId);
  return updated;
}

async function ensureToken(
  account: OutlookAccount,
  clientId: string,
  clientSecret: string,
  jobId?: number
): Promise<OutlookAccount> {
  const cached = tokenCache.get(account.email.toLowerCase());
  if (
    cached?.accessToken &&
    cached.accessTokenExpiry &&
    Date.now() < cached.accessTokenExpiry
  ) {
    return cached;
  }
  const refreshed = await refreshAccessToken(account, clientId, clientSecret, jobId);
  tokenCache.set(account.email.toLowerCase(), refreshed);
  return refreshed;
}

async function graphRequest(
  path: string,
  accessToken: string,
  jobId?: number
): Promise<Record<string, unknown>> {
  const url = `${MS_GRAPH_BASE}${path}`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });

  const text = await resp.text();

  if (resp.status === 401) throw new Error("MS_GRAPH_401: token expirado");
  if (resp.status === 429) {
    const retryAfter = parseInt(resp.headers.get("Retry-After") || "10");
    throw new Error(`MS_GRAPH_429: rate limit — retry after ${retryAfter}s`);
  }
  if (!resp.ok) {
    throw new Error(`MS Graph ${path} (${resp.status}): ${text.substring(0, 200)}`);
  }

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(
      `MS Graph retornou resposta não-JSON (${resp.status}): ${text.substring(0, 200)}`
    );
  }
}

function extractCode(text: string): string | null {
  if (!text) return null;
  const decoded = text.replace(/&#(\d+);/g, (_m, c) => String.fromCharCode(parseInt(c)));

  const p1 = decoded.match(/verification\s+code[:\s]*(\d{6})/i);
  if (p1) return p1[1];

  const p2 = decoded.match(/code[:\s]+(\d{6})/i);
  if (p2) return p2[1];

  const p3 = decoded.match(/\b(\d{6})\b/);
  if (p3) return p3[1];

  return null;
}

/**
 * Seleciona a conta Outlook correta para ler emails de `toEmail`.
 * - Conta exata se o destinatário é uma conta Outlook cadastrada
 * - Distribuição por hash para domínios customizados (catch-all)
 */
function selectAccount(
  toEmail: string,
  accounts: OutlookAccount[]
): OutlookAccount | null {
  if (accounts.length === 0) return null;

  const exact = accounts.find(
    (a) => a.email.toLowerCase() === toEmail.toLowerCase()
  );
  if (exact) return exact;

  let hash = 0;
  for (let i = 0; i < toEmail.length; i++) {
    hash = (hash * 31 + toEmail.charCodeAt(i)) & 0x7fffffff;
  }
  return accounts[hash % accounts.length];
}

// Contador global para round-robin entre contas (persiste em memória durante a sessão)
let roundRobinIndex = 0;

class OutlookEmailService {
  private clientId = "";
  private clientSecret = "";

  async init(): Promise<void> {
    this.clientId = (await getSetting("ms_client_id")) || "";
    this.clientSecret = (await getSetting("ms_client_secret")) || "";
  }

  /**
   * Troca um authorization_code por access_token + refresh_token.
   * Chamado pelo settings router após o usuário autorizar a conta via OAuth.
   */
  async exchangeCodeForTokens(
    code: string,
    redirectUri: string
  ): Promise<{ email: string; refreshToken: string }> {
    if (!this.clientId) await this.init();

    const resp = await fetch(MS_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code,
        redirect_uri: redirectUri,
        scope: MS_OAUTH_SCOPES,
      }),
    });

    const text = await resp.text();
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(
        `MS token exchange retornou resposta inválida (${resp.status}): ${text.substring(0, 200)}`
      );
    }

    if (data.error) {
      throw new Error(
        `MS token exchange error [${data.error}]: ${data.error_description || ""}`
      );
    }

    const accessToken = data.access_token as string;
    const refreshToken = data.refresh_token as string;
    const idToken = data.id_token as string | undefined;

    // 1ª tentativa: extrair email do id_token JWT (mais confiável para contas pessoais)
    let email = "";
    if (idToken) {
      try {
        const payload = JSON.parse(
          Buffer.from(idToken.split(".")[1], "base64url").toString("utf8")
        ) as Record<string, unknown>;
        email =
          (payload.email as string) ||
          (payload.preferred_username as string) ||
          (payload.upn as string) ||
          "";
      } catch {
        // ignora erros de parse do JWT
      }
    }

    // 2ª tentativa: Graph API /me
    if (!email) {
      try {
        const meResp = await fetch(
          `${MS_GRAPH_BASE}/me?$select=mail,userPrincipalName`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        const meData = (await meResp.json()) as Record<string, unknown>;
        email =
          (meData.mail as string) || (meData.userPrincipalName as string) || "";
      } catch {
        // ignora erros de rede
      }
    }

    if (!email) {
      throw new Error(
        "Não foi possível obter o email da conta Microsoft. Verifique as permissões do App."
      );
    }

    // Salvar/atualizar a conta no banco
    const allAccounts = await loadOutlookAccounts();
    const existingIdx = allAccounts.findIndex(
      (a) => a.email.toLowerCase() === email.toLowerCase()
    );
    if (existingIdx >= 0) {
      allAccounts[existingIdx].refreshToken = refreshToken;
    } else {
      allAccounts.push({ email, refreshToken });
    }
    await saveOutlookAccounts(allAccounts);

    // Atualizar cache
    tokenCache.set(email.toLowerCase(), {
      email,
      refreshToken,
      accessToken,
      accessTokenExpiry: Date.now() + ((data.expires_in as number) - 60) * 1000,
    });

    return { email, refreshToken };
  }

  /** Remove uma conta Outlook do pool. */
  async removeAccount(email: string): Promise<void> {
    const allAccounts = await loadOutlookAccounts();
    const filtered = allAccounts.filter(
      (a) => a.email.toLowerCase() !== email.toLowerCase()
    );
    await saveOutlookAccounts(filtered);
    tokenCache.delete(email.toLowerCase());
  }

  /** Lista todas as contas cadastradas (sem expor tokens). */
  async listAccounts(): Promise<Array<{ email: string }>> {
    const allAccounts = await loadOutlookAccounts();
    return allAccounts.map((a) => ({ email: a.email }));
  }

  /**
   * Retorna o próximo email Outlook disponível em round-robin.
   * Usado pelo orchestrator para gerar o email de registro no Manus.
   * Lança erro se não houver contas cadastradas.
   */
  async pickNextAccount(): Promise<string> {
    const allAccounts = await loadOutlookAccounts();
    if (allAccounts.length === 0) {
      throw new Error(
        "Nenhuma conta Outlook cadastrada. Adicione ao menos uma conta no painel → Configurações → Contas Outlook Autorizadas."
      );
    }
    const idx = roundRobinIndex % allAccounts.length;
    roundRobinIndex = (roundRobinIndex + 1) % allAccounts.length;
    return allAccounts[idx].email;
  }

  /**
   * Aguarda email de verificação e extrai o código de 6 dígitos.
   * Interface idêntica ao ZohoEmailService — nenhuma alteração necessária
   * no orchestrator ou no manus/index.ts.
   */
  async waitForVerificationCode(
    toEmail: string,
    fromDomain: string,
    timeoutMs = 90000,
    jobId?: number
  ): Promise<string> {
    if (!this.clientId) await this.init();

    if (!this.clientId || !this.clientSecret) {
      throw new Error(
        "Outlook não configurado. Configure ms_client_id e ms_client_secret no painel de configurações."
      );
    }

    const allAccounts = await loadOutlookAccounts();
    if (allAccounts.length === 0) {
      throw new Error(
        "Nenhuma conta Outlook cadastrada. Adicione ao menos uma conta no painel → Configurações → Email."
      );
    }

    const selectedAccount = selectAccount(toEmail, allAccounts);
    if (!selectedAccount) {
      throw new Error(
        `Nenhuma conta Outlook disponível para receber email de ${toEmail}`
      );
    }

    await logger.info(
      "email",
      `Aguardando email para ${toEmail} via conta ${selectedAccount.email}`,
      { fromDomain },
      jobId
    );

    const startTime = Date.now();
    const pollInterval = 3000;
    const effectiveTimeoutMs = timeoutMs + 30000; // +30s de margem
    let consecutiveErrors = 0;
    let account = selectedAccount;

    // Filtro OData: apenas por data (contains() + $orderby causa InefficientFilter no Outlook pessoal)
    // A filtragem por domínio remetente é feita em memória após receber os resultados
    const since = new Date(startTime - 60000).toISOString();
    const filter = encodeURIComponent(`receivedDateTime ge ${since}`);
    const graphPath =
      `/me/messages?$filter=${filter}` +
      `&$orderby=receivedDateTime desc` +
      `&$top=20` +
      `&$select=id,from,toRecipients,receivedDateTime,bodyPreview,body`;

    while (Date.now() - startTime < effectiveTimeoutMs) {
      try {
        account = await ensureToken(account, this.clientId, this.clientSecret, jobId);

        const data = await graphRequest(graphPath, account.accessToken!, jobId);
        consecutiveErrors = 0;

        const messages =
          (data.value as Array<Record<string, unknown>>) || [];

        for (const msg of messages) {
          // Filtrar por domínio remetente em memória (não pode ser feito via OData no Outlook pessoal)
          const fromAddr = (
            (msg.from as Record<string, Record<string, string>>)
              ?.emailAddress?.address || ""
          ).toLowerCase();
          if (!fromAddr.includes(fromDomain.toLowerCase())) continue;

          // Verificar destinatário
          const toRecipients =
            (msg.toRecipients as Array<{
              emailAddress: { address: string };
            }>) || [];
          const isForUs = toRecipients.some((r) =>
            r.emailAddress.address
              .toLowerCase()
              .includes(toEmail.toLowerCase())
          );
          if (!isForUs) continue;

          // Verificar se é recente
          const receivedAt = new Date(
            (msg.receivedDateTime as string) || 0
          ).getTime();
          if (receivedAt < startTime - 60000) continue;

          // Tentar extrair do bodyPreview (mais rápido, sem body completo)
          const preview = (msg.bodyPreview as string) || "";
          const previewCode = extractCode(preview);
          if (previewCode) {
            await logger.info(
              "email",
              `Código encontrado no preview: ${previewCode}`,
              { toEmail, messageId: msg.id },
              jobId
            );
            return previewCode;
          }

          // Tentar extrair do body completo
          const bodyContent =
            (msg.body as Record<string, string>)?.content || "";
          const bodyCode = extractCode(bodyContent);
          if (bodyCode) {
            await logger.info(
              "email",
              `Código encontrado no body: ${bodyCode}`,
              { toEmail, messageId: msg.id },
              jobId
            );
            return bodyCode;
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);

        if (msg.includes("MS_GRAPH_401")) {
          tokenCache.delete(account.email.toLowerCase());
          await logger.warn(
            "email",
            `Token expirado para ${account.email} — renovando...`,
            {},
            jobId
          );
          try {
            account = await refreshAccessToken(
              account,
              this.clientId,
              this.clientSecret,
              jobId
            );
            tokenCache.set(account.email.toLowerCase(), account);
          } catch (refreshErr) {
            const refreshMsg =
              refreshErr instanceof Error
                ? refreshErr.message
                : String(refreshErr);
            await logger.error(
              "email",
              `Falha ao renovar token: ${refreshMsg}`,
              {},
              jobId
            );
          }
          continue;
        }

        if (msg.includes("MS_GRAPH_429")) {
          const retryAfter = parseInt(
            msg.match(/retry after (\d+)s/)?.[1] || "10"
          );
          await logger.warn(
            "email",
            `Rate limit do Graph API — aguardando ${retryAfter}s`,
            {},
            jobId
          );
          await sleep(retryAfter * 1000);
          continue;
        }

        consecutiveErrors++;
        await logger.warn(
          "email",
          `Erro ao buscar emails (tentativa ${consecutiveErrors}): ${msg}`,
          {},
          jobId
        );

        if (consecutiveErrors >= 3) {
          const backoffMs = Math.min(consecutiveErrors * 5000, 30000);
          await logger.warn(
            "email",
            `${consecutiveErrors} erros consecutivos. Aguardando ${backoffMs / 1000}s...`,
            {},
            jobId
          );
          await sleep(backoffMs);
        }
      }

      await sleep(pollInterval);
    }

    throw new Error(
      `Timeout: email não recebido em ${effectiveTimeoutMs / 1000}s`
    );
  }
}

export const emailService = new OutlookEmailService();
