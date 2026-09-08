import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { randomUUID, createHash } from "crypto";
import path from "path";
import { JwtUtil } from "../../../shared/jwt";
import { pool } from "../../../adapters/postgres/PostgresAdapter";
import { nextSequenceId } from "../../../adapters/postgres/sequences";
import { PostgresConversationRepository } from "../../../infrastructure/db/PostgresConversationRepository";
import { PostgresMessageRepository } from "../../../infrastructure/db/PostgresMessageRepository";
import { PostgresIdentityRepository } from "../../../infrastructure/db/PostgresIdentityRepository";
import { PostgresProfileRepository } from "../../../infrastructure/db/PostgresProfileRepository";
import { PostgresWebChatSessionRepository } from "../../../infrastructure/db/PostgresWebChatSessionRepository";
import { Conversation } from "../../../domain/entities/Conversation";
import { Message } from "../../../domain/entities/Message";
import { Profile } from "../../../domain/entities/Profile";
import { Identity } from "../../../domain/entities/Identity";
import { WebChatSession } from "../../../domain/entities/WebChatSession";
import { QueueFactory } from "../../../queue/QueueFactory";
import { config } from "../../../config/env";
import { createLogger } from "../../../observability/logger";
import Redis from "ioredis";
import { createRedisClient } from "../../../infrastructure/cache/createRedisClient";
import { getWebchatJwtSecret } from "../../../middleware/customerAuth";
import { TakeoverManager } from "../../../human-takeover/TakeoverManager";
import { S3MediaStorageService } from "../../../media/services/S3MediaStorageService";
import { adminSocketRegistry } from "../../../api/AdminSocketRegistry";

const logger = createLogger("WebChatGateway");

// In-memory registry of active WebSocket sockets grouped by conversationId room
const activeConnections = new Map<string, Set<any>>();

interface EphemeralWsTicket {
  identityId: string;
  profileId: string;
  companyId: string;
  projectId: string;
  channelRef: string;
  role: string;
  expiresAt: number;
}

const wsTickets = new Map<string, EphemeralWsTicket>();

// Periodic cleanup of expired tickets
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, val] of wsTickets.entries()) {
    if (val.expiresAt <= now) {
      wsTickets.delete(key);
    }
  }
}, 30_000);
if (typeof (cleanupInterval as any).unref === "function") {
  (cleanupInterval as any).unref();
}

// Redis Pub/Sub subscriber client for horizontal scaling
let redisSub: Redis | null = null;

const HandshakeSchema = z.object({
  customerToken: z.string().optional(),
  guestUuid: z.string().optional(),
  companyId: z.string().optional(),
  projectId: z.string().optional()
});

/**
 * Backend-owned quick actions for the web portal.
 *
 * Deliberately NOT driven by LineProjectOnboardingService: its entry point takes
 * a LINE webhook event and dedupes against line_onboarding_sessions, so feeding
 * web traffic through it would fabricate LINE events and mix two channels'
 * state. The LINE menu also solves a problem the portal does not have — a LINE
 * user is anonymous until they link a project, while a portal user arrives
 * authenticated with a project already resolved.
 *
 * The values are an enum the client echoes back; they are matched, never
 * executed, and identity is always taken from the WS ticket.
 */
export type WebChatAction = { label: string; value: string; style?: "primary" | "default" };

export const WEBCHAT_ACTIONS: Record<string, WebChatAction> = {
  start: { label: "🚀 เริ่มใช้งาน", value: "start" },
  report_issue: { label: "📝 แจ้งปัญหา", value: "report_issue", style: "primary" },
  check_status: { label: "🔍 ตรวจสอบสถานะ", value: "check_status" },
  close_case: { label: "✅ ปิดเคส", value: "close_case" },
  change_project: { label: "🔄 เปลี่ยนโปรเจกต์", value: "change_project" },
  connect_new: { label: "🔗 เชื่อมใหม่", value: "connect_new" },
};

/** The greeting the portal shows when a conversation has no history yet. */
function buildWebChatMenu(): { text: string; actions: WebChatAction[] } {
  return {
    text: "สวัสดีค่ะ ยินดีต้อนรับสู่ศูนย์บริการ TicketX ค่ะ! ต้องการให้ช่วยเรื่องไหนดีคะ เลือกจากเมนูด้านล่าง หรือพิมพ์แจ้งเรื่องได้เลยค่ะ",
    actions: [
      WEBCHAT_ACTIONS.start,
      WEBCHAT_ACTIONS.report_issue,
      WEBCHAT_ACTIONS.check_status,
      WEBCHAT_ACTIONS.close_case,
      WEBCHAT_ACTIONS.change_project,
      WEBCHAT_ACTIONS.connect_new,
    ],
  };
}

/**
 * Reply to a tapped chip. Returns null for anything not in the enum, so an
 * unknown value falls through to the normal AI path instead of being trusted.
 */
function resolvePostback(value: string): { text: string; actions?: WebChatAction[] } | null {
  switch (value) {
    case "start":
      return {
        text: "👋 ยินดีต้อนรับสู่ TicketX Support ค่ะ! ท่านสามารถสอบถามข้อสงสัย แจ้งปัญหาการใช้งาน หรือติดตามสถานะตั๋วงานได้ตลอดเวลาเลยนะคะ",
        actions: [
          WEBCHAT_ACTIONS.report_issue,
          WEBCHAT_ACTIONS.check_status,
          WEBCHAT_ACTIONS.change_project,
        ]
      };
    case "report_issue":
      return {
        text: "ได้เลยค่ะ เล่ารายละเอียดปัญหาที่พบให้ฟังได้เลยนะคะ หรือกดปุ่ม '+ เปิดตั๋วใหม่' ด้านบนเพื่อกรอกแบบฟอร์มและแนบรูปภาพค่ะ",
        actions: [WEBCHAT_ACTIONS.check_status]
      };
    case "check_status":
      return {
        text: "ท่านสามารถดูรายการตั๋วทั้งหมดได้ที่เมนู 'ตั๋วของฉัน' หรือพิมพ์เลขที่ตั๋ว (เช่น TCK-...) เพื่อให้ AI ตรวจสอบสถานะล่าสุดให้ได้ทันทีค่ะ",
        actions: [WEBCHAT_ACTIONS.report_issue, WEBCHAT_ACTIONS.close_case]
      };
    case "close_case":
      return {
        text: "หากปัญหาได้รับการแก้ไขเรียบร้อยแล้ว ท่านสามารถพิมพ์เลขตั๋วงานที่ต้องการปิด หรือแจ้งยืนยันการปิดเคสได้เลยนะคะ",
        actions: [WEBCHAT_ACTIONS.check_status]
      };
    case "change_project":
      return {
        text: "ต้องการสลับโปรเจกต์ใช่ไหมคะ? ท่านสามารถพิมพ์ชื่อโครงการที่ต้องการสลับ หรือกดปุ่ม 'เชื่อมโปรเจกต์ใหม่' ด้านล่างได้เลยค่ะ",
        actions: [WEBCHAT_ACTIONS.connect_new, WEBCHAT_ACTIONS.check_status]
      };
    case "connect_new":
      return {
        // The example here was a live join code for project 101. A bot message
        // reaches guests, so it must describe the format, never a real code.
        text: "กรุณาพิมพ์ **รหัสโครงการ (Project Code รูปแบบ TX-XXXX-XXXX)** หรือรหัส 4 หลัก เพื่อยืนยันและเชื่อมต่อเข้าสู่โครงการใหม่ค่ะ",
      };
    case "show_menu":
      return buildWebChatMenu();
    default:
      return null;
  }
}

