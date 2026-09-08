import { pool } from "../adapters/postgres/PostgresAdapter";
import { createLogger } from "../observability/logger";
import {
  detectConfirmationIntent,
  detectCloseIntent,
  TICKET_NUMBER_PATTERN,
} from "../domain/ticket/CustomerConfirmation";
import { ticketStateMachine } from "../domain/ticket/TicketStateMachine";
import type { TicketLifecycleStatus } from "../domain/ticket/TicketLifecycle";
import { customerNotificationService } from "./CustomerNotificationService";
import { doneEmailService } from "./UrgentAlertService";

const logger = createLogger("customer-confirmation");

export interface ConfirmationOutcome {
  handled: boolean;
  ticketId?: number;
  from?: string;
  to?: string;
  reason?: string;
}

interface OpenTicket {
  id: number;
  ticket_number: string | null;
  subject: string | null;
  status: string;
  project_id: number | null;
  org_id: string | null;
}

/** A bare "ยืนยัน" / "ยังไม่ปิด" only answers a close question asked this recently. */
const CLOSE_QUESTION_WINDOW_MINUTES = 30;

/** Most cases the "which case" list shows; the chips carry the numbers. */
const WHICH_CASE_LIMIT = 5;

/**
 * Legal route from each lifecycle status to CLOSED, hop by hop. The customer
 * performs the two hops that are theirs (RESOLVED→CUSTOMER_CONFIRMED and
 * CUSTOMER_CONFIRMED→CLOSED); the system walks any engineering hops needed
 * to get there, each recorded with a reason, so a ticket closed at the
 * customer's request still has an honest event trail.
 */
const ROUTE_TO_CLOSED: Record<string, TicketLifecycleStatus[]> = {
  NEW: ["IN_PROGRESS", "RESOLVED", "CUSTOMER_CONFIRMED", "CLOSED"],
  TRIAGED: ["IN_PROGRESS", "RESOLVED", "CUSTOMER_CONFIRMED", "CLOSED"],
  OPEN: ["RESOLVED", "CUSTOMER_CONFIRMED", "CLOSED"],
  IN_PROGRESS: ["RESOLVED", "CUSTOMER_CONFIRMED", "CLOSED"],
  WAITING_CUSTOMER: ["RESOLVED", "CUSTOMER_CONFIRMED", "CLOSED"],
  WAITING_INTERNAL: ["RESOLVED", "CUSTOMER_CONFIRMED", "CLOSED"],
  REOPENED: ["RESOLVED", "CUSTOMER_CONFIRMED", "CLOSED"],
  RESOLVED: ["CUSTOMER_CONFIRMED", "CLOSED"],
  CUSTOMER_CONFIRMED: ["CLOSED"],
};

/**
 * Two-step close, decided by the customer alone and never by the LLM.
 *
 * Runs before the AI on every inbound text. It engages only for messages
 * that are answers in the close protocol — the delivery chips, the close
 * question chips, a "ปิดเคส" request — and returns handled=false for
 * everything else, which then flows to the AI untouched.
 *
 *   Plane: Delivery to Customer  → LINE "ทีมงานแก้ไขแล้ว รบกวนทดสอบ"  [ใช้งานได้แล้ว | ยังมีปัญหาอยู่]
 *   ใช้งานได้แล้ว / ปิดเคส        → CUSTOMER_CONFIRMED + "ต้องการปิดเคส … ใช่ไหมคะ"  [ยืนยันปิดเคส | ยังไม่ปิด | ยังมีปัญหาอยู่]
 *   ยืนยันปิดเคส <TCK>           → CLOSED (Plane → Close) + "ปิดเคสเรียบร้อย"
 *   ยังไม่ปิด                    → back to RESOLVED, nothing closes
 *   ยังมีปัญหาอยู่                → REOPENED → IN_PROGRESS (Plane → Re-Open)
 *   ปิดเคส with nothing open     → "ไม่มีเคสที่เปิดอยู่" at the edge, no AI turn
 */
export class CustomerConfirmationHandler {
  /** Every non-terminal ticket of the conversation, newest activity first. */
  private async loadOpenTickets(conversationId: number): Promise<OpenTicket[]> {
    const { rows } = await pool.query<OpenTicket>(
      `SELECT id, ticket_number, subject, status, project_id, org_id
         FROM tickets
        WHERE conversation_id = $1
          AND deleted_at IS NULL
          AND UPPER(COALESCE(status, '')) NOT IN ('CLOSED', 'CANCELLED')
        ORDER BY lifecycle_changed_at DESC NULLS LAST, id DESC`,
      [conversationId]
    );
    return rows.map((r) => ({ ...r, status: String(r.status || "").toUpperCase() }));
  }

