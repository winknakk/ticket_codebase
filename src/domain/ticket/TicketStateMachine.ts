import { pool } from "../../adapters/postgres/PostgresAdapter";
import { createLogger } from "../../observability/logger";
import {
  TicketLifecycleStatus,
  TransitionActor,
  canTransition,
  customerNotificationFor,
  isLifecycleStatus,
  lifecycleToPlaneStatus,
  planeStatusToLifecycle,
  shouldPushToPlane,
} from "./TicketLifecycle";

const logger = createLogger("ticket-state-machine");

export interface TransitionRequest {
  /** Numeric tickets.id, or ticket_number / ticket_id. */
  ticketRef: string | number;
  to: TicketLifecycleStatus;
  actor: TransitionActor;
  /** Who or what specifically — an operator id, "plane", a customer ref. */
  actorRef?: string;
  reason?: string;
  correlationId?: string;
  source?: string;
  /** Plane state to record alongside the lifecycle change, if known. */
  planeStatus?: string | null;
}

export interface TransitionResult {
  applied: boolean;
  ticketId?: number;
  from?: TicketLifecycleStatus;
  to?: TicketLifecycleStatus;
  /** True when the change must also be pushed to Plane. */
  pushToPlane?: boolean;
  planeStatus?: string;
  /** Customer-facing notification this transition warrants, if any. */
  notify?: ReturnType<typeof customerNotificationFor>;
  /**
   * ticket_events row id for this transition. Notifications key their
   * idempotency on it, so a re-resolution after REOPENED notifies again while
   * a repeated Done on an already-resolved ticket cannot.
   */
  eventId?: number | null;
  code?: string;
  reason?: string;
}

/**
 * The only sanctioned way to change tickets.status.
 *
 * Before this existed every status change was an unguarded
 * `UPDATE tickets SET status = ...`, and ticket_events held 0 rows against 36
 * tickets — the audit table had the right columns and had never been written
 * to. Each transition here is validated, applied under a conditional update
 * that makes concurrent writers safe, and recorded.
 */
export class TicketStateMachine {
  /**
   * Applies a lifecycle transition.
   *
   * The UPDATE carries `AND status = <expected>`, so two concurrent
   * transitions cannot both succeed: the loser sees rowCount 0 and is
   * reported as a conflict rather than silently overwriting.
   */
  async transition(req: TransitionRequest): Promise<TransitionResult> {
    if (!isLifecycleStatus(req.to)) {
      return { applied: false, code: "UNKNOWN_STATUS", reason: `Unknown target status '${req.to}'` };
    }

    const ticket = await this.loadTicket(req.ticketRef);
    if (!ticket) {
      return { applied: false, code: "TICKET_NOT_FOUND", reason: `Ticket ${req.ticketRef} not found` };
    }

    const from = ticket.status as TicketLifecycleStatus;
    if (!isLifecycleStatus(from)) {
      // A row still holding the pre-040 vocabulary. Refuse rather than guess.
      return {
        applied: false,
        code: "UNKNOWN_STATUS",
        reason: `Ticket ${ticket.id} holds a non-lifecycle status '${from}'`,
      };
    }

    const check = canTransition(from, req.to, req.actor);
    if (!check.allowed) {
      logger.warn(
        { ticketId: ticket.id, from, to: req.to, actor: req.actor, code: check.code },
        "Rejected ticket transition"
      );
      return { applied: false, from, to: req.to, code: check.code, reason: check.reason };
    }

    const planeStatus = req.planeStatus ?? lifecycleToPlaneStatus(req.to);

    const updated = await pool.query(
      // $1 is both assigned to a varchar column and compared against text
      // literals, so it needs an explicit cast — Postgres otherwise reports
      // "inconsistent types deduced for parameter $1".
      `UPDATE tickets
          SET status = $1::varchar,
              plane_status = COALESCE($2::varchar, plane_status),
              lifecycle_changed_at = NOW(),
              resolved_at = CASE WHEN $1::varchar = 'RESOLVED' THEN NOW() ELSE resolved_at END,
              closed_at = CASE WHEN $1::varchar IN ('CLOSED','CANCELLED') THEN NOW() ELSE closed_at END,
              updated_at = NOW()
        WHERE id = $3::integer AND status = $4::varchar
        RETURNING id`,
      [req.to, planeStatus, ticket.id, from]
    );

    if ((updated.rowCount || 0) === 0) {
      // Someone else transitioned this ticket between our read and write.
      logger.warn({ ticketId: ticket.id, from, to: req.to }, "Concurrent ticket transition lost the race");
      return {
        applied: false,
        from,
        to: req.to,
        code: "CONCURRENT_MODIFICATION",
        reason: `Ticket ${ticket.id} is no longer ${from}`,
      };
    }

    const eventId = await this.recordEvent(ticket.id, from, req.to, req);

    const result: TransitionResult = {
      eventId,
      applied: true,
      ticketId: ticket.id,
      from,
      to: req.to,
      pushToPlane: shouldPushToPlane(from, req.to),
      planeStatus,
      notify: customerNotificationFor(req.to),
    };

    logger.info(
      {
        ticketId: ticket.id,
        from,
        to: req.to,
        actor: req.actor,
        pushToPlane: result.pushToPlane,
        notify: result.notify,
        correlationId: req.correlationId,
      },
      "Ticket transition applied"
    );

    return result;
  }

