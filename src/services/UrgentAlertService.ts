import axios from "axios";
import { pool } from "../adapters/postgres/PostgresAdapter";
import { config } from "../config/env";
import { createLogger } from "../observability/logger";

const logger = createLogger("UrgentAlertService");

/**
 * Backend-originated "New Urgent Alert" (2026-09-07).
 *
 * The Incident Alert email used to depend on Plane delivering a
 * `workitem.created` webhook to the Plane Webhook Notification Flow. Plane on
 * projects.oneweb.tech delivers nothing (ISSUE-070), so no Urgent ticket ever
 * produced the email. TicketX itself knows the moment an Urgent ticket is
 * promoted to Plane, so it posts the same Plane-shaped payload to the same
 * flow URL. The flow's urgent branch (guard → ticket lookup by
 * plane_issue_id → claim → Gmail) runs unchanged; its claim is keyed on the
 * plane issue id as well as the event id, so if Plane's own webhooks ever
 * come back the alert still goes out once.
 *
 * Idempotent on this side through sla_cadence_claims (kind 'dev', slot 0),
 * the same ledger the hourly SLA reminders use — slot 0 is "the alert at
 * creation", slots 1..n are the repeats.
 */
export class UrgentAlertService {
  private warnedNoWebhook = false;

  private webhookUrl(): string | null {
    return (config.SLA_NOTIFICATION_FLOW_WEBHOOK_URL || "").trim() || null;
  }

  /**
   * Sends the alert for a freshly promoted ticket. Silent no-op for
   * non-Urgent tickets and for tickets not linked to Plane. Never throws:
   * promotion must not fail because a notification did.
   */
  async notifyPromoted(input: { ticketRef: string | number; planeIssueId: string; correlationId?: string }): Promise<{ sent: boolean; reason?: string }> {
    try {
      const { rows } = await pool.query<{ id: number; ticket_number: string | null; priority: string | null; plane_issue_id: string | null }>(
        `SELECT id, ticket_number, priority, plane_issue_id
           FROM tickets
          WHERE deleted_at IS NULL
            AND (plane_issue_id = $1::text OR ticket_number = $2::text
                 OR id = CASE WHEN $2::text ~ '^[0-9]+$' THEN $2::integer ELSE NULL END)
          ORDER BY (plane_issue_id = $1::text) DESC, id DESC
          LIMIT 1`,
        [String(input.planeIssueId), String(input.ticketRef)]
      );
      const t = rows[0];
      if (!t) return { sent: false, reason: "TICKET_NOT_FOUND" };
      if (String(t.priority || "").trim().toLowerCase() !== "urgent") return { sent: false, reason: "NOT_URGENT" };
      const planeIssueId = String(t.plane_issue_id || input.planeIssueId || "").trim();
      if (!planeIssueId || planeIssueId.startsWith("mock-")) return { sent: false, reason: "NOT_LINKED" };

      const url = this.webhookUrl();
      if (!url) {
        if (!this.warnedNoWebhook) {
          this.warnedNoWebhook = true;
          logger.warn("SLA_NOTIFICATION_FLOW_WEBHOOK_URL is not set; urgent alerts are skipped");
        }
        return { sent: false, reason: "NO_WEBHOOK_URL" };
      }

      const slotKey = `ticket:${t.id}:dev:0`;
      const claim = await pool.query<{ id: number }>(
        `INSERT INTO sla_cadence_claims (ticket_id, kind, slot_key, channel, status, created_at)
         VALUES ($1, 'dev', $2, 'email', 'pending', NOW())
         ON CONFLICT (ticket_id, kind, slot_key) DO NOTHING
         RETURNING id`,
        [t.id, slotKey]
      );
      if (!claim.rows.length) return { sent: false, reason: "ALREADY_SENT" };
      const claimId = claim.rows[0].id;

      try {
        // Same shape Plane would have sent for a new Urgent work item; the flow
        // guard reads event / data.id / data.priority, nothing else.
        await axios.post(
          url,
          {
            event: "workitem.created",
            action: "created",
            event_id: `ticketx:urgent:${t.id}`,
            delivery_id: `ticketx-backend:${input.correlationId || slotKey}`,
            source: "ticketx-backend",
            data: { id: planeIssueId, priority: "urgent", ticket_number: t.ticket_number },
            previous_attributes: {},
          },
          { headers: { "Content-Type": "application/json" }, timeout: 45_000 }
        );
        await pool.query(`UPDATE sla_cadence_claims SET status = 'sent', sent_at = NOW() WHERE id = $1`, [claimId]).catch(() => {});
        logger.info({ ticketNumber: t.ticket_number, planeIssueId, slotKey }, "Urgent alert posted to the notification flow");
        return { sent: true };
      } catch (err: any) {
        const code = String(err?.code || "");
        if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN") {
          // Never reached the flow: release the slot so the next attempt can retry.
          await pool.query(`DELETE FROM sla_cadence_claims WHERE id = $1`, [claimId]).catch(() => {});
        } else {
          // Timeouts included: the flow may have sent the email already (it
          // answers only after Gmail), so the slot stays taken.
          await pool
            .query(`UPDATE sla_cadence_claims SET status = $2 WHERE id = $1`, [claimId, code === "ECONNABORTED" ? "timeout" : "failed"])
            .catch(() => {});
        }
        logger.error({ ticketNumber: t.ticket_number, error: err.message, code }, "Urgent alert post failed");
        return { sent: false, reason: code || "POST_FAILED" };
      }
    } catch (err: any) {
      logger.error({ error: err.message, ticketRef: input.ticketRef }, "Urgent alert could not be evaluated");
      return { sent: false, reason: "ERROR" };
    }
  }
}

