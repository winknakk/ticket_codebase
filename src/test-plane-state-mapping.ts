/**
 * Pure checks for the Excise Plane state vocabulary (2026-09-07):
 * name canonicalisation, inbound lifecycle mapping, plane-actor permissions,
 * and outbound state selection against the project's real state list.
 * No database, no network: `npx tsx src/test-plane-state-mapping.ts`.
 */
import assert from "node:assert/strict";
import { mapPlaneStateToTicketStatus } from "./services/planeWebhookService";
import { planeStatusToLifecycle, lifecycleToPlaneStatus, canTransition } from "./domain/ticket/TicketLifecycle";
import {
  selectPlaneStateForTicketStatus,
  selectPlaneReopenState,
  selectPlaneDeliveryState,
  selectPlaneTriagedState,
} from "./services/planeService";

// --- 1. Plane name -> canonical label (what applyPlaneStatus receives) ---
const canon = (name: string, group?: string) => mapPlaneStateToTicketStatus({ name, group });
assert.equal(canon("Close", "completed"), "Done", "Close must be understood as the completed label");
assert.equal(canon("Re-Open", "backlog"), "Re-Open");
assert.equal(canon("re_open"), "Re-Open");
assert.equal(canon("Delivery to Customer", "started"), "Delivery to Customer");
assert.equal(canon("Test Failed", "started"), "Test Failed");
assert.equal(canon("Triaged", "unstarted"), "Triaged");
assert.equal(canon("Todo", "unstarted"), "Todo");
assert.equal(canon("Waiting for Customer", "started"), "Waiting for Customer");
assert.equal(canon("Cancelled", "cancelled"), "Cancelled");
assert.equal(mapPlaneStateToTicketStatus({ group: "completed" }), "Done", "group-only payloads still map");

// --- 2. Inbound lifecycle mapping (label is lower-cased inside) ---
const L = (label: string, current: any) => planeStatusToLifecycle(label, current);
assert.equal(L("Backlog", "NEW"), "TRIAGED");
assert.equal(L("Triaged", "NEW"), "TRIAGED");
assert.equal(L("Triaged", "IN_PROGRESS"), null, "never dragged backwards");
assert.equal(L("In Progress", "TRIAGED"), "IN_PROGRESS");
assert.equal(L("Test Failed", "TRIAGED"), "IN_PROGRESS");
assert.equal(L("Test Failed", "IN_PROGRESS"), null, "already being fixed");
assert.equal(L("Test Failed", "WAITING_CUSTOMER"), null, "a failed test does not pull the ticket off the customer");
assert.equal(L("In Progress", "WAITING_CUSTOMER"), "IN_PROGRESS", "work explicitly resumed");
assert.equal(L("Waiting for Customer", "IN_PROGRESS"), "WAITING_CUSTOMER");
assert.equal(L("Waiting for Customer", "RESOLVED"), null);
assert.equal(L("Delivery to Customer", "IN_PROGRESS"), "RESOLVED", "delivery asks the customer to confirm");
assert.equal(L("Delivery to Customer", "RESOLVED"), null);
assert.equal(L("Done", "IN_PROGRESS"), "RESOLVED", "Close arrives as the Done label");
assert.equal(L("Done", "CLOSED"), null, "Close on a closed ticket is a no-op");
assert.equal(L("Re-Open", "CLOSED"), "REOPENED");
assert.equal(L("Re-Open", "RESOLVED"), "REOPENED");
assert.equal(L("Re-Open", "CANCELLED"), "REOPENED");
assert.equal(L("Re-Open", "IN_PROGRESS"), null, "an active ticket is already open");
assert.equal(L("Cancelled", "IN_PROGRESS"), "CANCELLED");

