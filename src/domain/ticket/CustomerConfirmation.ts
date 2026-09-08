/**
 * Recognises a customer's answer to a resolution-confirmation request.
 *
 * Scope is deliberately narrow. This only runs when a ticket is already
 * RESOLVED and is waiting on the customer, so the question being answered is
 * known: "does it work now?". That makes deterministic matching appropriate
 * and safe — there is no need to involve the LLM to close a ticket, and doing
 * so would let customer text drive a state transition.
 *
 * Ambiguity resolves to NONE, never to CONFIRMED. Closing a ticket the
 * customer did not agree to close is the expensive mistake; asking again is
 * cheap.
 */

export type ConfirmationIntent = "CONFIRMED" | "REJECTED" | "NONE";

/**
 * Negation markers. Checked first: "ใช้งานได้แล้ว" and "ยังใช้งานไม่ได้"
 * share most of their characters, so a positive-first match would read the
 * rejection as a confirmation.
 */
const REJECTION_MARKERS = [
  "ยังไม่ได้",
  "ยังใช้ไม่ได้",
  "ยังใช้งานไม่ได้",
  "ไม่ได้อยู่",
  "ยังมีปัญหา",
  "ยังเหมือนเดิม",
  "ยังพัง",
  "ยังไม่หาย",
  "ยังเข้าไม่ได้",
  "ไม่หาย",
  "still not",
  "still broken",
  "still failing",
  "not working",
  "doesn't work",
  "does not work",
  "not fixed",
  "same problem",
  "same issue",
];

const CONFIRMATION_MARKERS = [
  "ใช้งานได้แล้ว",
  "ใช้ได้แล้ว",
  "ได้แล้วครับ",
  "ได้แล้วค่ะ",
  "เรียบร้อยแล้ว",
  "หายแล้ว",
  "ปกติแล้ว",
  "เข้าได้แล้ว",
  "ปิดเคสได้",
  "ปิดเคสได้เลย",
  "ขอบคุณครับ ปิดเคส",
  "it works",
  "working now",
  "works now",
  "resolved",
  "fixed now",
  "all good",
  "you can close",
  "close the case",
  "close it",
];

