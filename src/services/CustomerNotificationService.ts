import axios from "axios";
import { createHash } from "crypto";
import { pool } from "../adapters/postgres/PostgresAdapter";
import { config } from "../config/env";
import { createLogger } from "../observability/logger";
import { traceRecorder } from "../observability/TraceRecorder";

const logger = createLogger("customer-notification");

export type CustomerNotificationType =
  | "acknowledgement"
  | "acknowledgement_action"
  | "greeting"
  | "thanks"
  | "image_attached"
  | "image_confirm_case"
  | "image_which_case"
  | "image_case_not_found"
  | "image_need_context"
  | "unsupported_file"
  | "ticket_created"
  | "resolution_confirmation"
  | "closed"
  | "reopened"
  | "progress_update"
  // Two-step close (2026-09-07).
  | "close_confirmation_request"
  | "close_declined"
  | "close_no_open_case"
  | "close_which_case"
  | "resolution_nudge"
  | "auto_closed";

/** LINE quick-reply chip (message action): the tap sends `text` as the customer. */
export interface NotificationQuickReply {
  label: string;
  text: string;
}

export interface SendRequest {
  conversationId: number;
  notificationType: CustomerNotificationType;
  /** Deterministic per logical event — a retried webhook must produce the same key. */
  idempotencyKey: string;
  ticketId?: number | null;
  ticketNumber?: string | null;
  projectId?: number | null;
  orgId?: string | null;
  correlationId?: string | null;
  /** Optional case subject, shown when asking which case an image belongs to. */
  subject?: string | null;
  /**
   * Extra plain-Thai sentence appended to the body (progress_update: the
   * translated status and the target time). Never internal vocabulary.
   */
  detail?: string | null;
  /**
   * Quick-reply chips. When omitted, the type's default chips are attached
   * (delivery / close question); pass [] to send none.
   */
  quickReplies?: NotificationQuickReply[] | null;
}

/**
 * How long one acknowledgement covers a burst of customer messages. Long
 * enough to span a multi-part report plus its screenshots, short enough that a
 * genuinely new report minutes later is acknowledged again.
 */
const ACK_BURST_WINDOW_SECONDS = 90;

export interface SendResult {
  sent: boolean;
  /** True when this notification had already been sent for this key. */
  duplicate?: boolean;
  reason?: string;
  body?: string;
}

/**
 * Customer-facing messages for the Golden Flow.
 *
 * Two rules shape this service:
 *
 * 1. At most once. LINE retries webhooks, the reverse-sync poller re-reads
 *    the same Plane state every cycle, and an operator can resolve twice.
 *    A unique index on (notification_type, idempotency_key) is what enforces
 *    it — the row is claimed before the message is sent, so two concurrent
 *    senders cannot both deliver.
 *
 * 2. Never overstate. An acknowledgement says the report was received and is
 *    being looked at. It does not say an engineer has fixed anything, and it
 *    does not invent a case number that does not exist yet.
 *
 * 3. One voice. The assistant is female throughout the product, so every
 *    string here ends in ค่ะ / นะคะ and never in the male particle. The LINE
 *    onboarding path already enforces this by test; these messages share the
 *    same chat thread and were the last place still answering as a man.
 *    test-line-project-onboarding.ts greps this file, so keep the male
 *    particle out of the comments here too.
 */
export class CustomerNotificationService {
  /**
   * Acknowledgement variants. Every one is intent-neutral (fires before
   * classification, so it must read naturally for a question as well as an
   * incident report), promises nothing beyond "received, looking", and ends
   * in the female particle. Picked deterministically from the idempotency
   * key so a LINE webhook retry can never produce a differently-worded
   * duplicate, while consecutive messages still vary.
   */
  private static readonly ACK_VARIANTS = [
    "รับเรื่องแล้วนะคะ ขอเวลาสักครู่ค่ะ",
    "รับเรื่องไว้แล้วค่ะ เดี๋ยวแอดมินดูให้นะคะ",
    "รับทราบค่ะ ขอแอดมินดูสักครู่นะคะ",
    "รับเรื่องแล้วค่ะ รอสักครู่นะคะ",
  ] as const;

