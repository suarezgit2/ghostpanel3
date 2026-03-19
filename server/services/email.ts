/**
 * EmailService - Zoho Mail Integration (v2 — Resilient)
 * Reads verification emails from catch-all domain @lojasmesh.com
 *
 * UPDATED 2026-03-19: Corrigido tratamento de respostas HTML do Zoho
 * - Zoho pode retornar HTML (página de erro/login) em vez de JSON quando:
 *   a) O access token expirou e o 401 não veio no status (edge case)
 *   b) Rate limiting (429 mascarado como HTML)
 *   c) Manutenção do serviço
 * - Agora valida se a resposta é JSON antes de parsear
 * - Refresh automático do token quando recebe HTML
 * - Retry com backoff em caso de erros transitórios
 */

import { getSetting } from "../utils/settings";
import { sleep, logger } from "../utils/helpers";

const ZOHO_ACCOUNTS_URL = "https://accounts.zoho.com";
const ZOHO_MAIL_API = "https://mail.zoho.com/api";

class EmailService {
  private clientId = "";
  private clientSecret = "";
  private refreshToken = "";
  private accessToken = "";
  private accountId = "";
  private lastTokenRefresh = 0;

  async init(): Promise<void> {
    this.clientId = (await getSetting("zoho_client_id")) || "";
    this.clientSecret = (await getSetting("zoho_client_secret")) || "";
    this.refreshToken = (await getSetting("zoho_refresh_token")) || "";
    this.accountId = (await getSetting("zoho_account_id")) || "";
  }