  /**
   * Whether the bot's last word to this customer was a close question, and
   * for which case. Looks at the notification ledger (backend-sent question
   * or "which case" list) and at the last AI turn (the flow's
   * CONFIRM_CLOSE_PENDING reply names the case number in its text).
   */
  private async pendingCloseQuestion(conversationId: number): Promise<{ ticketNumber: string | null } | null> {
    const notif = await pool.query<{ notification_type: string; ticket_number: string | null; created_at: Date }>(
      `SELECT n.notification_type, t.ticket_number, n.created_at
         FROM customer_notifications n
         LEFT JOIN tickets t ON t.id = n.ticket_id
        WHERE n.conversation_id = $1
          AND n.notification_type IN ('close_confirmation_request', 'close_which_case')
          AND n.created_at >= NOW() - ($2::int * INTERVAL '1 minute')
        ORDER BY n.id DESC LIMIT 1`,
      [conversationId, CLOSE_QUESTION_WINDOW_MINUTES]
    );
    const ai = await pool.query<{ content: string; created_at: Date }>(
      `SELECT content, created_at FROM messages
        WHERE conversation_id = $1 AND role = 'ai'
          AND COALESCE(message_purpose, '') <> 'notification'
          AND created_at >= NOW() - ($2::int * INTERVAL '1 minute')
        ORDER BY id DESC LIMIT 1`,
      [conversationId, CLOSE_QUESTION_WINDOW_MINUTES]
    );

    const fromNotif = notif.rows[0]
      ? { at: new Date(notif.rows[0].created_at).getTime(), ticketNumber: notif.rows[0].ticket_number ? String(notif.rows[0].ticket_number).toUpperCase() : null }
      : null;
    let fromAi: { at: number; ticketNumber: string | null } | null = null;
    if (ai.rows[0] && /ต้องการปิดเคส|ยืนยันปิดเคส|ปิดเคส[^\n]{0,80}ใช่ไหม/.test(String(ai.rows[0].content || ""))) {
      const m = String(ai.rows[0].content).match(TICKET_NUMBER_PATTERN);
      fromAi = { at: new Date(ai.rows[0].created_at).getTime(), ticketNumber: m ? m[0].toUpperCase() : null };
    }
    if (!fromNotif && !fromAi) return null;
    const latest = !fromAi || (fromNotif && fromNotif.at >= fromAi.at) ? fromNotif! : fromAi;
    return { ticketNumber: latest.ticketNumber };
  }

  private notify(
    input: { conversationId: number; correlationId?: string },
    ticket: OpenTicket | null,
    notificationType:
      | "close_confirmation_request"
      | "close_declined"
      | "close_no_open_case"
      | "close_which_case"
      | "closed"
      | "reopened",
    idempotencyKey: string,
    extra: { detail?: string; quickReplies?: { label: string; text: string }[] } = {}
  ) {
    return customerNotificationService.send({
      conversationId: input.conversationId,
      notificationType,
      idempotencyKey,
      ticketId: ticket?.id ?? null,
      ticketNumber: ticket?.ticket_number ?? null,
      subject: ticket?.subject ?? null,
      projectId: ticket?.project_id ?? null,
      orgId: ticket?.org_id ?? null,
      correlationId: input.correlationId,
      detail: extra.detail ?? null,
      quickReplies: extra.quickReplies,
    });
  }

  /** Per-LINE-event key: a webhook retry must not re-send the question. */
  private eventKey(input: { conversationId: number; correlationId?: string }, tag: string): string {
    return `${input.correlationId || `conv:${input.conversationId}:${Date.now()}`}:${tag}`;
  }

  /** "Which case?" — the list plus one chip per case, each chip a full close request. */
  private async askWhichCase(input: { conversationId: number; correlationId?: string }, tickets: OpenTicket[]): Promise<ConfirmationOutcome> {
    const shown = tickets.slice(0, WHICH_CASE_LIMIT);
    const lines = shown.map((t) => {
      const subject = String(t.subject || "").trim();
      const short = subject.length > 60 ? `${subject.slice(0, 60)}…` : subject;
      return `• ${t.ticket_number || `#${t.id}`}${short ? ` – ${short}` : ""}`;
    });
    await this.notify(input, null, "close_which_case", this.eventKey(input, "which_case"), {
      detail: lines.join("\n"),
      quickReplies: shown
        .filter((t) => t.ticket_number)
        .map((t) => ({ label: String(t.ticket_number).slice(0, 20), text: `ปิดเคส ${t.ticket_number}` })),
    });
    return { handled: true, reason: "CLOSE_WHICH_CASE" };
  }

