import crypto from "crypto";
import axios from "axios";
import { DatabaseAdapter } from "../adapters/types";
import { pool } from "../adapters/postgres/PostgresAdapter";
import { config } from "../config/env";
import { ticketStateMachine } from "../domain/ticket/TicketStateMachine";
import { customerNotificationService } from "./CustomerNotificationService";
import { createLogger } from "../observability/logger";
import { traceRecorder } from "../observability/TraceRecorder";

const logger = createLogger("planeWebhookService");

export interface PlaneWebhookPayload {
  event?: string;
  action?: string;
  workspace_id?: string;
  data?: {
    id?: string;
    project?: string | { id?: string };
    priority?: string | null;
    completed_at?: string | null;
    state?: string | { id?: string; name?: string; group?: string } | null;
    state_detail?: { id?: string; name?: string; group?: string } | null;
    state_name?: string | null;
    state_group?: string | null;
  };
}

export interface PlaneWebhookSyncResult {
  processed: boolean;
  matched: boolean;
  deleted?: boolean;
  reason?: string;
  planeIssueId?: string;
  status?: string;
  priority?: string;
}

export interface PlaneMappingContext {
  workspaceSlug?: string;
  planeProjectId?: string;
  apiBaseUrl?: string;
  apiKey?: string;
}

export interface PlaneReverseSyncSummary {
  checked: number;
  /** Work items whose Plane-side version was unchanged since the last poll. */
  skipped: number;
  /** Set when Plane rate-limited us and the cycle stopped early. */
  rateLimited?: boolean;
  /** Milliseconds to wait before polling again, when rate limited. */
  retryAfterMs?: number;
  updated: number;
  deleted: number;
  unlinked: number;
  failed: number;
}

/**
 * Normalises a Plane state NAME to the vocabulary TicketLifecycle understands.
 *
 * The Excise project (2026-09-07) defines: Backlog, Re-Open (backlog group),
 * Triaged (unstarted), In Progress / Test Failed / Waiting for Customer /
 * Delivery to Customer (started), Close (completed), Cancelled. Names are
 * matched after collapsing spaces, underscores and hyphens, so "Re-Open",
 * "re_open" and "reopen" all land on the same label.
 */
function canonicalStatusName(name: string): string {
  const normalized = name.trim().toLowerCase().replace(/[\s_-]+/g, " ");
  const known: Record<string, string> = {
    backlog: "Backlog",
    open: "Backlog",
    todo: "Todo",
    "to do": "Todo",
    unstarted: "Todo",
    triaged: "Triaged",
    triage: "Triaged",
    started: "In Progress",
    "in progress": "In Progress",
    "test failed": "Test Failed",
    "testing failed": "Test Failed",
    "waiting for customer": "Waiting for Customer",
    "waiting customer": "Waiting for Customer",
    "waiting on customer": "Waiting for Customer",
    "delivery to customer": "Delivery to Customer",
    "delivered to customer": "Delivery to Customer",
    delivered: "Delivery to Customer",
    "re open": "Re-Open",
    reopen: "Re-Open",
    reopened: "Re-Open",
    completed: "Done",
    complete: "Done",
    done: "Done",
    resolved: "Done",
    closed: "Done",
    close: "Done",
    cancelled: "Cancelled",
    canceled: "Cancelled",
  };
  return known[normalized] || name.trim();
}

export function mapPlaneStateToTicketStatus(state?: { name?: string; group?: string } | null): string | undefined {
  if (!state) return undefined;
  if (state.name?.trim()) return canonicalStatusName(state.name);

  const groupMap: Record<string, string> = {
    backlog: "Backlog",
    unstarted: "Todo",
    started: "In Progress",
    completed: "Done",
    cancelled: "Cancelled",
    canceled: "Cancelled",
  };
  return state.group ? groupMap[state.group.trim().toLowerCase()] : undefined;
}

export function mapPlanePriorityToTicketPriority(priority?: string | null): string | undefined {
  if (!priority) return undefined;
  const priorityMap: Record<string, string> = {
    urgent: "Urgent",
    high: "High",
    medium: "Medium",
    low: "Low",
    none: "None",
  };
  return priorityMap[priority.trim().toLowerCase()];
}