export default async function WebChatGateway(fastify: FastifyInstance) {
  const conversationRepo = new PostgresConversationRepository();
  const messageRepo = new PostgresMessageRepository();
  const identityRepo = new PostgresIdentityRepository();
  const profileRepo = new PostgresProfileRepository();
  const sessionRepo = new PostgresWebChatSessionRepository();
  // Same default construction as the Orchestrator's: Redis-backed when
  // CACHE_PROVIDER=redis, otherwise the shared file-backed store. Both read the
  // state /api/v1/internal/sessions/resolve reports, so the gate below and the
  // flow's own check cannot disagree.
  const takeoverManager = new TakeoverManager();

  // Setup Redis Subscriber once
  if (!redisSub) {
    redisSub = createRedisClient("webchat-gateway-sub", { maxRetriesPerRequest: null });
    redisSub.subscribe("webchat:outbound").catch(err => {
      logger.error({ error: err.message }, "Failed to subscribe to Redis outbound channel");
    });
    redisSub.on("message", (channel, message) => {
      if (channel === "webchat:outbound") {
        try {
          const payload = JSON.parse(message);
          const outEvent = payload.event || (payload.type === "takeover_started" ? "takeover_started" : "message");
          const msgPayload = outEvent === "message" ? {
            event: "message",
            data: {
              id: payload.id || randomUUID(),
              role: payload.role || "ai",
              content: payload.text || payload.content || "",
              createdAt: payload.sentAt || new Date().toISOString(),
              attachments: payload.attachments || [],
              actions: Array.isArray(payload.actions) ? payload.actions : undefined
            }
          } : {
            event: outEvent,
            data: {
              conversation_id: String(payload.data?.conversation_id || payload.data?.conversationId || payload.conversationId || ""),
              conversationId: String(payload.data?.conversationId || payload.data?.conversation_id || payload.conversationId || ""),
              state: String(payload.data?.state || payload.data?.status || payload.state || payload.status || "PENDING_HUMAN"),
              status: String(payload.data?.status || payload.data?.state || payload.status || payload.state || "PENDING_HUMAN"),
              reason: String(payload.data?.reason || payload.reason || "ai_escalation"),
              reasonCode: String(payload.data?.reasonCode || payload.reasonCode || "AI_ESCALATED_HUMAN"),
              sentAt: payload.sentAt || payload.data?.sentAt || new Date().toISOString()
            }
          };

          const targetRooms: string[] = [];
          if (payload.conversationId) {
            targetRooms.push(`conversation:${payload.conversationId}`);
          }
          if (payload.recipientId) {
            targetRooms.push(`recipient:${payload.recipientId}`);
          }

          broadcastToRooms(targetRooms, msgPayload);
        } catch (err: any) {
          logger.error({ error: err.message }, "Failed to process Redis pub/sub message");
        }
      }
    });
  }

  /**
   * Endpoint 1: Handshake
   * Yields a short-lived signed JWT for guests or logged-in users.
   * Client-supplied projectId and companyId are treated as UNTRUSTED hints.
   * Authoritative identity, project, and org are resolved server-side.
   */
  fastify.post("/api/v1/webchat/handshake", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const jwtSecret = getWebchatJwtSecret();

      const parsed = HandshakeSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Bad Request",
          message: parsed.error.issues.map(e => `${e.path.join(".")}: ${e.message}`).join(", ")
        });
      }

      const { customerToken, guestUuid, companyId: clientCompanyHint, projectId: clientProjectHint } = parsed.data;

      let isGuest = true;
      let channelRef = "";
      let customerName = "";

      // 1. Identity Proofing Strategy
      if (customerToken) {
        const decoded = JwtUtil.verify(customerToken, jwtSecret);
        if (decoded && decoded.customerId) {
          isGuest = false;
          channelRef = decoded.customerId;
          customerName = decoded.name || `User_${channelRef.slice(0, 6)}`;
        } else {
          return reply.code(401).send({ error: "Unauthorized", message: "Invalid identity proofing token" });
        }
      }

      // 2. Profile & Authoritative Identity Resolution Strategy
      let identity: Identity | null = null;
      let resolvedGuestUuid = guestUuid || randomUUID();
      let authoritativeCompanyId = 1;
      let authoritativeProjectId = 1;

      if (isGuest) {
        channelRef = resolvedGuestUuid;
        identity = await identityRepo.findByChannelAndRef("WebChat", channelRef);

        // Validate guest project hint against active database projects
        const parsedProjHint = clientProjectHint ? parseInt(String(clientProjectHint), 10) : NaN;
        if (!isNaN(parsedProjHint) && parsedProjHint > 0) {
          const projCheck = await pool.query(
            "SELECT id, company_id FROM projects WHERE id = $1 LIMIT 1",
            [parsedProjHint]
          );
          if (projCheck.rows.length > 0) {
            authoritativeProjectId = Number(projCheck.rows[0].id);
            authoritativeCompanyId = Number(projCheck.rows[0].company_id || 1);
          }
        }

        if (!identity) {
          // Dynamic Guest compilation
          const nextProfileIdRes = await pool.query("SELECT COALESCE(MAX(CASE WHEN id::text ~ '^[0-9]+$' THEN id::bigint ELSE 0 END), 0) + 1 AS next_id FROM profiles");
          const nextProfileId = String(nextProfileIdRes.rows[0].next_id);

          const guestProfile = new Profile({
            id: nextProfileId,
            companyId: String(authoritativeCompanyId),
            name: `Guest_${channelRef.slice(0, 8)}`
          });
          await profileRepo.save(guestProfile);

          const nextIdentId = await nextSequenceId(pool, "identities");

          identity = new Identity({
            id: nextIdentId,
            profileId: nextProfileId,
            channel: "WebChat",
            channelRef
          });
          await identityRepo.save(identity);
        }
      } else {
        // Logged-in Customer Resolution
        identity = await identityRepo.findByChannelAndRef("WebChat", channelRef);

        if (!identity) {
          const safeCompanyId = (clientCompanyHint && !isNaN(parseInt(clientCompanyHint, 10))) ? parseInt(clientCompanyHint, 10) : 1;
          const profileCheck = await pool.query(
            "SELECT id, company_id FROM profiles WHERE name = $1 AND company_id = $2 LIMIT 1",
            [customerName, safeCompanyId]
          );

          let profileId = "";
          if (profileCheck.rows.length > 0) {
            profileId = String(profileCheck.rows[0].id);
            authoritativeCompanyId = Number(profileCheck.rows[0].company_id || safeCompanyId);
          } else {
            const nextProfileIdRes = await pool.query("SELECT COALESCE(MAX(CASE WHEN id::text ~ '^[0-9]+$' THEN id::bigint ELSE 0 END), 0) + 1 AS next_id FROM profiles");
            profileId = String(nextProfileIdRes.rows[0].next_id);
            authoritativeCompanyId = safeCompanyId;
            const customerProfile = new Profile({
              id: profileId,
              companyId: String(safeCompanyId),
              name: customerName
            });
            await profileRepo.save(customerProfile);
          }

          const nextIdentId = await nextSequenceId(pool, "identities");

          identity = new Identity({
            id: nextIdentId,
            profileId,
            channel: "WebChat",
            channelRef
          });
          await identityRepo.save(identity);
        } else {
          // Read authoritative companyId from profile
          const profRes = await pool.query("SELECT company_id FROM profiles WHERE id = $1 LIMIT 1", [parseInt(identity.profileId, 10) || 0]);
          if (profRes.rows.length > 0 && profRes.rows[0].company_id) {
            authoritativeCompanyId = Number(profRes.rows[0].company_id);
          }
        }

        // Authoritatively resolve customer's project access from profile_projects and conversations
        const parsedProjHint = clientProjectHint ? parseInt(String(clientProjectHint), 10) : NaN;
        //
        // Ordering is load-bearing, not cosmetic. This used to be a bare UNION
        // whose first row was then taken as the answer, so a customer linked to
        // several projects landed in whichever one the planner happened to emit
        // first: the EX03 customer kept resolving to project 1 and saw an empty
        // portal while 21 of their tickets sat in project 101.
        //
        // Preference, by authority rather than by recency of chatter:
        //   1. an explicit profile_projects grant, most recently granted first
        //   2. the project of their most recent open WebChat conversation
        //   3. the project of their most recent conversation on any channel
        //
        // Membership decides for a signed-in customer; conversation history is
        // only the fallback for a guest who has no grant at all. Ordering the
        // other way round looks reasonable until history is polluted: this
        // customer had been talking in project 1 purely because the old bug put
        // them there, so "most recent conversation" would have kept them there
        // for good while their 21 EX03 tickets stayed invisible.
        // `recency` is only comparable inside one rank — conversation ids at
        // ranks 0/1, epoch seconds at rank 2. DISTINCT ON therefore reduces each
        // project to its own best rank first, and only then are projects ordered
        // against each other. Grouping with MIN(rank)/MAX(recency) instead would
        // let a rank-2 epoch outrank a rank-0 conversation id in the tiebreak.
        const authorizedProjectsRes = await pool.query(
          `SELECT project_id
             FROM (
               SELECT DISTINCT ON (project_id) project_id, rank, recency
                 FROM (
                   SELECT project_id, 0 AS rank,
                          EXTRACT(EPOCH FROM COALESCE(created_at, TIMESTAMP 'epoch'))::bigint AS recency
                     FROM profile_projects
                    WHERE profile_id = $1
                   UNION ALL
                   SELECT project_id, 1 AS rank, id AS recency
                     FROM conversations
                    WHERE identity_id = $2 AND project_id IS NOT NULL
                      AND LOWER(channel) = 'webchat' AND status = 'open'
                   UNION ALL
                   SELECT project_id, 2 AS rank, id AS recency
                     FROM conversations
                    WHERE identity_id = $2 AND project_id IS NOT NULL
                 ) candidates
                ORDER BY project_id, rank ASC, recency DESC
             ) best
            ORDER BY rank ASC, recency DESC`,
          [parseInt(identity.profileId, 10) || 0, parseInt(identity.id, 10) || 0]
        );
        const authorizedProjectIds = authorizedProjectsRes.rows
          .map((r: any) => Number(r.project_id))
          .filter((n: number) => Number.isInteger(n) && n > 0);

        if (!isNaN(parsedProjHint) && authorizedProjectIds.includes(parsedProjHint)) {
          authoritativeProjectId = parsedProjHint;
        } else if (authorizedProjectIds.length > 0) {
          authoritativeProjectId = authorizedProjectIds[0];
        } else {
          const defaultProjRes = await pool.query(
            "SELECT id FROM projects WHERE company_id = $1 ORDER BY id ASC LIMIT 1",
            [authoritativeCompanyId]
          );
          authoritativeProjectId = defaultProjRes.rows.length > 0 ? Number(defaultProjRes.rows[0].id) : 1;
        }
      }

      // 3. Session Compilation & Token Generation
      const sessionToken = JwtUtil.sign(
        {
          identityId: identity.id,
          channelRef,
          role: isGuest ? "guest" : "customer",
          projectId: String(authoritativeProjectId),
          companyId: String(authoritativeCompanyId),
          jti: randomUUID()
        },
        jwtSecret,
        86400
      );

      const nextSessionId = await nextSequenceId(pool, "webchat_sessions");

      const webchatSession = new WebChatSession({
        id: nextSessionId,
        identityId: identity.id,
        sessionToken
      });
      await sessionRepo.save(webchatSession);

      // Generate short-lived signed JWT for subsequent client requests
      const clientJwt = JwtUtil.sign({
        identityId: identity.id,
        profileId: identity.profileId,
        companyId: String(authoritativeCompanyId),
        projectId: String(authoritativeProjectId),
        channelRef,
        role: isGuest ? "guest" : "customer"
      }, jwtSecret, 3600); // 1 hour expiration

      return reply.code(200).send({
        token: clientJwt,
        sessionToken,
        guestUuid: isGuest ? channelRef : undefined,
        projectId: String(authoritativeProjectId),
        companyId: String(authoritativeCompanyId)
      });
    } catch (err: any) {
      logger.error({ error: err.message }, "Handshake failed");
      return reply.code(500).send({ error: "Internal Server Error", message: err.message });
    }
  });

  /**
   * Endpoint 2: Get Messages
   * Scopes and returns the active message log.
   */
  fastify.get("/api/v1/webchat/messages", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const jwtSecret = getWebchatJwtSecret();

      const authHeader = request.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return reply.code(401).send({ error: "Unauthorized", message: "Missing or invalid token" });
      }

      const token = authHeader.slice(7);
      const decoded = JwtUtil.verify(token, jwtSecret);
      if (!decoded) {
        return reply.code(401).send({ error: "Unauthorized", message: "Session expired or invalid" });
      }

      const { identityId, projectId } = decoded;

      let activeConv = await conversationRepo.findActiveByIdentity(identityId, projectId);
      if (!activeConv) {
        const convRes = await pool.query(
          `SELECT id, project_id FROM conversations 
           WHERE identity_id = $1 AND LOWER(channel) = 'webchat' AND status = 'open'
           ORDER BY id DESC LIMIT 1`,
          [parseInt(identityId, 10) || 0]
        );
        if (convRes.rows.length > 0) {
          activeConv = { id: String(convRes.rows[0].id) } as any;
        }
      }
      if (!activeConv) {
        return reply.code(200).send({ conversationId: null, messages: [] });
      }

      const messages = await messageRepo.findRecentByConversationId(activeConv.id, 50);

      // Hydrate attachments
      const messagesWithAttachments = await Promise.all(
        messages.map(async (m) => {
          const { rows } = await pool.query(
            "SELECT file_url, file_name, file_type, file_size FROM message_attachments WHERE message_id = $1",
            [parseInt(m.id)]
          );
          return {
            id: m.id,
            role: m.role,
            content: m.content,
            createdAt: m.createdAt,
            attachments: rows.map(r => ({
              fileUrl: r.file_url,
              fileName: r.file_name,
              fileType: r.file_type,
              fileSize: r.file_size
            }))
          };
        })
      );

      return reply.code(200).send({
        conversationId: activeConv.id,
        messages: messagesWithAttachments
      });
    } catch (err: any) {
      logger.error({ error: err.message }, "Failed to retrieve messages");
      return reply.code(500).send({ error: "Internal Server Error", message: err.message });
    }
  });

  /**
   * Endpoint: Presigned Upload URL Generation
   * POST /api/v1/webchat/upload/presign
   */
  fastify.post("/api/v1/webchat/upload/presign", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = request.body as any;
      const fileName = String(body?.fileName || body?.filename || "attachment.jpg");
      const fileType = String(body?.fileType || body?.filetype || "image/jpeg");
      const fileSize = Number(body?.fileSize || body?.filesize || 0);

      const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB
      if (fileSize > MAX_FILE_SIZE) {
        return reply.code(400).send({ error: "File too large", message: "Maximum file size is 25MB" });
      }

      const ext = path.extname(fileName) || (fileType.includes("png") ? ".png" : fileType.includes("pdf") ? ".pdf" : ".jpg");
      const sanitizedBase = path.basename(fileName, ext).replace(/[^a-zA-Z0-9_-]/g, "_");
      const storageKey = `webchat_media/${sanitizedBase}_${Date.now()}_${randomUUID().slice(0, 8)}${ext}`;

      const mediaService = new S3MediaStorageService({});
      const uploadUrl = await mediaService.generateDirectUploadUrl(storageKey, 3600);
      const fileUrl = await mediaService.generatePresignedUrl(storageKey, 86400 * 7);

      return reply.code(200).send({
        uploadUrl,
        fileUrl,
        storageKey,
        fileName,
        fileType,
        fileSize
      });
    } catch (err: any) {
      logger.error({ error: err.message }, "Failed to generate presigned upload URL");
      return reply.code(500).send({ error: "Internal Server Error", message: err.message });
    }
  });

  /**
   * Endpoint: Direct Binary Upload Receiver
   * PUT /api/v1/webchat/upload/direct
   */
  fastify.put("/api/v1/webchat/upload/direct", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const query = request.query as any;
      const { key, expires, signature } = query;

      if (!key || !expires || !signature) {
        return reply.code(400).send({ error: "Bad Request", message: "Missing required upload parameters" });
      }

      const mediaService = new S3MediaStorageService({});
      const isValid = mediaService.verifyPresignedUrl(key, expires, signature);
      if (!isValid) {
        return reply.code(403).send({ error: "Forbidden", message: "Invalid or expired upload signature" });
      }

      let buffer: Buffer;
      if (Buffer.isBuffer(request.body)) {
        buffer = request.body;
      } else if (typeof request.body === "string") {
        buffer = Buffer.from(request.body);
      } else if (request.raw) {
        const chunks: Buffer[] = [];
        for await (const chunk of request.raw) {
          chunks.push(chunk);
        }
        buffer = Buffer.concat(chunks);
      } else {
        return reply.code(400).send({ error: "Bad Request", message: "Empty or invalid body payload" });
      }

      await mediaService.saveBuffer(key, buffer);

      return reply.code(200).send({
        success: true,
        key,
        size: buffer.length
      });
    } catch (err: any) {
      logger.error({ error: err.message }, "Direct binary upload failed");
      return reply.code(500).send({ error: "Internal Server Error", message: err.message });
    }
  });

  /**
   * Endpoint: Ephemeral Single-Use WebSocket Ticket
   * POST /api/v1/webchat/ws-ticket
   * Issues a short-lived (10s) opaque ticket for WebSocket handshake.
   */
  fastify.post("/api/v1/webchat/ws-ticket", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      let jwtSecret: string;
      try {
        jwtSecret = getWebchatJwtSecret();
      } catch {
        jwtSecret = config.SESSION_SECRET || "default_jwt_secret_32_characters_minimum_length_required";
      }

      const authHeader = request.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return reply.code(401).send({ error: "Unauthorized", message: "Customer authentication required" });
      }

      const token = authHeader.slice(7).trim();
      if (!token) {
        return reply.code(401).send({ error: "Unauthorized", message: "Token cannot be empty" });
      }

      let decoded: any = null;
      try {
        decoded = JwtUtil.verify(token, jwtSecret);
      } catch {}

      if (!decoded && config.SESSION_SECRET) {
        try {
          decoded = JwtUtil.verify(token, config.SESSION_SECRET);
        } catch {}
      }

      if (!decoded) {
        return reply.code(401).send({ error: "Unauthorized", message: "Invalid or expired token" });
      }

      const ticketId = "wst_" + randomUUID();
      const ttlMs = 10_000; // 10 seconds

      let resolvedProj = decoded.projectId;
      let resolvedComp = decoded.companyId;
      if (!resolvedProj || resolvedProj === "1") {
        try {
          const authCheck = await pool.query(
            `SELECT c.project_id, p.company_id 
             FROM conversations c
             JOIN projects p ON p.id = c.project_id
             WHERE (c.identity_id::text = $1 OR c.identity_id IN (SELECT id FROM identities WHERE channel_ref = $2))
               AND c.status = 'open'
             ORDER BY c.id DESC LIMIT 1`,
            [String(decoded.identityId || "0"), String(decoded.channelRef || decoded.customerId || "")]
          );
          if (authCheck.rows.length > 0) {
            resolvedProj = String(authCheck.rows[0].project_id);
            resolvedComp = String(authCheck.rows[0].company_id);
          }
        } catch {}
      }

      wsTickets.set(ticketId, {
        identityId: String(decoded.identityId || decoded.customerId || decoded.profileId || "guest"),
        profileId: String(decoded.profileId || "guest"),
        companyId: String(resolvedComp || "101"),
        projectId: String(resolvedProj || "101"),
        channelRef: String(decoded.channelRef || decoded.customerId || decoded.identityId || "guest"),
        role: decoded.role === "customer" ? "customer" : "guest",
        expiresAt: Date.now() + ttlMs,
      });

      return reply.code(200).send({
        success: true,
        ticket: ticketId,
        expiresIn: 10
      });
    } catch (err: any) {
      logger.error({ error: err.message }, "Failed to issue WebSocket ticket");
      return reply.code(500).send({ error: "Internal Server Error", message: err.message });
    }
  });

  /**
   * WebSocket Integration endpoint
   * Handles real-time bidirectional message exchanges and typing notifications.
   * Authenticates exclusively via ephemeral single-use ticket (?ticket=<ticket>).
   */
  fastify.get("/api/v1/webchat/socket", { websocket: true }, (socket, req) => {
    const url = new URL(req.url || "", "http://localhost");

    // Non-negotiable security invariant: Real JWT in query is strictly rejected
    if (url.searchParams.has("token")) {
      socket.close(1008, "Token query parameter is forbidden. Use ephemeral ticket");
      return;
    }

    const ticketParam = url.searchParams.get("ticket");
    if (!ticketParam) {
      socket.close(1008, "Ticket Required");
      return;
    }

    // Atomic single-use consumption
    const ticketData = wsTickets.get(ticketParam);
    wsTickets.delete(ticketParam);

    if (!ticketData || ticketData.expiresAt <= Date.now()) {
      socket.close(1008, "Invalid, expired, or already used ticket");
      return;
    }

    const { identityId, projectId, companyId, channelRef } = ticketData;
    let room = "";

    socket.on("message", async (rawMessage: any) => {
      try {
        const payloadStr = rawMessage.toString();
        const payload = JSON.parse(payloadStr);

        // 1. Handle Typing Status Broadcasts
        if (payload.event === "typing") {
          if (room) {
            broadcastToRoom(room, {
              event: "typing",
              data: {
                senderId: channelRef,
                isTyping: !!payload.isTyping
              }
            }, socket);
          }
          return;
        }

        // 2. Handle a tapped quick action.
        if (typeof payload.postback === "string") {
          const resolved = resolvePostback(payload.postback);
          if (!resolved) {
            logger.warn({ postback: payload.postback }, "Unknown WebChat postback ignored");
            return;
          }
          socket.send(JSON.stringify({
            event: "message",
            data: {
              id: randomUUID(),
              role: "ai",
              content: resolved.text,
              createdAt: new Date().toISOString(),
              attachments: [],
              actions: resolved.actions
            }
          }));
          return;
        }

        // 3. Handle Inbound Customer Message (Text and/or Attachments)
        const IncomingAttachmentSchema = z.object({
          fileUrl: z.string().min(1),
          fileName: z.string().optional().default("attachment"),
          fileType: z.string().optional(),
          fileSize: z.number().optional(),
          storageKey: z.string().optional(),
        });

        const IncomingMessageSchema = z.object({
          text: z.string().optional().default(""),
          tempId: z.string().optional(),
          attachments: z.array(IncomingAttachmentSchema).optional().default([])
        });

        const parsed = IncomingMessageSchema.safeParse(payload);
        if (!parsed.success) {
          socket.send(JSON.stringify({ error: "Bad Request", message: "Invalid message payload", details: parsed.error.issues }));
          return;
        }

        const rawText = (parsed.data.text || "").trim();
        const attachments = parsed.data.attachments || [];

        if (!rawText && attachments.length === 0) {
          socket.send(JSON.stringify({ error: "Bad Request", message: "Message content or attachments required" }));
          return;
        }

        const messageText = rawText || (attachments[0]?.fileName ? `[ไฟล์แนบ: ${attachments[0].fileName}]` : '[ไฟล์แนบ]');
        const messageType = attachments.length > 0 ? (attachments[0].fileType?.startsWith("image/") || attachments[0].fileUrl?.match(/\.(jpeg|jpg|png|webp|gif)/i) ? "image" : "file") : "text";
        const externalId = (parsed.data.tempId && parsed.data.tempId.trim()) ? parsed.data.tempId.trim() : `webchat_${Date.now()}_${randomUUID().slice(0, 8)}`;
        const tempId = externalId;

        // Ensure active conversation exists on message send
        let conversation = await conversationRepo.findActiveByIdentity(identityId, projectId);
        if (!conversation) {
          const nextConvId = await nextSequenceId(pool, "conversations");

          conversation = new Conversation({
            id: nextConvId,
            projectId,
            identityId,
            status: "open",
            handledBy: "ai",
            channel: "WebChat"
          });
          await conversationRepo.save(conversation);
        }

        const conversationId = conversation.id;
        room = `conversation:${conversationId}`;

        if (!activeConnections.has(room)) {
          activeConnections.set(room, new Set());
        }
        activeConnections.get(room)!.add(socket);

        // Check if message is a project join code (format TX-XXXX-XXXX, or the 4-char hint)
        const trimmedText = rawText;
        const isJoinCodePattern = /^TX-[A-Z0-9]+-[A-Z0-9]+$/i.test(trimmedText) || /^[A-Z0-9]{4,6}$/i.test(trimmedText);
        if (isJoinCodePattern) {
          const codeHash = createHash("sha256").update(trimmedText.toUpperCase()).digest("hex");
          const codeRes = await pool.query(
            `SELECT pjc.project_id, p.name as project_name, p.company_id, c.name as company_name
             FROM project_join_codes pjc
             JOIN projects p ON p.id = pjc.project_id
             LEFT JOIN companies c ON c.id = p.company_id
             WHERE (pjc.code_digest = $1 OR UPPER(pjc.code_hint) = UPPER($2))
               AND pjc.status = 'active'
             LIMIT 1`,
            [codeHash, trimmedText.slice(-4).toUpperCase()]
          );
          if (codeRes.rows.length > 0) {
            const row = codeRes.rows[0];
            const newProjectId = String(row.project_id);
            const newCompanyId = String(row.company_id || companyId);
            const projName = row.project_name;
            const compName = row.company_name;

            // Hoisted: the token signed below must carry this. Scoping it to the
            // block meant the fresh token went out without a profileId, and
            // customerAuth.ts:75 rejects any portal credential missing one — so
            // /api/portal/profile, /projects and the save button all answered
            // 403 immediately after the bot said "ยืนยันตัวตนสำเร็จ".
            let resolvedIdentityId: string | null = (identityId && identityId !== "guest") ? identityId : null;
            let joinedProfileId: string | null = null;

            if (resolvedIdentityId && !isNaN(parseInt(resolvedIdentityId, 10))) {
              const identRow = await pool.query("SELECT profile_id FROM identities WHERE id = $1", [parseInt(resolvedIdentityId, 10)]);
              const pId = identRow.rows[0]?.profile_id;
              joinedProfileId = pId ? String(pId) : null;
            }

            // Fallback 1: query by channelRef
            if (!joinedProfileId && channelRef && channelRef !== "guest") {
              const identRow = await pool.query(
                "SELECT id, profile_id FROM identities WHERE LOWER(channel) = 'webchat' AND channel_ref = $1 LIMIT 1",
                [channelRef]
              );
              if (identRow.rows.length > 0) {
                resolvedIdentityId = String(identRow.rows[0].id);
                joinedProfileId = identRow.rows[0].profile_id ? String(identRow.rows[0].profile_id) : null;
              }
            }

            // Fallback 2: query conversation identity
            if (!joinedProfileId && conversationId) {
              const convRow = await pool.query(
                "SELECT identity_id FROM conversations WHERE id = $1 LIMIT 1",
                [conversationId]
              );
              if (convRow.rows.length > 0 && convRow.rows[0].identity_id) {
                resolvedIdentityId = String(convRow.rows[0].identity_id);
                const identRow = await pool.query("SELECT profile_id FROM identities WHERE id = $1", [parseInt(resolvedIdentityId, 10)]);
                joinedProfileId = identRow.rows[0]?.profile_id ? String(identRow.rows[0].profile_id) : null;
              }
            }

            // Fallback 3: check ticketData profileId
            if (!joinedProfileId && (ticketData as any).profileId && (ticketData as any).profileId !== "guest") {
              joinedProfileId = String((ticketData as any).profileId);
            }

            // Fallback 4: create authoritative customer profile and identity if missing
            if (!joinedProfileId) {
              const nextProfileIdRes = await pool.query("SELECT COALESCE(MAX(CASE WHEN id::text ~ '^[0-9]+$' THEN id::bigint ELSE 0 END), 0) + 1 AS next_id FROM profiles");
              joinedProfileId = String(nextProfileIdRes.rows[0].next_id);
              const nextIdentId = await nextSequenceId(pool, "identities");
              resolvedIdentityId = String(nextIdentId);

              await pool.query(
                `INSERT INTO profiles (id, company_id, name, created_at, is_pii_erased, is_merged)
                 VALUES ($1, $2, $3, NOW(), false, false)`,
                [joinedProfileId, parseInt(newCompanyId, 10), `Customer_${channelRef.slice(0, 8)}`]
              );

              await pool.query(
                `INSERT INTO identities (id, profile_id, channel, channel_ref, created_at, is_pii, is_shared_account)
                 VALUES ($1, $2, 'WebChat', $3, NOW(), false, false)`,
                [nextIdentId, joinedProfileId, channelRef]
              );
            }

            if (joinedProfileId) {
              await pool.query(
                `INSERT INTO profile_projects (profile_id, project_id, created_at)
                 VALUES ($1, $2, NOW())
                 ON CONFLICT (profile_id, project_id) DO NOTHING`,
                [joinedProfileId, parseInt(newProjectId, 10)]
              );
              await pool.query(
                `UPDATE profiles SET company_id = $1 WHERE id::text = $2`,
                [parseInt(newCompanyId, 10), joinedProfileId]
              );
            }

            await pool.query(
              `UPDATE conversations SET project_id = $1, org_id = $2, status = 'open', identity_id = COALESCE($4, identity_id) WHERE id = $3`,
              [parseInt(newProjectId, 10), row.org_id || 'org_default', conversationId, resolvedIdentityId ? parseInt(resolvedIdentityId, 10) : null]
            );

            const jwtSecret = getWebchatJwtSecret();
            // `customerId` is required, not decorative: the client keeps this
            // token as its login proof, and the handshake above only accepts a
            // proof that carries `decoded.customerId` (see the customerToken
            // branch). Without it the token verified but produced no identity,
            // so every reload silently dropped the upgraded session back to
            // guest — the bot had said "ยืนยันตัวตนสำเร็จ" and the portal still
            // showed the guest gate, 0 projects and a 403 on /api/portal/profile.
            // Two claims are load-bearing and were both missing at different
            // times, producing two different symptoms:
            //   customerId — the handshake (line ~223) rejects a proof without
            //                it, so every reload 401'd back to guest.
            //   profileId  — customerAuth.ts:75 rejects a portal credential
            //                without it, so /api/portal/* answered 403.
            const freshSessionToken = JwtUtil.sign(
              {
                customerId: channelRef,
                identityId: resolvedIdentityId || identityId,
                profileId: joinedProfileId,
                channelRef,
                role: "customer",
                projectId: newProjectId,
                companyId: newCompanyId,
                jti: randomUUID()
              },
              jwtSecret,
              86400
            );

            if (!joinedProfileId) {
              logger.warn(
                { identityId, conversationId, projectId: newProjectId },
                "Join code accepted but the identity has no profile; portal routes will refuse this token"
              );
            }

            const successText = `✅ ยืนยันตัวตนสำเร็จ!\nยินดีต้อนรับสู่โครงการ **${projName}** (${compName || ''})\n\nขณะนี้ระบบพร้อมให้บริการแล้วค่ะ ท่านสามารถสอบถามข้อมูล แจ้งปัญหาการใช้งาน หรือขอความช่วยเหลือได้ทันทีค่ะ`;

            await pool.query(
              `INSERT INTO messages (conversation_id, role, content, message_type, created_at)
               VALUES ($1, 'ai', $2, 'text', NOW())`,
              [conversationId, successText]
            );

            socket.send(JSON.stringify({
              event: "message",
              data: {
                id: randomUUID(),
                role: "ai",
                content: successText,
                createdAt: new Date().toISOString(),
                attachments: []
              }
            }));

            socket.send(JSON.stringify({
              event: "project_switched",
              data: {
                projectId: parseInt(newProjectId, 10),
                projectName: projName,
                companyId: parseInt(newCompanyId, 10),
                companyName: compName,
                token: freshSessionToken
              }
            }));
            return;
          }
        }

        const receivedAtStr = new Date().toISOString();

        // Check if customer has a valid, non-fallback project assigned
        const currentConvRes = await pool.query(`SELECT project_id FROM conversations WHERE id = $1`, [conversationId]);
        const convProjectId = String(currentConvRes.rows[0]?.project_id || "");

        // Fail-closed tenant policy: never guess or fall back to project 1
        if (!convProjectId || convProjectId === "1" || convProjectId === "undefined" || convProjectId === "null") {
          logger.warn({ conversationId, identityId }, "WebChat customer attempted to send message without verified project context; prompting for join code");
          const promptJoinMsg = "กรุณาระบุรหัสโครงการ (Join Code) เพื่อเข้าใช้งานระบบค่ะ";
          socket.send(JSON.stringify({
            event: "message",
            data: {
              id: randomUUID(),
              role: "ai",
              content: promptJoinMsg,
              createdAt: new Date().toISOString()
            }
          }));
          return;
        }

        // 2. Check Human Takeover Gate before forwarding to AI
        let isHumanTakeover = false;
        try {
          const takeoverState = await takeoverManager.getTakeoverState(conversationId);
          if (takeoverState && (takeoverState.status === "ACTIVE_HUMAN" || takeoverState.status === "PENDING_HUMAN")) {
            isHumanTakeover = true;
            logger.info(
              { conversationId, status: takeoverState.status, agent: takeoverState.assignedHumanAgentId },
              "WebChat message withheld from AI: human takeover active"
            );
          }
        } catch (takeoverErr: any) {
          logger.error({ error: takeoverErr.message, conversationId }, "Takeover check failed; falling through");
        }

        // 3. Persist customer message to DB (atomic insert with ON CONFLICT)
        let insertedMessageId: number | null = null;
        if (conversationId) {
          try {
            const insertRes = await pool.query(
              `INSERT INTO messages (conversation_id, role, content, message_type, external_id, created_at)
               VALUES ($1, 'customer', $2, $3, $4, NOW())
               ON CONFLICT (conversation_id, external_id) DO UPDATE SET
                 content = EXCLUDED.content
               RETURNING id`,
              [conversationId, messageText, messageType, externalId]
            );
            if (insertRes.rows.length > 0) {
              insertedMessageId = insertRes.rows[0].id;
            } else {
              const row = await pool.query(
                `SELECT id FROM messages WHERE conversation_id = $1 AND external_id = $2 LIMIT 1`,
                [conversationId, externalId]
              );
              insertedMessageId = row.rows[0]?.id || null;
            }
          } catch (dbErr: any) {
            logger.warn({ error: dbErr.message, conversationId }, "Failed persisting customer message to DB");
          }
        }

        // 4. Persist attachments to message_attachments table
        if (insertedMessageId && attachments.length > 0) {
          for (const att of attachments) {
            try {
              await pool.query(
                `INSERT INTO message_attachments (message_id, file_url, thumbnail_url, file_name, file_type, file_size, storage_key, attachment_status, metadata, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, 'READY', $8, NOW())`,
                [
                  insertedMessageId,
                  att.fileUrl,
                  att.fileUrl,
                  att.fileName || 'attachment',
                  att.fileType || (att.fileUrl.match(/\.(png|jpg|jpeg|webp|gif)/i) ? 'image/jpeg' : 'application/octet-stream'),
                  att.fileSize || 0,
                  att.storageKey || null,
                  JSON.stringify({})
                ]
              );
            } catch (attErr: any) {
              logger.error({ error: attErr.message, messageId: insertedMessageId }, "Failed persisting message attachment");
            }
          }
        }

        // 5. Prepare customer message payload for real-time room broadcast
        const recipientRoom = `recipient:${channelRef}`;
        const clientMsgPayload = {
          event: "message",
          data: {
            id: insertedMessageId ? String(insertedMessageId) : externalId,
            externalId,
            role: "customer",
            content: messageText,
            createdAt: receivedAtStr,
            attachments
          }
        };

        // Broadcast to customer rooms (conversation + recipient) exactly once per socket
        broadcastToRooms([room, recipientRoom], clientMsgPayload, socket);

        // 6. If human takeover is active: notify operator in console and DO NOT enqueue to BullMQ / PromptX!
        if (isHumanTakeover) {
          try {
            const projectRes = await pool.query(`SELECT project_id FROM conversations WHERE id = $1`, [conversationId]);
            const convProjId = String(projectRes.rows[0]?.project_id || projectId || "");
            if (convProjId) {
              adminSocketRegistry.broadcastToProject(convProjId, JSON.stringify({
                event: "NEW_MESSAGE",
                data: {
                  conversationId: String(conversationId),
                  projectId: convProjId,
                  channel: "WebChat",
                  messageType
                }
              }));
            }
          } catch (adminErr: any) {
            logger.warn({ error: adminErr.message, conversationId }, "Failed notifying admin sockets of customer takeover message");
          }
          return;
        }

        // 7. Normal AI mode: delegate to background queue immediately (maxRetry: 0 to prevent duplicate flow runs)
        const inboundMsg = {
          senderId: channelRef,
          channel: "WebChat" as const,
          text: messageText,
          receivedAt: receivedAtStr,
          companyId,
          attachments,
          conversationId: String(conversationId),
          externalId,
          tempId: externalId,
          messageId: insertedMessageId
        };

        const jobQueue = QueueFactory.getQueue();
        const requestId = randomUUID();
        await jobQueue.enqueue({
          type: "webhook_message",
          data: inboundMsg,
          metadata: {
            requestId,
            receivedAt: receivedAtStr
          },
          maxRetry: 0
        });

      } catch (err: any) {
        logger.error({ error: err.message }, "Error processing socket message");
        socket.send(JSON.stringify({ error: "Internal Error", message: err.message }));
      }
    });

    // Handle initial socket link setup
    const recipientRoom = `recipient:${channelRef}`;
    if (!activeConnections.has(recipientRoom)) {
      activeConnections.set(recipientRoom, new Set());
    }
    activeConnections.get(recipientRoom)!.add(socket);

    (async () => {
      try {
        let conversation = await conversationRepo.findActiveByIdentity(identityId, projectId);
        if (!conversation) {
          const res = await pool.query(
            `SELECT id, project_id FROM conversations 
             WHERE (identity_id::text = $1 OR identity_id IN (SELECT id FROM identities WHERE channel_ref = $2))
               AND status = 'open' 
             ORDER BY id DESC LIMIT 1`,
            [identityId, channelRef]
          );
          if (res.rows.length > 0) {
            conversation = { id: String(res.rows[0].id), projectId: String(res.rows[0].project_id) } as any;
          }
        }
        if (conversation) {
          room = `conversation:${conversation.id}`;
          if (!activeConnections.has(room)) {
            activeConnections.set(room, new Set());
          }
          activeConnections.get(room)!.add(socket);
        }

        // Greet with the quick-action menu only when there is nothing to read
        // yet, so it never lands on top of an ongoing conversation. Sent on
        // this socket alone — not broadcast — because it is a per-viewer
        // greeting, not conversation content, and it is not persisted.
        if (!conversation) {
          const menu = buildWebChatMenu();
          socket.send(JSON.stringify({
            event: "message",
            data: {
              id: randomUUID(),
              role: "ai",
              content: menu.text,
              createdAt: new Date().toISOString(),
              attachments: [],
              actions: menu.actions
            }
          }));
        }
      } catch (err: any) {
        logger.error({ error: err.message }, "Error registering socket room connection");
      }
    })();

    socket.on("close", () => {
      if (activeConnections.has(recipientRoom)) {
        activeConnections.get(recipientRoom)!.delete(socket);
        if (activeConnections.get(recipientRoom)!.size === 0) {
          activeConnections.delete(recipientRoom);
        }
      }
      if (room && activeConnections.has(room)) {
        activeConnections.get(room)!.delete(socket);
        if (activeConnections.get(room)!.size === 0) {
          activeConnections.delete(room);
        }
      }
    });
  });
}

