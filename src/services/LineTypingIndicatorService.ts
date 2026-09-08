import axios from "axios";
import https from "node:https";
import { Pool } from "pg";
import { createLogger } from "../observability/logger";

const logger = createLogger("line-typing-indicator");

/**
 * LINE's loading animation ("typing" bubble) for 1:1 chats.
 *
 * Facts that shape everything below (Messaging API contract):
 * - It is displayed only in the smartphone app, only while the customer is
 *   looking at the chat; never on LINE for PC.
 * - `loadingSeconds` must be a multiple of five between 5 and 60. LINE
 *   rejects anything else with HTTP 400 - the indicator never appeared for
 *   weeks because a caller sent 3.
 * - There is no "stop" endpoint. It disappears when the time elapses or when
 *   the OA sends ANY message (so the fast-path acknowledgement dismisses it).
 *   Calling start again resets the timer, which is how it is kept alive.
 *
 * Because there is no stop, the keep-alive deliberately uses short windows
 * refreshed often: if the AI reply lands between two refreshes, the orphaned
 * indicator can only outlive it by one window.
 */
export interface WaitForReplyOptions {
  conversationId: number;
  /** LINE user id; when present the indicator is refreshed while waiting. */
  userId?: string | null;
  /** `latestMessageId()` captured before the turn was dispatched. */
  sinceMessageId: number;
  timeoutMs: number;
  pollMs?: number;
  refreshSeconds?: number;
}

export interface WaitForReplyResult {
  replied: boolean;
  elapsedMs: number;
  polls: number;
}

export class LineTypingIndicatorService {
  private readonly httpsAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 30_000,
    maxSockets: 8,
    maxFreeSockets: 4,
  });

  constructor(
    private readonly pool: Pool,
    private readonly channelAccessToken: string
  ) {}

  /** Only 1:1 chats render the indicator; group/room ids are skipped. */
  static isDirectUserId(userId: string | null | undefined): boolean {
    return /^U[0-9a-f]{32}$/i.test(String(userId || ""));
  }

  /**
   * Shows (or re-arms) the indicator. Failure is non-fatal - this is a UX
   * affordance, not part of the reply - but it is logged, not swallowed.
   */
  async show(userId: string | null | undefined, seconds = 5): Promise<void> {
    if (!LineTypingIndicatorService.isDirectUserId(userId) || !this.channelAccessToken) return;
    const loadingSeconds = Math.min(60, Math.max(5, Math.round(seconds / 5) * 5));
    try {
      await axios.post(
        "https://api.line.me/v2/bot/chat/loading/start",
        { chatId: userId, loadingSeconds },
        {
          headers: {
            Authorization: `Bearer ${this.channelAccessToken}`,
            "Content-Type": "application/json",
          },
          timeout: 3000,
          httpsAgent: this.httpsAgent,
        }
      );
    } catch (err: any) {
      logger.warn(
        {
          status: err.response?.status,
          data: err.response?.data,
          message: err.message,
          loadingSeconds,
        },
        "LINE loading animation rejected"
      );
    }
  }

  /**
   * High-water mark for reply detection. Id-based rather than time-based so a
   * skew between this host and PostgreSQL cannot hide or invent a reply.
   */
  async latestMessageId(conversationId: number): Promise<number> {
    const res = await this.pool.query<{ max_id: string | number | null }>(
      `SELECT COALESCE(MAX(id), 0) AS max_id FROM messages WHERE conversation_id = $1`,
      [conversationId]
    );
    return Number(res.rows[0]?.max_id || 0);
  }

  /**
   * Has the assistant replied since the mark? The AI flow persists every
   * reply as role 'ai' with no message_purpose; backend acknowledgements are
   * 'notification' and must not count, or the wait would end on the ack.
   */
  async hasReplySince(conversationId: number, sinceMessageId: number): Promise<boolean> {
    const res = await this.pool.query(
      `SELECT 1
       FROM messages
       WHERE conversation_id = $1
         AND id > $2
         AND role = 'ai'
         AND COALESCE(message_purpose, '') <> 'notification'
       LIMIT 1`,
      [conversationId, sinceMessageId]
    );
    return (res.rowCount || 0) > 0;
  }

  /**
   * Blocks until the AI reply row lands or the deadline passes, refreshing
   * the indicator between polls. Never throws: a database hiccup ends one
   * poll, not the turn.
   */
  async waitForReply(options: WaitForReplyOptions): Promise<WaitForReplyResult> {
    const startedAt = Date.now();
    const pollMs = Math.max(1000, options.pollMs ?? 5000);
    const refreshSeconds = options.refreshSeconds ?? 10;
    const deadline = startedAt + Math.max(pollMs, options.timeoutMs);
    let polls = 0;

    while (Date.now() < deadline) {
      polls += 1;
      try {
        if (await this.hasReplySince(options.conversationId, options.sinceMessageId)) {
          return { replied: true, elapsedMs: Date.now() - startedAt, polls };
        }
      } catch (err: any) {
        logger.warn(
          { conversationId: options.conversationId, error: err.message },
          "Reply poll failed; will retry on the next tick"
        );
      }
      if (options.userId) await this.show(options.userId, refreshSeconds);
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remaining)));
    }
    return { replied: false, elapsedMs: Date.now() - startedAt, polls };
  }
}