export function mapTicketPriorityToPlanePriority(priority?: string | null): string | undefined {
  if (!priority) return undefined;
  const priorityMap: Record<string, string> = {
    urgent: "urgent",
    high: "high",
    medium: "medium",
    low: "low",
    none: "none",
    // Legacy P-code aliases
    p1: "urgent",
    p2: "high",
    p3: "medium",
    p4: "low",
    p5: "none",
  };
  return priorityMap[priority.trim().toLowerCase()];
}

export function verifyPlaneWebhookSignature(
  payload: unknown,
  receivedSignature: string | undefined,
  secret: string | undefined
): boolean {
  if (!secret || !receivedSignature || !/^[a-f0-9]{64}$/i.test(receivedSignature)) return false;

  const expected = crypto.createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");
  const receivedBuffer = Buffer.from(receivedSignature, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  return receivedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}

export class PlaneWebhookService {
  private readonly doneNotificationDispatcher: (planeIssueId: string) => Promise<void>;

  /**
   * Per-project state list, so the poller resolves a work item's state id
   * locally instead of one GET /states/{id}/ per ticket per cycle. Plane
   * throttles the API key (429 RATE_LIMIT_EXCEEDED seen live 2026-09-07 at
   * ~40 requests/min); a five-minute cache brings a cycle down to one issue
   * GET per open ticket. Unknown ids (a state added since) refresh the list.
   */
  private readonly statesCache = new Map<string, { at: number; states: Array<{ id?: string; name?: string; group?: string }> }>();
  private static readonly STATES_CACHE_TTL_MS = 5 * 60_000;

  constructor(
    private readonly dbAdapter: DatabaseAdapter,
    private readonly httpClient: Pick<typeof axios, "get"> = axios,
    doneNotificationDispatcher?: (planeIssueId: string) => Promise<void>
  ) {
    this.doneNotificationDispatcher =
      doneNotificationDispatcher || ((planeIssueId) => this.dispatchCustomerDoneNotification(planeIssueId));
  }

  async sync(payload: PlaneWebhookPayload, mappingContext?: PlaneMappingContext): Promise<PlaneWebhookSyncResult> {
    const event = payload.event?.toLowerCase();
    const action = payload.action?.toLowerCase();
    if (
      (event !== "issue" && event !== "work_item" && !event?.includes("updated") && !event?.includes("created") && !event?.includes("deleted")) ||
      (action !== "update" && action !== "create" && action !== "delete" && !event)
    ) {
      return { processed: false, matched: false, reason: "unsupported_event" };
    }

    const data = payload.data;
    const planeIssueId = data?.id;
    if (!data || !planeIssueId) {
      throw new Error("Plane webhook payload is missing data.id");
    }

    const payloadProjectId = typeof data.project === "string" ? data.project : data.project?.id;
    const configuredProjectId = config.PLANE_PROJECT_ID;
    if (
      payloadProjectId &&
      configuredProjectId &&
      configuredProjectId !== "proj_id" &&
      payloadProjectId !== configuredProjectId
    ) {
      // Allow sync if the ticket is already linked in our database
      const isLinked = await pool
        .query("SELECT 1 FROM tickets WHERE plane_issue_id = $1 LIMIT 1", [planeIssueId])
        .then((res) => (res.rowCount || 0) > 0)
        .catch(() => false);

      if (!isLinked) {
        return { processed: false, matched: false, reason: "project_mismatch", planeIssueId };
      }
    }

    if (action === "delete" || event?.includes("delete")) {
      if (!this.dbAdapter.deleteTicketFromPlane) {
        return {
          processed: false,
          matched: false,
          deleted: false,
          reason: "delete_not_supported",
          planeIssueId,
        };
      }
      const deleted = await this.dbAdapter.deleteTicketFromPlane(planeIssueId);
      return {
        processed: true,
        matched: deleted,
        deleted,
        reason: deleted ? undefined : "ticket_not_linked",
        planeIssueId,
      };
    }

    const state = await this.resolveState(data, payloadProjectId || configuredProjectId, mappingContext);
    // Plane can set completed_at on a cancelled work item too. Prefer the
    // explicit state so Cancelled never gets flattened into Done.
    const status = mapPlaneStateToTicketStatus(state) || (data.completed_at ? "Done" : undefined);
    const priority = mapPlanePriorityToTicketPriority(data.priority);
    if (!status && !priority) {
      return { processed: false, matched: false, reason: "no_supported_changes", planeIssueId };
    }

    // Status now goes through the ticket state machine, which owns the
    // asymmetric reverse mapping: Plane "Done" produces TicketX RESOLVED, not
    // CLOSED, and only the customer moves it further. Writing Plane's
    // vocabulary straight into tickets.status - as this did before migration
    // 040 - is what made the customer half of the journey unrepresentable.
    //
    // Priority is unaffected by the two-layer split and still syncs directly.
    let syncResult: { matched: boolean; statusChanged: boolean; previousStatus?: string } = {
      matched: false,
      statusChanged: false,
    };

    let lifecycleResult: Awaited<ReturnType<typeof ticketStateMachine.applyPlaneStatus>> | null = null;

    if (priority) {
      syncResult = await this.dbAdapter.syncTicketFromPlane(planeIssueId, { priority });
    }

    if (status) {
      const ticketRow = await pool
        .query(`SELECT id FROM tickets WHERE plane_issue_id = $1 LIMIT 1`, [planeIssueId])
        .catch(() => null);
      const ticketId = ticketRow?.rows?.[0]?.id;

      if (ticketId) {
        lifecycleResult = await ticketStateMachine.applyPlaneStatus(ticketId, status, {
          source: "plane_webhook",
        });
        syncResult.matched = true;
        syncResult.statusChanged = Boolean(lifecycleResult.applied);
      }
    }

    // Update Plane creator attribution if present
    const creatorName = (data as any)?.created_by_detail?.display_name ||
      (data as any)?.created_by_detail?.first_name ||
      (typeof (data as any)?.created_by === "object" ? ((data as any)?.created_by?.first_name || (data as any)?.created_by?.display_name) : (data as any)?.created_by) ||
      "Plane.io User";

    try {
      await pool.query(
        `UPDATE tickets 
         SET created_by_type = 'PLANE_IO', 
             created_by_name = COALESCE($1, created_by_name, 'Plane.io User') 
         WHERE plane_issue_id = $2 AND (created_by_type IS NULL OR created_by_type = 'CUSTOMER')`,
        [creatorName, planeIssueId]
      );
    } catch (dbErr: any) {
      logger.warn({ error: dbErr.message, planeIssueId }, "Could not update plane creator attribution");
    }

    // B-5: a Plane-side state change is part of the same causal chain. The
    // correlation id is read from the ticket the change lands on, so the
    // reverse-sync hop joins the chain that created the ticket rather than
    // starting a fresh, unconnected one.
    if (lifecycleResult?.applied && lifecycleResult.ticketId) {
      const corr = await pool
        .query(`SELECT correlation_id, project_id, org_id, conversation_id FROM tickets WHERE id = $1`, [
          lifecycleResult.ticketId,
        ])
        .catch(() => null);
      const row = corr?.rows?.[0];
      await traceRecorder.record({
        correlationId: row?.correlation_id || `reverse-sync-${lifecycleResult.ticketId}`,
        component: "reverse_sync",
        eventType: "plane_status_applied",
        ticketId: lifecycleResult.ticketId,
        planeIssueId: planeIssueId,
        conversationId: row?.conversation_id ?? null,
        projectId: row?.project_id ?? null,
        orgId: row?.org_id ?? null,
        detail: { planeStatus: status, notify: lifecycleResult.notify ?? null, eventId: lifecycleResult.eventId ?? null },
      });
    } else if (status || state) {
      // Visible in the database, not only in the terminal: a Plane state that
      // resolved but changed nothing (NO_CHANGE), was rejected by the
      // lifecycle rules, or could not be resolved at all. The 2026-09-07
      // Delivery-to-Customer defect stayed invisible for an hour because the
      // only evidence was a warn line in a console nobody was watching.
      const code = lifecycleResult?.code ?? (status ? "NO_TICKET" : "STATE_UNRESOLVED");
      if (code !== "NO_CHANGE") {
        const t = await pool
          .query(`SELECT id, correlation_id, project_id, org_id, conversation_id FROM tickets WHERE plane_issue_id = $1 LIMIT 1`, [planeIssueId])
          .catch(() => null);
        const row = t?.rows?.[0];
        await traceRecorder.record({
          correlationId: row?.correlation_id || `reverse-sync-${planeIssueId}`,
          component: "reverse_sync",
          eventType: "plane_status_not_applied",
          status: "failed",
          ticketId: row?.id ?? null,
          planeIssueId,
          conversationId: row?.conversation_id ?? null,
          projectId: row?.project_id ?? null,
          orgId: row?.org_id ?? null,
          detail: { planeStatus: status ?? null, rawState: state ?? null, code, reason: lifecycleResult?.reason ?? null },
        });
      }
    }

    // The notification is driven by the lifecycle transition, not by Plane's
    // raw state. Only reaching RESOLVED asks the customer to confirm, so a
    // repeated "Done" on an already-resolved ticket notifies nobody.
    if (lifecycleResult?.applied && lifecycleResult.notify === "resolution_confirmation_request") {
      // Keyed on the transition's ticket_events row, so a repeated "Done"
      // cannot re-notify, while a genuine re-resolution after REOPENED
      // produces a new event and therefore a new notification.
      void this.dispatchResolutionNotification(
        planeIssueId,
        lifecycleResult.ticketId!,
        lifecycleResult.eventId ?? null
      ).catch((err) => {
        logger.error({ error: err.message, planeIssueId }, "Failed to dispatch customer resolution notification");
      });
    }

    return {
      processed: true,
      matched: syncResult.matched,
      reason: syncResult.matched ? undefined : "ticket_not_linked",
      planeIssueId,
      status,
      priority,
    };
  }

  /**
   * Asks the customer to confirm the fix.
   *
   * Replaces a message that announced completion outright. Under the
   * two-layer model Plane reaching Done means engineering finished, not that
   * the customer agrees — so the message invites confirmation, and the ticket
   * stays RESOLVED until the customer acts.
   */
  private async dispatchResolutionNotification(
    planeIssueId: string,
    ticketId: number,
    eventId: number | null
  ): Promise<void> {
    const { rows } = await pool.query(
      `SELECT t.id, t.ticket_number, t.subject, t.conversation_id, t.project_id, t.org_id
         FROM tickets t WHERE t.id = $1 LIMIT 1`,
      [ticketId]
    );
    if (rows.length === 0 || !rows[0].conversation_id) return;
    const ticket = rows[0];

    // Randomized "please test" wording with the [ใช้งานได้แล้ว | ยังมีปัญหาอยู่]
    // chips; the subject tells the customer which fix to test.
    await customerNotificationService.send({
      conversationId: Number(ticket.conversation_id),
      notificationType: "resolution_confirmation",
      idempotencyKey: eventId ? `ticket_event:${eventId}` : `ticket:${ticketId}:resolved`,
      ticketId: Number(ticket.id),
      ticketNumber: ticket.ticket_number,
      subject: ticket.subject ?? null,
      projectId: ticket.project_id ?? null,
      orgId: ticket.org_id ?? null,
      correlationId: planeIssueId,
    });
  }

  private async dispatchCustomerDoneNotification(planeIssueId: string): Promise<void> {
    try {
      const { rows } = await pool.query(
        `SELECT t.id, t.ticket_number, t.subject, t.conversation_id, c.channel, i.channel_ref
         FROM tickets t
         JOIN conversations c ON c.id = t.conversation_id
         JOIN identities i ON i.id = c.identity_id
         WHERE t.plane_issue_id = $1 LIMIT 1`,
        [planeIssueId]
      );

      if (rows.length === 0) return;
      const ticket = rows[0];
      const notificationText = `🎉 Ticket #${ticket.ticket_number || ticket.id} เรื่อง “${ticket.subject}” ดำเนินการเสร็จเรียบร้อยแล้วค่ะ หากยังพบปัญหาอยู่ พิมพ์รายละเอียดเพิ่มเติมกลับมาได้เลยนะคะ`;

      await this.dbAdapter.saveMessage(String(ticket.conversation_id), "ai", notificationText);

      if (ticket.channel === "line" || ticket.channel === "line_group") {
        const token = (config.LINE_CHANNEL_ACCESS_TOKEN || "").trim();
        if (token && ticket.channel_ref && !ticket.channel_ref.startsWith("test_")) {
          await axios.post(
            "https://api.line.me/v2/bot/message/push",
            {
              to: ticket.channel_ref,
              messages: [{ type: "text", text: notificationText }],
            },
            {
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
              },
              timeout: 10000,
            }
          );
        }
      }
    } catch (err: any) {
      logger.error({ error: err.message, planeIssueId }, "Error sending customer Done notification");
    }
  }

  async syncLinkedTicketsFromPlane(batchSize = config.PLANE_REVERSE_SYNC_BATCH_SIZE): Promise<PlaneReverseSyncSummary> {
    const summary: PlaneReverseSyncSummary = { checked: 0, skipped: 0, updated: 0, deleted: 0, unlinked: 0, failed: 0 };

    try {
      const mappingsRes = await pool.query(
        `SELECT project_id, org_id, workspace_slug, plane_project_id, plane_api_base_url, credential_ref
         FROM plane_workspace_mappings
         WHERE enabled = TRUE AND archived_at IS NULL`
      );

      if (!mappingsRes.rows || mappingsRes.rows.length === 0) {
        logger.info("No active Plane project mappings found for reverse sync");
        return summary;
      }

      for (const mapping of mappingsRes.rows) {
        const { project_id, org_id, workspace_slug, plane_project_id, plane_api_base_url, credential_ref } = mapping;

        // Query tickets matching 3-key scope (workspace_slug, plane_project_id, plane_issue_id)
        // Tickets explicitly linked to this Plane project, plus legacy
        // tickets that carry no Plane linkage yet and belong to this
        // project. The previous `OR project_id = $3` had no such guard, so a
        // ticket linked to one Plane project was also polled under every
        // other mapping for the same TicketX project - querying Plane for an
        // issue id that does not exist there, which is a large part of the
        // observed failure count.
        const ticketsRes = await pool.query(
          `SELECT id, plane_issue_id, plane_workspace_slug, plane_project_id, project_id, org_id,
                  ticket_number, plane_last_seen_updated_at
           FROM tickets
           WHERE (
                   (plane_workspace_slug = $1 AND plane_project_id = $2)
                   OR (project_id = $3 AND plane_project_id IS NULL)
                 )
             AND plane_issue_id IS NOT NULL AND plane_issue_id != ''
             AND deleted_at IS NULL
             -- Finished tickets are not polled: every one costs a Plane
             -- request per cycle, and 19 closed/cancelled test tickets were
             -- enough to push the key into 429 throttling (2026-09-07).
             -- Re-Open in Plane on a closed ticket is a rare manual act; it
             -- is picked up when the operator uses the reopen path instead.
             AND UPPER(COALESCE(status, '')) NOT IN ('CLOSED', 'CANCELLED')
           ORDER BY updated_at DESC
           LIMIT $4`,
          [workspace_slug, plane_project_id, project_id, batchSize]
        );

        for (const ticket of ticketsRes.rows) {
          const issueId = ticket.plane_issue_id;
          if (!issueId || String(issueId).startsWith("mock-")) continue;

          summary.checked += 1;
          try {
            const apiBase = (plane_api_base_url || config.PLANE_API_URL || "https://projects.oneweb.tech").replace(/\/+$/, "");
            // /issues/ is the endpoint this Plane instance serves; /work-items/ returned
            // 404 "Page not found" for EVERY id, and the absent-branch below then
            // deleted every successfully synced ticket from the DB (2026-08-27).
            const url = `${apiBase}/api/v1/workspaces/${encodeURIComponent(workspace_slug)}/projects/${encodeURIComponent(plane_project_id)}/issues/${encodeURIComponent(issueId)}/`;
            const apiKey = credential_ref.startsWith("env:") ? (process.env[credential_ref.slice(4)] || config.PLANE_API_KEY) : credential_ref;

            const response = await this.httpClient.get(url, {
              headers: { "X-API-Key": apiKey },
              timeout: 5000,
            });

            // Skip work items Plane has not touched since we last applied
            // them. Without this the poller rewrote every linked ticket on
            // every cycle, producing spurious writes and provoking Plane
            // into throttling the client.
            const remoteUpdatedAtRaw = (response.data as any)?.updated_at;
            const remoteUpdatedAt = remoteUpdatedAtRaw ? new Date(remoteUpdatedAtRaw) : null;
            const lastSeen = ticket.plane_last_seen_updated_at
              ? new Date(ticket.plane_last_seen_updated_at)
              : null;

            if (
              remoteUpdatedAt &&
              !Number.isNaN(remoteUpdatedAt.getTime()) &&
              lastSeen &&
              remoteUpdatedAt.getTime() <= lastSeen.getTime()
            ) {
              summary.skipped += 1;
              continue;
            }

            const syncRes = await this.sync(
              {
                event: "work_item.updated",
                data: {
                  id: issueId,
                  project: plane_project_id,
                  ...response.data,
                },
              },
              {
                workspaceSlug: workspace_slug,
                planeProjectId: plane_project_id,
                apiBaseUrl: apiBase,
                apiKey: apiKey,
              }
            );

            if (syncRes.matched) summary.updated += 1;

            // Record the version we just applied, so the next cycle can skip
            // this item. Written even when nothing matched: the remote
            // version has still been observed, and re-fetching it changes
            // nothing.
            if (remoteUpdatedAt && !Number.isNaN(remoteUpdatedAt.getTime())) {
              await pool.query(
                `UPDATE tickets SET plane_last_seen_updated_at = $1 WHERE id = $2`,
                [remoteUpdatedAt.toISOString(), ticket.id]
              );
            }
          } catch (err: any) {
            const isAbsentOrDeleted =
              err.response?.status === 404 ||
              err.response?.status === 410 ||
              (err.response?.status === 403 &&
                typeof err.response?.data?.detail === "string" &&
                (err.response.data.detail.includes("permission to view this workitem") ||
                  err.response.data.detail.includes("not found")));

            if (isAbsentOrDeleted) {
              try {
                const deleted = this.dbAdapter.deleteTicketFromPlane
                  ? await this.dbAdapter.deleteTicketFromPlane(issueId)
                  : false;
                if (deleted) {
                  summary.deleted += 1;
                  logger.info({ issueId, ticketId: ticket.id, ticketNumber: ticket.ticket_number }, "Deleted ticket from DB because Plane work item was removed (404/403 absent)");
                } else {
                  summary.unlinked += 1;
                }
              } catch (delErr: any) {
                logger.error({ error: delErr.message, issueId }, "Failed to delete ticket from DB on Plane 404/403 absent");
                summary.failed += 1;
              }
            } else if (err.response?.status === 429) {
              // Plane is throttling us. Continuing through the remaining
              // items guarantees more 429s and deepens the throttle, so the
              // cycle stops here and the poller waits before trying again.
              const retryAfter = Number(err.response?.headers?.["retry-after"]);
              summary.rateLimited = true;
              summary.retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0
                ? Math.min(retryAfter * 1000, 300_000)
                : 60_000;
              logger.warn(
                { issueId, retryAfterMs: summary.retryAfterMs },
                "Plane rate-limited reverse sync; stopping this cycle early"
              );
              return summary;
            } else {
              summary.failed += 1;
              // The failure count used to be reported with no indication of
              // why, so a poller degrading under rate limiting looked
              // identical to one hitting bad credentials.
              logger.warn(
                {
                  issueId,
                  ticketId: ticket.id,
                  ticketNumber: ticket.ticket_number,
                  workspaceSlug: workspace_slug,
                  planeProjectId: plane_project_id,
                  status: err.response?.status,
                  error: err.message,
                },
                "Plane reverse sync failed for work item"
              );
            }
          }
        }
      }
    } catch (err: any) {
      logger.error({ error: err.message }, "Failed to execute multi-project reverse sync query");
    }

    return summary;
  }

  private async resolveState(
    data: NonNullable<PlaneWebhookPayload["data"]>,
    projectId?: string,
    mappingContext?: PlaneMappingContext
  ): Promise<{ name?: string; group?: string } | undefined> {
    if (data.state_detail) return data.state_detail;
    if (typeof data.state === "object" && data.state) return data.state;
    if (data.state_name || data.state_group) {
      return { name: data.state_name || undefined, group: data.state_group || undefined };
    }
    if (!data.state || typeof data.state !== "string") return undefined;

    let ws = mappingContext?.workspaceSlug;
    let proj = mappingContext?.planeProjectId || projectId;
    let apiBase = mappingContext?.apiBaseUrl;
    let apiKey = mappingContext?.apiKey;

    // Look up mapping from database if context is missing
    if (!ws || !apiKey) {
      try {
        const mappingRes = await pool.query(
          `SELECT workspace_slug, plane_project_id, plane_api_base_url, credential_ref
           FROM plane_workspace_mappings
           WHERE (plane_project_id = $1 OR workspace_slug = $2) AND enabled = TRUE
           LIMIT 1`,
          [proj || "", ws || ""]
        );
        if (mappingRes.rows.length > 0) {
          const row = mappingRes.rows[0];
          ws = ws || row.workspace_slug;
          proj = proj || row.plane_project_id;
          apiBase = apiBase || row.plane_api_base_url;
          const ref = row.credential_ref;
          if (ref) {
            apiKey = apiKey || (ref.startsWith("env:") ? process.env[ref.slice(4)] : ref);
          }
        }
      } catch {
        // ignore and fallback
      }
    }

    ws = ws || config.PLANE_WORKSPACE_SLUG;
    proj = proj || config.PLANE_PROJECT_ID;
    apiBase = (apiBase || config.PLANE_API_URL || "https://projects.oneweb.tech").replace(/\/+$/, "");
    apiKey = apiKey || config.PLANE_API_KEY;

    if (
      !apiKey ||
      apiKey === "plane_mock_key" ||
      !proj ||
      proj === "proj_id" ||
      !ws ||
      ws === "ws_id"
    ) {
      throw new Error("Plane state lookup is not configured");
    }

    // Cached project state list first (one request per project per five
    // minutes), the single-state endpoint only when the id is unknown there.
    const cacheKey = `${apiBase}|${ws}|${proj}`;
    const lookup = (states: Array<{ id?: string; name?: string; group?: string }>) =>
      states.find((s) => String(s.id || "") === String(data.state));
    const cached = this.statesCache.get(cacheKey);
    if (cached && Date.now() - cached.at < PlaneWebhookService.STATES_CACHE_TTL_MS) {
      const hit = lookup(cached.states);
      if (hit) return { name: hit.name, group: hit.group };
    }
    try {
      const listUrl = `${apiBase}/api/v1/workspaces/${encodeURIComponent(ws)}/projects/${encodeURIComponent(proj)}/states/`;
      const listRes = await this.httpClient.get(listUrl, { headers: { "X-API-Key": apiKey }, timeout: 5000 });
      const raw = listRes.data;
      const states: Array<{ id?: string; name?: string; group?: string }> = Array.isArray(raw) ? raw : Array.isArray(raw?.results) ? raw.results : [];
      if (states.length) {
        this.statesCache.set(cacheKey, { at: Date.now(), states });
        const hit = lookup(states);
        if (hit) return { name: hit.name, group: hit.group };
      }
    } catch (listErr: any) {
      if (listErr?.response?.status === 429) throw listErr;
      logger.warn({ error: listErr.message, ws, proj }, "Plane state list fetch failed; falling back to single-state lookup");
    }

    const url = `${apiBase}/api/v1/workspaces/${encodeURIComponent(ws)}/projects/${encodeURIComponent(proj)}/states/${encodeURIComponent(data.state)}/`;
    const response = await this.httpClient.get(url, {
      headers: { "X-API-Key": apiKey },
      timeout: 5000,
    });
    const resolved = { name: response.data?.name, group: response.data?.group };
    if (!resolved.name && !resolved.group) {
      logger.warn(
        { stateId: data.state, ws, proj, keys: response.data ? Object.keys(response.data).slice(0, 8) : null },
        "Plane state lookup returned no name/group; status will not sync"
      );
    }
    return resolved;
  }
}