  /**
   * Action Acknowledgement variants for short confirmation/cancellation turns.
   */
  private static readonly ACK_ACTION_VARIANTS = [
    "รับทราบค่ะ",
    "รับเรื่องค่ะ",
    "รับทราบเรียบร้อยค่ะ",
    "รับเรื่องแล้วนะคะ",
  ] as const;

  /**
   * Complete replies for turns the webhook answers at the edge: a pure
   * greeting or pure thanks never reaches the AI (see detectPureSmallTalk in
   * lineWebhook), so this line is the whole conversation turn, not a stall.
   */
  private static readonly GREETING_VARIANTS = [
    "สวัสดีค่ะ มีอะไรให้แอดมินช่วยดูแลไหมคะ",
    "สวัสดีค่ะ แจ้งเรื่องหรือสอบถามเข้ามาได้เลยนะคะ",
    "สวัสดีค่า มีอะไรให้แอดมินช่วยบอกได้เลยนะคะ",
  ] as const;

  private static readonly THANKS_VARIANTS = [
    "ยินดีค่ะ มีอะไรให้ช่วยอีกแจ้งได้เลยนะคะ",
    "ยินดีดูแลเสมอค่ะ",
    "ขอบคุณเช่นกันนะคะ มีอะไรเพิ่มเติมแจ้งได้เลยค่ะ",
  ] as const;

  /**
   * SLA progress reports ("รายงานความคืบหน้า User" cadence). Each variant
   * states the case number and promises nothing beyond "still being worked
   * on"; the caller appends the translated status and target time via
   * SendRequest.detail. Seeded from the slot key so a re-run of the same slot
   * (which the idempotency index already blocks) could never differ.
   */
  private static readonly PROGRESS_VARIANTS = [
    "อัปเดตความคืบหน้าเคส {ticket} ให้นะคะ",
    "แอดมินแวะมาอัปเดตเคส {ticket} ค่ะ",
    "ขอรายงานสถานะล่าสุดของเคส {ticket} นะคะ",
    "เคส {ticket} ที่แจ้งไว้ แอดมินขออัปเดตให้ค่ะ",
    "มาบอกความคืบหน้าเคส {ticket} นะคะ",
  ] as const;

  /** Closing line for progress reports; seeded separately so opener/closer pairs vary. */
  private static readonly PROGRESS_CLOSERS = [
    "มีความคืบหน้าเพิ่มเติมแอดมินจะรีบแจ้งนะคะ",
    "ถ้ามีอะไรเปลี่ยนแปลงจะรีบมาบอกค่ะ",
    "แอดมินยังติดตามให้อยู่ตลอดนะคะ",
    "ขอบคุณที่รอนะคะ มีอัปเดตเมื่อไหร่จะแจ้งทันทีค่ะ",
  ] as const;

  /**
   * Two-step close wording. Every variant names the case number without "#"
   * (operator decision) and, where the subject is known, the subject in
   * quotes. None of them contains the phrases the AI gate's create-
   * confirmation net keys on ("ปุ่มด้านล่าง", "กดปุ่ม 'ยืนยัน'") — these rows
   * are hidden from the AI history anyway, but the wording stays safe if
   * that ever changes.
   */

