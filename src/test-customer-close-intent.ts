/**
 * Pure checks for the two-step close protocol (2026-09-07): close-intent
 * detection, the delivery-answer detector it sits beside, and the lifecycle
 * edges the handler walks. No database, no network:
 * `npx tsx src/test-customer-close-intent.ts`.
 */
import assert from "node:assert/strict";
import { detectCloseIntent, detectConfirmationIntent } from "./domain/ticket/CustomerConfirmation";
import { canTransition, lifecycleToPlaneStatus } from "./domain/ticket/TicketLifecycle";
import { CustomerNotificationService } from "./services/CustomerNotificationService";

const N = "TCK-2026-02482";

// --- 1. Explicit close confirmation (the chip and its typed forms) ---
assert.deepEqual(detectCloseIntent(`ยืนยันปิดเคส ${N}`), { kind: "CONFIRM_CLOSE", ticketNumber: N });
assert.deepEqual(detectCloseIntent("ยืนยันปิดเคส"), { kind: "CONFIRM_CLOSE", ticketNumber: null });
assert.deepEqual(detectCloseIntent("ยืนยันปิดเคสค่ะ"), { kind: "CONFIRM_CLOSE", ticketNumber: null });
assert.deepEqual(detectCloseIntent(`ยืนยัน ปิดเคส ${N} ครับ`), { kind: "CONFIRM_CLOSE", ticketNumber: N });
assert.equal(detectCloseIntent("ยืนยัน").kind, "NONE", "a bare ยืนยัน outside the close question is the AI's create confirmation");
assert.equal(detectCloseIntent("ยืนยัน", true).kind, "CONFIRM_CLOSE", "…but right after the close question it closes");
assert.equal(detectCloseIntent("ใช่ค่ะ", true).kind, "CONFIRM_CLOSE");
assert.equal(detectCloseIntent("ปิดได้เลยค่ะ", true).kind, "CONFIRM_CLOSE");
assert.equal(detectCloseIntent("โอเค", false).kind, "NONE");

// --- 2. Declining the close question ---
assert.equal(detectCloseIntent("ยังไม่ปิด", true).kind, "DECLINE_CLOSE");
assert.equal(detectCloseIntent("อย่าเพิ่งปิดนะคะ", true).kind, "DECLINE_CLOSE");
assert.equal(detectCloseIntent("ยกเลิก", true).kind, "DECLINE_CLOSE");
assert.equal(detectCloseIntent("ขอลองก่อนครับ", true).kind, "DECLINE_CLOSE");
assert.equal(detectCloseIntent("ยกเลิก", false).kind, "NONE", "ยกเลิก outside the question belongs to the AI (cancel create)");

// --- 3. Close requests (menu chip, typed, with or without a number) ---
assert.deepEqual(detectCloseIntent("ปิดเคส"), { kind: "CLOSE_REQUEST", ticketNumber: null });
assert.deepEqual(detectCloseIntent("ขอปิดเคสหน่อยค่ะ"), { kind: "CLOSE_REQUEST", ticketNumber: null });
assert.deepEqual(detectCloseIntent(`ปิดเคส ${N}`), { kind: "CLOSE_REQUEST", ticketNumber: N });
assert.deepEqual(detectCloseIntent(`รบกวนปิดเคส ${N} ให้หน่อยครับ`), { kind: "CLOSE_REQUEST", ticketNumber: N });
assert.deepEqual(detectCloseIntent(`ปิดเคสให้หน่อย เคส ${N} นะคะ`), { kind: "CLOSE_REQUEST", ticketNumber: N });
assert.deepEqual(detectCloseIntent("close ticket"), { kind: "CLOSE_REQUEST", ticketNumber: null });
assert.equal(detectCloseIntent("ปิดเคสไม่ได้ครับ ระบบขึ้น error").kind, "NONE", "a report that mentions closing is not a close request");
assert.equal(detectCloseIntent("ทำไมเคสยังไม่ปิด").kind, "NONE");
assert.equal(detectCloseIntent(`${N} ครับ`, true).kind, "CLOSE_REQUEST", "a bare number answers the which-case list");
assert.equal(detectCloseIntent(`${N} ครับ`, false).kind, "NONE", "…but is a status lookup otherwise (AI path)");

// --- 4. Delivery answers still detected; chips carry the number ---
assert.equal(detectConfirmationIntent(`ใช้งานได้แล้ว ${N}`), "CONFIRMED");
assert.equal(detectConfirmationIntent(`ยังมีปัญหาอยู่ ${N}`), "REJECTED");
assert.equal(detectCloseIntent(`ใช้งานได้แล้ว ${N}`).ticketNumber, N);

// --- 5. Lifecycle edges the handler walks ---
assert.equal(canTransition("RESOLVED", "CUSTOMER_CONFIRMED", "customer").allowed, true);
assert.equal(canTransition("CUSTOMER_CONFIRMED", "CLOSED", "customer").allowed, true);
assert.equal(canTransition("CUSTOMER_CONFIRMED", "RESOLVED", "customer").allowed, true);
assert.equal(canTransition("CUSTOMER_CONFIRMED", "REOPENED", "customer").allowed, true);
assert.equal(canTransition("REOPENED", "RESOLVED", "plane").allowed, true, "Re-Open → Delivery to Customer in Plane");
assert.equal(canTransition("IN_PROGRESS", "RESOLVED", "system").allowed, true);
assert.equal(lifecycleToPlaneStatus("CUSTOMER_CONFIRMED"), "Delivery to Customer", "Plane must not show Close before the button");
assert.equal(lifecycleToPlaneStatus("CLOSED"), "Close");

// --- 6. Chips: never a bare "ยืนยัน", always the case number ---
const closeChips = CustomerNotificationService.defaultQuickReplies("close_confirmation_request", N);
assert.deepEqual(closeChips.map((c) => c.text), [`ยืนยันปิดเคส ${N}`, "ยังไม่ปิด", `ยังมีปัญหาอยู่ ${N}`]);
assert.ok(closeChips.every((c) => c.label.length <= 20), "LINE caps quick-reply labels at 20 characters");
const deliveryChips = CustomerNotificationService.defaultQuickReplies("resolution_confirmation", N);
assert.deepEqual(deliveryChips.map((c) => c.text), [`ใช้งานได้แล้ว ${N}`, `ยังมีปัญหาอยู่ ${N}`]);
assert.deepEqual(CustomerNotificationService.defaultQuickReplies("closed", N), []);
// Every chip is recognised in the context it is shown in (the close question is pending).
for (const chip of [...closeChips, ...deliveryChips]) {
  const recognised = detectCloseIntent(chip.text, true).kind !== "NONE" || detectConfirmationIntent(chip.text) !== "NONE";
  assert.equal(recognised, true, `chip "${chip.text}" must be recognised`);
}
assert.equal(detectCloseIntent(`ยังมีปัญหาอยู่ ${N}`, true).kind, "NONE", "the reopen chip is a delivery answer, not a close-protocol word");
assert.equal(detectConfirmationIntent("ยังไม่ปิด"), "NONE", "declining to close is not a rejection of the fix");

console.log("Customer close-intent tests passed (two-step close protocol).");
