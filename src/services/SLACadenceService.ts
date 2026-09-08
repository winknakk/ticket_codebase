import axios from "axios";
import { PoolClient } from "pg";
import { pool } from "../adapters/postgres/PostgresAdapter";
import { config } from "../config/env";
import { createLogger } from "../observability/logger";
import { addBusinessDays, businessDaysBetween } from "./BusinessCalendar";
import { ConstantSystemService } from "./ConstantSystemService";
import { customerNotificationService } from "./CustomerNotificationService";
import { ticketStateMachine } from "../domain/ticket/TicketStateMachine";
import { doneEmailService } from "./UrgentAlertService";

const logger = createLogger("SLACadenceService");

/**
 * SLA cadence matrix ("แจ้งเตือน Dev ซ้ำ" / "รายงานความคืบหน้า User").
 *
 *   Urgent  dev every 1 h      user every 1 h
 *   High    dev every 2 h      user every 2 h
 *   Medium  dev every 4 h      user every 1 business day
 *   Low     dev every 1 bd     user every 2 business days
 *   None    on demand only     on demand only
 *
 * Business days follow BusinessCalendar (Mon–Fri, Asia/Bangkok).
 */
export type CadenceUnit = "hours" | "businessDays";

export interface CadenceInterval {
  every: number;
  unit: CadenceUnit;
}

export interface CadenceRule {
  dev: CadenceInterval | null;
  user: CadenceInterval | null;
}

const H = (every: number): CadenceInterval => ({ every, unit: "hours" });
const BD = (every: number): CadenceInterval => ({ every, unit: "businessDays" });

export const CADENCE_RULES: Record<string, CadenceRule> = {
  Urgent: { dev: H(1), user: H(1) },
  High: { dev: H(2), user: H(2) },
  Medium: { dev: H(4), user: BD(1) },
  Low: { dev: BD(1), user: BD(2) },
  None: { dev: null, user: null },
};

/** Legacy spellings still seen in data / callers. */
const PRIORITY_ALIASES: Record<string, keyof typeof CADENCE_RULES> = {
  urgent: "Urgent", critical: "Urgent", p1: "Urgent",
  high: "High", p2: "High",
  medium: "Medium", p3: "Medium",
  low: "Low", p4: "Low",
  none: "None", p5: "None",
};

export function normalizePriority(value: string | null | undefined): keyof typeof CADENCE_RULES {
  const raw = String(value || "").trim();
  if (raw in CADENCE_RULES) return raw as keyof typeof CADENCE_RULES;
  return PRIORITY_ALIASES[raw.toLowerCase()] || "Medium";
}

/**
 * Which interval slot `now` falls in, counted from the ticket's creation.
 * Slot 0 is the first interval (nothing due yet); the first reminder belongs
 * to slot 1. Slots make the reminder key deterministic, so a retry, a second
 * instance, or an evaluation that fires a little late all claim the SAME
 * row instead of sending again.
 */
export function cadenceSlot(createdAt: Date, now: Date, interval: CadenceInterval): number {
  if (interval.unit === "businessDays") {
    return Math.floor(businessDaysBetween(createdAt, now) / interval.every);
  }
  const elapsedHours = (now.getTime() - createdAt.getTime()) / 3_600_000;
  return Math.floor(elapsedHours / interval.every);
}

/** When the given slot began, in wall-clock terms. */
export function slotStartedAt(createdAt: Date, slot: number, interval: CadenceInterval): Date {
  if (slot <= 0) return new Date(createdAt.getTime());
  if (interval.unit === "businessDays") {
    return addBusinessDays(createdAt, slot * interval.every);
  }
  return new Date(createdAt.getTime() + slot * interval.every * 3_600_000);
}

const OPEN_STATUS_EXCLUDED = ["resolved", "closed", "cancelled", "done", "customer_confirmed"];
const ADVISORY_LOCK_KEY = "ticketx:sla_cadence";

/** Plain-Thai status wording — same semantics as the reply prompt's table. */
function thaiStatus(status: string | null | undefined): string {
  switch (String(status || "").trim().toUpperCase()) {
    case "NEW":
    case "OPEN":
    case "BACKLOG":
    case "TODO":
      return "รับเรื่องไว้แล้ว อยู่ในคิวรอดำเนินการ";
    case "TRIAGED":
      return "ตรวจสอบเบื้องต้นแล้ว กำลังจัดคิวให้ทีมที่รับผิดชอบ";
    case "IN_PROGRESS":
      return "ทีมงานกำลังเร่งดำเนินการแก้ไขอยู่";
    case "REOPENED":
      return "กลับมาเปิดเคสให้อีกครั้ง ทีมงานกำลังตรวจสอบซ้ำ";
    case "WAITING_CUSTOMER":
      return "รอข้อมูลเพิ่มเติมจากทางลูกค้า";
    case "WAITING_INTERNAL":
      return "รอทีมภายในตรวจสอบอยู่";
    default:
      return "อยู่ระหว่างดำเนินการ";
  }
}

/** "วันนี้ 18:34 น." / "พรุ่งนี้ 09:00 น." / "8 ก.ย. 2569 เวลา 17:00 น." in Bangkok time. */
function thaiWhen(date: Date, now: Date): string {
  const TZ = 7 * 3_600_000;
  const b = new Date(date.getTime() + TZ);
  const n = new Date(now.getTime() + TZ);
  const pad = (x: number) => (x < 10 ? `0${x}` : String(x));
  const clock = `${pad(b.getUTCHours())}:${pad(b.getUTCMinutes())} น.`;
  const key = (x: Date) => `${x.getUTCFullYear()}-${x.getUTCMonth()}-${x.getUTCDate()}`;
  const tomorrow = new Date(n.getTime() + 86_400_000);
  if (key(b) === key(n)) return `วันนี้ ${clock}`;
  if (key(b) === key(tomorrow)) return `พรุ่งนี้ ${clock}`;
  const MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
  return `${b.getUTCDate()} ${MONTHS[b.getUTCMonth()]} ${b.getUTCFullYear() + 543} เวลา ${clock}`;
}

interface OpenTicketRow {
  id: number;
  ticket_number: string;
  subject: string | null;
  summary: string | null;
  status: string | null;
  priority: string | null;
  created_at: string;
  due_date: string | null;
  conversation_id: number | null;
  project_id: number | null;
  project_name: string | null;
  handled_by: string | null;
  takeover_state: string | null;
  dev_emails: unknown;
  legacy_dev_email: string | null;
}

export interface CadenceRunResult {
  evaluated: number;
  devAlertsSent: number;
  userUpdatesSent: number;
  /** Two-step close follow-ups: tickets awaiting the customer's answer. */
  awaitingEvaluated: number;
  nudgesSent: number;
  autoClosed: number;
  skippedLocked: boolean;
}

/** A ticket delivered to the customer and still waiting on their answer. */
interface AwaitingTicketRow {
  id: number;
  ticket_number: string;
  subject: string | null;
  status: string;
  /** When it entered RESOLVED / CUSTOMER_CONFIRMED — the follow-up clock. */
  waiting_since: string;
  conversation_id: number;
  project_id: number | null;
  org_id: string | null;
  handled_by: string | null;
  takeover_state: string | null;
}

/** One entry of the console's engine run history (in-memory ring buffer). */
export interface CadenceRunLog {
  at: string;
  durationMs: number;
  dryRun: boolean;
  trigger: "timer" | "manual";
  result: CadenceRunResult;
  error: string | null;
}