  /** Engineering set Delivery to Customer: ask the customer to test. */
  private static readonly DELIVERY_VARIANTS = [
    "ทีมงานแก้ไขเคส {ticket}{about} เรียบร้อยแล้วค่ะ รบกวนลองใช้งานดูอีกครั้งนะคะ ถ้าใช้ได้แล้วแตะ 'ใช้งานได้แล้ว' หรือถ้ายังติดอยู่แตะ 'ยังมีปัญหาอยู่' ข้างล่างนี้ได้เลยค่ะ",
    "แอดมินได้รับแจ้งจากทีมงานว่าเคส {ticket}{about} แก้ไขเสร็จแล้วค่ะ รบกวนช่วยทดสอบหน่อยนะคะ แล้วแตะบอกผลข้างล่างนี้ได้เลยค่ะ",
    "เคส {ticket}{about} ทีมงานแก้ไขเสร็จแล้วนะคะ ลองเข้าใช้งานดูอีกครั้งได้เลยค่ะ เรียบร้อยดีไหมคะ แตะบอกแอดมินข้างล่างนี้ได้เลย",
    "อัปเดตค่ะ เคส {ticket}{about} ทางทีมแก้ไขให้เรียบร้อยแล้ว รบกวนลองทดสอบดูนะคะ ใช้ได้แล้วหรือยังติดตรงไหน แตะบอกได้เลยค่ะ",
    "ข่าวดีค่ะ เคส {ticket}{about} แก้ไขเสร็จเรียบร้อยแล้วนะคะ รบกวนลองใช้งานดูสักครู่ แล้วแตะบอกผลข้างล่างนี้ให้แอดมินหน่อยค่ะ",
  ] as const;

  /** Customer said it works (or asked to close): confirm before closing. */
  private static readonly CLOSE_QUESTION_VARIANTS = [
    "ดีใจด้วยนะคะที่ใช้งานได้แล้ว 🎉 ต้องการปิดเคส {ticket}{about} เลยไหมคะ แตะ 'ยืนยันปิดเคส' ได้เลยค่ะ",
    "ขอบคุณที่แจ้งนะคะ แอดมินขอยืนยันอีกครั้งค่ะ ปิดเคส {ticket}{about} ได้เลยใช่ไหมคะ",
    "รับทราบค่ะ ถ้าเรียบร้อยดีแล้ว แตะ 'ยืนยันปิดเคส' เพื่อปิดเคส {ticket}{about} ได้เลยนะคะ หรือถ้ายังมีอะไรติดอยู่แตะ 'ยังมีปัญหาอยู่' ค่ะ",
    "ต้องการปิดเคส {ticket}{about} ใช่ไหมคะ ถ้าใช่แตะ 'ยืนยันปิดเคส' ข้างล่างนี้ได้เลยค่ะ",
  ] as const;

  private static readonly CLOSED_VARIANTS = [
    "ปิดเคส {ticket} ให้เรียบร้อยแล้วนะคะ ขอบคุณที่ช่วยทดสอบค่ะ ถ้ามีอะไรอีกทักมาได้เลย",
    "เรียบร้อยค่ะ เคส {ticket} ปิดให้แล้วนะคะ ขอบคุณที่แจ้งเข้ามาค่ะ มีอะไรเพิ่มเติมแจ้งได้เสมอนะคะ",
    "ปิดเคส {ticket} แล้วค่ะ ขอบคุณมากนะคะ ถ้าเจอปัญหาเดิมอีกทักมาบอกได้เลย แอดมินเปิดเคสให้ใหม่ได้ค่ะ",
  ] as const;

  private static readonly REOPENED_VARIANTS = [
    "รับทราบค่ะ แอดมินเปิดเคส {ticket} ให้ทีมงานตรวจสอบอีกครั้งแล้วนะคะ ขออภัยที่ยังไม่เรียบร้อยค่ะ",
    "ขออภัยด้วยนะคะ แอดมินส่งเคส {ticket} กลับให้ทีมงานดูซ้ำแล้วค่ะ มีความคืบหน้าจะรีบแจ้งนะคะ",
    "เปิดเคส {ticket} ขึ้นมาตรวจสอบอีกครั้งแล้วค่ะ ทีมงานกำลังดูให้อยู่นะคะ ขอบคุณที่แจ้งค่ะ",
  ] as const;

  /** "ยังไม่ปิด" — leave the case waiting, without nagging. */
  private static readonly CLOSE_DECLINED_VARIANTS = [
    "โอเคค่ะ ยังไม่ปิดเคส {ticket} นะคะ ลองใช้งานให้แน่ใจก่อนได้เลย พร้อมเมื่อไหร่ค่อยแจ้งแอดมินค่ะ",
    "รับทราบค่ะ เคส {ticket} ยังเปิดไว้ให้นะคะ ถ้าเรียบร้อยแล้วค่อยบอกแอดมินได้เลยค่ะ",
  ] as const;

