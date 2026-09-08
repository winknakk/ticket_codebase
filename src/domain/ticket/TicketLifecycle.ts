/**
 * The TicketX customer lifecycle, and its mapping to Plane's engineering
 * workflow.
 *
 * Two layers, deliberately not collapsed:
 *
 *   TicketX owns the CUSTOMER lifecycle  - confirmation, reopening, the
 *                                          customer-facing status, SLA
 *   Plane   owns the ENGINEERING state   - progress and completion
 *
 * The mapping is intentionally asymmetric. Plane reaching "Done" means
 * engineering finished the work; it does not mean the customer agrees the
 * problem is solved. So Done maps to RESOLVED, never to CLOSED, and only the
 * customer can move a ticket past RESOLVED.
 */

export const TICKET_LIFECYCLE_STATUSES = [
  "NEW",
  "TRIAGED",
  "OPEN",
  "IN_PROGRESS",
  "WAITING_CUSTOMER",
  "WAITING_INTERNAL",
  "RESOLVED",
  "CUSTOMER_CONFIRMED",
  "CLOSED",
  "REOPENED",
  "CANCELLED",
] as const;

export type TicketLifecycleStatus = (typeof TICKET_LIFECYCLE_STATUSES)[number];

/**
 * The Plane state labels TicketX writes (stored in tickets.plane_status and
 * used to pick the target Plane state by name, with group fallbacks).
 * "Open" and "Done" remain for older rows; new writes use the Excise
 * project's vocabulary.
 */
export const PLANE_STATUSES = [
  "Backlog",
  "Triaged",
  "Open",
  "In Progress",
  "Waiting for Customer",
  "Delivery to Customer",
  "Re-Open",
  "Done",
  "Close",
  "Cancelled",
] as const;
export type PlaneStatus = (typeof PLANE_STATUSES)[number];

/** Who is attempting a transition. Authorization differs per actor. */
export type TransitionActor = "customer" | "operator" | "plane" | "system";

export function isLifecycleStatus(value: unknown): value is TicketLifecycleStatus {
  return typeof value === "string" && (TICKET_LIFECYCLE_STATUSES as readonly string[]).includes(value);
}

/**
 * Statuses from which no further work is expected. RESOLVED is deliberately
 * NOT terminal: it is waiting on the customer.
 */
export const TERMINAL_STATUSES: readonly TicketLifecycleStatus[] = ["CLOSED", "CANCELLED"];