  /**
   * Asks "ต้องการปิดเคส … ใช่ไหมคะ". A RESOLVED ticket moves to
   * CUSTOMER_CONFIRMED here (the customer has just said it works); any other
   * status is left alone until the confirmation chip.
   */
  private async askClose(input: { conversationId: number; correlationId?: string }, ticket: OpenTicket): Promise<ConfirmationOutcome> {
    let from = ticket.status;
    if (ticket.status === "RESOLVED") {
      const r = await ticketStateMachine.transition({
        ticketRef: ticket.id,
        to: "CUSTOMER_CONFIRMED",
        actor: "customer",
        actorRef: `conversation:${input.conversationId}`,
        reason: "Customer reports the fix works; awaiting close confirmation",
        correlationId: input.correlationId,
        source: "customer_reply",
      });
      if (!r.applied) logger.warn({ ticketId: ticket.id, code: r.code }, "Could not mark ticket CUSTOMER_CONFIRMED");
      else from = "RESOLVED";
    }
    await this.notify(input, ticket, "close_confirmation_request", this.eventKey(input, `close_ask:${ticket.id}`));
    return { handled: true, ticketId: ticket.id, from, to: ticket.status === "RESOLVED" ? "CUSTOMER_CONFIRMED" : ticket.status, reason: "CLOSE_QUESTION_ASKED" };
  }

  /** Walks the ticket to CLOSED along ROUTE_TO_CLOSED and tells the customer. */
  private async closeTicket(input: { conversationId: number; correlationId?: string }, ticket: OpenTicket): Promise<ConfirmationOutcome> {
    const route = ROUTE_TO_CLOSED[ticket.status];
    if (!route) {
      logger.warn({ ticketId: ticket.id, status: ticket.status }, "No close route for ticket status");
      return { handled: false, reason: "NO_CLOSE_ROUTE" };
    }
    let current: string = ticket.status;
    let closedEventId: number | null = null;
    for (const next of route) {
      const customerHop = (current === "RESOLVED" && next === "CUSTOMER_CONFIRMED") || (current === "CUSTOMER_CONFIRMED" && next === "CLOSED");
      const r = await ticketStateMachine.transition({
        ticketRef: ticket.id,
        to: next,
        actor: customerHop ? "customer" : "system",
        actorRef: customerHop ? `conversation:${input.conversationId}` : "confirmation-handler",
        reason: customerHop
          ? next === "CLOSED" ? "Customer confirmed the close question" : "Customer confirmed the fix works"
          : `Closed at the customer's request (engineering hop ${current} -> ${next})`,
        correlationId: input.correlationId,
        source: "customer_reply",
      });
      if (!r.applied) {
        logger.warn({ ticketId: ticket.id, from: current, to: next, code: r.code }, "Close route hop rejected");
        return { handled: false, ticketId: ticket.id, from: ticket.status, to: current, reason: r.code };
      }
      current = next;
      if (next === "CLOSED") closedEventId = r.eventId ?? null;
    }

    await this.notify(input, ticket, "closed", closedEventId ? `ticket_event:${closedEventId}` : `ticket:${ticket.id}:closed`, { quickReplies: [] });
    // Customer "Done" email (Gmail via the notification flow), originated here
    // because Plane's own webhook never arrives (ISSUE-053). Fire-and-forget.
    void doneEmailService.notifyClosed({ ticketId: ticket.id, closeEventId: closedEventId, correlationId: input.correlationId }).catch(() => {});
    logger.info({ ticketId: ticket.id, conversationId: input.conversationId, correlationId: input.correlationId, from: ticket.status }, "Ticket closed by customer confirmation");
    return { handled: true, ticketId: ticket.id, from: ticket.status, to: "CLOSED" };
  }

  /** REOPENED → IN_PROGRESS: straight back into engineering hands (Plane → Re-Open). */
  private async reopenTicket(input: { conversationId: number; correlationId?: string }, ticket: OpenTicket): Promise<ConfirmationOutcome> {
    const reopened = await ticketStateMachine.transition({
      ticketRef: ticket.id,
      to: "REOPENED",
      actor: "customer",
      actorRef: `conversation:${input.conversationId}`,
      reason: "Customer reported the issue is still present",
      correlationId: input.correlationId,
      source: "customer_reply",
    });
    if (!reopened.applied) {
      logger.warn({ ticketId: ticket.id, code: reopened.code }, "Customer rejection could not be applied");
      return { handled: false, reason: reopened.code };
    }
    const working = await ticketStateMachine.transition({
      ticketRef: ticket.id,
      to: "IN_PROGRESS",
      actor: "system",
      actorRef: "confirmation-handler",
      reason: "Reopened by customer; returned to engineering",
      correlationId: input.correlationId,
      source: "customer_reply",
    });
    await this.notify(input, ticket, "reopened", reopened.eventId ? `ticket_event:${reopened.eventId}` : `ticket:${ticket.id}:reopened`, { quickReplies: [] });
    logger.info({ ticketId: ticket.id, conversationId: input.conversationId, correlationId: input.correlationId }, "Customer rejected resolution; ticket reopened");
    return { handled: true, ticketId: ticket.id, from: ticket.status, to: working.applied ? "IN_PROGRESS" : "REOPENED" };
  }