  /** "ปิดเคส" with nothing open — answered at the edge, never sent to the AI. */
  private static readonly NO_OPEN_CASE_VARIANTS = [
    "ตอนนี้ไม่มีเคสที่เปิดอยู่ให้ปิดเลยค่ะ ทุกเรื่องที่แจ้งไว้เรียบร้อยหมดแล้วนะคะ ถ้ามีปัญหาใหม่แจ้งเข้ามาได้เลยค่ะ",
    "แอดมินเช็คแล้วไม่พบเคสที่ยังเปิดอยู่เลยค่ะ เลยยังไม่มีอะไรให้ปิดนะคะ มีเรื่องใหม่แจ้งมาได้เลยค่ะ",
    "ตอนนี้ไม่มีเคสค้างอยู่เลยค่ะ ทุกเคสปิดเรียบร้อยแล้วนะคะ ถ้าเจอปัญหาอีกทักมาได้เสมอค่ะ",
    "ไม่มีเคสที่เปิดอยู่ให้ปิดแล้วค่ะ เคสก่อนหน้าปิดไปเรียบร้อยหมดแล้วนะคะ ถ้าต้องการแจ้งเรื่องใหม่บอกแอดมินได้เลยค่ะ",
  ] as const;

  /** Several cases are open: list them and let the chips pick. */
  private static readonly WHICH_CASE_VARIANTS = [
    "ตอนนี้มีเคสเปิดอยู่หลายเคสค่ะ ต้องการปิดเคสไหนคะ แตะเลือกข้างล่างนี้ได้เลยค่ะ",
    "มีเคสที่ยังเปิดอยู่มากกว่าหนึ่งเคสนะคะ อยากปิดเคสไหน แตะเลือกได้เลยค่ะ",
  ] as const;

  /** Reminder after the customer stayed silent on the delivery message. */
  private static readonly NUDGE_VARIANTS = [
    "แอดมินขอติดตามเคส {ticket}{about} หน่อยนะคะ ทีมงานแก้ไขให้แล้ว รบกวนลองใช้งานดูค่ะ แล้วแตะบอกผลข้างล่างนี้ได้เลยนะคะ{deadline}",
    "ทักมาเตือนเคส {ticket}{about} ค่ะ ทีมงานแก้ไขเสร็จแล้วนะคะ ใช้งานได้แล้วหรือยังคะ แตะบอกแอดมินได้เลยค่ะ{deadline}",
    "เคส {ticket}{about} ที่ทีมงานแก้ไขไปแล้ว ไม่ทราบว่าลองใช้งานแล้วเป็นอย่างไรบ้างคะ แตะบอกผลข้างล่างนี้ได้เลยค่ะ{deadline}",
  ] as const;

  private static readonly AUTO_CLOSED_VARIANTS = [
    "แอดมินปิดเคส {ticket} ให้อัตโนมัติแล้วนะคะ เนื่องจากไม่ได้รับการยืนยันกลับ ถ้ายังพบปัญหาอยู่ทักมาบอกได้เลยค่ะ แอดมินเปิดเคสให้ใหม่ได้ทันที",
    "เคส {ticket} ถูกปิดอัตโนมัติแล้วค่ะ เพราะไม่มีการตอบกลับหลังทีมงานแก้ไขเสร็จนะคะ หากยังมีปัญหาแจ้งกลับมาได้เลยค่ะ",
  ] as const;

  private static pickVariant(variants: readonly string[], seed?: string | null): string {
    if (!seed) return variants[0];
    const digest = createHash("sha256").update(seed).digest();
    return variants[digest[0] % variants.length];
  }

  /**
   * Rotating pick for periodic messages. A hash pick can land on the same
   * variant twice in a row (seen: hourly slots 3 and 4 identical); when the
   * seed ends in a slot number the variant simply cycles with it, so
   * consecutive reports are guaranteed to differ. Non-numeric seeds (manual
   * test keys) fall back to the hash pick.
   */
  private static pickRotating(variants: readonly string[], seed: string | null | undefined, offset = 0): string {
    const m = /(\d+)\s*$/.exec(String(seed || ""));
    if (!m) return CustomerNotificationService.pickVariant(variants, seed);
    return variants[(Number(m[1]) + offset) % variants.length];
  }

