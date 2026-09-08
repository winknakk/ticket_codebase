import { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../../config/env";
import { MetricAggregator } from "../../aiops/dashboard/MetricAggregator";
import { IngestionService } from "../../aiops/ragops/IngestionService";
import { EvalTestRunner } from "../../aiops/llmops/EvalTestRunner";
import { TrafficSplitter } from "../../aiops/prompt-control/TrafficSplitter";
import { authHook } from "../../middleware/auth";
import { resolveProjectFilter, canAccessProject } from "../../middleware/tenantScope";
import { PostgresOutboxRepository } from "../../infrastructure/db/PostgresOutboxRepository";
import { DocumentIngestionPayloadSchema, AbTestWeightSchema, EvalTestCaseSchema } from "../../schemas/aiops";
import { DatabaseAdapter } from "../../adapters/types";
import { HumanReplyService } from "../../services/humanReplyService";
import { PlaneService } from "../../services/planeService";
import { TicketService } from "../../tools/TicketService";
import { TicketInputSchema } from "../../schemas/validation";
import { TakeoverManager } from "../../human-takeover/TakeoverManager";
import { ConversationMemoryService } from "../../memory/ConversationMemoryService";
import { pool } from "../../adapters/postgres/PostgresAdapter";
import { S3MediaStorageService } from "../../media/services/S3MediaStorageService";

export interface AdminRouteDependencies {
  metricAggregator: MetricAggregator;
  ingestionService: IngestionService;
  evalTestRunner: EvalTestRunner;
  trafficSplitter: TrafficSplitter;
  dbAdapter: DatabaseAdapter;
  takeoverManager?: TakeoverManager;
}

export async function registerAdminRoutes(fastify: FastifyInstance, deps: AdminRouteDependencies) {
  const lineProfileCache = new Map<string, {
    value: { pictureUrl?: string; displayName?: string } | null;
    expiresAt: number;
  }>();

  const getLineProfile = async (userId: string) => {
    const cached = lineProfileCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    try {
      const response = await fetch(`https://api.line.me/v2/bot/profile/${encodeURIComponent(userId)}`, {
        headers: { Authorization: `Bearer ${config.LINE_CHANNEL_ACCESS_TOKEN}` },
        signal: AbortSignal.timeout(3000),
      });
      const value = response.ok ? await response.json() as { pictureUrl?: string; displayName?: string } : null;
      // Keep successful avatars warm for the inbox refresh cycle; retry unavailable profiles sooner.
      lineProfileCache.set(userId, {
        value,
        expiresAt: Date.now() + (value ? 60 * 60 * 1000 : 5 * 60 * 1000),
      });
      return value;
    } catch (error: any) {
      console.error("[admin.ts] Failed to fetch LINE user profile:", error.message);
      lineProfileCache.set(userId, { value: null, expiresAt: Date.now() + 5 * 60 * 1000 });
      return null;
    }
  };

  const hydrateLineAvatars = async (conversations: any[]) => Promise.all(conversations.map(async (conversation) => {
    const channel = String(conversation.channel || "").toLowerCase();
    const userId = String(conversation.customer || "");
    if ((channel !== "line" && channel !== "line_group") || !userId.startsWith("U")) return conversation;

    const profile = await getLineProfile(userId);
    if (!profile) return conversation;

    const hydrated = { ...conversation };
    if (profile.pictureUrl) hydrated.avatar_url = profile.pictureUrl;
    if (
      profile.displayName
      && (!hydrated.profile_name || ["-", "unknown"].includes(String(hydrated.profile_name).toLowerCase()))
    ) {
      hydrated.profile_name = profile.displayName;
    }
    return hydrated;
  }));

  const outboxRepo = new PostgresOutboxRepository();

  // Add authentication hook for all admin endpoints
  fastify.addHook("onRequest", authHook);

  // Validate conversationId and authorize projectId.
  //
  // registerAdminRoutes is called directly on the root instance rather than
  // through fastify.register(), so hooks added here are NOT encapsulated and
  // fire for every route in the application, including the login surface.
  // The guard below keeps this hook to the routes it is meant for.
  fastify.addHook("preHandler", async (request, reply) => {
    const params = request.params as any;
    const routeUrl = (request as any).routeOptions?.url || "";

    if (!routeUrl.startsWith("/api/admin") && !routeUrl.startsWith("/api/v1/admin")) {
      return;
    }

    if (params && params.id !== undefined && routeUrl) {
      if (routeUrl.includes("/api/admin/conversations/:id")) {
        const id = String(params.id);
        const parsed = parseInt(id, 10);
        if (isNaN(parsed) || parsed <= 0 || id === "null" || id === "undefined") {
          return reply.code(400).send({
            error: "Bad Request",
            message: `Invalid conversationId: ${id}`,
          });
        }
      }
    }

    const query = request.query as any;

    // Authorize the requested project against the caller's own scope.
    //
    // This block previously only checked that the conversation belonged to
    // the *requested* project — but the requested project was whatever the
    // caller typed, so it constrained nothing. resolveProjectFilter checks it
    // against the authenticated principal instead, and bounds projectId=all
    // to the projects that principal may actually see.
    const filter = resolveProjectFilter(request, reply, query?.projectId);
    if (!filter) {
      return reply; // resolveProjectFilter already sent 400/403
    }

    // Conversation-scoped routes: confirm the conversation is inside the
    // caller's scope, using the conversation's real project rather than the
    // one supplied on the query string.
    if (routeUrl.includes("/api/admin/conversations/:id") && params?.id !== undefined) {
      const conversationId = parseInt(String(params.id), 10);
      const owning = await pool.query(
        `SELECT project_id FROM conversations WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
        [conversationId]
      );

      if (owning.rowCount === 0) {
        return reply.code(404).send({
          error: "Not Found",
          message: `Conversation ${conversationId} not found`,
        });
      }

      if (!canAccessProject(request, owning.rows[0].project_id)) {
        return reply.code(404).send({
          error: "Not Found",
          message: `Conversation ${conversationId} not found`,
        });
      }

      // Callers may still name a project explicitly; if they do it must match
      // the conversation's own project.
      const requested = parseInt(String(query?.projectId), 10);
      if (Number.isInteger(requested) && requested > 0 && requested !== Number(owning.rows[0].project_id)) {
        return reply.code(404).send({
          error: "Not Found",
          message: `Conversation ${conversationId} does not belong to project ${requested}`,
        });
      }
    }
  });

  // 1. GET /api/v1/admin/metrics
  fastify.get("/api/v1/admin/metrics", async (request, reply) => {
    const query = request.query as any;
    const tenantId = query.tenantId ? String(query.tenantId) : undefined;
    const metrics = await deps.metricAggregator.getDashboardMetrics(tenantId);
    return reply.code(200).send(metrics);
  });

  // 2. GET /api/v1/admin/traces
  fastify.get("/api/v1/admin/traces", async (request, reply) => {
    const query = request.query as any;
    const tenantId = query.tenantId ? String(query.tenantId) : undefined;
    const traces = await deps.metricAggregator.getConversationTraceSummaries(tenantId);
    return reply.code(200).send(traces);
  });

  // 3. POST /api/v1/admin/knowledge/upload
  fastify.post("/api/v1/admin/knowledge/upload", async (request, reply) => {
    const parsed = DocumentIngestionPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "Bad Request",
        message: parsed.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join(", "),
      });
    }

    const chunks = await deps.ingestionService.ingestDocument(parsed.data);
    return reply.code(200).send({
      success: true,
      documentId: chunks[0]?.docId || "unknown",
      chunksCount: chunks.length,
    });
  });

  // 4. POST /api/v1/admin/evals/run
  fastify.post("/api/v1/admin/evals/run", async (request, reply) => {
    const body = request.body as any;
    const tenantId = body.tenantId ? String(body.tenantId) : "1";
    const testCasesInput = z.array(EvalTestCaseSchema).safeParse(body.testCases);

    if (!testCasesInput.success) {
      return reply.code(400).send({
        error: "Bad Request",
        message: testCasesInput.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join(", "),
      });
    }

    const results = await deps.evalTestRunner.runSuite(testCasesInput.data, tenantId);
    const total = results.length;
    const successful = results.filter((r) => r.success).length;
    const avgAccuracy = total > 0 ? results.reduce((acc, r) => acc + r.accuracyScore, 0) / total : 0;

    return reply.code(200).send({
      summary: {
        totalTestCases: total,
        successfulTestCases: successful,
        averageAccuracyScore: parseFloat(avgAccuracy.toFixed(2)),
      },
      results,
    });
  });

  // 5. GET/POST /api/v1/admin/prompts/ab-test
  fastify.get("/api/v1/admin/prompts/ab-test", async (request, reply) => {
    const query = request.query as any;
    const tenantId = query.tenantId ? String(query.tenantId) : "1";
    const promptName = query.promptName ? String(query.promptName) : "support";

    const weights = deps.trafficSplitter.getWeights(tenantId, promptName);
    if (!weights) {
      return reply.code(404).send({
        error: "Not Found",
        message: `No A/B test weights configured for tenant ${tenantId} and prompt ${promptName}.`,
      });
    }
    return reply.code(200).send(weights);
  });

  fastify.post("/api/v1/admin/prompts/ab-test", async (request, reply) => {
    const parsed = AbTestWeightSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "Bad Request",
        message: parsed.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join(", "),
      });
    }

    try {
      deps.trafficSplitter.setWeights(parsed.data);
      return reply.code(200).send({ success: true, message: "A/B test weights configured successfully." });
    } catch (err: any) {
      return reply.code(400).send({ error: "Bad Request", message: err.message });
    }
  });

  const humanReplyService = new HumanReplyService(deps.dbAdapter);
  const planeService = new PlaneService(deps.dbAdapter);
  const getMediaStorageService = (req?: any) => {
    let baseUrl = (config.BACKEND_PUBLIC_URL || "http://localhost:3000").trim();
    if (req?.headers?.host) {
      const protocol = req.headers["x-forwarded-proto"] || (req.socket?.encrypted ? "https" : "http");
      baseUrl = `${protocol}://${req.headers.host}`;
    }
    return new S3MediaStorageService({
      publicCdnBaseUrl: `${baseUrl}/api/v1/media`
    });
  };

  const hydrateAttachment = async (att: any, req?: any) => {
    const storageKey = att.storage_key || "";
    const mediaStorageService = getMediaStorageService(req);
    const hasLocalFile = storageKey ? await mediaStorageService.exists(storageKey) : false;
    const freshFileUrl = hasLocalFile
      ? await mediaStorageService.generatePresignedUrl(storageKey, 86400)
      : att.file_url;

    return {
      id: att.id,
      fileUrl: freshFileUrl,
      thumbnailUrl: hasLocalFile ? freshFileUrl : (att.thumbnail_url || att.file_url),
      fileName: att.file_name,
      fileType: att.file_type || "image/jpeg",
      fileSize: att.file_size || 0,
      storageKey
    };
  };

  // 6. GET /api/admin/conversations
  fastify.get("/api/admin/conversations", async (request, reply) => {
    const query = request.query as any;
    const projectId = query?.projectId ? String(query.projectId) : undefined;
    const list = await humanReplyService.listConversations(projectId, request.tenantContext);
    return reply.code(200).send(await hydrateLineAvatars(list));
  });

  // 7. GET /api/admin/conversations/:id/messages
  fastify.get("/api/admin/conversations/:id/messages", async (request, reply) => {
    const params = request.params as any;
    try {
      const messages = await humanReplyService.getMessages(params.id);

      // Use request-aware media service so publicCdnBaseUrl matches the actual host
      let mediaService: any = null;
      try {
        mediaService = getMediaStorageService(request);
      } catch (mediaErr: any) {
        console.warn("[admin.ts] Media service initialization warning:", mediaErr.message);
      }

      const hydratedMessages = await Promise.all(messages.map(async (m: any) => {
        const msgId = m.id || m.Id;
        if (!msgId) return m;

        let attachments: any[] = [];
        try {
          const attRes = await pool.query(
            `SELECT id, file_url, thumbnail_url, file_name, file_type, file_size, storage_key 
             FROM message_attachments WHERE message_id = $1`,
            [msgId]
          );

          // Generate fresh URLs from storage_key (presigned URLs expire after 15 min)
          attachments = await Promise.all(attRes.rows.map(async (att: any) => {
            let fileUrl = att.file_url;
            let thumbnailUrl = att.thumbnail_url || att.file_url;

            // If storage_key exists and mediaService is ready, generate fresh presigned URL
            if (att.storage_key && mediaService) {
              try {
                const freshUrl = await mediaService.generatePresignedUrl(att.storage_key, 86400);
                fileUrl = freshUrl;
                thumbnailUrl = freshUrl;
              } catch (e) {
                // Fall back to stored URL
              }
            }

            return {
              id: att.id,
              fileUrl,
              thumbnailUrl,
              fileName: att.file_name,
              fileType: att.file_type || "image/jpeg",
              fileSize: att.file_size || 0,
              storageKey: att.storage_key
            };
          }));
        } catch (attErr: any) {
          // If message_attachments table doesn't exist or fails, proceed without attachments
        }

        return {
          ...m,
          messageType: m.message_type || m.messageType || "text",
          attachments
        };
      }));

      return reply.code(200).send(hydratedMessages);
    } catch (err: any) {
      console.error("[admin.ts] Error fetching conversation messages:", err.message);
      return reply.code(500).send({ error: "Failed to fetch conversation messages", message: err.message });
    }
  });


    // 8. POST /api/admin/conversations/:id/takeover
    fastify.post("/api/admin/conversations/:id/takeover", async (request, reply) => {
      const params = request.params as any;
      const result = await humanReplyService.takeover(params.id);
      let takeoverState;
      if (deps.takeoverManager) {
        const leaseDurationMs = config.HUMAN_ACTIVE_TIMEOUT_MINUTES * 60 * 1000;
        takeoverState = await deps.takeoverManager.setTakeoverState(
          params.id,
          "ACTIVE_HUMAN",
          "human_agent_admin",
          leaseDurationMs
        );
      }
      return reply.code(200).send({
        ...result,
        takeover_status: takeoverState?.status || "ACTIVE_HUMAN",
        human_session_started_at: takeoverState?.human_session_started_at || null,
        human_session_expire_at: takeoverState?.human_session_expire_at || null,
      });
    });

    // 9. POST /api/admin/conversations/:id/reply
    fastify.post("/api/admin/conversations/:id/reply", async (request, reply) => {
      const params = request.params as any;
      const body = request.body as any;

      if (!body || typeof body.message !== "string") {
        return reply.code(400).send({
          error: "Bad Request",
          message: "Field 'message' is required and must be a string",
        });
      }

      if (deps.takeoverManager) {
        const takeoverState = await deps.takeoverManager.getTakeoverState(params.id);
        if (takeoverState.status !== "ACTIVE_HUMAN") {
          // Auto-trigger takeover when human operator replies directly
          await humanReplyService.takeover(params.id);
          const leaseDurationMs = config.HUMAN_ACTIVE_TIMEOUT_MINUTES * 60 * 1000;
          await deps.takeoverManager.setTakeoverState(params.id, "ACTIVE_HUMAN", "human_agent_admin", leaseDurationMs);
        }
      }

      const rawReplyTo = body.reply_to_message_id || body.replyToMessageId || body.reply_to_id || body.replyToId;
      const replyToId = rawReplyTo ? parseInt(String(rawReplyTo), 10) : undefined;
      const result = await humanReplyService.sendReply(params.id, body.message, replyToId);
      let humanSessionExpireAt: string | null = null;
      if (deps.takeoverManager) {
        const leaseDurationMs = config.HUMAN_ACTIVE_TIMEOUT_MINUTES * 60 * 1000;
        await deps.takeoverManager.setTakeoverState(params.id, "ACTIVE_HUMAN", "human_agent_admin", leaseDurationMs, true);
        // Return updated session info immediately so frontend timer starts without waiting for a poll cycle
        const updatedState = await deps.takeoverManager.getTakeoverState(params.id);
        humanSessionExpireAt = (updatedState as any)?.human_session_expire_at || null;
      }
      return reply.code(200).send({
        ...result,
        handled_by: "human",
        takeover_status: "ACTIVE_HUMAN",
        human_session_expire_at: humanSessionExpireAt,
      });
    });

    // 9.1. POST /api/admin/media/upload (Base64 file upload from Admin UI)
    fastify.post("/api/admin/media/upload", async (request, reply) => {
      const body = request.body as any;
      if (!body || !body.base64Data) {
        return reply.code(400).send({ error: "Missing base64Data in request body" });
      }

      try {
        const base64Str = body.base64Data.replace(/^data:image\/\w+;base64,/, "");
        const buffer = Buffer.from(base64Str, "base64");
        const fileName = body.fileName || `admin_upload_${Date.now()}.jpg`;
        const mimeType = body.fileType || "image/jpeg";

        const { S3MediaStorageService } = await import("../../media/services/S3MediaStorageService");
        const mediaService = new S3MediaStorageService({});
        const uploadResult = await mediaService.upload({
          buffer,
          fileName,
          mimeType,
          folder: "admin_media"
        });

        return reply.code(200).send({
          success: true,
          fileUrl: uploadResult.fileUrl,
          storageKey: uploadResult.storageKey,
          fileName: uploadResult.fileName
        });
      } catch (err: any) {
        return reply.code(500).send({ error: "Upload failed", details: err.message });
      }
    });

    // 9.2. POST /api/admin/conversations/:id/send-image
    fastify.post("/api/admin/conversations/:id/send-image", async (request, reply) => {
      const params = request.params as any;
      const body = request.body as any;
      if (!body || !body.imageUrl) {
        return reply.code(400).send({ error: "Field 'imageUrl' is required" });
      }

      const replyToId = body.reply_to_message_id ? parseInt(String(body.reply_to_message_id), 10) : undefined;
      const caption = body.caption || body.message || undefined;
      const result = await humanReplyService.sendImageReply(params.id, body.imageUrl, replyToId, body.storageKey, body.fileName, caption);

      if (deps.takeoverManager) {
        const leaseDurationMs = (config.HUMAN_SESSION_TIMEOUT_MINUTES || 480) * 60 * 1000;
        deps.takeoverManager.setTakeoverState(params.id, "ACTIVE_HUMAN", "human_agent_admin", leaseDurationMs, true);
      }

      return reply.code(200).send(result);
    });

    // 9.5. POST /api/admin/conversations/:id/release
    fastify.post("/api/admin/conversations/:id/release", async (request, reply) => {
      const params = request.params as any;
      try {
        let takeoverState;
        if (deps.takeoverManager) {
          takeoverState = await deps.takeoverManager.setTakeoverState(params.id, "ACTIVE_AI");
        }

        const conv = await deps.dbAdapter.getConversation(params.id);
        if (conv && conv.handled_by !== "human") {
          return reply.code(200).send({
            success: true,
            handled_by: conv.handled_by,
            takeover_status: takeoverState?.status || "ACTIVE_AI",
            human_session_started_at: null,
            human_session_expire_at: null,
            last_human_reply_at: null,
          });
        }

        // Generate AI closing summary in the background using existing memory service
        const conversationMemoryService = new ConversationMemoryService();
        deps.dbAdapter.getMessages(params.id).then(async (rawMsgs) => {
          const msgs = rawMsgs.map((m: any, idx: number) => ({
            id: String(m.id || m.Id || idx),
            role: m.role || "customer",
            content: m.content || "",
            timestamp: m.timestamp || m.created_at || new Date().toISOString(),
          }));
          const tickets = await deps.dbAdapter.listAllTickets(params.id);
          conversationMemoryService.generateClosingSummary(params.id, msgs, tickets).catch((err) => {
            console.error("[Release] Summary generation failed:", err.message);
          });
        }).catch((err) => {
          console.error("[Release] Failed to load messages for closing summary:", err.message);
        });

        await deps.dbAdapter.updateHandoffState(params.id, "ai");
        return reply.code(200).send({
          success: true,
          handled_by: "ai",
          takeover_status: takeoverState?.status || "ACTIVE_AI",
          human_session_started_at: null,
          human_session_expire_at: null,
          last_human_reply_at: null,
        });
      } catch (e: any) {
        return reply.code(500).send({ error: "Failed to release conversation", message: e.message });
      }
    });

    // GET /api/admin/conversations/:id/timeline
    fastify.get("/api/admin/conversations/:id/timeline", async (request, reply) => {
      const params = request.params as any;
      const conversationId = params.id;
      try {
        const conv = await deps.dbAdapter.getConversation(conversationId);
        if (!conv) {
          return reply.code(404).send({ error: "Conversation not found" });
        }

        // Query messages with attachments
        const { rows: dbMessages } = await pool.query(
          `SELECT id, role, content, message_type, created_at FROM messages WHERE conversation_id = $1 ORDER BY id ASC`,
          [parseInt(conversationId, 10)]
        );

        const hydratedMessages = await Promise.all(dbMessages.map(async (m: any) => {
          const attRes = await pool.query(
            `SELECT id, file_url, thumbnail_url, file_name, file_type, file_size, storage_key 
           FROM message_attachments WHERE message_id = $1`,
            [m.id]
          );
          return {
            id: `msg-${m.id}`,
            messageId: m.id,
            type: "message",
            role: m.role,
            content: m.content,
            messageType: m.message_type || "text",
            timestamp: m.created_at,
            attachments: attRes.rows.map((att: any) => ({
              id: att.id,
              fileUrl: att.file_url,
              thumbnailUrl: att.thumbnail_url || att.file_url,
              fileName: att.file_name,
              fileType: att.file_type || "image/jpeg",
              fileSize: att.file_size || 0,
              storageKey: att.storage_key
            }))
          };
        }));

        // Query event logs
        const { rows: dbEvents } = await pool.query(
          `SELECT id, event_type, payload, created_at FROM conversation_events WHERE conversation_id = $1`,
          [parseInt(conversationId, 10)]
        );

        const timelineItems = [
          ...hydratedMessages,
          ...dbEvents.map((e: any) => ({
            id: `evt-${e.id}`,
            type: "event",
            eventType: e.event_type,
            payload: typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload,
            timestamp: e.created_at,
          })),
        ];


        // Sort chronologically
        timelineItems.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

        return reply.code(200).send({ rows: timelineItems });
      } catch (e: any) {
        return reply.code(500).send({ error: "Failed to retrieve timeline", message: e.message });
      }
    });

    // 9.6. GET /api/admin/conversations/:id/profile
    fastify.get("/api/admin/conversations/:id/profile", async (request, reply) => {
      const params = request.params as any;
      const conversationId = params.id;
      try {
        // 1. Get conversation
        const conv = await deps.dbAdapter.getConversation(conversationId);
        if (!conv) {
          return reply.code(404).send({ error: "Conversation not found" });
        }

        // 2. Get messages
        const messages = await deps.dbAdapter.getMessages(conversationId);

        // 3. Resolve Identity, Profile, Company, Project
        let identity = {
          channel: conv.channel || "line",
          channel_ref: "unknown",
          profile_name: "unknown",
          avatar_url: null as string | null,
          email: "unknown",
          phone: "unknown"
        };

        let company = {
          name: "Orbit Retail",
          industry: "Retail & E-commerce"
        };

        let project = {
          id: null as number | null,
          name: "",
          company: "",
          environment: "",
          projectType: "",
          defaultPriority: "",
          priorities: [] as any[]
        };

        try {
          const { pool } = require("../../adapters/postgres/PostgresAdapter");
          const projectId = conv.project_id;
          if (projectId) {
            project.id = parseInt(String(projectId), 10);

            const projRes = await pool.query(
              `SELECT p.name AS project_name, p.environment, p.project_type, c.name AS company_name 
             FROM projects p 
             LEFT JOIN companies c ON c.id = p.company_id 
             WHERE p.id = $1`,
              [projectId]
            );
            if (projRes.rows.length > 0) {
              project.name = projRes.rows[0].project_name || "";
              project.company = projRes.rows[0].company_name || "";
              project.environment = projRes.rows[0].environment || "";
              project.projectType = projRes.rows[0].project_type || "";
            }

            const slaRes = await pool.query(
              `SELECT priority, priority_name, description, response_hours, resolve_hours, service_window, is_default, display_order 
             FROM project_sla_policies 
             WHERE project_id = $1 
             ORDER BY display_order ASC`,
              [projectId]
            );

            if (slaRes.rows.length > 0) {
              project.priorities = slaRes.rows.map((r: any) => ({
                code: r.priority,
                name: r.priority_name || r.priority,
                description: r.description || "",
                responseHours: r.response_hours || r.resolve_hours || 0,
                resolveHours: r.resolve_hours || 0,
                serviceWindow: r.service_window || ""
              }));
              const defRow = slaRes.rows.find((r: any) => r.is_default);
              project.defaultPriority = defRow ? defRow.priority : slaRes.rows[0].priority;
            }
          }
        } catch (err: any) {
          console.error("Failed to dynamically load project details inside profile:", err.message);
        }

        // If we are using NocoDBAdapter, we can query the database directly for actual profile / company!
        if (typeof (deps.dbAdapter as any).getRows === "function") {
          try {
            const adapter = deps.dbAdapter as any;
            const identityId = adapter.extractId(conv.identity_id);
            if (identityId) {
              const idents = await adapter.getRows(adapter.tableIdentities, { where: `(Id,eq,${identityId})`, limit: 1 });
              if (idents.length > 0) {
                const ident = idents[0];
                identity.channel_ref = ident.channel_ref || "-";
                identity.channel = ident.channel || "line";

                const profileId = adapter.extractId(ident.profile_id);
                if (profileId) {
                  const profs = await adapter.getRows(adapter.tableProfiles, { where: `(Id,eq,${profileId})`, limit: 1 });
                  if (profs.length > 0) {
                    const prof = profs[0];
                    identity.profile_name = prof.display_name || prof.name || "-";
                    identity.email = prof.email || "-";
                    identity.phone = prof.phone || "-";
                    identity.avatar_url = prof.avatar_url || null;

                    const compId = adapter.extractId(prof.company_id || prof.company);
                    if (compId) {
                      const comps = await adapter.getRows(adapter.tableCompanies, { where: `(Id,eq,${compId})`, limit: 1 });
                      if (comps.length > 0) {
                        company.name = comps[0].name || "-";
                        company.industry = comps[0].industry || "-";
                      }
                    }
                  }
                }
              }
            }
          } catch (dbErr: any) {
            console.error("[admin.ts] Failed to query full NocoDB profile path:", dbErr.message);
          }
        } else {
          // Query Postgres
          try {
            const { pool } = require("../../adapters/postgres/PostgresAdapter");
            const res = await pool.query(
              `SELECT 
              i.channel_ref, i.channel, 
              p.name AS profile_name,
              p.email AS profile_email,
              p.phone AS profile_phone,
              p.id AS profile_id,
              co.name AS company_name
             FROM conversations c
             JOIN identities i ON i.id = c.identity_id
             LEFT JOIN profiles p ON p.id = i.profile_id
             LEFT JOIN companies co ON co.id = p.company_id
             WHERE c.id = $1::integer LIMIT 1`,
              [conversationId]
            );
            if (res.rows.length > 0) {
              const row = res.rows[0];
              identity.channel_ref = row.channel_ref || "-";
              identity.channel = row.channel || "line";
              identity.profile_name = row.profile_name || "-";
              identity.email = row.profile_email || "-";
              identity.phone = row.profile_phone || "-";
              identity.avatar_url = null;
              company.name = row.company_name || "-";
            }
          } catch (dbErr: any) {
            console.error("[admin.ts] Failed to query full Postgres profile path:", dbErr.message);
          }
        }

        if (identity.channel_ref === "unknown" || !identity.channel_ref) {
          identity.channel_ref = conv.customer || "-";
        }
        if (identity.profile_name === "unknown" || !identity.profile_name) {
          identity.profile_name = "-";
        }

        // Dynamically fetch real LINE user profile (avatar & display name) via LINE Messaging API
        if ((identity.channel === "line" || identity.channel === "line_group") && identity.channel_ref && identity.channel_ref.startsWith("U")) {
          const lineData = await getLineProfile(identity.channel_ref);
          if (lineData?.pictureUrl) {
            identity.avatar_url = lineData.pictureUrl;
          }
          if (lineData?.displayName && (identity.profile_name === "-" || identity.profile_name === "unknown" || !identity.profile_name)) {
            identity.profile_name = lineData.displayName;
          }
        }

        // 4. Calculate stats
        const totalMessages = messages.length;
        const userMessages = messages.filter((m: any) => m.role === "user" || m.role === "customer" || m.sender === "customer").length;
        const agentMessages = totalMessages - userMessages;

        let firstContact = conv.created_at || new Date().toISOString();
        let lastContact = new Date().toISOString();
        if (messages.length > 0) {
          firstContact = messages[0].created_at || messages[0].CreatedAt || firstContact;
          lastContact = messages[messages.length - 1].created_at || messages[messages.length - 1].CreatedAt || lastContact;
        }

        const statistics = {
          total_messages: totalMessages,
          user_messages: userMessages,
          agent_messages: agentMessages,
          first_contact: firstContact,
          last_contact: lastContact,
          handled_by: conv.handled_by || "ai"
        };

        // 5. Generate dynamic AI summary from messages
        let aiSummary = `Customer ${identity.profile_name} from ${company.name} has opened a new conversation room. No messages have been exchanged yet.`;
        if (messages.length > 0) {
          const customerMsgs = messages.filter((m: any) => m.role === "user" || m.role === "customer" || m.sender === "customer");
          const lastMsg = messages[messages.length - 1];

          const getSnippet = (msg: any) => {
            const text = (msg.content || "").trim();
            if (text) {
              return text.length > 120 ? text.substring(0, 120) + '...' : text;
            }
            if (msg.attachments && msg.attachments.length > 0) {
              return '[Attachment]';
            }
            if (msg.message_type === 'image' || msg.messageType === 'image') {
              return '[Image]';
            }
            return '(no text content)';
          };

          const firstMsg = customerMsgs.length > 0 ? customerMsgs[0] : messages[0];
          const questionText = getSnippet(firstMsg);

          aiSummary = `${identity.profile_name} from ${company.name} reached out regarding: "${questionText}".`;
          if (lastMsg) {
            const senderLabel = lastMsg.role === "user" || lastMsg.role === "customer" || lastMsg.sender === "customer" ? "Customer" : "AI/Operator";
            const lastText = getSnippet(lastMsg);
            aiSummary += ` The latest update was from the ${senderLabel}: "${lastText}".`;
          }
        }

        // 6. Customer 360 Evolution (Previous conversations, Ticket history, Customer activity summary)
        let previousConversations: any[] = [];
        let ticketHistory: any[] = [];
        let customerActivitySummary = {
          total_conversations: 1,
          total_tickets: 0,
          resolved_tickets: 0,
          pending_tickets: 0,
          total_messages: totalMessages,
        };

        if (typeof (deps.dbAdapter as any).getRows === "function") {
          try {
            const adapter = deps.dbAdapter as any;
            const identityId = adapter.extractId(conv.identity_id);
            if (identityId) {
              // Find all conversations for this identity
              const allConvs = await adapter.getRows(adapter.tableConversations, {
                where: `(identity_id,eq,${identityId})`,
                limit: 100,
              });

              const otherConvs = allConvs.filter((c: any) => String(c.Id || c.id || c.id1) !== String(conversationId));

              // Map previous conversations
              previousConversations = otherConvs.map((c: any) => ({
                id: String(c.Id || c.id || c.id1),
                channel: c.channel || "line",
                status: c.status || "open",
                handled_by: c.handled_by || "ai",
                created_at: c.created_at || c.CreatedAt || new Date().toISOString(),
              }));

              // Get all conversation IDs of this customer
              const convIds = allConvs.map((c: any) => String(adapter.extractId(c.Id || c.id || c.id1)));

              // Fetch tickets
              const allTickets = await adapter.listAllTickets(); // resolves from cache or NocoDB
              ticketHistory = allTickets.filter((t: any) => convIds.includes(String(t.conversationId)));

              // Fetch messages for all convs to sum up messages count
              const allMsgs = await adapter.getRows(adapter.tableMessages, { limit: 1000 });
              const customerMsgs = allMsgs.filter((m: any) => convIds.includes(String(adapter.extractId(m.conversation_id))));

              customerActivitySummary = {
                total_conversations: allConvs.length,
                total_tickets: ticketHistory.length,
                resolved_tickets: ticketHistory.filter((t: any) => t.status === 'Resolved' || t.status === 'Closed' || t.status === 'Done').length,
                pending_tickets: ticketHistory.filter((t: any) => t.status !== 'Resolved' && t.status !== 'Closed' && t.status !== 'Done').length,
                total_messages: customerMsgs.length,
              };
            }
          } catch (err: any) {
            console.error("[admin.ts] Failed to query CRM customer 360 data:", err.message);
          }
        } else {
          // Query Postgres
          try {
            const { pool } = require("../../adapters/postgres/PostgresAdapter");
            // Fetch previous conversations for this identity
            const convRes = await pool.query(
              `SELECT id, channel, status, handled_by, created_at FROM conversations
             WHERE identity_id = (SELECT identity_id FROM conversations WHERE id = $1::integer)
               AND id != $1::integer
             ORDER BY created_at DESC LIMIT 100`,
              [conversationId]
            );
            previousConversations = convRes.rows.map((c: any) => ({
              id: String(c.id),
              channel: c.channel || "line",
              status: c.status || "open",
              handled_by: c.handled_by || "ai",
              created_at: c.created_at instanceof Date ? c.created_at.toISOString() : c.created_at || new Date().toISOString(),
            }));

            const tixRes = await pool.query(
              `SELECT t.id, t.subject, t.summary, t.status, t.priority, t.project_id, t.created_at, p.priority_name, p.resolve_hours
             FROM tickets t
             LEFT JOIN project_sla_policies p ON p.project_id = t.project_id AND p.priority = t.priority
             WHERE t.conversation_id IN (
               SELECT id FROM conversations WHERE identity_id = (SELECT identity_id FROM conversations WHERE id = $1::integer)
             )`,
              [conversationId]
            );
            ticketHistory = tixRes.rows.map((t: any) => {
              const severity = t.priority_name || t.priority || "Low";
              const baseDate = t.created_at ? new Date(t.created_at) : new Date();
              const resolveHours = t.resolve_hours || 120;
              const dueDate = new Date(baseDate.getTime() + resolveHours * 60 * 60 * 1000).toISOString();

              return {
                id: String(t.id),
                id1: String(t.id),
                ticketId: String(t.id),
                conversationId: String(conversationId),
                subject: t.subject,
                summary: t.summary,
                status: t.status,
                priority: t.priority,
                severity,
                dueDate,
                createdAt: baseDate.toISOString(),
              };
            });

            // Fetch messages count
            const msgsCountRes = await pool.query(
              `SELECT COUNT(*)::integer AS count FROM messages
             WHERE conversation_id IN (
               SELECT id FROM conversations WHERE identity_id = (SELECT identity_id FROM conversations WHERE id = $1::integer)
             )`,
              [conversationId]
            );

            customerActivitySummary = {
              total_conversations: previousConversations.length + 1,
              total_tickets: ticketHistory.length,
              resolved_tickets: ticketHistory.filter((t: any) => t.status === 'Resolved' || t.status === 'Closed' || t.status === 'Done').length,
              pending_tickets: ticketHistory.filter((t: any) => t.status !== 'Resolved' && t.status !== 'Closed' && t.status !== 'Done').length,
              total_messages: msgsCountRes.rows[0]?.count || totalMessages,
            };
          } catch (err: any) {
            console.error("[admin.ts] Failed to query CRM customer 360 data:", err.message);
          }
        }

        return reply.code(200).send({
          identity,
          company,
          project,
          statistics,
          ai_summary: aiSummary,
          previous_conversations: previousConversations,
          ticket_history: ticketHistory,
          customer_activity_summary: customerActivitySummary,
        });
      } catch (e: any) {
        return reply.code(500).send({ error: "Failed to load CRM profile", message: e.message });
      }
    });

    // 10. POST /api/admin/tickets/:id/promote
    fastify.post("/api/admin/tickets/:id/promote", async (request, reply) => {
      const params = request.params as any;
      const result = await planeService.promoteTicketToPlane(params.id);
      return reply.code(200).send(result);
    });

    // 11. GET /api/admin/conversations/:id/tickets
    fastify.get("/api/admin/conversations/:id/tickets", async (request, reply) => {
      const params = request.params as any;
      const query = request.query as any;
      const projectId = query?.projectId ? String(query.projectId) : undefined;
      const tickets = await deps.dbAdapter.listAllTickets(params.id, projectId, undefined, undefined, request.tenantContext);
      return reply.code(200).send(tickets);
    });

    // Outbox dead letters.
    //
    // Eleven abandoned events sat unnoticed for 19 days because nothing
    // surfaced them. These endpoints make the queue's failures visible and
    // give an operator an explicit way to requeue one after fixing the cause.
    fastify.get("/api/admin/outbox/dead-letters", async (request, reply) => {
      const query = request.query as any;
      const limit = Math.min(parseInt(String(query?.limit ?? "50"), 10) || 50, 200);
      const offset = Math.max(parseInt(String(query?.offset ?? "0"), 10) || 0, 0);

      const [items, byKind] = await Promise.all([
        outboxRepo.listDeadLetters(limit, offset),
        outboxRepo.countDeadLettersByKind(),
      ]);

      const summary = byKind.reduce(
        (acc: Record<string, number>, row) => {
          acc[row.failure_kind || "unclassified"] = row.count;
          return acc;
        },
        {} as Record<string, number>
      );

      return reply.code(200).send({
        summary,
        total: byKind.reduce((n, row) => n + row.count, 0),
        items: items.map((row: any) => ({
          id: row.id,
          eventType: row.event_type,
          aggregateType: row.aggregate_type,
          aggregateId: row.aggregate_id,
          attempts: row.attempts,
          // transient  - the retry budget ran out; the cause may have cleared
          // permanent  - the payload will never be accepted; requeueing is futile
          // blocked    - credentials or permissions; fix configuration first
          failureKind: row.failure_kind || "unclassified",
          error: row.error_message,
          createdAt: row.created_at,
          deadLetteredAt: row.dead_lettered_at,
          retryable: row.failure_kind !== "permanent",
        })),
      });
    });

    fastify.post("/api/admin/outbox/dead-letters/:id/requeue", async (request, reply) => {
      const params = request.params as any;
      const id = parseInt(String(params.id), 10);
      if (!Number.isInteger(id) || id <= 0) {
        return reply.code(400).send({ error: "Bad Request", message: "Invalid outbox event id" });
      }

      const requeued = await outboxRepo.requeueDeadLetter(id);
      if (!requeued) {
        return reply.code(404).send({
          error: "Not Found",
          message: `No dead-lettered outbox event with id ${id}`,
        });
      }

      return reply.code(200).send({ success: true, id, status: "pending" });
    });

    // 11.5. GET /api/admin/tickets
    fastify.get("/api/admin/tickets", async (request, reply) => {
      const query = request.query as any;
      const projectId = query?.projectId ? String(query.projectId) : undefined;
      const tickets = await deps.dbAdapter.listAllTickets(undefined, projectId, undefined, undefined, request.tenantContext);
      return reply.code(200).send(tickets);
    });

    // GET /api/admin/tickets/:id
    fastify.get("/api/admin/tickets/:id", async (request, reply) => {
      const params = request.params as any;
      const ticketIdStr = String(params.id);
      const isNumeric = /^\d+$/.test(ticketIdStr);
      const query = isNumeric
        ? `SELECT * FROM tickets WHERE id = $1`
        : `SELECT * FROM tickets WHERE ticket_id = $1`;
      const { rows } = await pool.query(query, [isNumeric ? parseInt(ticketIdStr, 10) : ticketIdStr]);
      if (rows.length === 0) {
        return reply.code(404).send({ error: "Ticket not found" });
      }
      const ticket = rows[0];
      return reply.code(200).send({
        id: String(ticket.id),
        ticketId: ticket.ticket_id,
        conversationId: String(ticket.conversation_id),
        projectId: String(ticket.project_id),
        subject: ticket.subject,
        summary: ticket.summary,
        status: ticket.status,
        priority: ticket.priority,
        severity: ticket.severity,
        assignedPm: ticket.assigned_pm,
        createdVia: ticket.created_via,
        planeIssueId: ticket.plane_issue_id,
        dueDate: ticket.due_date ? ticket.due_date.toISOString() : null,
        createdAt: ticket.created_at.toISOString(),
        enrichmentState: ticket.enrichment_state,
        aiTitle: ticket.title,
        runningSummary: ticket.running_summary,
        lastAiSummary: ticket.last_ai_summary,
        duplicateOfTicketId: ticket.duplicate_of_ticket_id ? String(ticket.duplicate_of_ticket_id) : null,
        duplicateScore: ticket.duplicate_score,
        duplicateReason: ticket.duplicate_reason,
        aiConfidenceMetrics: ticket.ai_confidence_metrics,
      });
    });

    // GET /api/admin/traces/raw
    fastify.get("/api/admin/traces/raw", async (request, reply) => {
      const traces = await deps.dbAdapter.listAllTraces();
      return reply.code(200).send(traces);
    });

    // 12. POST /api/admin/conversations/:id/tickets
    fastify.post("/api/admin/conversations/:id/tickets", async (request, reply) => {
      const params = request.params as any;
      const body = request.body as any;

      if (!body || !body.subject || !body.summary || !body.severity || !body.priority) {
        return reply.code(400).send({
          error: "Bad Request",
          message: "Fields 'subject', 'summary', 'severity', and 'priority' are required",
        });
      }

      const ticketService = new TicketService(deps.dbAdapter);
      const createdByType = body.created_by_type || body.createdByType || "HUMAN_AGENT";
      const createdByName = body.created_by_name || body.createdByName || body.operator_name || "Super Admin Overseer";

      const result = await ticketService.createTicket({
        conversationId: params.id,
        subject: body.subject,
        summary: body.summary,
        severity: body.severity,
        priority: body.priority,
        projectId: body.projectId || "1",
        createdByType,
        createdByName,
      });

      if (!result.success) {
        return reply.code(500).send(result);
      }

      if (result.success && result.data && result.data.id) {
        try {
          const planeService = new PlaneService(deps.dbAdapter);
          const planeResult = await planeService.promoteTicketToPlane(result.data.id);
          if (planeResult && planeResult.plane_issue_id) {
            result.data.planeIssueId = planeResult.plane_issue_id;
            result.data.plane_issue_id = planeResult.plane_issue_id;
          }
        } catch (planeErr: any) {
          fastify.log.warn({ err: planeErr.message }, "[TicketCreation] Auto-promote to Plane failed gracefully");
        }
      }

      return reply.code(200).send(result);
    });

    // ── AX-FE-010: Projects Listing API ─────────────────────────
    fastify.get("/api/v1/admin/projects", async (_request, reply) => {
      try {
        const { rows } = await pool.query(
          "SELECT id, company_id, name, project_type, environment FROM projects ORDER BY id ASC"
        );
        if (rows && rows.length > 0) {
          const projects = rows.map((r: any) => ({
            id: String(r.id),
            company_id: r.company_id,
            name: r.name,
            projectType: r.project_type || "Support Project",
            environment: r.environment || "Production",
          }));
          return reply.code(200).send(projects);
        }
      } catch (err: any) {
        fastify.log.warn({ err }, "Failed to list projects from PostgreSQL, using real project seed");
      }
      return reply.code(200).send([
        { id: "1", company_id: 1, name: "AutomationX Demo", projectType: "Demo Project", environment: "AutomationX Demo Environment" },
        { id: "2", company_id: 2, name: "Customer Success Service", projectType: "Support Project", environment: "Customer Success Production" },
        { id: "8", company_id: 5, name: "24/7", projectType: "Support Project", environment: "Avalant 24/7 Production" },
        { id: "11", company_id: 5, name: "SSO Project", projectType: "Support Project", environment: "SSO Production" },
        { id: "12", company_id: 5, name: "CRA Project", projectType: "Support Project", environment: "CRA Production" },
      ]);
    });

    // ── AX-BE-060: Admin Settings Controller ────────────────────

    // Helper validation functions
    function validateSla(body: any) {
      const { priority, resolve_hours, response_hours, service_window } = body;
      if (!priority || !/^(Urgent|High|Medium|Low|None|P[1-5])$/i.test(priority)) {
        throw new Error("Invalid priority: must be Urgent, High, Medium, Low, None, or P1-P5");
      }
      if (resolve_hours === undefined || isNaN(parseInt(resolve_hours, 10)) || parseInt(resolve_hours, 10) <= 0 || parseInt(resolve_hours, 10) > 720) {
        throw new Error("Invalid resolve_hours: must be an integer between 1 and 720");
      }
      if (response_hours !== undefined && response_hours !== null) {
        const rh = parseInt(response_hours, 10);
        if (isNaN(rh) || rh <= 0 || rh > parseInt(resolve_hours, 10)) {
          throw new Error("Invalid response_hours: must be an integer between 1 and resolve_hours");
        }
      }
      if (service_window && service_window !== "24x7" && service_window !== "Business Hours") {
        throw new Error("Invalid service_window: must be '24x7' or 'Business Hours'");
      }
    }

    function validateBusinessHours(body: any) {
      const { day_of_week, start_time, end_time, timezone } = body;
      const day = parseInt(day_of_week, 10);
      if (day_of_week === undefined || isNaN(day) || day < 0 || day > 6) {
        throw new Error("Invalid day_of_week: must be an integer between 0 and 6");
      }
      const timeRegex = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;
      if (!start_time || !timeRegex.test(start_time)) {
        throw new Error("Invalid start_time format (HH:MM or HH:MM:SS required)");
      }
      if (!end_time || !timeRegex.test(end_time)) {
        throw new Error("Invalid end_time format (HH:MM or HH:MM:SS required)");
      }
      // Chronological check
      const startSec = start_time.split(':').reduce((acc: number, val: string) => acc * 60 + parseInt(val, 10), 0);
      const endSec = end_time.split(':').reduce((acc: number, val: string) => acc * 60 + parseInt(val, 10), 0);
      if (startSec >= endSec) {
        throw new Error("start_time must be chronologically before end_time");
      }
      if (timezone) {
        try {
          Intl.DateTimeFormat(undefined, { timeZone: timezone });
        } catch (e) {
          throw new Error(`Invalid timezone ID: '${timezone}'`);
        }
      }
    }

    function validateSettings(body: any) {
      const { aiSettings, prompt, featureFlags } = body;
      if (aiSettings) {
        const ct = aiSettings.confidence_threshold !== undefined ? aiSettings.confidence_threshold : aiSettings.confidenceThreshold;
        const mhd = aiSettings.max_handoff_depth !== undefined ? aiSettings.max_handoff_depth : aiSettings.maxHandoffDepth;
        const vmt = aiSettings.vector_match_threshold !== undefined ? aiSettings.vector_match_threshold : aiSettings.vectorMatchThreshold;

        if (ct !== undefined) {
          const val = parseFloat(ct);
          if (isNaN(val) || val < 0.0 || val > 1.0) {
            throw new Error("Invalid confidence_threshold: must be a float between 0.0 and 1.0");
          }
        }
        if (vmt !== undefined) {
          const val = parseFloat(vmt);
          if (isNaN(val) || val < 0.0 || val > 1.0) {
            throw new Error("Invalid vector_match_threshold: must be a float between 0.0 and 1.0");
          }
        }
        if (mhd !== undefined) {
          const val = parseInt(mhd, 10);
          if (isNaN(val) || val < 1 || val > 20) {
            throw new Error("Invalid max_handoff_depth: must be an integer between 1 and 20");
          }
        }
      }
      if (prompt) {
        const si = prompt.system_instruction !== undefined ? prompt.system_instruction : prompt.systemInstruction;
        const temp = prompt.temperature !== undefined ? prompt.temperature : prompt.temperature;
        const mt = prompt.max_tokens !== undefined ? prompt.max_tokens : prompt.maxTokens;

        if (si !== undefined && (typeof si !== "string" || si.trim() === "")) {
          throw new Error("Invalid system_instruction: must be a non-empty string");
        }
        if (temp !== undefined) {
          const val = parseFloat(temp);
          if (isNaN(val) || val < 0.0 || val > 2.0) {
            throw new Error("Invalid temperature: must be a float between 0.0 and 2.0");
          }
        }
        if (mt !== undefined) {
          const val = parseInt(mt, 10);
          if (isNaN(val) || val < 1 || val > 8192) {
            throw new Error("Invalid max_tokens: must be an integer between 1 and 8192");
          }
        }
      }
      if (featureFlags) {
        if (typeof featureFlags !== "object") {
          throw new Error("Invalid featureFlags format: must be an object");
        }
        for (const [key, val] of Object.entries(featureFlags)) {
          if (typeof val !== "boolean") {
            throw new Error(`Invalid feature flag value for flag '${key}': must be boolean`);
          }
        }
      }
    }

    // 1. SLA Policies CRUD
    fastify.get("/api/v1/admin/projects/:id/sla", async (request, reply) => {
      const { id } = request.params as any;
      const { pool } = require("../../adapters/postgres/PostgresAdapter");
      const { rows } = await pool.query(
        "SELECT * FROM project_sla_policies WHERE project_id = $1 ORDER BY display_order ASC, id ASC",
        [parseInt(id, 10)]
      );
      return reply.code(200).send(rows);
    });

    fastify.post("/api/v1/admin/projects/:id/sla", async (request, reply) => {
      const { id } = request.params as any;
      const body = request.body as any;
      const actor = (request.headers["x-actor"] as string) || "admin";
      const { pool } = require("../../adapters/postgres/PostgresAdapter");
      const { ConfigLoaderService } = require("../../services/ConfigLoaderService");

      try {
        validateSla(body);
      } catch (validationErr: any) {
        return reply.code(400).send({ error: "Validation Error", message: validationErr.message });
      }

      const {
        priority,
        resolve_hours,
        priority_name,
        description,
        response_hours,
        service_window,
        display_order,
        is_default,
        is_active
      } = body;

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // Fetch old value for audit logging
        const oldSla = await client.query(
          "SELECT * FROM project_sla_policies WHERE project_id = $1 AND priority = $2",
          [parseInt(id, 10), priority]
        );
        const oldValue = oldSla.rows[0] || null;

        // Upsert SLA policy
        await client.query(
          `INSERT INTO project_sla_policies (
          project_id, priority, resolve_hours, priority_name, description, 
          response_hours, service_window, display_order, is_default, is_active
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (project_id, priority) DO UPDATE SET
          resolve_hours = EXCLUDED.resolve_hours,
          priority_name = COALESCE(EXCLUDED.priority_name, project_sla_policies.priority_name),
          description = COALESCE(EXCLUDED.description, project_sla_policies.description),
          response_hours = COALESCE(EXCLUDED.response_hours, project_sla_policies.response_hours),
          service_window = COALESCE(EXCLUDED.service_window, project_sla_policies.service_window),
          display_order = COALESCE(EXCLUDED.display_order, project_sla_policies.display_order),
          is_default = COALESCE(EXCLUDED.is_default, project_sla_policies.is_default),
          is_active = COALESCE(EXCLUDED.is_active, project_sla_policies.is_active)`,
          [
            parseInt(id, 10),
            priority,
            parseInt(resolve_hours, 10),
            priority_name || null,
            description || null,
            response_hours !== undefined ? parseInt(response_hours, 10) : null,
            service_window || 'Business Hours',
            display_order !== undefined ? parseInt(display_order, 10) : 1,
            is_default === true,
            is_active !== false
          ]
        );

        // Audit Log
        await client.query(
          `INSERT INTO admin_audit_logs (project_id, action, old_value, new_value, actor)
         VALUES ($1, $2, $3, $4, $5)`,
          [
            parseInt(id, 10),
            "UPSERT_SLA_POLICY",
            JSON.stringify(oldValue || {}),
            JSON.stringify(body),
            actor
          ]
        );

        await client.query("COMMIT");
      } catch (err: any) {
        await client.query("ROLLBACK");
        return reply.code(500).send({ error: "Database Error", message: err.message });
      } finally {
        client.release();
      }

      // Evict settings cache
      await ConfigLoaderService.getInstance().invalidateProjectCache(String(id));

      return reply.code(200).send({ success: true });
    });

    fastify.delete("/api/v1/admin/projects/:id/sla/:priority", async (request, reply) => {
      const { id, priority } = request.params as any;
      const actor = (request.headers["x-actor"] as string) || "admin";
      const { pool } = require("../../adapters/postgres/PostgresAdapter");
      const { ConfigLoaderService } = require("../../services/ConfigLoaderService");

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // Fetch old value for audit logging
        const oldSla = await client.query(
          "SELECT * FROM project_sla_policies WHERE project_id = $1 AND priority = $2",
          [parseInt(id, 10), priority]
        );
        const oldValue = oldSla.rows[0] || null;

        if (!oldValue) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: "Not Found", message: "SLA Policy not found" });
        }

        await client.query(
          "DELETE FROM project_sla_policies WHERE project_id = $1 AND priority = $2",
          [parseInt(id, 10), priority]
        );

        // Audit Log
        await client.query(
          `INSERT INTO admin_audit_logs (project_id, action, old_value, new_value, actor)
         VALUES ($1, $2, $3, $4, $5)`,
          [
            parseInt(id, 10),
            "DELETE_SLA_POLICY",
            JSON.stringify(oldValue),
            JSON.stringify({}),
            actor
          ]
        );

        await client.query("COMMIT");
      } catch (err: any) {
        await client.query("ROLLBACK");
        return reply.code(500).send({ error: "Database Error", message: err.message });
      } finally {
        client.release();
      }

      await ConfigLoaderService.getInstance().invalidateProjectCache(String(id));

      return reply.code(200).send({ success: true });
    });

    // 2. Business Hours CRUD
    fastify.get("/api/v1/admin/projects/:id/business-hours", async (request, reply) => {
      const { id } = request.params as any;
      const { pool } = require("../../adapters/postgres/PostgresAdapter");
      const { rows } = await pool.query(
        "SELECT * FROM project_business_hours WHERE project_id = $1 ORDER BY day_of_week ASC",
        [parseInt(id, 10)]
      );
      return reply.code(200).send(rows);
    });

    fastify.post("/api/v1/admin/projects/:id/business-hours", async (request, reply) => {
      const { id } = request.params as any;
      const body = request.body as any;
      const actor = (request.headers["x-actor"] as string) || "admin";
      const { pool } = require("../../adapters/postgres/PostgresAdapter");
      const { ConfigLoaderService } = require("../../services/ConfigLoaderService");

      try {
        validateBusinessHours(body);
      } catch (validationErr: any) {
        return reply.code(400).send({ error: "Validation Error", message: validationErr.message });
      }

      const { day_of_week, start_time, end_time, timezone } = body;

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // Fetch old value for audit logging
        const oldBH = await client.query(
          "SELECT * FROM project_business_hours WHERE project_id = $1 AND day_of_week = $2",
          [parseInt(id, 10), parseInt(day_of_week, 10)]
        );
        const oldValue = oldBH.rows[0] || null;

        // Clean existing business hours for that day
        await client.query(
          "DELETE FROM project_business_hours WHERE project_id = $1 AND day_of_week = $2",
          [parseInt(id, 10), parseInt(day_of_week, 10)]
        );

        // Insert new business hours
        await client.query(
          `INSERT INTO project_business_hours (project_id, day_of_week, start_time, end_time, timezone)
         VALUES ($1, $2, $3, $4, $5)`,
          [
            parseInt(id, 10),
            parseInt(day_of_week, 10),
            start_time,
            end_time,
            timezone || 'UTC'
          ]
        );

        // Audit Log
        await client.query(
          `INSERT INTO admin_audit_logs (project_id, action, old_value, new_value, actor)
         VALUES ($1, $2, $3, $4, $5)`,
          [
            parseInt(id, 10),
            "UPSERT_BUSINESS_HOURS",
            JSON.stringify(oldValue || {}),
            JSON.stringify(body),
            actor
          ]
        );

        await client.query("COMMIT");
      } catch (err: any) {
        await client.query("ROLLBACK");
        return reply.code(500).send({ error: "Database Error", message: err.message });
      } finally {
        client.release();
      }

      await ConfigLoaderService.getInstance().invalidateProjectCache(String(id));

      return reply.code(200).send({ success: true });
    });

    fastify.delete("/api/v1/admin/projects/:id/business-hours/:day", async (request, reply) => {
      const { id, day } = request.params as any;
      const actor = (request.headers["x-actor"] as string) || "admin";
      const { pool } = require("../../adapters/postgres/PostgresAdapter");
      const { ConfigLoaderService } = require("../../services/ConfigLoaderService");

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // Fetch old value for audit logging
        const oldBH = await client.query(
          "SELECT * FROM project_business_hours WHERE project_id = $1 AND day_of_week = $2",
          [parseInt(id, 10), parseInt(day, 10)]
        );
        const oldValue = oldBH.rows[0] || null;

        if (!oldValue) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: "Not Found", message: "Business hours not found" });
        }

        await client.query(
          "DELETE FROM project_business_hours WHERE project_id = $1 AND day_of_week = $2",
          [parseInt(id, 10), parseInt(day, 10)]
        );

        // Audit Log
        await client.query(
          `INSERT INTO admin_audit_logs (project_id, action, old_value, new_value, actor)
         VALUES ($1, $2, $3, $4, $5)`,
          [
            parseInt(id, 10),
            "DELETE_BUSINESS_HOURS",
            JSON.stringify(oldValue),
            JSON.stringify({}),
            actor
          ]
        );

        await client.query("COMMIT");
      } catch (err: any) {
        await client.query("ROLLBACK");
        return reply.code(500).send({ error: "Database Error", message: err.message });
      } finally {
        client.release();
      }

      await ConfigLoaderService.getInstance().invalidateProjectCache(String(id));

      return reply.code(200).send({ success: true });
    });

    // 3. Project Settings (Prompt, AI Settings, Feature Flags)
    fastify.get("/api/v1/admin/projects/:id/settings", async (request, reply) => {
      const { id } = request.params as any;
      const { pool } = require("../../adapters/postgres/PostgresAdapter");

      const aiRes = await pool.query(
        "SELECT * FROM project_ai_settings WHERE project_id = $1 LIMIT 1",
        [parseInt(id, 10)]
      );
      const promptRes = await pool.query(
        "SELECT * FROM project_prompts WHERE project_id = $1 ORDER BY id DESC LIMIT 1",
        [parseInt(id, 10)]
      );
      const flagsRes = await pool.query(
        "SELECT * FROM project_feature_flags WHERE project_id = $1",
        [parseInt(id, 10)]
      );

      const featureFlags = flagsRes.rows.reduce((acc: any, curr: any) => {
        acc[curr.flag_name] = curr.is_enabled;
        return acc;
      }, {});

      return reply.code(200).send({
        aiSettings: aiRes.rows[0] || null,
        prompt: promptRes.rows[0] || null,
        featureFlags
      });
    });

    fastify.post("/api/v1/admin/projects/:id/settings", async (request, reply) => {
      const { id } = request.params as any;
      const body = request.body as any;
      const actor = (request.headers["x-actor"] as string) || "admin";
      const { pool } = require("../../adapters/postgres/PostgresAdapter");
      const { ConfigLoaderService } = require("../../services/ConfigLoaderService");

      try {
        validateSettings(body);
      } catch (validationErr: any) {
        return reply.code(400).send({ error: "Validation Error", message: validationErr.message });
      }

      const { aiSettings, prompt, featureFlags } = body;

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // Fetch old values for audit log
        const oldAi = await client.query("SELECT * FROM project_ai_settings WHERE project_id = $1 LIMIT 1", [parseInt(id, 10)]);
        const oldPrompt = await client.query("SELECT * FROM project_prompts WHERE project_id = $1 ORDER BY id DESC LIMIT 1", [parseInt(id, 10)]);
        const oldFlags = await client.query("SELECT * FROM project_feature_flags WHERE project_id = $1", [parseInt(id, 10)]);

        const oldFeatureFlags = oldFlags.rows.reduce((acc: any, curr: any) => {
          acc[curr.flag_name] = curr.is_enabled;
          return acc;
        }, {});

        const oldValue = {
          aiSettings: oldAi.rows[0] || null,
          prompt: oldPrompt.rows[0] || null,
          featureFlags: oldFeatureFlags
        };

        // Save AI Settings
        if (aiSettings) {
          const ct = aiSettings.confidence_threshold !== undefined ? aiSettings.confidence_threshold : aiSettings.confidenceThreshold;
          const mhd = aiSettings.max_handoff_depth !== undefined ? aiSettings.max_handoff_depth : aiSettings.maxHandoffDepth;
          const vmt = aiSettings.vector_match_threshold !== undefined ? aiSettings.vector_match_threshold : aiSettings.vectorMatchThreshold;

          await client.query(
            `INSERT INTO project_ai_settings (project_id, confidence_threshold, max_handoff_depth, vector_match_threshold)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (project_id) DO UPDATE SET
             confidence_threshold = EXCLUDED.confidence_threshold,
             max_handoff_depth = EXCLUDED.max_handoff_depth,
             vector_match_threshold = EXCLUDED.vector_match_threshold`,
            [
              parseInt(id, 10),
              ct !== undefined ? parseFloat(ct) : 0.70,
              mhd !== undefined ? parseInt(mhd, 10) : 5,
              vmt !== undefined ? parseFloat(vmt) : 0.60
            ]
          );
        }

        // Save Prompts
        if (prompt) {
          const si = prompt.system_instruction !== undefined ? prompt.system_instruction : prompt.systemInstruction;
          const mn = prompt.model_name !== undefined ? prompt.model_name : prompt.modelName;
          const temp = prompt.temperature !== undefined ? prompt.temperature : prompt.temperature;
          const mt = prompt.max_tokens !== undefined ? prompt.max_tokens : prompt.maxTokens;

          if (si) {
            await client.query(
              `INSERT INTO project_prompts (project_id, system_instruction, model_name, temperature, max_tokens)
             VALUES ($1, $2, $3, $4, $5)`,
              [
                parseInt(id, 10),
                si,
                mn || 'gemini-1.5-pro',
                temp !== undefined ? parseFloat(temp) : 0.00,
                mt !== undefined ? parseInt(mt, 10) : 2048
              ]
            );
          }
        }

        // Save Feature Flags
        if (featureFlags) {
          for (const [flagName, isEnabled] of Object.entries(featureFlags)) {
            await client.query(
              `INSERT INTO project_feature_flags (project_id, flag_name, is_enabled)
             VALUES ($1, $2, $3)
             ON CONFLICT (project_id, flag_name) DO UPDATE SET
               is_enabled = EXCLUDED.is_enabled`,
              [parseInt(id, 10), flagName, isEnabled === true]
            );
          }
        }

        // Audit Log
        await client.query(
          `INSERT INTO admin_audit_logs (project_id, action, old_value, new_value, actor)
         VALUES ($1, $2, $3, $4, $5)`,
          [
            parseInt(id, 10),
            "UPDATE_PROJECT_SETTINGS",
            JSON.stringify(oldValue),
            JSON.stringify(body),
            actor
          ]
        );

        await client.query("COMMIT");
      } catch (err: any) {
        await client.query("ROLLBACK");
        return reply.code(500).send({ error: "Database Error", message: err.message });
      } finally {
        client.release();
      }

      // Invalidate project settings cache
      await ConfigLoaderService.getInstance().invalidateProjectCache(String(id));

      return reply.code(200).send({ success: true });
    });
  }