/**
 * Backend-originated customer "Done" email (same reason, same flow). Fired
 * when a ticket reaches CLOSED — after the customer's confirmation chip or
 * the silent-customer auto-close — as the Plane-shaped `workitem.updated`
 * the flow's Done branch expects (state_group completed, completed_at newly
 * set). Once per close event: a reopen → close cycle emails again.
 */
export class DoneEmailService {
  private warnedNoWebhook = false;

  async notifyClosed(input: { ticketId: number; closeEventId?: number | null; correlationId?: string }): Promise<{ sent: boolean; reason?: string }> {
    try {
      const { rows } = await pool.query<{ id: number; ticket_number: string | null; priority: string | null; plane_issue_id: string | null; status: string | null }>(
        `SELECT id, ticket_number, priority, plane_issue_id, status FROM tickets WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
        [input.ticketId]
      );
      const t = rows[0];
      if (!t) return { sent: false, reason: "TICKET_NOT_FOUND" };
      const planeIssueId = String(t.plane_issue_id || "").trim();
      if (!planeIssueId || planeIssueId.startsWith("mock-")) return { sent: false, reason: "NOT_LINKED" };

      const url = (config.SLA_NOTIFICATION_FLOW_WEBHOOK_URL || "").trim();
      if (!url) {
        if (!this.warnedNoWebhook) {
          this.warnedNoWebhook = true;
          logger.warn("SLA_NOTIFICATION_FLOW_WEBHOOK_URL is not set; customer done emails are skipped");
        }
        return { sent: false, reason: "NO_WEBHOOK_URL" };
      }

      const slotKey = `ticket:${t.id}:done:${input.closeEventId ?? 0}`;
      const claim = await pool.query<{ id: number }>(
        `INSERT INTO sla_cadence_claims (ticket_id, kind, slot_key, channel, status, created_at)
         VALUES ($1, 'done_email', $2, 'email', 'pending', NOW())
         ON CONFLICT (ticket_id, kind, slot_key) DO NOTHING
         RETURNING id`,
        [t.id, slotKey]
      );
      if (!claim.rows.length) return { sent: false, reason: "ALREADY_SENT" };
      const claimId = claim.rows[0].id;

      try {
        const now = new Date().toISOString();
        await axios.post(
          url,
          {
            event: "workitem.updated",
            action: "updated",
            event_id: `ticketx:done:${t.id}:${input.closeEventId ?? 0}`,
            delivery_id: `ticketx-backend:${input.correlationId || slotKey}`,
            source: "ticketx-backend",
            data: { id: planeIssueId, state_group: "completed", completed_at: now, priority: String(t.priority || "").toLowerCase(), ticket_number: t.ticket_number },
            previous_attributes: { completed_at: null },
          },
          { headers: { "Content-Type": "application/json" }, timeout: 45_000 }
        );
        await pool.query(`UPDATE sla_cadence_claims SET status = 'sent', sent_at = NOW() WHERE id = $1`, [claimId]).catch(() => {});
        logger.info({ ticketNumber: t.ticket_number, planeIssueId, slotKey }, "Customer done email posted to the notification flow");
        return { sent: true };
      } catch (err: any) {
        const code = String(err?.code || "");
        if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN") {
          await pool.query(`DELETE FROM sla_cadence_claims WHERE id = $1`, [claimId]).catch(() => {});
        } else {
          await pool
            .query(`UPDATE sla_cadence_claims SET status = $2 WHERE id = $1`, [claimId, code === "ECONNABORTED" ? "timeout" : "failed"])
            .catch(() => {});
        }
        logger.error({ ticketNumber: t.ticket_number, error: err.message, code }, "Customer done email post failed");
        return { sent: false, reason: code || "POST_FAILED" };
      }
    } catch (err: any) {
      logger.error({ error: err.message, ticketId: input.ticketId }, "Customer done email could not be evaluated");
      return { sent: false, reason: "ERROR" };
    }
  }
}

export const urgentAlertService = new UrgentAlertService();
export const doneEmailService = new DoneEmailService();