  /** Wording is deliberately conservative — see rule 2 above. */
  private body(type: CustomerNotificationType, ticketNumber?: string | null, seed?: string | null, subject?: string | null, detail?: string | null): string {
    switch (type) {
      case "progress_update": {
        // No "#" before the case number (operator decision) and a closer that
        // varies independently of the opener, so consecutive hourly reports
        // never read as the same template.
        const opener = CustomerNotificationService.pickRotating(CustomerNotificationService.PROGRESS_VARIANTS, seed)
          .replace("{ticket}", ticketNumber ? ticketNumber : "ที่แจ้งไว้");
        // 5 openers × 4 closers with different strides → 20 distinct pairs before any repeat.
        const closer = CustomerNotificationService.pickRotating(CustomerNotificationService.PROGRESS_CLOSERS, seed, 1);
        const extra = String(detail || "").trim();
        return extra
          ? `${opener} ${extra} ${closer}`
          : `${opener} ทีมงานยังดำเนินการอยู่ค่ะ ${closer}`;
      }
      case "acknowledgement":
        return CustomerNotificationService.pickVariant(CustomerNotificationService.ACK_VARIANTS, seed);
      case "acknowledgement_action":
        return CustomerNotificationService.pickVariant(CustomerNotificationService.ACK_ACTION_VARIANTS, seed);
      case "greeting":
        return CustomerNotificationService.pickVariant(CustomerNotificationService.GREETING_VARIANTS, seed);
      case "thanks":
        return CustomerNotificationService.pickVariant(CustomerNotificationService.THANKS_VARIANTS, seed);
      // Screenshot landed on an existing case. Naming the case is the point of
      // the message, so the number is stated when it is known.
      case "image_attached":
        return ticketNumber
          ? `ได้รับรูปแล้วนะคะ แนบเข้าเคส ${ticketNumber} ให้เรียบร้อยแล้วค่ะ`
          : "ได้รับรูปแล้วนะคะ แนบเข้าเคสให้เรียบร้อยแล้วค่ะ";
      // A standalone screenshot is never attached on a guess — ask which case
      // it belongs to. The lineWebhook pending-reply handler resolves the
      // answer (ใช่ / ไม่ใช่ / เลขเคส / ชื่อเรื่อง) deterministically.
      case "image_confirm_case": {
        // Truncating mid-word read as a glitch ("...ไม่ถูกต้") — allow the full
        // subject up to a sane cap and mark a real cut with an ellipsis.
        const raw = String(subject || "").trim();
        const shown = raw.length > 120 ? `${raw.slice(0, 120)}…` : raw;
        const about = shown ? ` เรื่อง "${shown}"` : "";
        return ticketNumber
          ? `ได้รับรูปแล้วนะคะ รูปนี้เป็นของเคสล่าสุด ${ticketNumber}${about} ใช่ไหมคะ`
          : "ได้รับรูปแล้วนะคะ เป็นรูปของเคสที่แจ้งไว้ล่าสุดใช่ไหมคะ";
      }
      case "image_which_case":
        return "รบกวนบอกเลขเคส (TCK-...) หรือพิมพ์ชื่อเรื่องที่แจ้งไว้หน่อยนะคะ แอดมินจะได้แนบรูปให้ถูกเคสค่ะ";
      case "image_case_not_found":
        return "แอดมินยังไม่พบเคสตามที่แจ้งเลยค่ะ รบกวนเช็คเลขเคสอีกครั้งนะคะ";
      // A file / clip the pipeline cannot read: say so at once with the fix in
      // hand, instead of acknowledging and sending an empty turn to the AI.
      case "unsupported_file":
        return "ขออภัยค่ะ ไฟล์แบบนี้แอดมินยังเปิดดูไม่ได้ค่ะ รบกวนส่งเป็นรูปภาพ (PNG หรือ JPG) หรือพิมพ์อธิบายอาการมาได้เลยนะคะ";
      // A screenshot with no case and no recent report to attach it to: ask for
      // the one line that makes it actionable instead of guessing.
      case "image_need_context":
        return "ได้รับรูปแล้วนะคะ รบกวนพิมพ์อธิบายอาการสั้น ๆ อีกนิดค่ะ จะได้เปิดเคสให้ถูกต้องนะคะ";
      case "ticket_created":
        return ticketNumber
          ? `สร้างเคส #${ticketNumber} ให้แล้วนะคะ ทีมงานกำลังตรวจสอบให้อยู่ค่ะ`
          : "สร้างเคสให้แล้วนะคะ ทีมงานกำลังตรวจสอบให้อยู่ค่ะ";
      case "resolution_confirmation":
        return this.fill(CustomerNotificationService.DELIVERY_VARIANTS, seed, ticketNumber, subject);
      case "close_confirmation_request":
        return this.fill(CustomerNotificationService.CLOSE_QUESTION_VARIANTS, seed, ticketNumber, subject);
      case "closed":
        return this.fill(CustomerNotificationService.CLOSED_VARIANTS, seed, ticketNumber, null);
      case "reopened":
        return this.fill(CustomerNotificationService.REOPENED_VARIANTS, seed, ticketNumber, null);
      case "close_declined":
        return this.fill(CustomerNotificationService.CLOSE_DECLINED_VARIANTS, seed, ticketNumber, null);
      case "close_no_open_case":
        return CustomerNotificationService.pickVariant(CustomerNotificationService.NO_OPEN_CASE_VARIANTS, seed);
      case "close_which_case": {
        // `detail` carries the pre-formatted case list (one line per case).
        const list = String(detail || "").trim();
        const head = CustomerNotificationService.pickVariant(CustomerNotificationService.WHICH_CASE_VARIANTS, seed);
        return list ? `${head}\n\n${list}` : head;
      }
      case "resolution_nudge": {
        // `detail` is the plain-Thai auto-close notice, when auto-close is on.
        const deadline = String(detail || "").trim();
        return this.fill(CustomerNotificationService.NUDGE_VARIANTS, seed, ticketNumber, subject)
          .replace("{deadline}", deadline ? ` ${deadline}` : "");
      }
      case "auto_closed":
        return this.fill(CustomerNotificationService.AUTO_CLOSED_VARIANTS, seed, ticketNumber, null);
    }
  }