/** Lowercase and collapse whitespace. Thai has no case, but the English markers need it. */
function normalize(text: string): string {
  return String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function detectConfirmationIntent(text: string): ConfirmationIntent {
  const t = normalize(text);
  if (!t) return "NONE";

  // Rejection wins on a tie. "ยังใช้งานไม่ได้ครับ" contains no confirmation
  // marker, but a customer writing "ขอบคุณครับ แต่ยังใช้ไม่ได้" contains
  // both sentiments, and the operative half is the complaint.
  if (REJECTION_MARKERS.some((m) => t.includes(normalize(m)))) return "REJECTED";
  if (CONFIRMATION_MARKERS.some((m) => t.includes(normalize(m)))) return "CONFIRMED";

  return "NONE";
}

// ---------------------------------------------------------------------------
// Two-step close (operator decision 2026-09-07)
// ---------------------------------------------------------------------------
//
// A positive answer no longer closes anything by itself. The bot asks
// "ต้องการปิดเคส <number> เรื่อง <subject> ใช่ไหมคะ" with quick-reply chips, and
// only the explicit close confirmation performs the transition. The chips
// carry the ticket number in their text ("ยืนยันปิดเคส TCK-2026-00001") so
// the answer is unambiguous even when the customer has several cases open,
// and so a bare "ยืนยัน" — which the AI gate reads as "create the ticket" —
// is never the thing that closes a case.

export type CloseIntentKind =
  /** "ยืนยันปิดเคส", "ยืนยันปิดเคส TCK-…", or a bare yes that follows the close question. */
  | "CONFIRM_CLOSE"
  /** "ยังไม่ปิด", "อย่าเพิ่งปิด", "ยกเลิก" while a close question is pending. */
  | "DECLINE_CLOSE"
  /** "ปิดเคส", "ขอปิดเคส TCK-…": the customer asks to close something. */
  | "CLOSE_REQUEST"
  | "NONE";

export interface CloseIntent {
  kind: CloseIntentKind;
  /** Ticket number found in the message, upper-cased, when present. */
  ticketNumber: string | null;
}

export const TICKET_NUMBER_PATTERN = /TCK-\d{4}-\d{4,6}/i;

/** Polite particles and filler a short Thai command may carry. */
const TAIL =
  "(?:\\s*(?:ให้|หน่อย|ด้วย|เลย|ที|นะ|น่ะ|ค่ะ|คะ|ครับ|คับ|ค้าบ|คร้าบ|ครับผม|จ้า|จ้ะ|งับ|ฮะ|ฮับ|ค่า|นะคะ|นะครับ|เดี๋ยวนี้|ตอนนี้|ได้ไหม|ได้มั้ย|หน่อยได้ไหม|please|pls|thanks|thank you)\\s*)*";
const TICKET = "(?:\\s*(?:เคส|ticket|เลข|หมายเลข)?\\s*(TCK-\\d{4}-\\d{4,6}))?";

/** Whole-message close request: "ปิดเคส", "ขอปิดเคส TCK-… หน่อยค่ะ", "close case". */
const CLOSE_REQUEST_RE = new RegExp(
  `^\\s*(?:ขอ|อยาก|ช่วย|รบกวน|ต้องการ|จะ|please\\s+)?\\s*(?:ปิดเคส|ปิดตั๋ว|ปิดงาน|ปิดเรื่อง|close\\s+(?:the\\s+)?(?:case|ticket))${TICKET}${TAIL}${TICKET}${TAIL}$`,
  "i"
);

/** Explicit close confirmation — the chip text, or the same words typed. */
const CONFIRM_CLOSE_RE = new RegExp(
  `^\\s*(?:ยืนยัน\\s*ปิดเคส|ยืนยัน\\s*การปิดเคส|ยืนยันปิด|confirm\\s+close)${TICKET}${TAIL}${TICKET}${TAIL}$`,
  "i"
);

/** A short affirmative that only means "close it" when the close question was just asked. */
const BARE_YES_RE = new RegExp(
  `^\\s*(?:ยืนยัน|ใช่|ใช่เลย|ใช่ค่ะ|ใช่ครับ|ปิดเลย|ปิดได้เลย|ปิดได้|ปิดเคสได้เลย|ปิดเคสเลย|ตกลง|โอเค|ok|okay|yes|confirm|ได้เลย|ได้|เอาเลย|จัดไป|👍|✅)${TAIL}$`,
  "i"
);

/** A refusal to close, meaningful only while the close question is pending. */
const DECLINE_CLOSE_RE = new RegExp(
  `^\\s*(?:ยังไม่ปิด|ยังไม่ต้องปิด|อย่าเพิ่งปิด|ไม่ปิด|ไม่ต้องปิด|ยังก่อน|ยังไม่|ยัง|เดี๋ยวก่อน|รอก่อน|รอแป๊บ|ขอเช็คก่อน|ขอลองก่อน|ขอดูก่อน|ขอทดสอบก่อน|ยกเลิก|ไม่ใช่|ไม่|cancel|not\\s+yet|no|nope|❌)${TAIL}$`,
  "i"
);

/**
 * Classifies a message against the close-confirmation protocol.
 *
 * `closeQuestionPending` tells the detector that the last thing the bot said
 * was the close question (or the "which case" list). Only then do a bare
 * "ยืนยัน"/"ใช่" and a bare "ยังไม่ปิด"/"ยกเลิก" count — outside that context
 * they are ordinary conversation and are left to the AI.
 */
export function detectCloseIntent(text: string, closeQuestionPending = false): CloseIntent {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  if (!raw) return { kind: "NONE", ticketNumber: null };
  const num = raw.match(TICKET_NUMBER_PATTERN);
  const ticketNumber = num ? num[0].toUpperCase() : null;

  if (CONFIRM_CLOSE_RE.test(raw)) return { kind: "CONFIRM_CLOSE", ticketNumber };
  if (CLOSE_REQUEST_RE.test(raw)) return { kind: "CLOSE_REQUEST", ticketNumber };

  if (closeQuestionPending) {
    if (DECLINE_CLOSE_RE.test(raw)) return { kind: "DECLINE_CLOSE", ticketNumber };
    if (BARE_YES_RE.test(raw)) return { kind: "CONFIRM_CLOSE", ticketNumber };
    // The "which case" list was answered with just a number.
    if (ticketNumber && raw.replace(TICKET_NUMBER_PATTERN, "").replace(/นะครับ|นะคะ|ครับ|ค่ะ|คับ|จ้า|เคส|\s/g, "") === "") {
      return { kind: "CLOSE_REQUEST", ticketNumber };
    }
  }

  return { kind: "NONE", ticketNumber };
}