/**
 * Broadcasts a message to all open WebSockets across multiple rooms (deduplicated by socket instance).
 * Skips the optional skipSocket parameter to avoid echoing.
 * Also deduplicates by message id per socket using a bounded Set to eliminate duplicate delivery.
 */
export function broadcastToRooms(rooms: string[], payload: any, skipSocket?: any) {
  const targetSockets = new Set<any>();
  for (const room of rooms) {
    if (!room) continue;
    const sockets = activeConnections.get(room);
    if (sockets) {
      for (const s of sockets) {
        if (s !== skipSocket && s.readyState === 1) { // 1 = OPEN
          targetSockets.add(s);
        }
      }
    }
  }

  const payloadStr = JSON.stringify(payload);
  const msgId = payload?.data?.id || payload?.id;

  for (const socket of targetSockets) {
    if (msgId) {
      if (!socket._deliveredMessageIds) {
        socket._deliveredMessageIds = new Set<string>();
      }
      if (socket._deliveredMessageIds.has(msgId)) {
        continue;
      }
      socket._deliveredMessageIds.add(msgId);
      if (socket._deliveredMessageIds.size > 1000) {
        const first = socket._deliveredMessageIds.values().next().value;
        if (first) socket._deliveredMessageIds.delete(first);
      }
    }
    socket.send(payloadStr);
  }
}

