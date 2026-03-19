/**
 * EmailService - Zoho Mail Integration
 * Reads verification emails from catch-all domain @lojasmesh.com
 * 
 * UPDATED 2026-03-13: Fixed based on Zoho API testing
 * - Extract code from "summary" field first (fastest, no extra API call)
 * - Use folderId in content endpoint path (required by Zoho API)
 * - Filter by toAddress to match the specific email recipient
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

  async init(): Promise<void> {
    this.clientId = (await getSetting("zoho_client_id")) || "";
    this.clientSecret = (await getSetting("zoho_client_secret")) || "";
    this.refreshToken = (await getSetting("zoho_refresh_token")) || "";
    this.accountId = (await getSetting("zoho_account_id")) || "";
  }

  async refreshAccessToken(): Promise<string> {
    if (!this.clientId) await this.init();

    if (!this.refreshToken) {
      throw new Error("Zoho refresh token não configurado.");
    }

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

    const data = (await resp.json()) as Record<string, unknown>;

    if (data.error) {
      throw new Error(`Zoho refresh error: ${data.error}`);
    }

    this.accessToken = data.access_token as string;
    return this.accessToken;
  }

  async ensureAccessToken(): Promise<string> {
    if (!this.accessToken) {
      return await this.refreshAccessToken();
    }
    return this.accessToken;
  }

  async getRecentEmails(limit = 20): Promise<Array<Record<string, unknown>>> {
    const token = await this.ensureAccessToken();

    const resp = await fetch(
      `${ZOHO_MAIL_API}/accounts/${this.accountId}/messages/view?limit=${limit}&sortorder=false`,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
    );

    if (resp.status === 401) {
      await this.refreshAccessToken();
      return this.getRecentEmails(limit);
    }

    const data = (await resp.json()) as Record<string, unknown>;
    return (data.data as Array<Record<string, unknown>>) || [];
  }

  /**
   * Get email content using the correct Zoho API path.
   * IMPORTANT: Requires folderId in the URL path!
   * /api/accounts/{accountId}/folders/{folderId}/messages/{messageId}/content
   */
  async getEmailContent(messageId: string, folderId: string): Promise<string> {
    const token = await this.ensureAccessToken();

    const resp = await fetch(
      `${ZOHO_MAIL_API}/accounts/${this.accountId}/folders/${folderId}/messages/${messageId}/content`,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
    );

    if (resp.status === 401) {
      await this.refreshAccessToken();
      return this.getEmailContent(messageId, folderId);
    }

    const data = (await resp.json()) as Record<string, unknown>;
    const inner = data.data as Record<string, unknown> | undefined;
    return (inner?.content as string) || "";
  }

  /**
   * Extract 6-digit verification code from text.
   * Tries multiple patterns to find the code.
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

    while (Date.now() - startTime < timeoutMs) {
      try {
        const emails = await this.getRecentEmails(20);

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
            const content = await this.getEmailContent(email.messageId as string, folderId);
            const contentCode = this.extractCode(content);
            if (contentCode) {
              await logger.info("email", `Código encontrado no content: ${contentCode}`, { toEmail, sender }, jobId);
              return contentCode;
            }
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await logger.warn("email", `Erro ao buscar emails: ${msg}`, {}, jobId);
      }

      await sleep(pollInterval);
    }

    throw new Error(`Timeout: email não recebido em ${timeoutMs / 1000}s`);
  }
}

export const emailService = new EmailService();
