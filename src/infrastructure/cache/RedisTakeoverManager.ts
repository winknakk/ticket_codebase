import Redis from "ioredis";
import { config } from "../../config/env";
import { getProjectId } from "../../kernel/context/RequestContextHolder";
import { createLogger } from "../../observability/logger";
import { RoomStatus } from "../../schemas/aiops";
import { createRedisClient } from "../../infrastructure/cache/createRedisClient";

const logger = createLogger("RedisTakeoverManager");

export class RedisTakeoverManager {
  private redis: Redis;

  constructor() {
    this.redis = createRedisClient("redis-takeover-manager", {
      maxRetriesPerRequest: 3,
      enableOfflineQueue: true,
    });
    this.redis.on("error", (err) => {
      logger.error({ error: err.message }, "RedisTakeoverManager Redis connection error");
    });
  }

  private getLeaseKey(conversationId: string): string {
    const projectId = getProjectId() || "1";
    return `project:${projectId}:takeover:${conversationId}`;
  }

  /**
   * Acquires a takeover session lease in Redis for a specific duration.
   */
  async acquireLease(
    convId: string,
    agentId: string,
    durationMs: number,
    status: Exclude<RoomStatus, "ACTIVE_AI">,
    isReply = false,
    maxDurationMs = durationMs
  ): Promise<{
    status: Exclude<RoomStatus, "ACTIVE_AI">;
    agentId: string;
    startedAt: number;
    expiresAt: number;
    maxExpiresAt: number;
    lastHumanReplyAt: number | null;
  }> {
    const key = this.getLeaseKey(convId);
    const now = Date.now();
    const existingRaw = await this.redis.get(key);
    let existing: any = null;
    try {
      existing = existingRaw ? JSON.parse(existingRaw) : null;
    } catch {
      existing = null;
    }

    const continuingActiveSession = status === "ACTIVE_HUMAN" && existing?.status === "ACTIVE_HUMAN";
    const startedAt = continuingActiveSession && Number.isFinite(existing?.startedAt)
      ? existing.startedAt
      : now;
    const maxExpiresAt = continuingActiveSession && Number.isFinite(existing?.maxExpiresAt)
      ? existing.maxExpiresAt
      : startedAt + maxDurationMs;
    const expiresAt = Math.min(now + durationMs, maxExpiresAt);
    const lastHumanReplyAt = isReply
      ? now
      : continuingActiveSession
        ? existing?.lastHumanReplyAt || null
        : null;
    const lease = { status, agentId, startedAt, expiresAt, maxExpiresAt, lastHumanReplyAt };
    const value = JSON.stringify(lease);
    const ttlSeconds = Math.max(1, Math.ceil((expiresAt - now) / 1000));
    await this.redis.setex(key, ttlSeconds, value);
    logger.info({ convId, agentId, status, durationMs, expiresAt, maxExpiresAt, key }, "Acquired takeover lease in Redis");
    return lease;
  }

  /**
   * Deletes a takeover lease immediately.
   */
  async releaseLease(convId: string): Promise<void> {
    const key = this.getLeaseKey(convId);
    await this.redis.del(key);
    logger.info({ convId, key }, "Released takeover lease in Redis");
  }

  /**
   * Checks the current state of a takeover lease lock.
   */
  async checkLeaseStatus(convId: string): Promise<{
    active: boolean;
    status?: Exclude<RoomStatus, "ACTIVE_AI">;
    agentId?: string;
    startedAt?: number;
    expiresAt?: number;
    maxExpiresAt?: number;
    lastHumanReplyAt?: number | null;
  }> {
    const key = this.getLeaseKey(convId);
    const raw = await this.redis.get(key);
    if (!raw) {
      return { active: false };
    }
    try {
      const data = JSON.parse(raw);
      const now = Date.now();
      if (now > data.expiresAt) {
        await this.redis.del(key);
        return { active: false };
      }
      return {
        active: true,
        status: data.status === "PENDING_HUMAN" ? "PENDING_HUMAN" : "ACTIVE_HUMAN",
        agentId: data.agentId,
        startedAt: data.startedAt,
        expiresAt: data.expiresAt,
        maxExpiresAt: data.maxExpiresAt,
        lastHumanReplyAt: data.lastHumanReplyAt || null,
      };
    } catch (err: any) {
      logger.warn({ key, error: err.message }, "Failed to parse lease from Redis. Reverting to inactive.");
      return { active: false };
    }
  }

  /**
   * Disconnects the Redis connection client.
   */
  async disconnect(): Promise<void> {
    await this.redis.quit();
  }
}