  async refreshAccessToken(jobId?: number): Promise<string> {
    if (!this.clientId) await this.init();

    if (!this.refreshToken) {
      throw new Error("Zoho refresh token não configurado.");
    }

    await logger.info("email", "Renovando access token do Zoho...", {}, jobId);

    const resp = await fetch(`${ZOHO_ACCOUNTS_URL}/oauth/v2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: this.refreshToken,
      }),
    });

    const text = await resp.text();
    let data: Record<string, unknown>;

    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`Zoho token refresh retornou resposta inválida (status ${resp.status}): ${text.substring(0, 200)}`);
    }

    if (data.error) {
      throw new Error(`Zoho refresh error: ${data.error}`);
    }

    this.accessToken = data.access_token as string;
    this.lastTokenRefresh = Date.now();
    await logger.info("email", "Access token do Zoho renovado com sucesso", {}, jobId);
    return this.accessToken;
  }

  async ensureAccessToken(jobId?: number): Promise<string> {
    // Forçar refresh se o token tem mais de 50 minutos (Zoho tokens duram 1h)
    const TOKEN_MAX_AGE_MS = 50 * 60 * 1000;
    if (!this.accessToken || (this.lastTokenRefresh > 0 && Date.now() - this.lastTokenRefresh > TOKEN_MAX_AGE_MS)) {
      return await this.refreshAccessToken(jobId);
    }
    return this.accessToken;
  }

  /**
   * Faz uma requisição à API do Zoho Mail com tratamento robusto de erros.
   * - Valida se a resposta é JSON
   * - Tenta refresh do token se receber HTML ou 401
   * - Retry uma vez após refresh
   */
  private async zohoRequest(url: string, jobId?: number, retried = false): Promise<Record<string, unknown>> {
    const token = await this.ensureAccessToken(jobId);

    const resp = await fetch(url, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
    });

    const contentType = resp.headers.get("content-type") || "";
    const text = await resp.text();

    // Caso 1: Resposta 401 explícita — refresh e retry
    if (resp.status === 401 && !retried) {
      await logger.warn("email", `Zoho retornou 401 — renovando token e retentando...`, {}, jobId);
      await this.refreshAccessToken(jobId);
      return this.zohoRequest(url, jobId, true);
    }

    // Caso 2: Resposta não é JSON (HTML, erro de rede, etc.)
    if (!contentType.includes("application/json") && !text.trim().startsWith("{") && !text.trim().startsWith("[")) {
      if (!retried) {
        await logger.warn("email",
          `Zoho retornou HTML em vez de JSON (status ${resp.status}). Renovando token e retentando...`,
          { responsePreview: text.substring(0, 150) }, jobId
        );
        await this.refreshAccessToken(jobId);
        return this.zohoRequest(url, jobId, true);
      }
      throw new Error(`Zoho retornou resposta não-JSON após retry (status ${resp.status}): ${text.substring(0, 200)}`);
    }

    // Caso 3: Resposta parece JSON — tentar parsear
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      if (!retried) {
        await logger.warn("email",
          `Zoho retornou JSON inválido (status ${resp.status}). Renovando token e retentando...`,
          { responsePreview: text.substring(0, 150) }, jobId
        );
        await this.refreshAccessToken(jobId);
        return this.zohoRequest(url, jobId, true);
      }
      throw new Error(`Zoho retornou JSON inválido após retry (status ${resp.status}): ${text.substring(0, 200)}`);
    }

    // Caso 4: Zoho retornou erro no JSON
    if (data.status && (data.status as Record<string, unknown>)?.code !== 200) {
      const errorCode = (data.status as Record<string, unknown>)?.code;
      const errorDesc = (data.status as Record<string, unknown>)?.description || "Unknown error";
      
      // Se for erro de autenticação no body, tentar refresh
      if ((errorCode === 401 || errorCode === "UNAUTHORIZED") && !retried) {
        await logger.warn("email", `Zoho retornou erro de auth no body. Renovando token...`, {}, jobId);
        await this.refreshAccessToken(jobId);
        return this.zohoRequest(url, jobId, true);
      }

      throw new Error(`Zoho API error ${errorCode}: ${errorDesc}`);
    }

    return data;
  }

  async getRecentEmails(limit = 20, jobId?: number): Promise<Array<Record<string, unknown>>> {
    const data = await this.zohoRequest(
      `${ZOHO_MAIL_API}/accounts/${this.accountId}/messages/view?limit=${limit}&sortorder=false`,
      jobId
    );
    return (data.data as Array<Record<string, unknown>>) || [];
  }

  /**
   * Get email content using the correct Zoho API path.
   * IMPORTANT: Requires folderId in the URL path!
   */
  async getEmailContent(messageId: string, folderId: string, jobId?: number): Promise<string> {
    const data = await this.zohoRequest(
      `${ZOHO_MAIL_API}/accounts/${this.accountId}/folders/${folderId}/messages/${messageId}/content`,
      jobId
    );
    const inner = data.data as Record<string, unknown> | undefined;
    return (inner?.content as string) || "";
  }

  /**
   * Extract 6-digit verification code from text.
   */
  private extractCode(text: string): string | null {
    if (!text) return null;

    // Decode HTML entities first
    const decoded = text.replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(parseInt(code)));

    // Pattern 1: "verification code" followed by 6 digits
    const p1 = decoded.match(/verification\s+code[:\s]*(\d{6})/i);
    if (p1) return p1[1];

    // Pattern 2: "code:" followed by 6 digits
    const p2 = decoded.match(/code[:\s]+(\d{6})/i);
    if (p2) return p2[1];

    // Pattern 3: Any standalone 6-digit number
    const p3 = decoded.match(/\b(\d{6})\b/);
    if (p3) return p3[1];

    return null;
  }

  /**
   * Aguarda email de verificação e extrai o código de 6 dígitos.
   *
   * Strategy:
   * 1. First try to extract code from the "summary" field (no extra API call needed)
   * 2. If not found in summary, fetch full content using folderId
   * 3. Also filter by toAddress to match the specific recipient
   */
  async waitForVerificationCode(
    toEmail: string,
    fromDomain: string,
    timeoutMs = 90000,
    jobId?: number
  ): Promise<string> {
    if (!this.clientId) await this.init();

    await logger.info("email", `Aguardando email para ${toEmail}`, { fromDomain }, jobId);

    const startTime = Date.now();
    const pollInterval = 3000;
    let consecutiveErrors = 0;

    while (Date.now() - startTime < timeoutMs) {
      try {
        const emails = await this.getRecentEmails(20, jobId);
        consecutiveErrors = 0; // Reset on success

        for (const email of emails) {
          const sender = (email.fromAddress as string) || (email.sender as string) || "";
          const receivedTime = parseInt((email.receivedTime as string) || "0");
          const toAddress = (email.toAddress as string) || "";
          const summary = (email.summary as string) || "";
          const folderId = (email.folderId as string) || "";

          // Only recent emails (received after start, with 60s margin)
          if (receivedTime < startTime - 60000) continue;

          // Check sender domain
          if (!sender.toLowerCase().includes(fromDomain.toLowerCase())) continue;

          // Check recipient matches our target email
          if (!toAddress.toLowerCase().includes(toEmail.toLowerCase())) continue;

          // Strategy 1: Try to extract code from summary (fastest)
          const summaryCode = this.extractCode(summary);
          if (summaryCode) {
            await logger.info("email", `Código encontrado no summary: ${summaryCode}`, { toEmail, sender }, jobId);
            return summaryCode;
          }

          // Strategy 2: Fetch full content (requires folderId)
          if (folderId) {
            const content = await this.getEmailContent(email.messageId as string, folderId, jobId);
            const contentCode = this.extractCode(content);
            if (contentCode) {
              await logger.info("email", `Código encontrado no content: ${contentCode}`, { toEmail, sender }, jobId);
              return contentCode;
            }
          }
        }
      } catch (err: unknown) {
        consecutiveErrors++;
        const msg = err instanceof Error ? err.message : String(err);
        await logger.warn("email", `Erro ao buscar emails (tentativa ${consecutiveErrors}): ${msg}`, {}, jobId);

        // Backoff progressivo em caso de erros consecutivos
        if (consecutiveErrors >= 3) {
          const backoffMs = Math.min(consecutiveErrors * 5000, 30000);
          await logger.warn("email", `${consecutiveErrors} erros consecutivos. Aguardando ${backoffMs / 1000}s...`, {}, jobId);
          await sleep(backoffMs);
        }
      }

      await sleep(pollInterval);
    }

    throw new Error(`Timeout: email não recebido em ${timeoutMs / 1000}s`);
  }
}

export const emailService = new EmailService();