export function isTerminal(status: TicketLifecycleStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

// ---------------------------------------------------------------------------
// Forward mapping: TicketX lifecycle -> Plane engineering state
// ---------------------------------------------------------------------------

const LIFECYCLE_TO_PLANE: Record<TicketLifecycleStatus, PlaneStatus> = {
  NEW: "Backlog",
  TRIAGED: "Triaged",
  OPEN: "In Progress",
  IN_PROGRESS: "In Progress",
  WAITING_CUSTOMER: "Waiting for Customer",
  WAITING_INTERNAL: "In Progress",
  // Engineering hands the fix to the customer; the customer's confirmation
  // (not Plane) is what moves the ticket on to Close.
  RESOLVED: "Delivery to Customer",
  // The close question is still pending: Plane keeps showing Delivery until
  // the customer presses "ยืนยันปิดเคส".
  CUSTOMER_CONFIRMED: "Delivery to Customer",
  CLOSED: "Close",
  REOPENED: "Re-Open",
  CANCELLED: "Cancelled",
};

export function lifecycleToPlaneStatus(status: TicketLifecycleStatus): PlaneStatus {
  return LIFECYCLE_TO_PLANE[status];
}

/**
 * Whether a lifecycle transition needs to be pushed to Plane at all.
 *
 * Returns false when the Plane state would not change. Re-sending Done
 * because the customer confirmed, or because the ticket closed, is a no-op
 * write and is exactly the status ping-pong this design exists to avoid.
 */
export function shouldPushToPlane(from: TicketLifecycleStatus, to: TicketLifecycleStatus): boolean {
  return LIFECYCLE_TO_PLANE[from] !== LIFECYCLE_TO_PLANE[to];
}

// ---------------------------------------------------------------------------
// Reverse mapping: Plane engineering state -> TicketX lifecycle
// ---------------------------------------------------------------------------

/**
 * Plane emits more states than TicketX writes (Todo, In Progress, Started,
 * Backlog...), so the reverse direction normalises a wider vocabulary.
 *
 * Returns null when Plane's state implies no lifecycle change, which is what
 * keeps an unchanged remote state from generating a write.
 */
export function planeStatusToLifecycle(
  planeStatus: string | null | undefined,
  current: TicketLifecycleStatus
): TicketLifecycleStatus | null {
  const normalized = String(planeStatus || "").trim().toLowerCase();

  switch (normalized) {
    case "backlog":
      // Only meaningful as an advance out of NEW. A ticket already being
      // worked is not dragged backwards because Plane says Backlog.
      return current === "NEW" ? "TRIAGED" : null;

    case "todo":
    case "to do":
    case "unstarted":
    case "triaged":
      // Only an advance out of NEW; an already-triaged or active ticket is
      // never dragged back.
      return current === "NEW" ? "TRIAGED" : null;

    case "open":
    case "in progress":
    case "in_progress":
    case "started":
    case "test failed":
      // Engineering picking the work up (or a failed test sending it back to
      // the bench — still "being fixed" from the customer's point of view).
      // Never overrides a state that is waiting on a person, except when the
      // work explicitly resumes from Waiting for Customer via Plane.
      if (current === "WAITING_INTERNAL") return null;
      if (current === "WAITING_CUSTOMER") return normalized === "test failed" ? null : "IN_PROGRESS";
      return current === "IN_PROGRESS" ? null : "IN_PROGRESS";

    case "waiting for customer":
    case "waiting_customer":
      if (current === "WAITING_CUSTOMER") return null;
      if (current === "RESOLVED" || current === "CUSTOMER_CONFIRMED" || current === "CLOSED" || current === "CANCELLED") return null;
      return "WAITING_CUSTOMER";

    case "re-open":
    case "re open":
    case "reopen":
    case "reopened":
      // Engineering found the problem is back (or the customer did, via
      // Plane). Only meaningful from a finished state; an active ticket is
      // already open.
      if (current === "RESOLVED" || current === "CUSTOMER_CONFIRMED" || current === "CLOSED" || current === "CANCELLED") return "REOPENED";
      return null;

    case "done":
    case "completed":
    case "complete":
    case "close":
    case "delivery to customer":
      // THE critical asymmetry: engineering finishing (Delivery to Customer,
      // or Close set by hand) is not the customer agreeing. It produces
      // RESOLVED, and the customer alone moves it on.
      if (current === "RESOLVED" || current === "CUSTOMER_CONFIRMED" || current === "CLOSED") return null;
      return "RESOLVED";

    case "cancelled":
    case "canceled":
      return current === "CANCELLED" ? null : "CANCELLED";

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Transition rules
// ---------------------------------------------------------------------------

const ALLOWED_TRANSITIONS: Record<TicketLifecycleStatus, readonly TicketLifecycleStatus[]> = {
  // Engineering may deliver (or park on the customer) straight from Backlog /
  // Triaged without ever pressing In Progress — seen live 2026-09-07: EXAI-67
  // moved Triaged → Delivery to Customer and the poller rejected it every
  // 30 s, so the customer never got the "please test" message.
  NEW: ["TRIAGED", "OPEN", "IN_PROGRESS", "WAITING_CUSTOMER", "RESOLVED", "CANCELLED"],
  TRIAGED: ["OPEN", "IN_PROGRESS", "WAITING_CUSTOMER", "WAITING_INTERNAL", "RESOLVED", "CANCELLED"],
  OPEN: ["IN_PROGRESS", "WAITING_CUSTOMER", "WAITING_INTERNAL", "RESOLVED", "CANCELLED"],
  IN_PROGRESS: ["WAITING_CUSTOMER", "WAITING_INTERNAL", "RESOLVED", "CANCELLED"],
  WAITING_CUSTOMER: ["IN_PROGRESS", "RESOLVED", "CANCELLED"],
  WAITING_INTERNAL: ["IN_PROGRESS", "RESOLVED", "CANCELLED"],
  // Only the customer leaves RESOLVED.
  RESOLVED: ["CUSTOMER_CONFIRMED", "REOPENED"],
  // CUSTOMER_CONFIRMED = "the customer said it works; the close question is
  // pending" (two-step close, 2026-09-07). It resolves to CLOSED on the
  // confirmation chip, to REOPENED if the customer changes their mind, or back
  // to RESOLVED if they decline to close for now.
  CUSTOMER_CONFIRMED: ["CLOSED", "REOPENED", "RESOLVED"],
  CLOSED: ["REOPENED"],
  // Engineering may deliver straight from Re-Open (Plane: Re-Open → Delivery
  // to Customer) without passing through In Progress first.
  REOPENED: ["IN_PROGRESS", "WAITING_CUSTOMER", "RESOLVED", "CANCELLED"],
  CANCELLED: ["REOPENED"],
};

/**
 * Transitions each actor may perform, as "FROM->TO".
 *
 * Plane is deliberately absent from anything past RESOLVED: reverse sync
 * cannot confirm or close on the customer's behalf, which is what stops Done
 * from silently closing a ticket.
 */
const ACTOR_TRANSITIONS: Record<TransitionActor, readonly string[]> = {
  customer: [
    "RESOLVED->CUSTOMER_CONFIRMED",
    "RESOLVED->REOPENED",
    "CUSTOMER_CONFIRMED->CLOSED",
    "CUSTOMER_CONFIRMED->REOPENED",
    "CUSTOMER_CONFIRMED->RESOLVED",
    "CLOSED->REOPENED",
    "WAITING_CUSTOMER->IN_PROGRESS",
  ],
  plane: [
    "NEW->TRIAGED",
    "NEW->IN_PROGRESS",
    "TRIAGED->IN_PROGRESS",
    "OPEN->IN_PROGRESS",
    "REOPENED->IN_PROGRESS",
    "WAITING_CUSTOMER->IN_PROGRESS",
    "NEW->RESOLVED",
    "TRIAGED->RESOLVED",
    "OPEN->RESOLVED",
    "IN_PROGRESS->RESOLVED",
    "WAITING_CUSTOMER->RESOLVED",
    "WAITING_INTERNAL->RESOLVED",
    "REOPENED->RESOLVED",
    // "Waiting for Customer" state in Plane.
    "NEW->WAITING_CUSTOMER",
    "TRIAGED->WAITING_CUSTOMER",
    "OPEN->WAITING_CUSTOMER",
    "IN_PROGRESS->WAITING_CUSTOMER",
    "REOPENED->WAITING_CUSTOMER",
    // "Re-Open" state in Plane (operator decision 2026-09-07): engineering may
    // reopen a finished ticket. This only ever ADDS work — it can still not
    // confirm or close on the customer's behalf.
    "RESOLVED->REOPENED",
    "CLOSED->REOPENED",
    "CANCELLED->REOPENED",
    "NEW->CANCELLED",
    "TRIAGED->CANCELLED",
    "OPEN->CANCELLED",
    "IN_PROGRESS->CANCELLED",
    "WAITING_CUSTOMER->CANCELLED",
    "WAITING_INTERNAL->CANCELLED",
    "REOPENED->CANCELLED",
  ],
  // Operators and the system may perform any structurally valid transition.
  operator: ["*"],
  system: ["*"],
};

export interface TransitionCheck {
  allowed: boolean;
  reason?: string;
  code?: "INVALID_TRANSITION" | "ACTOR_NOT_PERMITTED" | "UNKNOWN_STATUS" | "NO_OP";
}

/**
 * Whether an actor may move a ticket from one status to another.
 *
 * Both checks matter: the transition has to be structurally valid *and* the
 * actor has to be allowed to make it. Plane can drive a ticket to RESOLVED
 * but not to CUSTOMER_CONFIRMED, even though that edge exists.
 */
export function canTransition(
  from: TicketLifecycleStatus,
  to: TicketLifecycleStatus,
  actor: TransitionActor
): TransitionCheck {
  if (!isLifecycleStatus(from) || !isLifecycleStatus(to)) {
    return { allowed: false, code: "UNKNOWN_STATUS", reason: `Unknown status in ${from} -> ${to}` };
  }

  if (from === to) {
    return { allowed: false, code: "NO_OP", reason: `Ticket is already ${to}` };
  }

  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    return {
      allowed: false,
      code: "INVALID_TRANSITION",
      reason: `${from} -> ${to} is not a valid transition`,
    };
  }

  const permitted = ACTOR_TRANSITIONS[actor];
  if (!permitted) {
    return { allowed: false, code: "ACTOR_NOT_PERMITTED", reason: `Unknown actor '${actor}'` };
  }
  if (permitted.includes("*") || permitted.includes(`${from}->${to}`)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    code: "ACTOR_NOT_PERMITTED",
    reason: `Actor '${actor}' may not perform ${from} -> ${to}`,
  };
}

/** Valid next states for a ticket, for UI and API affordances. */
export function nextStatuses(
  from: TicketLifecycleStatus,
  actor: TransitionActor
): TicketLifecycleStatus[] {
  return ALLOWED_TRANSITIONS[from].filter((to) => canTransition(from, to, actor).allowed);
}

/**
 * Whether reaching a status should notify the customer, and with what intent.
 * Returns null when there is no customer-facing message.
 */
export function customerNotificationFor(
  to: TicketLifecycleStatus
): "resolution_confirmation_request" | "closed" | "reopened" | null {
  switch (to) {
    case "RESOLVED":
      return "resolution_confirmation_request";
    case "CLOSED":
      return "closed";
    case "REOPENED":
      return "reopened";
    default:
      return null;
  }
}