  /** Substitutes {ticket} and {about} in a picked variant. */
  private fill(variants: readonly string[], seed: string | null | undefined, ticketNumber?: string | null, subject?: string | null): string {
    const raw = String(subject || "").trim();
    const shown = raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
    return CustomerNotificationService.pickVariant(variants, seed)
      .replace("{ticket}", ticketNumber ? ticketNumber : "ที่แจ้งไว้")
      .replace("{about}", shown ? ` เรื่อง "${shown}"` : "");
  }

  /**
   * Chips attached when the caller does not choose its own. Each chip's text
   * carries the case number so the reply is unambiguous with several cases
   * open, and so nothing here is a bare "ยืนยัน" (the AI gate's create-
   * confirmation word).
   */
  static defaultQuickReplies(type: CustomerNotificationType, ticketNumber?: string | null): NotificationQuickReply[] {
    const n = ticketNumber ? ` ${ticketNumber}` : "";
    switch (type) {
      case "resolution_confirmation":
      case "resolution_nudge":
        return [
          { label: "ใช้งานได้แล้ว", text: `ใช้งานได้แล้ว${n}` },
          { label: "ยังมีปัญหาอยู่", text: `ยังมีปัญหาอยู่${n}` },
        ];
      case "close_confirmation_request":
        return [
          { label: "ยืนยันปิดเคส", text: `ยืนยันปิดเคส${n}` },
          { label: "ยังไม่ปิด", text: "ยังไม่ปิด" },
          { label: "ยังมีปัญหาอยู่", text: `ยังมีปัญหาอยู่${n}` },
        ];
      default:
        return [];
    }
  }