/**
 * Broadcasts a message to all open WebSockets in a conversation room.
 * Skips the optional skipSocket parameter to avoid echoing.
 */
function broadcastToRoom(room: string, payload: any, skipSocket?: any) {
  broadcastToRooms([room], payload, skipSocket);
}

/**
 * Direct in-memory delivery bridge for outbound messages (e.g. from BullMQ worker
 * when PromptX replies), ensuring delivery even when Redis is down or unavailable.
 */
export function broadcastWebChatOutbound(payload: {
  conversationId?: string | number;
  recipientId?: string;
  text?: string;
  content?: string;
  id?: string;
  role?: string;
  sentAt?: string;
  attachments?: any[];
  actions?: any[];
}) {
  const msgPayload = {
    event: "message",
    data: {
      id: payload.id || randomUUID(),
      role: payload.role || "ai",
      content: payload.text || payload.content || "",
      createdAt: payload.sentAt || new Date().toISOString(),
      attachments: payload.attachments || [],
      actions: Array.isArray(payload.actions) ? payload.actions : undefined
    }
  };

  const targetRooms: string[] = [];
  if (payload.conversationId) {
    targetRooms.push(`conversation:${payload.conversationId}`);
  }
  if (payload.recipientId) {
    targetRooms.push(`recipient:${payload.recipientId}`);
  }

  broadcastToRooms(targetRooms, msgPayload);
}