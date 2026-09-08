import axios from "axios";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../../config/env";
import { customerNotificationService } from "../../services/CustomerNotificationService";
import { customerConfirmationHandler } from "../../services/CustomerConfirmationHandler";
import { executionContextService } from "../../domain/execution/ExecutionContextService";
import { traceRecorder } from "../../observability/TraceRecorder";
import {
  LineOnboardingDecision,
  LineProjectOnboardingService,
} from "../../services/LineProjectOnboardingService";
import { createLogger } from "../../observability/logger";
import { pool } from "../../adapters/postgres/PostgresAdapter";
import { resolveLineWebhookPayload, verifyLineSignature } from "../../services/lineWebhookSecurity";
import {
  buildLineChoicePrompt,
  buildLineOnboardingCarousel,
  buildLineProjectLinkConfirmation,
  buildLineProjectMenu,
  LINE_ONBOARDING_CARDS,
  lineOnboardingCardDirectory,
} from "../../services/LineOnboardingCarouselService";
import { LineMessageBatchingService } from "../../services/LineMessageBatchingService";
import { AgentSessionQueueService } from "../../services/AgentSessionQueueService";
import { AgentSessionQueueWorker } from "../../services/AgentSessionQueueWorker";
import { LineTypingIndicatorService } from "../../services/LineTypingIndicatorService";

const logger = createLogger("line-webhook");

/**
 * Shared keep-alive agent for outbound LINE / PromptX calls.
 *
 * Every reply, push and loading-indicator request used to open its own TCP +
 * TLS connection: measured against api.line.me that is ~155 ms of handshake
 * (connect 78 ms, TLS 137 ms, first byte 275 ms) paid again on every single
 * call, and one webhook event can make three of them. Reusing sockets removes
 * that handshake for everything after the first call.
 */
const lineHttpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 32,
  maxFreeSockets: 8,
});

/** Milliseconds elapsed since `start`, rounded, for structured timing logs. */
function elapsedMs(start: bigint): number {
  return Math.round(Number(process.hrtime.bigint() - start) / 1e6);
}

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

function buildLineReply(decision: LineOnboardingDecision): Record<string, unknown> {
  const message: Record<string, unknown> = {
    type: "text",
    text: decision.replyText || "รับข้อมูลแล้วนะคะ",
  };
  if (decision.quickReplies?.length) {
    message.quickReply = {
      items: decision.quickReplies.map((item) => ({
        type: "action",
        action: {
          type: "postback",
          label: item.label,
          data: item.data,
          displayText: item.label,
        },
      })),
    };
  } else if (decision.messageQuickReplies?.length) {
    // Message-action chips: the tap sends plain text as the user, so it flows
    // through the normal AI path instead of the onboarding postback handler.
    message.quickReply = {
      items: decision.messageQuickReplies.map((item) => ({
        type: "action",
        action: {
          type: "message",
          label: item.label,
          text: item.text,
        },
      })),
    };
  }
  return message;
}

