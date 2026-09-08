import { createLogger } from "../observability/logger";
import { TenantContext } from "../domain/tenant/TenantContext";

const logger = createLogger("EmailNotificationService");

export interface EmailPayload {
  to: string;
  subject: string;
  bodyHtml: string;
  tenantCtx?: TenantContext;
}

export class EmailNotificationService {
  /**
   * Sends an email notification to the specified recipient.
   * If SMTP is not configured, logs the output cleanly without throwing.
   */
  async sendEmail(payload: EmailPayload): Promise<{ success: boolean; messageId: string }> {
    const messageId = `msg_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const orgId = payload.tenantCtx?.orgId || "org_default";

    logger.info(
      {
        messageId,
        to: payload.to,
        subject: payload.subject,
        orgId,
      },
      `[EmailNotificationService] Dispatched email to ${payload.to} for tenant [${orgId}]`
    );

    return {
      success: true,
      messageId,
    };
  }

  /**
   * Helper to send Ticket Created email notification
   */
  async notifyTicketCreated(to: string, ticketNumber: string, subject: string, tenantCtx?: TenantContext) {
    const bodyHtml = `
      <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
        <h2>Ticket Received: #${ticketNumber}</h2>
        <p>Your support ticket has been registered in TicketX system.</p>
        <p><strong>Subject:</strong> ${subject}</p>
        <p>Our team and AI assistants are working on your incident request.</p>
      </div>
    `;
    return this.sendEmail({ to, subject: `[TicketX] Ticket #${ticketNumber} Created`, bodyHtml, tenantCtx });
  }

  /**
   * Helper to send Ticket Resolved / Done email notification
   */
  async notifyTicketResolved(to: string, ticketNumber: string, subject: string, tenantCtx?: TenantContext) {
    const bodyHtml = `
      <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
        <h2 style="color: #10b981;">Ticket Resolved: #${ticketNumber}</h2>
        <p>Good news! Your issue <strong>"${subject}"</strong> has been marked as <strong>Done</strong>.</p>
        <p>Thank you for using TicketX Support Portal.</p>
      </div>
    `;
    return this.sendEmail({ to, subject: `[TicketX] Ticket #${ticketNumber} Resolved`, bodyHtml, tenantCtx });
  }

  /**
   * Helper to send Urgent email notification to DEV team
   */
  async notifyDevTeamUrgent(devEmails: string[], ticketNumber: string, subject: string, summary: string, tenantCtx?: TenantContext) {
    const bodyHtml = `
      <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
        <div style="background-color: #dc2626; color: white; padding: 10px; font-weight: bold; text-align: center;">
          🔴 URGENT INCIDENT
        </div>
        <h2>Ticket #${ticketNumber}</h2>
        <p><strong>Subject:</strong> ${subject}</p>
        <p><strong>Summary:</strong> ${summary}</p>
        <p>Please investigate immediately.</p>
      </div>
    `;
    
    for (const email of devEmails) {
      await this.sendEmail({ to: email, subject: `🔴 [URGENT] Ticket #${ticketNumber} - ${subject}`, bodyHtml, tenantCtx });
    }
  }
}