  /**
   * Applies whatever lifecycle change a Plane state implies, if any.
   *
   * Returns `applied: false, code: "NO_CHANGE"` when Plane's state maps to no
   * transition — which is the common case on a reverse-sync poll and is why
   * unchanged remote state produces no write.
   */
  async applyPlaneStatus(
    ticketRef: string | number,
    planeStatus: string,
    opts: { correlationId?: string; source?: string } = {}
  ): Promise<TransitionResult> {
    const ticket = await this.loadTicket(ticketRef);
    if (!ticket) {
      return { applied: false, code: "TICKET_NOT_FOUND", reason: `Ticket ${ticketRef} not found` };
    }

    const from = ticket.status as TicketLifecycleStatus;
    if (!isLifecycleStatus(from)) {
      return { applied: false, code: "UNKNOWN_STATUS", reason: `Ticket ${ticket.id} holds '${from}'` };
    }

    const target = planeStatusToLifecycle(planeStatus, from);

    if (!target) {
      // Plane's state implies nothing new. Record the engineering state
      // anyway — it is Plane's to own — but do not touch the lifecycle.
      await pool.query(
        `UPDATE tickets SET plane_status = $1, updated_at = NOW()
          WHERE id = $2 AND plane_status IS DISTINCT FROM $1`,
        [this.normalisePlaneStatus(planeStatus), ticket.id]
      );
      return { applied: false, from, code: "NO_CHANGE", reason: `Plane '${planeStatus}' implies no lifecycle change` };
    }

    return this.transition({
      ticketRef: ticket.id,
      to: target,
      actor: "plane",
      actorRef: "plane-sync",
      reason: `Plane state '${planeStatus}'`,
      correlationId: opts.correlationId,
      source: opts.source || "plane_reverse_sync",
      planeStatus: this.normalisePlaneStatus(planeStatus),
    });
  }

  /** Maps Plane's wider vocabulary onto the four states we store. */
  /** The Plane label recorded in tickets.plane_status (engineering state, Plane's to own). */
  private normalisePlaneStatus(planeStatus: string): string | null {
    switch (String(planeStatus || "").trim().toLowerCase().replace(/[\s_-]+/g, " ")) {
      case "backlog":
      case "todo":
      case "to do":
      case "unstarted":
        return "Backlog";
      case "triaged":
      case "triage":
        return "Triaged";
      case "open":
      case "in progress":
      case "started":
        return "In Progress";
      case "test failed":
        return "Test Failed";
      case "waiting for customer":
      case "waiting customer":
        return "Waiting for Customer";
      case "delivery to customer":
      case "delivered":
        return "Delivery to Customer";
      case "re open":
      case "reopen":
      case "reopened":
        return "Re-Open";
      case "done":
      case "complete":
      case "completed":
        return "Done";
      case "close":
      case "closed":
        return "Close";
      case "cancelled":
      case "canceled":
        return "Cancelled";
      default:
        return null;
    }
  }

  private async loadTicket(
    ref: string | number
  ): Promise<{ id: number; status: string; plane_status: string | null; project_id: number | null } | null> {
    const asNumber = parseInt(String(ref), 10);
    const byId = Number.isInteger(asNumber) && String(ref).trim() === String(asNumber);

    const { rows } = byId
      ? await pool.query(
          `SELECT id, status, plane_status, project_id FROM tickets WHERE id = $1 LIMIT 1`,
          [asNumber]
        )
      : await pool.query(
          `SELECT id, status, plane_status, project_id FROM tickets
            WHERE ticket_number = $1 OR ticket_id = $1 LIMIT 1`,
          [String(ref)]
        );

    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Writes the audit row. A failure here is logged but does not roll back the
   * transition: losing an audit row is bad, but leaving the ticket in an
   * inconsistent state because the audit table was unavailable is worse.
   */
  private async recordEvent(
    ticketId: number,
    from: TicketLifecycleStatus,
    to: TicketLifecycleStatus,
    req: TransitionRequest
  ): Promise<number | null> {
    try {
      const { rows } = await pool.query(
        `INSERT INTO ticket_events (ticket_id, event_type, actor, payload, correlation_id, source, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         RETURNING id`,
        [
          ticketId,
          "STATUS_TRANSITION",
          req.actorRef || req.actor,
          JSON.stringify({
            from,
            to,
            actor: req.actor,
            actorRef: req.actorRef || null,
            reason: req.reason || null,
            planeStatus: req.planeStatus ?? lifecycleToPlaneStatus(to),
          }),
          req.correlationId || null,
          req.source || req.actor,
        ]
      );
      return rows.length > 0 ? Number(rows[0].id) : null;
    } catch (err: any) {
      logger.error({ error: err.message, ticketId, from, to }, "Failed to record ticket_events row");
      return null;
    }
  }
}

export const ticketStateMachine = new TicketStateMachine();