  /**
   * Resolves the LINE user id and tenant for a conversation.
   * Returns null when the conversation has no LINE identity, in which case
   * nothing is sent rather than guessing a recipient.
   */
  private async resolveRecipient(conversationId: number): Promise<{
    recipientRef: string;
    channel: string;
    projectId: number | null;
    orgId: string | null;
  } | null> {
    const { rows } = await pool.query(
      `SELECT i.channel_ref, c.channel, c.project_id, c.org_id
         FROM conversations c
         JOIN identities i ON c.identity_id = i.id
        WHERE c.id = $1 AND c.deleted_at IS NULL
        LIMIT 1`,
      [conversationId]
    );
    if (rows.length === 0 || !rows[0].channel_ref) return null;
    return {
      recipientRef: String(rows[0].channel_ref),
      channel: String(rows[0].channel || "line").toLowerCase(),
      projectId: rows[0].project_id ?? null,
      orgId: rows[0].org_id ?? null,
    };
  }

  /**
   * Claims the notification row.
   *
   * Returns false when the unique index rejects it, which means this exact
   * notification was already sent (or is being sent right now). Claiming
   * before sending is what makes concurrent senders safe.
   */
  private async claim(req: SendRequest, recipientRef: string, channel: string, body: string): Promise<number | null> {
    const { rows } = await pool.query(
      `INSERT INTO customer_notifications
         (conversation_id, ticket_id, project_id, org_id, notification_type,
          idempotency_key, channel, recipient_ref, status, body, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10)
       ON CONFLICT (notification_type, idempotency_key) DO NOTHING
       RETURNING id`,
      [
        req.conversationId,
        req.ticketId ?? null,
        req.projectId ?? null,
        req.orgId ?? null,
        req.notificationType,
        req.idempotencyKey,
        channel,
        recipientRef,
        body,
        req.correlationId ?? null,
      ]
    );
    return rows.length > 0 ? Number(rows[0].id) : null;
  }

  private async markSent(id: number): Promise<void> {
    await pool
      .query(`UPDATE customer_notifications SET status = 'sent', sent_at = NOW(), updated_at = NOW() WHERE id = $1`, [id])
      .catch((err) => logger.warn({ error: err.message, id }, "Could not mark notification sent"));
  }

  private async markFailed(id: number, error: string): Promise<void> {
    await pool
      .query(
        `UPDATE customer_notifications SET status = 'failed', error_message = $2, updated_at = NOW() WHERE id = $1`,
        [id, error.slice(0, 500)]
      )
      .catch(() => {});
  }

  /** Pushes a LINE message. Never logs the access token. */
  private async pushLine(recipientRef: string, text: string, quickReplies: NotificationQuickReply[] = []): Promise<void> {
    const token = (config.LINE_CHANNEL_ACCESS_TOKEN || "").trim();
    if (!token) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is not configured");

    const message: Record<string, unknown> = { type: "text", text };
    if (quickReplies.length > 0) {
      // LINE allows at most 13 items; labels are capped at 20 characters.
      message.quickReply = {
        items: quickReplies.slice(0, 13).map((item) => ({
          type: "action",
          action: { type: "message", label: item.label.slice(0, 20), text: item.text },
        })),
      };
    }

    await axios.post(
      "https://api.line.me/v2/bot/message/push",
      { to: recipientRef, messages: [message] },
      { headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, timeout: 10000 }
    );
  }