// --- 3. Plane may now reopen (operator decision) but still never confirms/closes ---
assert.equal(canTransition("CLOSED", "REOPENED", "plane").allowed, true);
assert.equal(canTransition("RESOLVED", "REOPENED", "plane").allowed, true);
assert.equal(canTransition("CANCELLED", "REOPENED", "plane").allowed, true);
assert.equal(canTransition("RESOLVED", "CUSTOMER_CONFIRMED", "plane").allowed, false, "only the customer confirms");
assert.equal(canTransition("CUSTOMER_CONFIRMED", "CLOSED", "plane").allowed, false, "only the customer/system closes");
assert.equal(canTransition("CUSTOMER_CONFIRMED", "CLOSED", "customer").allowed, true, "the confirmation chip closes");
assert.equal(canTransition("CUSTOMER_CONFIRMED", "RESOLVED", "customer").allowed, true, "declining the close question goes back to waiting");
assert.equal(canTransition("CUSTOMER_CONFIRMED", "REOPENED", "customer").allowed, true);
assert.equal(lifecycleToPlaneStatus("CUSTOMER_CONFIRMED"), "Delivery to Customer");
assert.equal(canTransition("IN_PROGRESS", "WAITING_CUSTOMER", "plane").allowed, true);
// Live defect 2026-09-07 (EXAI-67): Triaged → Delivery to Customer must be accepted.
for (const from of ["NEW", "TRIAGED", "REOPENED"] as const) {
  assert.equal(L("Delivery to Customer", from), "RESOLVED", `${from} → Delivery maps to RESOLVED`);
  assert.equal(canTransition(from, "RESOLVED", "plane").allowed, true, `plane may deliver from ${from}`);
  assert.equal(canTransition(from, "WAITING_CUSTOMER", "plane").allowed, true, `plane may park on the customer from ${from}`);
}
assert.equal(canTransition("WAITING_CUSTOMER", "IN_PROGRESS", "plane").allowed, true);

// --- 4. Outbound labels ---
assert.equal(lifecycleToPlaneStatus("REOPENED"), "Re-Open");
assert.equal(lifecycleToPlaneStatus("RESOLVED"), "Delivery to Customer");
assert.equal(lifecycleToPlaneStatus("CLOSED"), "Close");
assert.equal(lifecycleToPlaneStatus("TRIAGED"), "Triaged");
assert.equal(lifecycleToPlaneStatus("WAITING_CUSTOMER"), "Waiting for Customer");

// --- 5. Outbound state selection against the real Excise list (after rename + addition) ---
const S = (name: string, group: string) => ({ id: name.toLowerCase().replace(/\W+/g, "-"), name, group });
const excise = [
  S("Backlog", "backlog"), S("Re-Open", "backlog"), S("Triaged", "unstarted"),
  S("In Progress", "started"), S("Test Failed", "started"), S("Waiting for Customer", "started"), S("Delivery to Customer", "started"),
  S("Close", "completed"), S("Cancelled", "cancelled"),
];
const pick = (status: string) => selectPlaneStateForTicketStatus(excise as any, status)?.name;
assert.equal(pick("NEW"), "Backlog");
assert.equal(pick("TRIAGED"), "Triaged");
assert.equal(pick("IN_PROGRESS"), "In Progress");
assert.equal(pick("WAITING_CUSTOMER"), "Waiting for Customer");
assert.equal(pick("WAITING_INTERNAL"), "In Progress");
assert.equal(pick("RESOLVED"), "Delivery to Customer");
assert.equal(pick("Delivery to Customer"), "Delivery to Customer");
assert.equal(pick("CUSTOMER_CONFIRMED"), "Delivery to Customer", "pending close question must not show Close in Plane");
assert.equal(pick("CLOSED"), "Close");
assert.equal(pick("Close"), "Close");
assert.equal(pick("Done"), "Close", "legacy Done label still lands on the completed state");
assert.equal(pick("REOPENED"), "Re-Open");
assert.equal(pick("Re-Open"), "Re-Open");
assert.equal(pick("CANCELLED"), "Cancelled");
assert.equal(pick("Test Failed"), "Test Failed");

// Fallbacks for a project that still has the old vocabulary (Backlog/Todo/In Progress/Done/Cancelled)
const legacy = [S("Backlog", "backlog"), S("Todo", "unstarted"), S("In Progress", "started"), S("Done", "completed"), S("Cancelled", "cancelled")];
const pickLegacy = (status: string) => selectPlaneStateForTicketStatus(legacy as any, status)?.name;
assert.equal(pickLegacy("REOPENED"), "Backlog", "no Re-Open state -> Backlog");
assert.equal(pickLegacy("RESOLVED"), "Done", "no Delivery state -> completed");
assert.equal(pickLegacy("TRIAGED"), "Todo", "no Triaged state -> unstarted");
assert.equal(pickLegacy("WAITING_CUSTOMER"), "In Progress", "no Waiting state -> started");
assert.equal(selectPlaneReopenState(legacy as any)?.name, "Backlog");
assert.equal(selectPlaneDeliveryState(legacy as any)?.name, "Done");
assert.equal(selectPlaneTriagedState(excise as any)?.name, "Triaged");

console.log("Plane state mapping tests passed (Excise vocabulary + legacy fallbacks).");