export interface TicketListFilter {
  /** cadence = only what the engine would consider; open/closed/all otherwise. */
  scope?: "cadence" | "open" | "closed" | "all";
  priority?: string;
  channel?: string;
  projectId?: number;
  q?: string;
  sort?: "recent" | "next" | "due";
  limit?: number;
}

export interface SLACadenceOptions {
  /** PromptX flow webhook that owns Gmail delivery (Plane Webhook Notification Flow). */
  notificationFlowWebhookUrl?: string | null;
  fallbackDevEmail?: string;
  /** Safety valves for stale test data: ignore tickets older than this, cap sends per run. */
  lookbackDays?: number;
  maxSendsPerRun?: number;
  /** Evaluate and log what WOULD be sent; claim nothing, send nothing. */
  dryRun?: boolean;
  /**
   * Send the very first reminder of a ticket only when its slot boundary was
   * crossed within this many minutes. Without it, switching the engine on
   * blasts every already-open ticket at once (measured: 46 customer messages
   * on the first pass against live data). Set generously above the evaluation
   * interval so a slot is never missed, but far below the shortest cadence.
   */
  catchUpGraceMinutes?: number;
}

export class SLACadenceService {
  private timer: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private readonly webhookUrl: string | null;
  private readonly fallbackDevEmail: string;
  private readonly lookbackDays: number;
  private readonly maxSendsPerRun: number;
  private readonly dryRun: boolean;
  private readonly catchUpGraceMinutes: number;
  private readonly catchUpGraceMs: number;
  private warnedNoWebhook = false;
  // Engine telemetry for the SLA console.
  private intervalMs = 900_000;
  private startedAt: Date | null = null;
  private lastTickAt: Date | null = null;
  private lastRunAt: Date | null = null;
  private lastRunDurationMs: number | null = null;
  private lastRunResult: CadenceRunResult | null = null;
  private lastRunError: string | null = null;
  private lastRunDryRun = false;
  private dryRunOverride: boolean | null = null;
  /** Last 20 passes, newest first — the console shows them so a failure that
   *  happened two ticks ago is still visible. */
  private readonly runLog: CadenceRunLog[] = [];
  private manualRun = false;

  constructor(options: SLACadenceOptions = {}) {
    this.webhookUrl = (options.notificationFlowWebhookUrl || config.SLA_NOTIFICATION_FLOW_WEBHOOK_URL || "").trim() || null;
    this.fallbackDevEmail = options.fallbackDevEmail || config.DEV_NOTIFICATION_FALLBACK_EMAIL;
    this.lookbackDays = options.lookbackDays ?? config.SLA_CADENCE_LOOKBACK_DAYS;
    this.maxSendsPerRun = options.maxSendsPerRun ?? config.SLA_CADENCE_MAX_SENDS_PER_RUN;
    this.dryRun = options.dryRun === true;
    this.catchUpGraceMinutes = options.catchUpGraceMinutes ?? config.SLA_CADENCE_CATCHUP_GRACE_MINUTES;
    this.catchUpGraceMs = this.catchUpGraceMinutes * 60_000;
  }

  /** Periodic evaluation. Default 15 minutes — finer than the shortest (1 h) interval. */
  startMonitor(intervalMs = 900_000): void {
    if (this.timer) return;
    this.intervalMs = intervalMs;
    this.startedAt = new Date();
    this.lastTickAt = this.startedAt;
    logger.info(
      { intervalMs, webhookConfigured: Boolean(this.webhookUrl), lookbackDays: this.lookbackDays },
      "Starting SLA cadence engine"
    );
    this.timer = setInterval(() => {
      this.lastTickAt = new Date();
      this.evaluateOpenTickets().catch((err: any) =>
        logger.error({ error: err.message }, "SLA cadence evaluation failed")
      );
    }, intervalMs);
  }

  /** When the timer will fire next (null while the engine is stopped). */
  nextRunAt(): Date | null {
    if (!this.timer || !this.lastTickAt) return null;
    return new Date(this.lastTickAt.getTime() + this.intervalMs);
  }

  private effectiveDryRun(): boolean {
    return this.dryRunOverride ?? this.dryRun;
  }