  /**
   * Sends a customer notification at most once.
   *
   * The message is recorded in the conversation regardless of delivery, so an
   * operator can see what the customer was told even if LINE was unreachable.
   */
  async send(req: SendRequest): Promise<SendResult> {
    const recipient = await this.resolveRecipient(req.conversationId);
    if (!recipient) {
      logger.warn({ conversationId: req.conversationId }, "No recipient for conversation; notification suppressed");
      return { sent: false, reason: "NO_RECIPIENT" };
    }

    // One acknowledgement per burst, not per message. Idempotency is keyed on
    // the LINE event, so a customer sending "แจ้งเคสค่ะ", then the details, then
    // a screenshot used to receive three of these — and now that the wording is
    // randomized they would not even look like the same message.
    if (req.notificationType === "acknowledgement" || req.notificationType === "acknowledgement_action") {
      const recent = await pool.query(
        `SELECT 1 FROM customer_notifications
          WHERE conversation_id = $1
            AND notification_type IN ('acknowledgement', 'acknowledgement_action')
            AND created_at >= NOW() - ($2::int * INTERVAL '1 second')
          LIMIT 1`,
        [req.conversationId, ACK_BURST_WINDOW_SECONDS]
      );
      if (recent.rows.length > 0) {
        logger.info(
          { conversationId: req.conversationId, idempotencyKey: req.idempotencyKey },
          "Acknowledgement suppressed: one was already sent for this burst"
        );
        return { sent: false, duplicate: true, reason: "RECENTLY_ACKNOWLEDGED" };
      }
    }

    const body = this.body(req.notificationType, req.ticketNumber, req.idempotencyKey, req.subject, req.detail);

    const claimId = await this.claim(
      { ...req, projectId: req.projectId ?? recipient.projectId, orgId: req.orgId ?? recipient.orgId },
      recipient.recipientRef,
      recipient.channel,
      body
    );

    if (claimId === null) {
      logger.info(
        { conversationId: req.conversationId, type: req.notificationType, idempotencyKey: req.idempotencyKey },
        "Customer notification already sent for this event; suppressing duplicate"
      );
      return { sent: false, duplicate: true, reason: "ALREADY_SENT", body };
    }

    const quickReplies =
      req.quickReplies === undefined || req.quickReplies === null
        ? CustomerNotificationService.defaultQuickReplies(req.notificationType, req.ticketNumber)
        : req.quickReplies;

    try {
      if (recipient.channel === "line") {
        await this.pushLine(recipient.recipientRef, body, quickReplies);
      } else {
        // Other channels deliver through their own gateway; the ledger row
        // and the conversation record are still written.
        logger.info({ channel: recipient.channel }, "Non-LINE channel: notification recorded, delivery delegated");
      }

      await this.markSent(claimId);
      await this.appendToConversation(req.conversationId, body);

      await traceRecorder.record({
        correlationId: req.correlationId || `notify-${claimId}`,
        component: "notification",
        eventType: `${req.notificationType}_sent`,
        conversationId: req.conversationId,
        ticketId: req.ticketId ?? null,
        projectId: req.projectId ?? recipient.projectId ?? null,
        orgId: req.orgId ?? recipient.orgId ?? null,
        detail: { channel: recipient.channel, notificationId: claimId, ticketNumber: req.ticketNumber ?? null },
      });

      logger.info(
        {
          conversationId: req.conversationId,
          ticketId: req.ticketId ?? null,
          type: req.notificationType,
          notificationId: claimId,
          correlationId: req.correlationId ?? null,
        },
        "Customer notification sent"
      );
      return { sent: true, body };
    } catch (err: any) {
      await this.markFailed(claimId, err.message);
      await traceRecorder.record({
        correlationId: req.correlationId || `notify-${claimId}`,
        component: "notification",
        eventType: `${req.notificationType}_failed`,
        status: "failed",
        conversationId: req.conversationId,
        ticketId: req.ticketId ?? null,
        errorMessage: err.message,
      });
      // Still record what we intended to say, so the thread is not silently
      // missing a turn the customer may or may not have received.
      await this.appendToConversation(req.conversationId, body);
      logger.error(
        { conversationId: req.conversationId, type: req.notificationType, error: err.message },
        "Customer notification delivery failed"
      );
      return { sent: false, reason: "DELIVERY_FAILED", body };
    }
  }

  private async appendToConversation(conversationId: number, text: string): Promise<void> {
    await pool
      .query(
        `INSERT INTO messages (conversation_id, role, content, message_type, message_purpose, created_at)
         VALUES ($1, 'ai', $2, 'text', 'notification', NOW())`,
        [conversationId, text]
      )
      .catch((err) => logger.warn({ error: err.message, conversationId }, "Could not append notification to conversation"));
  }
}

export const customerNotificationService = new CustomerNotificationService();