  /**
   * Returns handled=false when the message is not part of the close protocol,
   * which is the common case — the caller then continues with normal
   * processing.
   */
  async handle(input: { conversationId: number; text: string; correlationId?: string }): Promise<ConfirmationOutcome> {
    const text = String(input.text || "");
    const tickets = await this.loadOpenTickets(input.conversationId);
    const pending = tickets.length > 0 ? await this.pendingCloseQuestion(input.conversationId) : null;
    const close = detectCloseIntent(text, pending !== null);
    const byNumber = (n: string | null | undefined) =>
      n ? tickets.find((t) => String(t.ticket_number || "").toUpperCase() === n.toUpperCase()) ?? null : null;

    // 1. "ยืนยันปิดเคส [TCK]" — the only thing that closes.
    if (close.kind === "CONFIRM_CLOSE") {
      let target = byNumber(close.ticketNumber);
      if (!target && !close.ticketNumber) {
        target = byNumber(pending?.ticketNumber);
        if (!target) {
          const confirmed = tickets.filter((t) => t.status === "CUSTOMER_CONFIRMED");
          if (confirmed.length === 1) target = confirmed[0];
          else if (tickets.length === 1 && pending) target = tickets[0];
        }
      }
      if (!target) {
        if (tickets.length === 0) {
          await this.notify(input, null, "close_no_open_case", this.eventKey(input, "no_open_case"));
          return { handled: true, reason: "NO_OPEN_CASE" };
        }
        return this.askWhichCase(input, tickets);
      }
      return this.closeTicket(input, target);
    }

    // 2. "ยังไม่ปิด" while the question is pending — keep it open, say so.
    if (close.kind === "DECLINE_CLOSE" && pending) {
      let target = byNumber(pending.ticketNumber);
      if (!target) {
        const confirmed = tickets.filter((t) => t.status === "CUSTOMER_CONFIRMED");
        target = confirmed.length === 1 ? confirmed[0] : tickets.length === 1 ? tickets[0] : null;
      }
      if (target && target.status === "CUSTOMER_CONFIRMED") {
        const r = await ticketStateMachine.transition({
          ticketRef: target.id,
          to: "RESOLVED",
          actor: "customer",
          actorRef: `conversation:${input.conversationId}`,
          reason: "Customer declined to close for now",
          correlationId: input.correlationId,
          source: "customer_reply",
        });
        if (!r.applied) logger.warn({ ticketId: target.id, code: r.code }, "Could not return ticket to RESOLVED");
      }
      await this.notify(input, target, "close_declined", this.eventKey(input, "close_declined"), { quickReplies: [] });
      return { handled: true, ticketId: target?.id, from: target?.status, to: target?.status === "CUSTOMER_CONFIRMED" ? "RESOLVED" : target?.status, reason: "CLOSE_DECLINED" };
    }

    // 3. "ปิดเคส [TCK]" — menu chip, typed, or a bare number answering the list.
    if (close.kind === "CLOSE_REQUEST") {
      if (tickets.length === 0) {
        await this.notify(input, null, "close_no_open_case", this.eventKey(input, "no_open_case"));
        logger.info({ conversationId: input.conversationId, correlationId: input.correlationId }, "Close requested with no open case; answered at the edge");
        return { handled: true, reason: "NO_OPEN_CASE" };
      }
      const target = byNumber(close.ticketNumber) ?? (!close.ticketNumber && tickets.length === 1 ? tickets[0] : null);
      if (!target) return this.askWhichCase(input, tickets);
      return this.askClose(input, target);
    }

    // 4. Answer to the delivery message ("does it work now?").
    const awaiting = tickets.filter((t) => t.status === "RESOLVED" || t.status === "CUSTOMER_CONFIRMED");
    if (awaiting.length === 0) return { handled: false, reason: "NO_TICKET_AWAITING_CONFIRMATION" };

    const intent = detectConfirmationIntent(text);
    if (intent === "NONE") return { handled: false, reason: "NO_CONFIRMATION_INTENT" };

    const numbered = close.ticketNumber ? awaiting.find((t) => String(t.ticket_number || "").toUpperCase() === close.ticketNumber) : null;
    const target = numbered ?? awaiting[0];

    if (intent === "CONFIRMED") {
      // Positive, but nothing closes yet: ask the close question.
      return this.askClose(input, target);
    }
    return this.reopenTicket(input, target);
  }
}

export const customerConfirmationHandler = new CustomerConfirmationHandler();