  stopMonitor(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info("SLA cadence engine stopped");
    }
  }

  /**
   * One evaluation pass. A PostgreSQL advisory lock makes it safe to run in
   * more than one process; a second runner simply skips the pass.
   */
  async evaluateOpenTickets(now: Date = new Date(), opts: { dryRun?: boolean } = {}): Promise<CadenceRunResult> {
    const result: CadenceRunResult = { evaluated: 0, devAlertsSent: 0, userUpdatesSent: 0, awaitingEvaluated: 0, nudgesSent: 0, autoClosed: 0, skippedLocked: false };
    if (this.isProcessing) return result;
    this.isProcessing = true;
    this.dryRunOverride = typeof opts.dryRun === "boolean" ? opts.dryRun : null;
    const runStartedAt = Date.now();
    this.lastRunError = null;

    let client: PoolClient | null = null;
    let locked = false;
    try {
      client = await pool.connect();
      const lock = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS ok", [ADVISORY_LOCK_KEY]);
      locked = Boolean(lock.rows[0]?.ok);
      if (!locked) {
        result.skippedLocked = true;
        logger.info("SLA cadence pass skipped: another runner holds the lock");
        return result;
      }

      const fallbackEmail = await ConstantSystemService.getConstant("DEV_NOTIFICATION_FALLBACK_EMAIL", this.fallbackDevEmail);
      const tickets = await this.loadOpenTickets();
      result.evaluated = tickets.length;
      let sends = 0;

      for (const t of tickets) {
        if (sends >= this.maxSendsPerRun) {
          logger.warn({ maxSendsPerRun: this.maxSendsPerRun }, "SLA cadence send cap reached; remaining tickets wait for the next pass");
          break;
        }
        const priority = normalizePriority(t.priority);
        const rule = CADENCE_RULES[priority];
        const createdAt = new Date(t.created_at);

        if (rule.dev) {
          const slot = cadenceSlot(createdAt, now, rule.dev);
          if (slot >= 1 && this.isSlotFresh(createdAt, slot, rule.dev, now)) {
            const sent = await this.sendDevReminder(t, priority, rule.dev, slot, fallbackEmail);
            if (sent) { result.devAlertsSent += 1; sends += 1; }
          }
        }

        if (rule.user && t.conversation_id) {
          const slot = cadenceSlot(createdAt, now, rule.user);
          if (slot >= 1 && this.isSlotFresh(createdAt, slot, rule.user, now)) {
            const sent = await this.sendUserProgress(t, slot, now);
            if (sent) { result.userUpdatesSent += 1; sends += 1; }
          }
        }
      }

      // Second pass: tickets delivered to the customer and still unanswered.
      await this.runResolutionFollowUps(now, result, this.maxSendsPerRun - sends);
      return result;
    } catch (err: any) {
      this.lastRunError = String(err?.message || err);
      throw err;
    } finally {
      if (client) {
        if (locked) {
          await client.query("SELECT pg_advisory_unlock(hashtext($1))", [ADVISORY_LOCK_KEY]).catch(() => {});
        }
        client.release();
      }
      this.lastRunAt = new Date();
      this.lastRunDurationMs = Date.now() - runStartedAt;
      this.lastRunResult = result;
      this.lastRunDryRun = this.effectiveDryRun();
      this.runLog.unshift({
        at: this.lastRunAt.toISOString(),
        durationMs: this.lastRunDurationMs,
        dryRun: this.lastRunDryRun,
        trigger: this.manualRun ? "manual" : "timer",
        result: { ...result },
        error: this.lastRunError,
      });
      if (this.runLog.length > 20) this.runLog.length = 20;
      this.manualRun = false;
      this.dryRunOverride = null;
      this.isProcessing = false;
    }
  }

  /**
   * True when the slot boundary was crossed recently enough to notify now.
   *
   * A ticket that has been open for days sits in a very high slot; without
   * this guard, enabling the engine (or a long outage) would fire one message
   * per open ticket immediately — a dry run against live data produced 46
   * customer messages in a single pass. Old tickets simply wait for their next
   * boundary, which for Urgent is at most an hour away.
   */
  private isSlotFresh(createdAt: Date, slot: number, interval: CadenceInterval, now: Date): boolean {
    const startedAt = slotStartedAt(createdAt, slot, interval);
    return now.getTime() - startedAt.getTime() <= this.catchUpGraceMs;
  }

  private async loadOpenTickets(): Promise<OpenTicketRow[]> {
    const { rows } = await pool.query<OpenTicketRow>(
      `SELECT t.id, t.ticket_number, t.subject, t.summary, t.status, t.priority, t.created_at, t.due_date,
              t.conversation_id, t.project_id,
              p.name AS project_name,
              c.handled_by, c.takeover_state,
              CASE WHEN jsonb_typeof(p.metadata->'dev_notification_emails') = 'array'
                   THEN p.metadata->'dev_notification_emails' ELSE NULL END AS dev_emails,
              p.metadata->>'dev_notification_email' AS legacy_dev_email
       FROM tickets t
       LEFT JOIN projects p ON p.id = t.project_id
       LEFT JOIN conversations c ON c.id = t.conversation_id
       WHERE t.deleted_at IS NULL
         AND LOWER(COALESCE(t.status, '')) <> ALL($1::text[])
         AND t.created_at >= NOW() - ($2::int * INTERVAL '1 day')
       ORDER BY t.created_at ASC`,
      [OPEN_STATUS_EXCLUDED, this.lookbackDays]
    );
    return rows;
  }

  private resolveDevEmails(t: OpenTicketRow, fallbackEmail: string): string[] {
    const valid = (v: unknown) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || "").trim());
    const fromArray = Array.isArray(t.dev_emails) ? t.dev_emails.map((v) => String(v).trim()).filter(valid) : [];
    if (fromArray.length) return Array.from(new Set(fromArray));
    if (valid(t.legacy_dev_email)) return [String(t.legacy_dev_email).trim()];
    return valid(fallbackEmail) ? [fallbackEmail] : [];
  }

  /**
   * Claims a cadence slot in sla_cadence_claims (migration 046); null when
   * this slot was already taken — by this process, another instance, or an
   * earlier retry. Claiming BEFORE sending is what makes concurrency safe.
   */
  private async claimSlot(ticketId: number, kind: "dev" | "user" | "nudge" | "autoclose", slotKey: string, channel: string): Promise<number | null> {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO sla_cadence_claims (ticket_id, kind, slot_key, channel, status, created_at)
       VALUES ($1, $2, $3, $4, 'pending', NOW())
       ON CONFLICT (ticket_id, kind, slot_key) DO NOTHING
       RETURNING id`,
      [ticketId, kind, slotKey, channel]
    );
    return rows.length ? Number(rows[0].id) : null;
  }

  private async finishSlot(claimId: number, status: "sent" | "failed" | "skipped" | "timeout"): Promise<void> {
    // Explicit casts: the same parameter used in SET and in a CASE test left
    // PostgreSQL unable to infer $2, the UPDATE errored silently and claims
    // stayed 'pending' forever (seen live on ticket:362:user:2).
    await pool
      .query(
        `UPDATE sla_cadence_claims
         SET status = $2::text,
             sent_at = CASE WHEN $2::text = 'sent' THEN NOW() ELSE sent_at END
         WHERE id = $1::int`,
        [claimId, status]
      )
      .catch((err) => logger.warn({ claimId, status, error: err.message }, "Could not finish cadence claim"));
  }

  private async releaseSlot(claimId: number): Promise<void> {
    // A failed delivery must not consume the slot, or the reminder is lost
    // until the next interval.
    await pool.query(`DELETE FROM sla_cadence_claims WHERE id = $1`, [claimId]).catch(() => {});
  }

  /**
   * Dev reminder = one POST to the notification flow, which formats and sends
   * the Gmail as apagent.test@gmail.com and claims the reminder_key in
   * outbox_events itself, so the flow is idempotent on its own side too.
   */
  private async sendDevReminder(t: OpenTicketRow, priority: string, interval: CadenceInterval, slot: number, fallbackEmail: string, slotKeyOverride?: string): Promise<boolean> {
    if (!this.webhookUrl) {
      if (!this.warnedNoWebhook) {
        this.warnedNoWebhook = true;
        logger.warn("SLA_NOTIFICATION_FLOW_WEBHOOK_URL is not set; dev reminders are skipped (nothing is faked)");
      }
      return false;
    }
    const devEmails = this.resolveDevEmails(t, fallbackEmail);
    if (!devEmails.length) {
      logger.warn({ ticketNumber: t.ticket_number }, "No dev recipient resolved; reminder skipped");
      return false;
    }
    const reminderKey = slotKeyOverride || `ticket:${t.id}:dev:${slot}`;
    if (this.effectiveDryRun()) {
      logger.info({ ticketNumber: t.ticket_number, priority, slot, reminderKey, devEmails }, "[dry-run] would send dev reminder");
      return true;
    }
    const logId = await this.claimSlot(t.id, "dev", reminderKey, "email");
    if (logId === null) return false;

    try {
      await axios.post(
        this.webhookUrl,
        {
          event: "ticketx.sla_dev_reminder",
          reminder: {
            reminder_key: reminderKey,
            ticket_id: t.id,
            ticket_number: t.ticket_number,
            subject: t.subject || "",
            summary: t.summary || "",
            status: t.status || "",
            priority,
            due_date: t.due_date,
            created_at: t.created_at,
            project_name: t.project_name || "TicketX Support",
            dev_emails: devEmails,
            repeat_label: interval.unit === "hours" ? `ทุก ${interval.every} ชั่วโมง` : `ทุก ${interval.every} วันทำการ`,
            slot,
          },
        },
        // The flow answers only after its Gmail step (~20 s measured); 15 s
        // timed out on a delivery that had in fact succeeded.
        { headers: { "Content-Type": "application/json" }, timeout: 45_000 }
      );
      await this.finishSlot(logId, "sent");
      logger.info({ ticketNumber: t.ticket_number, priority, slot, recipients: devEmails.length }, "SLA dev reminder handed to notification flow");
      return true;
    } catch (err: any) {
      // Release the slot ONLY when the request never reached PromptX. Once it
      // was transmitted (timeout, 5xx, reset) the flow may well have run and
      // sent the mail; the flow dedupes on reminder_key, so keeping the claim
      // prevents a retry storm without risking a lost reminder.
      const neverSent = ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(String(err.code || ""));
      if (neverSent) {
        await this.releaseSlot(logId);
      } else {
        await this.finishSlot(logId, err.code === "ECONNABORTED" ? "timeout" : "failed");
      }
      logger.error(
        { ticketNumber: t.ticket_number, slot, error: err.message, code: err.code, status: err.response?.status, slotReleased: neverSent },
        "SLA dev reminder POST did not complete"
      );
      return false;
    }
  }

  /** Customer progress report on LINE via the idempotent CustomerNotificationService. */
  private async sendUserProgress(t: OpenTicketRow, slot: number, now: Date, slotKeyOverride?: string): Promise<boolean> {
    const handledBy = String(t.handled_by || "ai").toLowerCase();
    const takeover = String(t.takeover_state || "none").toLowerCase();
    if (handledBy !== "ai" || takeover !== "none") {
      // A human owns this thread; an automated progress line would collide with theirs.
      return false;
    }
    const slotKey = slotKeyOverride || `ticket:${t.id}:user:${slot}`;
    const due = t.due_date ? new Date(t.due_date) : null;
    const dueAhead = due && !isNaN(due.getTime()) && due.getTime() > now.getTime();
    const detail = dueAhead
      ? `ตอนนี้${thaiStatus(t.status)} คาดว่าจะเรียบร้อยภายใน${thaiWhen(due as Date, now)} ค่ะ`
      : `ตอนนี้${thaiStatus(t.status)} ทีมงานกำลังเร่งดำเนินการให้โดยเร็วที่สุดค่ะ`;
    if (this.effectiveDryRun()) {
      logger.info({ ticketNumber: t.ticket_number, slot, slotKey, conversationId: t.conversation_id, detail }, "[dry-run] would send customer progress report");
      return true;
    }
    const logId = await this.claimSlot(t.id, "user", slotKey, "line");
    if (logId === null) return false;

    try {
      const res = await customerNotificationService.send({
        conversationId: Number(t.conversation_id),
        notificationType: "progress_update",
        idempotencyKey: slotKey,
        ticketId: t.id,
        ticketNumber: t.ticket_number,
        projectId: t.project_id ?? null,
        correlationId: slotKey,
        detail,
      });
      await this.finishSlot(logId, res.sent ? "sent" : "skipped");
      if (res.sent) {
        logger.info({ ticketNumber: t.ticket_number, slot }, "SLA progress report sent to customer");
      }
      return res.sent;
    } catch (err: any) {
      await this.releaseSlot(logId);
      logger.error({ ticketNumber: t.ticket_number, slot, error: err.message }, "SLA progress report failed; slot released for retry");
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Two-step close follow-ups (operator decision 2026-09-07).
  //
  // After "Delivery to Customer" the ticket waits in RESOLVED (or in
  // CUSTOMER_CONFIRMED once the close question is pending). A customer who
  // never answers would leave it there forever, so: one LINE nudge after
  // RESOLUTION_NUDGE_BUSINESS_DAYS, and an automatic close after
  // RESOLUTION_AUTO_CLOSE_BUSINESS_DAYS — both counted in business days from
  // the moment the ticket started waiting, both idempotent through
  // sla_cadence_claims, both skipped while a human owns the thread. A ticket
  // the customer reopens restarts the clock naturally (lifecycle_changed_at).
  // ---------------------------------------------------------------------------

  private async loadAwaitingTickets(): Promise<AwaitingTicketRow[]> {
    const { rows } = await pool.query<AwaitingTicketRow>(
      `SELECT t.id, t.ticket_number, t.subject, UPPER(t.status) AS status,
              COALESCE(t.lifecycle_changed_at, t.resolved_at, t.updated_at) AS waiting_since,
              t.conversation_id, t.project_id, t.org_id,
              c.handled_by, c.takeover_state
         FROM tickets t
         JOIN conversations c ON c.id = t.conversation_id
        WHERE t.deleted_at IS NULL
          AND UPPER(COALESCE(t.status, '')) IN ('RESOLVED', 'CUSTOMER_CONFIRMED')
          AND t.conversation_id IS NOT NULL
          AND COALESCE(t.lifecycle_changed_at, t.resolved_at, t.updated_at) >= NOW() - ($1::int * INTERVAL '1 day')
        ORDER BY waiting_since ASC`,
      [this.lookbackDays]
    );
    return rows;
  }

  private async runResolutionFollowUps(now: Date, result: CadenceRunResult, budget: number): Promise<void> {
    const nudgeDays = config.RESOLUTION_NUDGE_BUSINESS_DAYS;
    const closeDays = config.RESOLUTION_AUTO_CLOSE_BUSINESS_DAYS;
    if (nudgeDays <= 0 && closeDays <= 0) return;

    const tickets = await this.loadAwaitingTickets();
    result.awaitingEvaluated = tickets.length;
    let sends = 0;

    for (const t of tickets) {
      if (sends >= budget) {
        logger.warn({ budget }, "Follow-up send cap reached; remaining tickets wait for the next pass");
        break;
      }
      const since = new Date(t.waiting_since);
      if (isNaN(since.getTime())) continue;
      // The clock key: a reopen → redelivery cycle gets fresh slots.
      const clockKey = String(since.getTime());

      if (closeDays > 0 && addBusinessDays(since, closeDays).getTime() <= now.getTime()) {
        const done = await this.autoCloseTicket(t, `ticket:${t.id}:autoclose:${clockKey}`);
        if (done) { result.autoClosed += 1; sends += 1; }
        continue;
      }
      if (nudgeDays > 0 && addBusinessDays(since, nudgeDays).getTime() <= now.getTime()) {
        const sent = await this.sendResolutionNudge(t, `ticket:${t.id}:nudge:${clockKey}`, since, now);
        if (sent) { result.nudgesSent += 1; sends += 1; }
      }
    }
  }

  private humanOwnsThread(t: { handled_by: string | null; takeover_state: string | null }): boolean {
    return String(t.handled_by || "ai").toLowerCase() !== "ai" || String(t.takeover_state || "none").toLowerCase() !== "none";
  }

  /** "Did the fix work?" reminder with the same chips as the delivery message. */
  private async sendResolutionNudge(t: AwaitingTicketRow, slotKey: string, since: Date, now: Date): Promise<boolean> {
    if (this.humanOwnsThread(t)) return false;
    const closeDays = config.RESOLUTION_AUTO_CLOSE_BUSINESS_DAYS;
    const deadline = closeDays > 0
      ? `หากไม่ได้รับการตอบกลับ ระบบจะปิดเคสให้อัตโนมัติภายใน ${thaiWhen(addBusinessDays(since, closeDays), now)} นะคะ`
      : "";
    if (this.effectiveDryRun()) {
      logger.info({ ticketNumber: t.ticket_number, slotKey, conversationId: t.conversation_id }, "[dry-run] would send resolution nudge");
      return true;
    }
    const logId = await this.claimSlot(t.id, "nudge", slotKey, "line");
    if (logId === null) return false;
    try {
      const res = await customerNotificationService.send({
        conversationId: Number(t.conversation_id),
        notificationType: "resolution_nudge",
        idempotencyKey: slotKey,
        ticketId: t.id,
        ticketNumber: t.ticket_number,
        subject: t.subject,
        projectId: t.project_id ?? null,
        orgId: t.org_id ?? null,
        correlationId: slotKey,
        detail: deadline,
      });
      await this.finishSlot(logId, res.sent ? "sent" : "skipped");
      if (res.sent) logger.info({ ticketNumber: t.ticket_number }, "Resolution nudge sent to customer");
      return res.sent;
    } catch (err: any) {
      await this.releaseSlot(logId);
      logger.error({ ticketNumber: t.ticket_number, error: err.message }, "Resolution nudge failed; slot released for retry");
      return false;
    }
  }

  /**
   * Silent customer: close on their behalf. Walks the honest route
   * (RESOLVED → CUSTOMER_CONFIRMED → CLOSED) as the system with an explicit
   * reason, so the event trail never claims the customer confirmed anything.
   * Plane follows to Close through the outbox trigger.
   */
  private async autoCloseTicket(t: AwaitingTicketRow, slotKey: string): Promise<boolean> {
    if (this.humanOwnsThread(t)) return false;
    if (this.effectiveDryRun()) {
      logger.info({ ticketNumber: t.ticket_number, slotKey, status: t.status }, "[dry-run] would auto-close ticket");
      return true;
    }
    const logId = await this.claimSlot(t.id, "autoclose", slotKey, "line");
    if (logId === null) return false;
    try {
      const hops: Array<"CUSTOMER_CONFIRMED" | "CLOSED"> = t.status === "RESOLVED" ? ["CUSTOMER_CONFIRMED", "CLOSED"] : ["CLOSED"];
      let closedEventId: number | null = null;
      for (const to of hops) {
        const r = await ticketStateMachine.transition({
          ticketRef: t.id,
          to,
          actor: "system",
          actorRef: "sla-cadence:auto-close",
          reason: `Auto-closed: no customer answer within ${config.RESOLUTION_AUTO_CLOSE_BUSINESS_DAYS} business day(s) of delivery`,
          correlationId: slotKey,
          source: "sla_cadence",
        });
        if (!r.applied) {
          logger.warn({ ticketNumber: t.ticket_number, to, code: r.code }, "Auto-close hop rejected");
          await this.finishSlot(logId, "skipped");
          return false;
        }
        if (to === "CLOSED") closedEventId = r.eventId ?? null;
      }
      const res = await customerNotificationService.send({
        conversationId: Number(t.conversation_id),
        notificationType: "auto_closed",
        idempotencyKey: closedEventId ? `ticket_event:${closedEventId}` : slotKey,
        ticketId: t.id,
        ticketNumber: t.ticket_number,
        projectId: t.project_id ?? null,
        orgId: t.org_id ?? null,
        correlationId: slotKey,
        quickReplies: [],
      });
      await this.finishSlot(logId, res.sent ? "sent" : "skipped");
      void doneEmailService.notifyClosed({ ticketId: t.id, closeEventId: closedEventId, correlationId: slotKey }).catch(() => {});
      logger.info({ ticketNumber: t.ticket_number, notified: res.sent }, "Ticket auto-closed after silent delivery");
      return true;
    } catch (err: any) {
      await this.finishSlot(logId, "failed");
      logger.error({ ticketNumber: t.ticket_number, error: err.message }, "Auto-close failed");
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // SLA console support (admin API). Read paths are pure. Write paths touch one
  // ticket only, run through the same senders as the timer, and are audited in
  // ticket_events so a test never masquerades as production history.
  // ---------------------------------------------------------------------------

  static consoleWritesAllowed(): boolean {
    const explicit = config.SLA_CONSOLE_ALLOW_WRITES;
    if (typeof explicit === "boolean") return explicit;
    return config.NODE_ENV !== "production";
  }

  getEngineState() {
    const url = this.webhookUrl;
    return {
      serverNow: new Date(),
      enabled: config.SLA_CADENCE_ENABLED,
      running: this.timer !== null,
      isProcessing: this.isProcessing,
      intervalMs: this.intervalMs,
      startedAt: this.startedAt,
      lastTickAt: this.lastTickAt,
      nextRunAt: this.nextRunAt(),
      lastRunAt: this.lastRunAt,
      lastRunDurationMs: this.lastRunDurationMs,
      lastRunResult: this.lastRunResult,
      lastRunDryRun: this.lastRunDryRun,
      lastRunError: this.lastRunError,
      runLog: this.runLog,
      lookbackDays: this.lookbackDays,
      maxSendsPerRun: this.maxSendsPerRun,
      catchUpGraceMinutes: this.catchUpGraceMinutes,
      webhookConfigured: Boolean(url),
      webhookHost: url ? new URL(url).host : null,
      fallbackDevEmail: this.fallbackDevEmail,
      openStatusExcluded: OPEN_STATUS_EXCLUDED,
      rules: CADENCE_RULES,
      writesAllowed: SLACadenceService.consoleWritesAllowed(),
    };
  }

  /** Runs one pass immediately (same code path as the timer). */
  async runNow(opts: { dryRun?: boolean } = {}): Promise<CadenceRunResult & { alreadyRunning: boolean }> {
    if (this.isProcessing) {
      return { evaluated: 0, devAlertsSent: 0, userUpdatesSent: 0, awaitingEvaluated: 0, nudgesSent: 0, autoClosed: 0, skippedLocked: false, alreadyRunning: true };
    }
    this.manualRun = true;
    const result = await this.evaluateOpenTickets(new Date(), opts);
    return { ...result, alreadyRunning: false };
  }

  private async loadTicketByRef(ref: string): Promise<TicketDetailRow | null> {
    const raw = String(ref || "").trim();
    if (!raw) return null;
    const numeric = /^\d+$/.test(raw) ? Number(raw) : null;
    const { rows } = await pool.query<TicketDetailRow>(
      `SELECT t.id, t.ticket_number, t.subject, t.summary, t.status, t.priority, t.severity,
              t.created_at, t.updated_at, t.due_date, t.response_due_at, t.first_response_at,
              t.sla_breached, t.deleted_at, t.conversation_id, t.project_id, t.org_id,
              t.plane_issue_id, t.plane_workspace_slug, t.plane_project_id, t.plane_status,
              p.name AS project_name,
              c.channel, c.handled_by, c.takeover_state,
              i.channel_ref AS customer_ref, pr.name AS customer_name, pr.email AS customer_email,
              CASE WHEN jsonb_typeof(p.metadata->'dev_notification_emails') = 'array'
                   THEN p.metadata->'dev_notification_emails' ELSE NULL END AS dev_emails,
              p.metadata->>'dev_notification_email' AS legacy_dev_email
       FROM tickets t
       LEFT JOIN projects p ON p.id = t.project_id
       LEFT JOIN conversations c ON c.id = t.conversation_id
       LEFT JOIN identities i ON i.id = c.identity_id
       LEFT JOIN profiles pr ON pr.id = i.profile_id
       WHERE ($1::int IS NOT NULL AND t.id = $1::int) OR UPPER(t.ticket_number) = UPPER($2)
       ORDER BY t.id DESC
       LIMIT 1`,
      [numeric, raw]
    );
    return rows[0] || null;
  }

  /** Recent tickets for the console picker (newest first). */
  async listRecentTickets(limit = 20) {
    const { rows } = await pool.query(
      `SELECT t.id, t.ticket_number, t.subject, t.status, t.priority, t.created_at, t.project_id,
              LOWER(COALESCE(c.channel, '')) AS channel
       FROM tickets t LEFT JOIN conversations c ON c.id = t.conversation_id
       WHERE t.deleted_at IS NULL
       ORDER BY t.id DESC
       LIMIT $1`,
      [Math.min(100, Math.max(1, limit))]
    );
    return rows;
  }

  /**
   * Filtered ticket list for the console picker and the overview board.
   *
   * `scope` decides which tickets are worth showing at all:
   *   cadence — open, inside the lookback window, and the priority has a rule
   *   open    — every ticket that is not resolved/closed/cancelled
   *   closed  — the finished ones
   *   all     — everything (still excludes soft-deleted rows)
   *
   * Each row carries the computed next dev/user delivery so the board can
   * count down and sort without a round trip per ticket.
   */
  async listTickets(filter: TicketListFilter = {}, now: Date = new Date()) {
    const scope = filter.scope || "cadence";
    const limit = Math.min(200, Math.max(1, filter.limit ?? 60));
    const params: any[] = [];
    const where: string[] = ["t.deleted_at IS NULL"];

    if (scope === "cadence" || scope === "open") {
      params.push(OPEN_STATUS_EXCLUDED);
      where.push(`LOWER(COALESCE(t.status, '')) <> ALL($${params.length}::text[])`);
    } else if (scope === "closed") {
      params.push(OPEN_STATUS_EXCLUDED);
      where.push(`LOWER(COALESCE(t.status, '')) = ANY($${params.length}::text[])`);
    }
    if (scope === "cadence") {
      params.push(this.lookbackDays);
      where.push(`t.created_at >= NOW() - ($${params.length}::int * INTERVAL '1 day')`);
    }
    if (filter.priority) { params.push(filter.priority); where.push(`t.priority = $${params.length}`); }
    if (filter.projectId) { params.push(filter.projectId); where.push(`t.project_id = $${params.length}::int`); }
    if (filter.channel === "other") {
      where.push(`COALESCE(LOWER(c.channel), '') NOT IN ('line', 'webchat')`);
    } else if (filter.channel) {
      params.push(filter.channel);
      where.push(`LOWER(COALESCE(c.channel, '')) = $${params.length}`);
    }
    if (filter.q) {
      params.push(`%${filter.q.trim()}%`);
      where.push(`(t.ticket_number ILIKE $${params.length} OR t.subject ILIKE $${params.length} OR t.summary ILIKE $${params.length})`);
    }
    params.push(limit);

    const { rows } = await pool.query(
      `SELECT t.id, t.ticket_number, t.subject, t.status, t.priority, t.created_at, t.due_date,
              t.project_id, t.conversation_id, t.plane_issue_id IS NOT NULL AS in_plane,
              p.name AS project_name,
              LOWER(COALESCE(c.channel, '')) AS channel,
              COALESCE(c.handled_by, 'ai') AS handled_by, COALESCE(c.takeover_state, 'none') AS takeover_state
       FROM tickets t
       LEFT JOIN projects p ON p.id = t.project_id
       LEFT JOIN conversations c ON c.id = t.conversation_id
       WHERE ${where.join(" AND ")}
       ORDER BY t.id DESC
       LIMIT $${params.length}`,
      params
    );
    if (rows.length === 0) return { rows: [], total: 0 };

    // One extra query resolves "has this slot already been claimed" for the
    // whole page, instead of one per ticket.
    const ids = rows.map((r: any) => r.id);
    const claims = await pool.query(
      `SELECT ticket_id, kind, slot_key FROM sla_cadence_claims WHERE ticket_id = ANY($1::int[])`,
      [ids]
    );
    const claimed = new Set(claims.rows.map((r: any) => `${r.ticket_id}:${r.kind}:${r.slot_key}`));

    const enriched = rows.map((r: any) => {
      const priority = normalizePriority(r.priority);
      const rule = CADENCE_RULES[priority];
      const createdAt = new Date(r.created_at);
      const open = !OPEN_STATUS_EXCLUDED.includes(String(r.status || "").toLowerCase());
      const aiOwned = String(r.handled_by).toLowerCase() === "ai" && String(r.takeover_state).toLowerCase() === "none";
      const leg = (kind: "dev" | "user", interval: CadenceInterval | null) => {
        if (!interval || !open) return null;
        const slot = cadenceSlot(createdAt, now, interval);
        const key = `ticket:${r.id}:${kind}:${slot}`;
        const done = claimed.has(`${r.id}:${kind}:${key}`) || claimed.has(`${r.id}:${kind}:ticket:${r.id}:${kind}:${slot}`);
        const boundary = slotStartedAt(createdAt, slot + (slot >= 1 && !done && this.isSlotFresh(createdAt, slot, interval, now) ? 0 : 1), interval);
        return { slot, claimed: done, nextAt: boundary.toISOString() };
      };
      const dev = leg("dev", rule.dev);
      const user = rule.user && r.conversation_id && aiOwned ? leg("user", rule.user) : null;
      return {
        ...r,
        priority,
        open,
        devNextAt: dev?.nextAt || null,
        devSlot: dev?.slot ?? null,
        userNextAt: user?.nextAt || null,
        userSlot: user?.slot ?? null,
        nextAt: [dev?.nextAt, user?.nextAt].filter(Boolean).sort()[0] || null,
      };
    });

    if (filter.sort === "next") {
      enriched.sort((a, b) => (a.nextAt ? new Date(a.nextAt).getTime() : Infinity) - (b.nextAt ? new Date(b.nextAt).getTime() : Infinity));
    } else if (filter.sort === "due") {
      enriched.sort((a, b) => (a.due_date ? new Date(a.due_date).getTime() : Infinity) - (b.due_date ? new Date(b.due_date).getTime() : Infinity));
    }
    return { rows: enriched, total: enriched.length };
  }

  /** Projects that actually own tickets — populates the picker's project filter. */
  async listProjects() {
    const { rows } = await pool.query(
      `SELECT p.id, p.name, COUNT(t.id)::int AS tickets
       FROM projects p JOIN tickets t ON t.project_id = p.id AND t.deleted_at IS NULL
       GROUP BY p.id, p.name ORDER BY p.id`
    );
    return rows;
  }

  /**
   * Closes or cancels a ticket from the console. Raw status write on purpose:
   * this is test-data hygiene, so it must not notify the customer or push to
   * Plane. Audited like every other console write.
   */
  async closeTicket(ref: string, mode: "closed" | "cancelled" = "cancelled", reason?: string) {
    const t = await this.loadTicketByRef(ref);
    if (!t) return { ok: false as const, reason: "TICKET_NOT_FOUND" };
    const status = mode === "closed" ? "CLOSED" : "CANCELLED";
    const { rows } = await pool.query(
      `UPDATE tickets
       SET status = $2,
           cancellation_reason = CASE WHEN $2 = 'CANCELLED' THEN COALESCE($3, cancellation_reason) ELSE cancellation_reason END,
           lifecycle_changed_at = NOW(), updated_at = NOW()
       WHERE id = $1
       RETURNING id, ticket_number, status`,
      [t.id, status, reason || "Closed from the SLA console (test data)"]
    );
    await this.audit(t.id, "SLA_CONSOLE_CLOSE_TICKET", { from: t.status, to: status, reason: reason || null });
    logger.warn({ ticketId: t.id, ticketNumber: t.ticket_number, from: t.status, to: status }, "SLA console changed a ticket status");
    return { ok: true as const, ticket: rows[0], previousStatus: t.status };
  }

  private describeCadence(
    kind: "dev" | "user",
    interval: CadenceInterval,
    createdAt: Date,
    now: Date,
    claimedKeys: Set<string>,
    ticketId: number
  ) {
    const slot = cadenceSlot(createdAt, now, interval);
    const slotStart = slotStartedAt(createdAt, slot, interval);
    const nextBoundary = slotStartedAt(createdAt, slot + 1, interval);
    const fresh = slot >= 1 && this.isSlotFresh(createdAt, slot, interval, now);
    const slotKey = `ticket:${ticketId}:${kind}:${slot}`;
    const claimed = claimedKeys.has(slotKey);
    const nextRun = this.nextRunAt();

    // Align a wall-clock target to the engine's tick grid.
    const alignToTick = (target: Date): Date | null => {
      if (!nextRun) return null;
      if (nextRun.getTime() >= target.getTime()) return nextRun;
      const steps = Math.ceil((target.getTime() - nextRun.getTime()) / this.intervalMs);
      return new Date(nextRun.getTime() + steps * this.intervalMs);
    };

    let phase: string;
    let predictedAt: Date | null;
    if (slot >= 1 && fresh && !claimed) {
      phase = "due_now";
      predictedAt = nextRun;
    } else if (claimed) {
      phase = "slot_sent";
      predictedAt = alignToTick(nextBoundary);
    } else if (slot >= 1 && !fresh) {
      phase = "missed_boundary";
      predictedAt = alignToTick(nextBoundary);
    } else {
      phase = "waiting_first_boundary";
      predictedAt = alignToTick(nextBoundary);
    }

    return {
      kind,
      interval,
      slot,
      slotKey,
      slotStartedAt: slotStart,
      nextBoundaryAt: nextBoundary,
      freshWithinGrace: fresh,
      claimed,
      phase,
      predictedDeliveryAt: predictedAt,
      engineRunning: Boolean(nextRun),
    };
  }

  private async loadHistory(ticketId: number) {
    const [logs, notes, outbox, audit] = await Promise.all([
      pool.query(
        `SELECT id, kind, channel, slot_key, status, created_at, sent_at
         FROM sla_cadence_claims WHERE ticket_id = $1
         ORDER BY id DESC LIMIT 50`,
        [ticketId]
      ),
      pool.query(
        `SELECT id, notification_type, idempotency_key, channel, status, body, error_message, sent_at, created_at
         FROM customer_notifications WHERE ticket_id = $1 ORDER BY id DESC LIMIT 50`,
        [ticketId]
      ),
      pool.query(
        `SELECT id, event_type, status, payload, created_at
         FROM outbox_events
         WHERE aggregate_type = 'Ticket' AND aggregate_id = $1::text
           AND event_type IN ('SlaDevReminderEmailClaimed','PlaneUrgentDevEmailClaimed','PlaneDoneEmailNotificationClaimed')
         ORDER BY id DESC LIMIT 50`,
        [String(ticketId)]
      ),
      pool.query(
        `SELECT id, event_type, actor, source, payload, created_at
         FROM ticket_events WHERE ticket_id = $1 AND event_type LIKE 'SLA_CONSOLE_%'
         ORDER BY id DESC LIMIT 20`,
        [ticketId]
      ),
    ]);
    return {
      cadenceClaims: logs.rows,
      customerNotifications: notes.rows,
      emailClaims: outbox.rows,
      consoleAudit: audit.rows,
    };
  }

  /** Everything the console shows for one ticket. Pure read. */
  async inspectTicket(ref: string, now: Date = new Date()) {
    const t = await this.loadTicketByRef(ref);
    if (!t) return null;

    const priority = normalizePriority(t.priority);
    const rule = CADENCE_RULES[priority];
    const createdAt = new Date(t.created_at);
    const status = String(t.status || "").toLowerCase();
    const isOpen = !t.deleted_at && !OPEN_STATUS_EXCLUDED.includes(status);
    const ageMs = now.getTime() - createdAt.getTime();
    const withinLookback = ageMs <= this.lookbackDays * 86_400_000;
    const hasConversation = Boolean(t.conversation_id);
    const channel = String(t.channel || "").toLowerCase();
    const aiOwned = String(t.handled_by || "ai").toLowerCase() === "ai" && String(t.takeover_state || "none").toLowerCase() === "none";
    const fallbackEmail = await ConstantSystemService.getConstant("DEV_NOTIFICATION_FALLBACK_EMAIL", this.fallbackDevEmail);
    const devEmails = this.resolveDevEmails(t, fallbackEmail);
    const webhookConfigured = Boolean(this.webhookUrl);

    const history = await this.loadHistory(t.id);
    const claimedKeys = new Set<string>(history.cadenceClaims.map((r: any) => String(r.slot_key)));

    const checks = [
      { key: "open", ok: isOpen, label: "สถานะเคสยังเปิดอยู่", detail: t.deleted_at ? "ถูกลบ" : `status = ${t.status}` },
      { key: "lookback", ok: withinLookback, label: `อยู่ในกรอบ ${this.lookbackDays} วันของเครื่องยนต์`, detail: `อายุเคส ${(ageMs / 3_600_000).toFixed(1)} ชั่วโมง` },
      { key: "conversation", ok: hasConversation, label: "มีห้องสนทนาผูกอยู่ (จำเป็นสำหรับรายงานลูกค้า)", detail: hasConversation ? `conversation ${t.conversation_id}` : "ไม่มี" },
      { key: "line", ok: channel === "line", label: "ช่องทาง LINE (push ถึงลูกค้าได้จริง)", detail: channel || "ไม่ทราบช่องทาง" },
      { key: "ai_owned", ok: aiOwned, label: "AI ดูแลอยู่ (ไม่มี human รับช่วง)", detail: `handled_by=${t.handled_by || "ai"}, takeover=${t.takeover_state || "none"}` },
      { key: "dev_recipients", ok: devEmails.length > 0, label: "มีอีเมลทีม Dev ปลายทาง", detail: devEmails.join(", ") || "ไม่พบ" },
      { key: "webhook", ok: webhookConfigured, label: "ตั้ง SLA_NOTIFICATION_FLOW_WEBHOOK_URL แล้ว (เมลเตือน Dev)", detail: webhookConfigured ? "ตั้งแล้ว" : "ยังไม่ตั้ง — เมลเตือนซ้ำจะถูกข้าม" },
      { key: "engine", ok: this.timer !== null, label: "เครื่องยนต์กำลังเดิน", detail: this.timer ? `ทุก ${Math.round(this.intervalMs / 60000)} นาที` : "ปิดอยู่ (SLA_CADENCE_ENABLED=false หรือยังไม่ start)" },
    ];
    const devEligible = isOpen && withinLookback && Boolean(rule.dev) && devEmails.length > 0 && webhookConfigured;
    const userEligible = isOpen && withinLookback && Boolean(rule.user) && hasConversation && aiOwned;

    const due = t.due_date ? new Date(t.due_date) : null;
    const responseDue = t.response_due_at ? new Date(t.response_due_at) : null;
    const firstResponse = t.first_response_at ? new Date(t.first_response_at) : null;

    return {
      serverNow: now,
      ticket: {
        id: t.id,
        ticketNumber: t.ticket_number,
        subject: t.subject,
        summary: t.summary,
        status: t.status,
        planeStatus: t.plane_status,
        priority,
        rawPriority: t.priority,
        severity: t.severity,
        projectId: t.project_id,
        projectName: t.project_name,
        orgId: t.org_id,
        conversationId: t.conversation_id,
        channel,
        customerName: t.customer_name,
        customerRef: t.customer_ref ? `${String(t.customer_ref).slice(0, 7)}…${String(t.customer_ref).slice(-4)}` : null,
        customerHasEmail: Boolean(t.customer_email),
        createdAt,
        updatedAt: t.updated_at,
        deletedAt: t.deleted_at,
        plane: t.plane_issue_id
          ? { issueId: t.plane_issue_id, workspaceSlug: t.plane_workspace_slug, projectId: t.plane_project_id }
          : null,
      },
      sla: {
        firstResponseAt: firstResponse,
        responseDueAt: responseDue,
        responseMet: firstResponse && responseDue ? firstResponse.getTime() <= responseDue.getTime() : null,
        dueAt: due,
        resolutionRemainingMs: due ? due.getTime() - now.getTime() : null,
        breached: due ? due.getTime() < now.getTime() && isOpen : false,
        breachedFlag: Boolean(t.sla_breached),
      },
      eligibility: { checks, devEligible, userEligible },
      cadence: {
        priority,
        rule,
        dev: rule.dev ? this.describeCadence("dev", rule.dev, createdAt, now, claimedKeys, t.id) : null,
        user: rule.user ? this.describeCadence("user", rule.user, createdAt, now, claimedKeys, t.id) : null,
        devRecipients: devEmails,
        catchUpGraceMinutes: this.catchUpGraceMinutes,
      },
      history,
    };
  }

  private async audit(ticketId: number, eventType: string, payload: Record<string, unknown>): Promise<void> {
    await pool
      .query(
        `INSERT INTO ticket_events (ticket_id, event_type, actor, payload, source, created_at)
         VALUES ($1, $2, 'sla-console', $3::jsonb, 'admin_console', NOW())`,
        [ticketId, eventType, JSON.stringify(payload)]
      )
      .catch((err) => logger.warn({ ticketId, eventType, error: err.message }, "Console audit row not written"));
  }

  /**
   * Test accelerator: moves the ticket's clock back so cadence slots and SLA
   * targets behave as if the ticket were `minutes` older. All four timestamps
   * shift together so the SLA arithmetic stays internally consistent.
   */
  async shiftTicketClock(ref: string, minutes: number) {
    const t = await this.loadTicketByRef(ref);
    if (!t) return { ok: false as const, reason: "TICKET_NOT_FOUND" };
    const m = Math.trunc(Number(minutes));
    if (!Number.isFinite(m) || m === 0 || Math.abs(m) > 1440) return { ok: false as const, reason: "MINUTES_OUT_OF_RANGE" };

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const before = await client.query(
        `SELECT created_at, first_response_at, response_due_at, due_date FROM tickets WHERE id = $1 FOR UPDATE`,
        [t.id]
      );
      const after = await client.query(
        `UPDATE tickets
         SET created_at        = created_at - ($2::int * INTERVAL '1 minute'),
             first_response_at = CASE WHEN first_response_at IS NULL THEN NULL ELSE first_response_at - ($2::int * INTERVAL '1 minute') END,
             response_due_at   = CASE WHEN response_due_at IS NULL THEN NULL ELSE response_due_at - ($2::int * INTERVAL '1 minute') END,
             due_date          = CASE WHEN due_date IS NULL THEN NULL ELSE due_date - ($2::int * INTERVAL '1 minute') END,
             updated_at        = NOW()
         WHERE id = $1
         RETURNING created_at, first_response_at, response_due_at, due_date`,
        [t.id, m]
      );
      await client.query("COMMIT");
      await this.audit(t.id, "SLA_CONSOLE_CLOCK_SHIFT", { minutes: m, before: before.rows[0], after: after.rows[0] });
      logger.warn({ ticketId: t.id, ticketNumber: t.ticket_number, minutes: m }, "SLA console shifted a ticket clock");
      return { ok: true as const, ticketId: t.id, ticketNumber: t.ticket_number, minutes: m, before: before.rows[0], after: after.rows[0] };
    } catch (err: any) {
      await client.query("ROLLBACK").catch(() => {});
      return { ok: false as const, reason: "DB_ERROR", error: err.message };
    } finally {
      client.release();
    }
  }

  /**
   * Sends one dev reminder or one customer progress report right now using a
   * manual slot key, so it can never consume the ticket's real cadence slot.
   */
  async forceTestSend(ref: string, kind: "dev" | "user") {
    const t = await this.loadTicketByRef(ref);
    if (!t) return { ok: false as const, reason: "TICKET_NOT_FOUND" };
    const priority = normalizePriority(t.priority);
    const rule = CADENCE_RULES[priority];
    const now = new Date();
    const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);

    if (kind === "dev") {
      if (!this.webhookUrl) return { ok: false as const, reason: "WEBHOOK_NOT_CONFIGURED" };
      const fallbackEmail = await ConstantSystemService.getConstant("DEV_NOTIFICATION_FALLBACK_EMAIL", this.fallbackDevEmail);
      if (!this.resolveDevEmails(t, fallbackEmail).length) return { ok: false as const, reason: "NO_DEV_RECIPIENT" };
      const key = `ticket:${t.id}:dev:manual-${stamp}`;
      const sent = await this.sendDevReminder(t, priority, rule.dev || H(1), 0, fallbackEmail, key);
      await this.audit(t.id, "SLA_CONSOLE_FORCE_SEND", { kind, key, sent });
      return { ok: true as const, kind, key, sent, ticketNumber: t.ticket_number };
    }

    if (!t.conversation_id) return { ok: false as const, reason: "NO_CONVERSATION" };
    const aiOwned = String(t.handled_by || "ai").toLowerCase() === "ai" && String(t.takeover_state || "none").toLowerCase() === "none";
    if (!aiOwned) return { ok: false as const, reason: "HUMAN_OWNS_THREAD" };
    const key = `ticket:${t.id}:user:manual-${stamp}`;
    const sent = await this.sendUserProgress(t, 0, now, key);
    await this.audit(t.id, "SLA_CONSOLE_FORCE_SEND", { kind, key, sent });
    return { ok: true as const, kind, key, sent, ticketNumber: t.ticket_number };
  }

  /** Removes this ticket's cadence claims and test notifications so a scenario can be replayed. */
  async resetTicketTestData(ref: string) {
    const t = await this.loadTicketByRef(ref);
    if (!t) return { ok: false as const, reason: "TICKET_NOT_FOUND" };
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const a = await client.query(`DELETE FROM sla_cadence_claims WHERE ticket_id = $1`, [t.id]);
      const b = await client.query(`DELETE FROM outbox_events WHERE aggregate_type = 'Ticket' AND aggregate_id = $1::text AND event_type = 'SlaDevReminderEmailClaimed'`, [String(t.id)]);
      const c = await client.query(`DELETE FROM customer_notifications WHERE ticket_id = $1 AND notification_type = 'progress_update'`, [t.id]);
      await client.query("COMMIT");
      const counts = { cadenceClaims: a.rowCount || 0, emailClaims: b.rowCount || 0, progressNotifications: c.rowCount || 0 };
      await this.audit(t.id, "SLA_CONSOLE_RESET", counts);
      return { ok: true as const, ticketId: t.id, ticketNumber: t.ticket_number, deleted: counts };
    } catch (err: any) {
      await client.query("ROLLBACK").catch(() => {});
      return { ok: false as const, reason: "DB_ERROR", error: err.message };
    } finally {
      client.release();
    }
  }
}

interface TicketDetailRow extends OpenTicketRow {
  summary: string | null;
  severity: string | null;
  updated_at: string | null;
  response_due_at: string | null;
  first_response_at: string | null;
  sla_breached: boolean | null;
  deleted_at: string | null;
  org_id: string | null;
  plane_issue_id: string | null;
  plane_workspace_slug: string | null;
  plane_project_id: string | null;
  plane_status: string | null;
  channel: string | null;
  customer_ref: string | null;
  customer_name: string | null;
  customer_email: string | null;
}