async function sendLineReply(replyToken: string, decision: LineOnboardingDecision): Promise<void> {
  if (!replyToken) throw new Error("LINE event cannot be replied to because replyToken is missing");
  const messages = decision.replyWithOnboardingCarousel
    ? [buildLineOnboardingCarousel(config.BACKEND_PUBLIC_URL)]
    : decision.projectLinkConfirmation
      ? [buildLineProjectLinkConfirmation(decision.projectLinkConfirmation)]
    : decision.projectMenu
      ? buildLineProjectMenu(decision.projectMenu)
    : decision.quickReplies?.length
      ? [buildLineChoicePrompt(decision.replyText || "เลือกวิธีดำเนินการได้เลยค่ะ", decision.quickReplies)]
    : [buildLineReply(decision)];
  try {
    await axios.post(
      "https://api.line.me/v2/bot/message/reply",
      { replyToken, messages },
      {
        headers: {
          Authorization: `Bearer ${config.LINE_CHANNEL_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 10000,
        httpsAgent: lineHttpsAgent,
      }
    );
  } catch (err: any) {
    logger.error(
      {
        status: err.response?.status,
        data: err.response?.data,
        message: err.message,
        replyToken,
        // Whether a token is configured is the diagnostically useful part.
        // The previous line logged its first 15 characters on every LINE
        // reply failure, which put credential material into the server log.
        tokenConfigured: Boolean(config.LINE_CHANNEL_ACCESS_TOKEN),
      },
      "LINE reply API call failed"
    );
    throw err;
  }
}

async function sendLinePush(userId: string, text: string): Promise<void> {
  await sendLinePushMessages(userId, [{ type: "text", text }]);
}

async function sendLinePushMessages(
  userId: string,
  messages: Array<Record<string, unknown>>,
  notificationDisabled = false
): Promise<void> {
  await axios.post(
    "https://api.line.me/v2/bot/message/push",
    { to: userId, messages, notificationDisabled },
    {
      headers: {
        Authorization: `Bearer ${config.LINE_CHANNEL_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      timeout: 10000,
      httpsAgent: lineHttpsAgent,
    }
  );
}

/**
 * Shows LINE's typing indicator in a 1:1 chat while the event is processed.
 *
 * `loadingSeconds` must be a multiple of five between 5 and 60 — LINE rejects
 * anything else with HTTP 400 ("must be a multiple of five"). This was
 * previously called with 3, so every request failed and the indicator never
 * appeared; the empty catch below kept that silent. The value is snapped to a
 * legal multiple here so a future caller cannot reintroduce the same defect.
 *
 * Failure stays non-fatal — this is a UX affordance, not part of the reply —
 * but it is now logged rather than swallowed.
 */
/**
 * Single implementation lives in LineTypingIndicatorService (shared with the
 * agent session worker, which keeps the indicator alive for the whole AI
 * turn). The route falls back to its own instance when the server does not
 * inject one, so tests that register the routes alone still work.
 */
let typingIndicator: LineTypingIndicatorService | null = null;

function getTypingIndicator(): LineTypingIndicatorService {
  if (!typingIndicator) {
    typingIndicator = new LineTypingIndicatorService(pool, config.LINE_CHANNEL_ACCESS_TOKEN || "");
  }
  return typingIndicator;
}

async function showLineLoadingAnimation(userId: string, seconds = 5): Promise<void> {
  await getTypingIndicator().show(userId, seconds);
}

async function forwardPromptXWebhook(
  url: string,
  destination: string,
  event: any,
  ticketx?: Record<string, unknown>
): Promise<void> {
  await axios.post(
    url,
    {
      destination,
      events: [event],
      ...(ticketx ? { ticketx } : {}),
    },
    {
      headers: { "Content-Type": "application/json" },
      timeout: 15000,
      httpsAgent: lineHttpsAgent,
    }
  );
}

/**
 * Detects a message that is ONLY a greeting or ONLY a thank-you, so the
 * webhook can answer it completely at the edge: a 1-second human reply, no
 * "รับเรื่องแล้ว" acknowledgement landing on a hello, and no second AI reply
 * repeating the greeting 40 seconds later. Deliberately conservative — any
 * substance after the greeting ("สวัสดีค่ะ ระบบล่ม") fails the pure match
 * and flows to the AI as usual.
 */
// Male particles appear here only as CUSTOMER input to match, never as bot
// output — test-line-project-onboarding greps this file for them, so they are
// written as unicode escapes.
const SMALL_TALK_TAIL =
  "(?:[\\s!.,~า]|ๆ|5|ค่ะ|คะ|ค่า|ค๊า|จ้า|จ๊ะ|จ้ะ|จร้า|นะ|น้า|งับ|ฮะ|ฮับ|ผม|ด้วย|เด้อ|ครัช|ค้าบ|\\u0e04\\u0e23\\u0e31\\u0e1a|\\u0e04\\u0e31\\u0e1a)*";
const GREETING_RE = new RegExp(
  `^(?:สวัสดี(?:ตอนเช้า|ตอนบ่าย|ตอนเย็น|ยามเช้า)?|หวัดดี|ดีจ้า|ดี|อรุณสวัสดิ์|ฮัลโหล|ฮายย*|ฮะโหล|hello+|helo+|hi+|hey+|hai|good\\s*(?:morning|afternoon|evening)|morning)${SMALL_TALK_TAIL}$`,
  "i"
);
const THANKS_RE = new RegExp(
  `^(?:ขอบ(?:พระ)?คุณ(?:มาก|หลาย|นะ)*|ขอบใจ|แต้งกิ้ว|แต๊งกิ้ว|แต้งค์|thank\\s*(?:you|u)?|thanks?|thx|tks|ty)${SMALL_TALK_TAIL}$`,
  "i"
);

export function detectPureSmallTalk(text: string): "greeting" | "thanks" | null {
  let t = String(text || "").trim();
  if (!t || t.length > 30) return null;
  // Collapse stretched letters — "งับบบบ", "ค่าาาา", "5555", "ดีค้าบบ" — so the
  // pattern sees the canonical word. Runs of 3+ of the same character become
  // one; legitimate Thai never triples a character.
  t = t.replace(/(.)\1{2,}/g, "$1");
  if (GREETING_RE.test(t)) return "greeting";
  if (THANKS_RE.test(t)) return "thanks";
  return null;
}

/**
 * Classifies the customer's reply to "รูปนี้เป็นของเคสล่าสุด TCK-… ใช่ไหมคะ".
 * Deterministic on purpose — same philosophy as the ticket-close confirmation
 * handler: attaching evidence to a case is a state change, and customer text
 * must not reach an LLM that can perform one.
 */
export function classifyPendingImageReply(
  text: string
): { kind: "yes" | "no" | "ticket" | "other"; ticketId?: string } {
  const t = String(text || "").trim();
  const m = t.match(/TCK-\d{4}-\d{4,6}/i);
  if (m) return { kind: "ticket", ticketId: m[0].toUpperCase() };
  if (!t || t.length > 40) return { kind: "other" };
  if (new RegExp(`^(?:ใช่(?:เลย|แล้ว)?|ถูก(?:ต้อง|แล้ว)?|yes|y|ok|โอเค)${SMALL_TALK_TAIL}$`, "i").test(t)) {
    return { kind: "yes" };
  }
  if (new RegExp(`^(?:ไม่ใช่|ไม่|no|ผิด)${SMALL_TALK_TAIL}$`, "i").test(t)) {
    return { kind: "no" };
  }
  return { kind: "other" };
}

/**
 * Matches free-text against the conversation's live tickets by subject.
 * Contains-in-either-direction only, and only a UNIQUE hit counts — anything
 * ambiguous returns null so the message flows to the AI instead of a guess.
 */
export function matchTicketBySubject(
  text: string,
  tickets: Array<{ ticket_number: string; subject: string | null }>
): string | null {
  const t = String(text || "").trim();
  if (t.length < 4 || t.length > 80) return null;
  const hits = tickets.filter((k) => {
    const s = String(k.subject || "").trim();
    return s.length >= 4 && (s.includes(t) || t.includes(s));
  });
  return hits.length === 1 ? hits[0].ticket_number : null;
}

function requireProjectId(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("Invalid project ID");
  return parsed;
}

async function requireConfiguredAdminApiKey(
  _request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  if (!config.API_KEY) {
    await reply.code(503).send({
      error: "Admin onboarding API is disabled until API_KEY is configured",
    });
  }
}

const adminRouteOptions = { preHandler: requireConfiguredAdminApiKey };

export function registerLineWebhookRoutes(
  fastify: FastifyInstance,
  onboardingService: LineProjectOnboardingService,
  batchingService: LineMessageBatchingService,
  queueService?: AgentSessionQueueService,
  queueWorker?: AgentSessionQueueWorker,
  injectedTypingIndicator?: LineTypingIndicatorService
): void {
  if (injectedTypingIndicator) typingIndicator = injectedTypingIndicator;
  fastify.get("/api/v1/media/line-onboarding/cards/:filename", async (request, reply) => {
    const filename = String((request.params as any).filename || "");
    if (!LINE_ONBOARDING_CARDS.some((card) => card.fileName === filename)) {
      return reply.code(404).send({ error: "LINE onboarding card not found" });
    }
    const imagePath = path.join(lineOnboardingCardDirectory(), filename);
    try {
      const image = await fs.promises.readFile(imagePath);
      return reply
        .header("Content-Type", "image/png")
        .header("Cache-Control", "public, max-age=86400, immutable")
        .header("X-Content-Type-Options", "nosniff")
        .send(image);
    } catch (error: any) {
      logger.error({ error: error.message, filename }, "LINE onboarding card could not be read");
      return reply.code(503).send({ error: "LINE onboarding card unavailable" });
    }
  });

  fastify.post("/api/v1/webhooks/line", async (request: FastifyRequest, reply) => {
    if (!config.LINE_CHANNEL_SECRET) {
      logger.error("LINE webhook rejected because LINE_CHANNEL_SECRET is not configured");
      return reply.code(503).send({ error: "LINE webhook is not configured" });
    }
    let signedPayload;
    try {
      signedPayload = resolveLineWebhookPayload({
        body: request.body,
        requestRawBody: request.rawBody,
        headerSignature: request.headers["x-line-signature"],
      });
    } catch {
      return reply.code(400).send({ error: "Invalid forwarded LINE raw body" });
    }
    if (!verifyLineSignature(signedPayload.rawBody, signedPayload.signature, config.LINE_CHANNEL_SECRET)) {
      logger.warn({ ip: request.ip }, "Invalid LINE webhook signature");
      return reply.code(403).send({ error: "Invalid LINE webhook signature" });
    }

    const body = signedPayload.body;
    const destination = String(body.destination || "").trim();
    const events = Array.isArray(body.events) ? body.events : [];
    if (!destination || events.length === 0) {
      return reply.code(200).send({ success: true, processed: 0 });
    }

    let processed = 0;
    try {
      for (const event of events) {
        if (event?.type === "unsend") {
          const unsendMessageId = event?.unsend?.messageId;
          if (unsendMessageId) {
            logger.info({ unsendMessageId }, "LINE unsend event received: removing message");
            try {
              await pool.query(
                `DELETE FROM message_attachments WHERE message_id IN (SELECT id FROM messages WHERE external_id = $1)`,
                [unsendMessageId]
              );
              await pool.query(`DELETE FROM messages WHERE external_id = $1`, [unsendMessageId]);
            } catch (unsendErr: any) {
              logger.error({ error: unsendErr.message, unsendMessageId }, "Failed to process LINE unsend event");
            }
          }
          processed += 1;
          continue;
        }

        const sourceType = String(event?.source?.type || "");
        if (sourceType === "group" || sourceType === "room") {
          await forwardPromptXWebhook(config.LINE_GROUP_GATEWAY_WEBHOOK_URL, destination, event);
          processed += 1;
          continue;
        }

        const webhookEventId = String(event?.webhookEventId || "").trim();
        // Stage timings for this event. Without them the only way to tell
        // where a slow reply was spent is to guess between the tunnel, the
        // remote database and the LINE API.
        const eventStartedAt = process.hrtime.bigint();
        if (event?.source?.userId) {
          showLineLoadingAnimation(String(event.source.userId)).catch(() => {});
        }
        const decision = await onboardingService.processEvent({
          type: String(event?.type || "unknown"),
          webhookEventId,
          destination,
          userId: event?.source?.userId ? String(event.source.userId) : undefined,
          messageText: event?.message?.type === "text" ? String(event.message.text || "") : undefined,
          postbackData: event?.postback?.data ? String(event.postback.data) : undefined,
          isUnblocked: event?.follow?.isUnblocked === true,
        });
        const decisionMs = elapsedMs(eventStartedAt);

        if (decision.duplicate || decision.action === "IGNORE") {
          processed += 1;
          continue;
        }
        try {
          if (decision.action === "REPLY") {
            const replyStartedAt = process.hrtime.bigint();

            // "ปิดเคส" carousel card (two-step close, 2026-09-07): the same
            // deterministic handler that answers the typed word decides what
            // to say — no open case → "ไม่มีเคสที่เปิดอยู่", one case → the close
            // question with chips, several → the list. It pushes its own
            // message, so the canned prompt below is only the fallback when
            // the handler could not act.
            let menuCloseHandled = false;
            if (decision.reason === "close_case_prompt" && decision.conversationId) {
              try {
                const outcome = await customerConfirmationHandler.handle({
                  conversationId: Number(decision.conversationId),
                  text: "ปิดเคส",
                  correlationId: webhookEventId,
                });
                menuCloseHandled = outcome.handled;
                if (outcome.handled) {
                  await pool.query(
                    `INSERT INTO messages (conversation_id, role, content, message_type, external_id, created_at)
                     VALUES ($1, 'customer', $2, 'text', $3, NOW())
                     ON CONFLICT (conversation_id, external_id) DO NOTHING`,
                    [decision.conversationId, "ปิดเคส", `${webhookEventId}:menu_tap`]
                  ).catch(() => {});
                  logger.info(
                    { webhookEventId, conversationId: decision.conversationId, reason: outcome.reason, ticketId: outcome.ticketId },
                    "Close-menu tap answered by the confirmation handler"
                  );
                }
              } catch (menuErr: any) {
                logger.error({ error: menuErr.message, webhookEventId }, "Close-menu handler failed; falling back to the canned prompt");
              }
            }
            if (menuCloseHandled) {
              processed += 1;
              continue;
            }

            await sendLineReply(String(event.replyToken || ""), decision);
            // The close-menu exchange must reach the AI's conversation history:
            // the gate can only route the customer's follow-up ("TCK-... ครับ")
            // to CLOSE when it can see that the previous assistant turn asked
            // which case to close (live run r1KD5VIzkKeCJ9kBObrHR misrouted to
            // GET_STATUS exactly because this canned prompt was never
            // persisted). Deliberately ONLY the close prompt: the report and
            // status prompt variants contain "ปุ่มด้านล่าง", which the gate's
            // deterministic confirmation net reads as an awaiting-confirmation
            // marker. NULL message_purpose keeps both rows visible to the
            // history query (it filters only 'notification').
            if (decision.reason === "close_case_prompt" && decision.conversationId && decision.replyText) {
              try {
                await pool.query(
                  `INSERT INTO messages (conversation_id, role, content, message_type, external_id, created_at)
                   VALUES ($1, 'customer', $2, 'text', $3, NOW()),
                          ($1, 'ai', $4, 'text', $5, NOW())
                   ON CONFLICT (conversation_id, external_id) DO NOTHING`,
                  [
                    decision.conversationId,
                    "ปิดเคส",
                    `${webhookEventId}:menu_tap`,
                    decision.replyText,
                    `${webhookEventId}:menu_prompt`,
                  ]
                );
              } catch (persistErr: any) {
                logger.error(
                  { error: persistErr.message, webhookEventId, conversationId: decision.conversationId },
                  "Failed to persist close-menu exchange"
                );
              }
            }
            logger.info(
              {
                webhookEventId,
                eventType: String(event?.type || "unknown"),
                reason: decision.reason,
                decisionMs,
                replyMs: elapsedMs(replyStartedAt),
                totalMs: elapsedMs(eventStartedAt),
              },
              "LINE event handled"
            );
          } else if (decision.action === "PASS_TO_AI") {
            if (event?.type === "message" && event?.message?.type === "image" && event?.message?.id) {
              const imageId = String(event.message.id);
              let imageIngested = false;
              let ingestedMessageId: number | null = null;
              let convId = decision.conversationId;
              if (!convId && event?.source?.userId) {
                // The onboarding decision did not name a conversation, so it
                // is resolved from the LINE identity. This must be scoped to
                // the project the decision resolved: a LINE user enrolled in
                // more than one project would otherwise have their image
                // attached to whichever conversation happened to be newest,
                // which can be a different project's thread.
                if (!decision.projectId) {
                  logger.warn(
                    { userId: event.source.userId, imageId },
                    "Skipping image ingest: no project scope resolved for this event"
                  );
                } else {
                  try {
                    const convRes = await pool.query(
                      `SELECT c.id FROM conversations c
                       JOIN identities i ON c.identity_id = i.id
                       WHERE i.channel_ref = $1
                         AND c.project_id = $2
                         AND c.status = 'open'
                         AND c.deleted_at IS NULL
                       ORDER BY c.id DESC LIMIT 1`,
                      [event.source.userId, decision.projectId]
                    );
                    if (convRes.rows.length > 0) {
                      convId = convRes.rows[0].id;
                    } else {
                      logger.warn(
                        { userId: event.source.userId, projectId: decision.projectId },
                        "No open conversation in the resolved project for this LINE identity"
                      );
                    }
                  } catch (convErr: any) {
                    logger.warn({ error: convErr.message }, "Failed to resolve conversation for image");
                  }
                }
              }

              if (convId) {
                try {
                  const { LINEAdapter } = await import("../../presentation/http/adapters/LINEAdapter");
                  const { S3MediaStorageService } = await import("../../media/services/S3MediaStorageService");
                  const mediaStorage = new S3MediaStorageService({});
                  const lineToken = (config.LINE_CHANNEL_ACCESS_TOKEN || "").trim();
                  const lineAdapter = new LINEAdapter(mediaStorage, lineToken);

                  const normalized = await lineAdapter.adaptEvent(event);
                  if (normalized && normalized.attachments.length > 0) {
                    const att = normalized.attachments[0];
                    const savedMsgResult = await pool.query(
                      `INSERT INTO messages (conversation_id, role, content, message_type, external_id, quote_token, created_at)
                       VALUES ($1, 'customer', $2, 'image', $3, $4, NOW())
                       ON CONFLICT (conversation_id, external_id) DO UPDATE SET
                         message_type = 'image',
                         quote_token = COALESCE(EXCLUDED.quote_token, messages.quote_token)
                       RETURNING id`,
                      [convId, event.message.text || "", imageId, event.message.quoteToken || null]
                    );
                    const messageId = savedMsgResult.rows[0]?.id;
                    if (messageId) {
                      await pool.query(
                        `INSERT INTO message_attachments 
                          (message_id, file_url, thumbnail_url, file_name, file_type, file_size, storage_key, attachment_status, metadata)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, 'READY', $8)
                         ON CONFLICT DO NOTHING`,
                        [
                          messageId,
                          att.fileUrl,
                          att.thumbnailUrl || att.fileUrl,
                          att.fileName,
                          att.fileType,
                          att.fileSize,
                          att.storageKey,
                          JSON.stringify(att.metadata || { sourceChannel: "line", lineImageId: imageId })
                        ]
                      );
                      logger.info({ messageId, imageId, storageKey: att.storageKey }, "Auto-ingested LINE image attachment");
                      imageIngested = true;
                      ingestedMessageId = messageId;
                    }
                  }
                } catch (imgErr: any) {
                  logger.error({ error: imgErr.message, imageId }, "Failed to auto-ingest LINE image");
                }
              }

              // An image carries no text for the classifier, so it never goes to
              // the AI. Spec (user, 2026-08-28):
              // - image accompanying a report text (either order): never attach
              //   to an older case and never message about it — the text turn's
              //   promotion collects the image into the NEW ticket; if that
              //   ticket already exists, attach to it directly.
              // - standalone image with a live case: ALWAYS ask first whether it
              //   belongs to the newest case; the reply is handled
              //   deterministically by handlePendingImageReply below.
              // - standalone image, no live case: ask for a one-line description.
              if (imageIngested && convId) {
                void (async () => {
                  try {
                    // Debounce window (10s): wait in background to see if customer sends accompanying text
                    await new Promise((resolve) => setTimeout(resolve, 10000));

                    // Check if customer sent a text message in the last 30 seconds (before or after the image)
                    const recentText = await pool.query(
                      `SELECT id, content, created_at FROM messages
                        WHERE conversation_id = $1::integer
                          AND role = 'customer'
                          AND message_type = 'text'
                          AND created_at >= NOW() - INTERVAL '30 seconds'
                        ORDER BY created_at DESC LIMIT 1`,
                      [convId]
                    );

                    // If text accompanied the image in this turn (within 30s), the AI flow handles both together — do not prompt
                    if (recentText.rows.length > 0) {
                      logger.info(
                        { convId, text: recentText.rows[0].content },
                        "Image accompanied by recent customer text within 30 seconds; AI flow handling turn"
                      );
                      return;
                    }

                    // Standalone image: mark attachment so if customer replies with a ticket number or explanation,
                    // we can attach it deterministically.
                    if (ingestedMessageId) {
                      await pool.query(
                        `UPDATE message_attachments
                            SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"awaitingCaseConfirm": true}'::jsonb
                          WHERE message_id = $1`,
                        [ingestedMessageId]
                      );
                    }

                    // Prompt customer for context ("ได้รับรูปแล้วนะคะ รบกวนพิมพ์อธิบายอาการสั้น ๆ อีกนิดค่ะ...")
                    await customerNotificationService.send({
                      conversationId: Number(convId),
                      notificationType: "image_need_context",
                      idempotencyKey: webhookEventId || `image-${imageId}`,
                      projectId: decision.projectId ?? null,
                      correlationId: webhookEventId,
                    });
                  } catch (attachErr: any) {
                    logger.error(
                      { error: attachErr.message, imageId, conversationId: convId },
                      "Post-ingest image handling failed"
                    );
                  }
                })();
              }

              if (imageIngested) {
                processed += 1;
                continue;
              }
            }

            // Non-image media (a .webp sent as a FILE, videos, voice clips):
            // the pipeline cannot read these, and letting them through meant an
            // acknowledgement plus an empty AI turn (run 4vBCthf81M). Say what
            // works instead, immediately, and end the turn. Stickers are
            // emotional punctuation — consumed silently: no ack, no AI, and
            // telling someone to resend a sticker as PNG would be absurd.
            if (
              event?.type === "message" &&
              ["file", "video", "audio", "sticker"].includes(String(event?.message?.type || ""))
            ) {
              if (event.message.type !== "sticker" && decision.conversationId && webhookEventId) {
                void customerNotificationService
                  .send({
                    conversationId: Number(decision.conversationId),
                    notificationType: "unsupported_file",
                    idempotencyKey: webhookEventId,
                    projectId: decision.projectId ?? null,
                    correlationId: webhookEventId,
                  })
                  .catch((fileErr: any) =>
                    logger.error(
                      { error: fileErr.message, webhookEventId },
                      "Unsupported-file notice failed"
                    )
                  );
              }
              processed += 1;
              continue;
            }

            // Image pre-ingestion (S3 upload) is done immediately above —
            // LINE image URLs expire quickly and must be fetched before batching.

            // --- Fast Path: persist the inbound text, then acknowledge ---
            //
            // The customer's message used to exist only inside the batch
            // payload forwarded to PromptX. Persisting it here means the
            // report survives even if every downstream dependency is down,
            // and gives the acknowledgement something true to acknowledge.
            //
            // Idempotent on (conversation_id, external_id): a LINE retry
            // updates the same row rather than inserting a second copy.
            if (decision.conversationId && event?.type === "message" && event?.message?.type === "text") {
              try {
                await pool.query(
                  `INSERT INTO messages (conversation_id, role, content, message_type, external_id, quote_token, created_at)
                   VALUES ($1, 'customer', $2, 'text', $3, $4, NOW())
                   ON CONFLICT (conversation_id, external_id) DO UPDATE
                     SET content = EXCLUDED.content`,
                  [
                    decision.conversationId,
                    String(event.message.text || ""),
                    String(event.message.id || ""),
                    event.message.quoteToken || null,
                  ]
                );
              } catch (persistErr: any) {
                logger.error(
                  { error: persistErr.message, webhookEventId, conversationId: decision.conversationId },
                  "Failed to persist inbound LINE text message"
                );
              }
            }

            // If this conversation has a ticket waiting on the customer, the
            // reply may be the answer to that question. Handled deterministically
            // and before the AI: closing a ticket is a state transition, and
            // customer text must not reach an LLM that can perform one.
            //
            // Returns handled=false for anything that is not an answer, which
            // is the common case, and processing continues normally.
            let confirmationHandled = false;
            if (decision.conversationId && event?.type === "message" && event?.message?.type === "text") {
              try {
                const outcome = await customerConfirmationHandler.handle({
                  conversationId: Number(decision.conversationId),
                  text: String(event.message.text || ""),
                  correlationId: webhookEventId,
                });
                confirmationHandled = outcome.handled;
                if (outcome.handled) {
                  logger.info(
                    {
                      webhookEventId,
                      conversationId: decision.conversationId,
                      ticketId: outcome.ticketId,
                      from: outcome.from,
                      to: outcome.to,
                    },
                    "Customer reply resolved a pending ticket confirmation"
                  );
                }
              } catch (confirmErr: any) {
                logger.error(
                  { error: confirmErr.message, webhookEventId },
                  "Customer confirmation handling failed"
                );
              }
            }

            // A screenshot question is pending ("รูปนี้เป็นของเคสล่าสุด … ใช่ไหมคะ"):
            // resolve the customer's answer deterministically. Only a clear
            // yes/no/เลขเคส/unique subject match consumes the turn — anything
            // else clears the question and flows to the AI untouched.
            if (!confirmationHandled && decision.conversationId && webhookEventId && event?.message?.type === "text") {
              try {
                const pending = await pool.query(
                  `SELECT ma.id, ma.metadata->>'candidateTicket' AS candidate
                     FROM message_attachments ma
                     JOIN messages m ON m.id = ma.message_id
                    WHERE m.conversation_id = $1::integer
                      AND ma.metadata->>'awaitingCaseConfirm' = 'true'
                      AND COALESCE(ma.metadata->>'planeIssueId', '') = ''
                      AND ma.created_at >= NOW() - INTERVAL '10 minutes'
                    ORDER BY ma.id DESC LIMIT 1`,
                  [decision.conversationId]
                );
                if (pending.rows.length > 0) {
                  const convIdNum = Number(decision.conversationId);
                  const candidate = String(pending.rows[0].candidate || "");
                  const reply = classifyPendingImageReply(String(event.message.text || ""));
                  const clearPending = () =>
                    pool.query(
                      `UPDATE message_attachments ma
                          SET metadata = COALESCE(ma.metadata, '{}'::jsonb) || '{"awaitingCaseConfirm": false}'::jsonb
                         FROM messages m
                        WHERE m.id = ma.message_id
                          AND m.conversation_id = $1::integer
                          AND ma.metadata->>'awaitingCaseConfirm' = 'true'`,
                      [convIdNum]
                    );
                  const notify = (
                    notificationType: "image_attached" | "image_which_case" | "image_case_not_found",
                    ticketNumber?: string
                  ) =>
                    customerNotificationService.send({
                      conversationId: convIdNum,
                      notificationType,
                      ticketNumber: ticketNumber ?? null,
                      idempotencyKey: webhookEventId,
                      projectId: decision.projectId ?? null,
                      correlationId: webhookEventId,
                    });
                  const attachTo = async (ticketNumber: string): Promise<boolean> => {
                    const { PlaneService } = await import("../../services/planeService");
                    const { AdapterFactory } = await import("../../adapters/AdapterFactory");
                    const planeService = new PlaneService(AdapterFactory.getAdapter());
                    const r = await planeService.attachPendingImagesToTicketNumber(convIdNum, ticketNumber);
                    return r.attached > 0;
                  };

                  let consumed = true;
                  if (reply.kind === "yes" && candidate) {
                    if (await attachTo(candidate)) {
                      await clearPending();
                      await notify("image_attached", candidate);
                    } else {
                      await clearPending();
                      await notify("image_case_not_found");
                    }
                  } else if (reply.kind === "ticket" && reply.ticketId) {
                    if (await attachTo(reply.ticketId)) {
                      await clearPending();
                      await notify("image_attached", reply.ticketId);
                    } else {
                      // Wrong or dead number — keep the question open for a retry.
                      await notify("image_case_not_found");
                    }
                  } else if (reply.kind === "no") {
                    await notify("image_which_case");
                  } else {
                    const live = await pool.query(
                      `SELECT ticket_number, subject FROM tickets
                        WHERE conversation_id = $1::integer
                          AND deleted_at IS NULL
                          AND plane_issue_id IS NOT NULL AND plane_issue_id <> ''
                          AND UPPER(COALESCE(status, '')) NOT IN ('CLOSED', 'CANCELLED')
                        ORDER BY id DESC LIMIT 5`,
                      [convIdNum]
                    );
                    const bySubject = matchTicketBySubject(String(event.message.text || ""), live.rows);
                    if (bySubject && (await attachTo(bySubject))) {
                      await clearPending();
                      await notify("image_attached", bySubject);
                    } else {
                      // Not an answer to the question — likely a new report.
                      // Drop the pending question and process the text normally.
                      await clearPending();
                      consumed = false;
                    }
                  }
                  if (consumed) {
                    processed += 1;
                    continue;
                  }
                }
              } catch (pendErr: any) {
                logger.error(
                  { error: pendErr.message, webhookEventId },
                  "Pending image reply handling failed; message continues to the AI"
                );
              }
            }

            // Pure greeting / thanks: answer completely at the edge and skip
            // the AI turn (user decision 2026-08-27). The inbound text is
            // already persisted above; the reply is idempotent on the event id
            // and recorded as a notification, so it stays out of AI history.
            if (!confirmationHandled && decision.conversationId && webhookEventId && event?.message?.type === "text") {
              const smallTalk = detectPureSmallTalk(String(event.message.text || ""));
              if (smallTalk) {
                void customerNotificationService
                  .send({
                    conversationId: Number(decision.conversationId),
                    notificationType: smallTalk,
                    idempotencyKey: webhookEventId,
                    projectId: decision.projectId ?? null,
                    correlationId: webhookEventId,
                  })
                  .catch((stErr: any) =>
                    logger.error(
                      { error: stErr.message, webhookEventId },
                      "Small-talk edge reply failed"
                    )
                  );
                processed += 1;
                continue;
              }
            }

            // --- B-0: mint the server-owned execution context ---
            //
            // Created here, after signature verification and identity /
            // project / conversation resolution, so the tenant facts are
            // established by trusted code before AgentX ever runs.
            //
            // The token travels OUT OF BAND in payload.ticketx, never inside
            // the message text. A customer who types something that looks
            // like a context marker is typing plain text: it is not read from
            // there, and it is not forgeable in any case.
            let executionToken: string | undefined;
            let executionContextId: string | undefined;
            if (decision.conversationId && decision.projectId) {
              try {
                const convTenant = await pool.query(
                  `SELECT org_id, identity_id FROM conversations WHERE id = $1 LIMIT 1`,
                  [decision.conversationId]
                );
                const orgId = convTenant.rows[0]?.org_id;
                if (orgId) {
                  const created = await executionContextService.create({
                    channel: "line",
                    lineEventId: webhookEventId,
                    identityId: convTenant.rows[0]?.identity_id ?? null,
                    conversationId: Number(decision.conversationId),
                    projectId: Number(decision.projectId),
                    orgId: String(orgId),
                    correlationId: webhookEventId || undefined,
                  });
                  executionToken = created.token;
                  // Carried separately: the queue persists its payload, so it
                  // stores this id and re-derives the token at dispatch rather
                  // than keeping a usable capability in a database row.
                  executionContextId = created.context.contextId;

                  await traceRecorder.record({
                    correlationId: created.context.correlationId,
                    component: "line_webhook",
                    eventType: "message_received",
                    lineEventId: webhookEventId,
                    conversationId: created.context.conversationId,
                    identityId: created.context.identityId,
                    projectId: created.context.projectId,
                    orgId: created.context.orgId,
                    detail: { messageType: event?.message?.type || event?.type },
                  });
                }
              } catch (ctxErr: any) {
                logger.error(
                  { error: ctxErr.message, webhookEventId },
                  "Could not create execution context; downstream tool calls will fail closed"
                );
              }
            }

            // Fast-path acknowledgement (restored 2026-08-27 by user decision,
            // now with randomized wording in CustomerNotificationService so
            // consecutive turns never repeat the same line). Fires before any
            // AI work so the customer hears back immediately. Idempotent on
            // webhookEventId: a LINE retry cannot produce a second bubble, and
            // the deterministic variant pick means a retry could not even
            // produce different wording.
            if (decision.conversationId && webhookEventId && event?.type === "message" && !confirmationHandled) {
              const msgText = String(event?.message?.text || "").trim();
              const tailPattern = "(?:[\\s.,!ๆ555คะครับค่ะคับค้าบคร้าบจ้าจ้ะงับฮะฮับนะน้าอ้วนผมวะอ่ะแอดมินพี่คุณ]*)$";
              const isActionTurn =
                new RegExp(`^(?:ครับ|ค่ะ|คับ|ค้าบ|คร้าบ|ค่า|ค๊า|ฮับ|ฮะ|งับ|จ้า|จ้ะ|จร้า|อือ|อื้อ|เค|k|ok|yes|yup|yep|sure|confirm|จัดไป|ลุย|ลุยเลย|เอาเลย|ตามนั้น|เปิดเลย|เปิดเคสเลย|จัดการเลย|จัดให้หน่อย|ถูก|ถูกต้อง|ถูกแล้ว|ใช่|ใช่เลย|ใช่แล้ว|ช่าย|โอเค|ได้|ได้เลย|ได้หมด|ยกเลิก|cancel|ไม่เอา|ไม่ต้อง|ไม่แจ้ง|ช่างมัน|แก้ได้แล้ว|ทำได้แล้ว|หายแล้ว|รีเซ็ต|reset|พิมพ์ผิด|เปลี่ยนใจ|ไม่เป็นไร|อย่าเพิ่ง|no|nope|❌|👍|✅)${tailPattern}`, "i").test(msgText) ||
                /(?:ยืนยัน|ถูกต้อง|ถูกแล้ว|ใช่เลย|โอเค|ได้เลย|เปิดเคสเลย|จัดไป|ตามนั้น|ส่งรูป|นี่รูป|รูปปัญหา|ภาพปัญหา|แนบรูป|ยกเลิก|cancel|ไม่เอาแล้ว|ไม่ต้องแล้ว|ไม่แจ้งแล้ว|ช่างมัน|แก้ได้แล้ว|ทำได้แล้ว|รีเซ็ต|reset|พิมพ์ผิด|เปลี่ยนใจ|ไม่เป็นไรแล้ว|อย่าเพิ่งเปิด)/i.test(msgText) ||
                /(?:^|\s|[.,!])(?:ใช่|ถูก|โอเค|ok|ได้|ครับ|ค่ะ|คับ|งับ|ฮะ|จ้า|เค|ยกเลิก|ไม่เอา|ไม่ต้อง)/i.test(msgText);

              const ackUserId = event?.source?.userId ? String(event.source.userId) : "";
              void customerNotificationService
                .send({
                  conversationId: Number(decision.conversationId),
                  notificationType: isActionTurn ? "acknowledgement_action" : "acknowledgement",
                  idempotencyKey: webhookEventId,
                  projectId: decision.projectId ?? null,
                  correlationId: webhookEventId,
                })
                .then((ackResult: any) => {
                  // Phase B of the typing indicator. The ack push just
                  // dismissed the indicator armed at receipt, and the batch
                  // debounce (15 s) plus queue hand-off are silent otherwise.
                  // Re-arm it now; the worker keeps it alive from dispatch
                  // until the AI reply row lands.
                  if (ackResult?.sent && ackUserId) {
                    return showLineLoadingAnimation(ackUserId, 20);
                  }
                  return undefined;
                })
                .catch((ackErr: any) =>
                  logger.error(
                    { error: ackErr.message, webhookEventId },
                    "Failed to send customer acknowledgement"
                  )
                );
            }

            if (confirmationHandled) {
              // The turn is complete: the ticket transitioned and the customer
              // was told. Forwarding it to the AI as well would produce a
              // second, contradictory reply.
              processed += 1;
              continue;
            }

            if (config.LINE_BATCH_ENABLED && event?.source?.userId) {
              // Enqueue for debounced batch forwarding.
              // This is synchronous (no await) — webhook returns HTTP 200 to LINE immediately.
              batchingService.enqueue(
                String(event.source.userId),
                destination,
                event,
                {
                  projectId: decision.projectId,
                  projectName: decision.projectName,
                  conversationId: decision.conversationId,
                  pushOnboardingCarousel: decision.pushOnboardingCarousel,
                  // Out-of-band capability token. Never placed in the message.
                  executionToken,
                  executionContextId,
                  correlationId: webhookEventId,
                }
              );
              // The 24-hour carousel recall push is sent immediately (not batched) —
              // it is a one-time push notification independent of the AI response.
              if (decision.pushOnboardingCarousel && event?.source?.userId) {
                try {
                  await sendLinePushMessages(
                    String(event.source.userId),
                    [buildLineOnboardingCarousel(config.BACKEND_PUBLIC_URL)],
                    true
                  );
                } catch (carouselError: any) {
                  logger.error(
                    { error: carouselError.message, webhookEventId },
                    "LINE message batched but the 24-hour carousel recall push failed"
                  );
                }
              }
            } else {
              // Batching disabled — route through queue service if available or fallback directly
              if (decision.conversationId && queueService && queueWorker) {
                const sourceEventId = String(event.webhookEventId || event.message?.id || `event-${Date.now()}`);
                await queueService.enqueue({
                  conversationId: decision.conversationId,
                  sourceEventId,
                  channel: "line",
                  senderRef: String(event.source?.userId || "unknown"),
                  destination,
                  projectId: decision.projectId,
                  payload: {
                    destination,
                    events: [event],
                    ticketx: {
                      onboardingVerified: true,
                      projectId: decision.projectId,
                      projectName: decision.projectName,
                      conversationId: decision.conversationId,
                      // B-0: the third forward site. Batch (590) and direct (650) already
                      // carry the token; this queue path silently dropped it, so every
                      // queued turn reached the flow with an empty execution_token and
                      // Plane promotion failed closed.
                      executionToken,
                      correlationId: webhookEventId || undefined,
                    },
                  },
                  sequenceAt: new Date(),
                });
                queueWorker.dispatchConversation(decision.conversationId).catch((workerErr: any) => {
                  logger.error(
                    { error: workerErr.message, conversationId: decision.conversationId },
                    "[line-webhook] Failed in dispatched queue worker"
                  );
                });
              } else {
                await forwardPromptXWebhook(config.LINE_DM_GATEWAY_WEBHOOK_URL, destination, event, {
                  onboardingVerified: true,
                  projectId: decision.projectId,
                  projectName: decision.projectName,
                  conversationId: decision.conversationId,
                  // B-0: the batch path already carries this; the direct path dropped it, so
                  // every non-batched turn reached the flow with an empty execution_token and
                  // Plane promotion failed closed (403 EXECUTION_CONTEXT_REQUIRED).
                  executionToken,
                  correlationId: webhookEventId || undefined,
                });
              }

              if (decision.pushOnboardingCarousel && event?.source?.userId) {
                try {
                  await sendLinePushMessages(
                    String(event.source.userId),
                    [buildLineOnboardingCarousel(config.BACKEND_PUBLIC_URL)],
                    true
                  );
                } catch (carouselError: any) {
                  logger.error(
                    { error: carouselError.message, webhookEventId },
                    "LINE AI forwarding succeeded but the 24-hour carousel recall push failed"
                  );
                }
              }
            }

            // The AI's own reply is sent later, by the flow — this measures
            // only the backend's share of the turn, up to hand-off.
            logger.info(
              {
                webhookEventId,
                eventType: String(event?.type || "unknown"),
                reason: decision.reason,
                batched: Boolean(config.LINE_BATCH_ENABLED && event?.source?.userId),
                decisionMs,
                handoffMs: elapsedMs(eventStartedAt),
              },
              "LINE event handed to AI"
            );
          }
        } catch (deliveryError) {
          await onboardingService.releaseWebhookEventForRetry(webhookEventId);
          throw deliveryError;
        }
        processed += 1;
      }
      return reply.code(200).send({ success: true, processed });
    } catch (error: any) {
      logger.error(
        {
          error: error.message,
          stack: error.stack,
          response: error.response?.data,
        },
        "LINE webhook processing failed"
      );
      return reply.code(503).send({
        error: "LINE webhook processing failed",
        details: error.response?.data || error.message,
      });
    }
  });

  fastify.get("/api/v1/admin/projects/:projectId/join-code", adminRouteOptions, async (request, reply) => {
    const projectId = requireProjectId((request.params as any).projectId);
    const status = await onboardingService.getJoinCodeStatus(projectId, request.tenantContext.orgId);
    if (!status) return reply.code(404).send({ error: "Project not found" });
    return reply.send({ success: true, data: status });
  });

  fastify.post("/api/v1/admin/projects/:projectId/join-code/rotate", adminRouteOptions, async (request, reply) => {
    const projectId = requireProjectId((request.params as any).projectId);
    const body = (request.body || {}) as any;
    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
    if (expiresAt && Number.isNaN(expiresAt.getTime())) {
      return reply.code(400).send({ error: "Invalid expiresAt" });
    }
    const result = await onboardingService.rotateJoinCode({
      projectId,
      orgId: request.tenantContext.orgId,
      createdBy: request.tenantContext.correlationId,
      expiresAt,
    });
    return reply.send({
      success: true,
      data: result,
      warning: "The plaintext code is returned once. Store and distribute it securely.",
    });
  });

  fastify.delete("/api/v1/admin/projects/:projectId/join-code", adminRouteOptions, async (request, reply) => {
    const projectId = requireProjectId((request.params as any).projectId);
    const revoked = await onboardingService.revokeJoinCode(projectId, request.tenantContext.orgId);
    return reply.send({ success: true, revoked });
  });

  fastify.get("/api/v1/admin/line-onboarding/requests", adminRouteOptions, async (request, reply) => {
    const result = await pool.query(
      `SELECT id, line_user_id, destination, requested_details, status,
              resolved_project_id, created_at, updated_at
       FROM line_onboarding_requests
       WHERE org_id = $1
       ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, created_at DESC
       LIMIT 200`,
      [request.tenantContext.orgId]
    );
    return reply.send({ success: true, data: result.rows });
  });

  fastify.post("/api/v1/admin/line-onboarding/requests/:requestId/resolve", adminRouteOptions, async (request, reply) => {
    const requestId = requireProjectId((request.params as any).requestId);
    const projectId = requireProjectId((request.body as any)?.projectId);
    const result = await onboardingService.resolveManualRequest({
      requestId,
      projectId,
      orgId: request.tenantContext.orgId,
    });
    let notificationDelivered = false;
    try {
      await sendLinePush(
        result.lineUserId,
        `เจ้าหน้าที่เช็กให้แล้วนะคะ บัญชีเชื่อมกับโปรเจกต์ “${result.projectName}” เรียบร้อยแล้ว ✅ พร้อมใช้งานได้เลยค่ะ`
      );
      notificationDelivered = true;
    } catch (error: any) {
      logger.error(
        { error: error.message, requestId, projectId },
        "Manual onboarding was resolved but the LINE confirmation push failed"
      );
    }
    return reply.send({ success: true, data: result, notificationDelivered });
  });

  fastify.post("/api/v1/admin/line-onboarding/requests/:requestId/reject", adminRouteOptions, async (request, reply) => {
    const requestId = requireProjectId((request.params as any).requestId);
    const rejected = await onboardingService.rejectManualRequest(requestId, request.tenantContext.orgId);
    if (!rejected) return reply.code(404).send({ error: "Pending onboarding request not found" });
    return reply.send({ success: true, rejected: true });
  });

  // Admin observability routes for Agent Session Queue
  fastify.get("/api/v1/admin/queue/status", adminRouteOptions, async (_request, reply) => {
    if (!queueService) return reply.code(503).send({ error: "Queue service is not configured" });
    const status = await queueService.getQueueStatus();
    return reply.send({ success: true, data: status });
  });

  fastify.get("/api/v1/admin/queue/items", adminRouteOptions, async (request, reply) => {
    if (!queueService) return reply.code(503).send({ error: "Queue service is not configured" });
    const query = (request.query || {}) as any;
    const conversationId = query.conversationId ? Number(query.conversationId) : undefined;
    const status = query.status ? String(query.status) : undefined;
    const limit = query.limit ? Number(query.limit) : undefined;
    const items = await queueService.getQueueItems({ conversationId, status, limit });
    return reply.send({ success: true, data: items });
  });

  fastify.post("/api/v1/admin/queue/recover", adminRouteOptions, async (_request, reply) => {
    if (!queueService) return reply.code(503).send({ error: "Queue service is not configured" });
    const result = await queueService.recoverExpiredLeases();
    return reply.send({ success: true, data: result });
  });
}
