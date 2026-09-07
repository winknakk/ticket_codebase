import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import axios from "axios";
import { config } from "../config/env";
import { AdapterFactory } from "../adapters/AdapterFactory";
import { TicketService } from "../tools/TicketService";
import { KnowledgeService } from "../tools/search-project-docs/KnowledgeService";
import { EmbeddingService } from "../rag/EmbeddingService";
import { PgVectorStore } from "../rag/PgVectorStore";
import { InMemoryVectorStore } from "../rag/InMemoryVectorStore";
import { VectorStoreRetriever } from "../rag/VectorStoreRetriever";
import {
  ToolRegistry,
  CreateTicketTool,
  GetTicketTool,
  GetTicketStatusTool,
  UpdateSummaryTool,
  FindTicketTool,
  MergeTicketTool,
  ReopenTicketTool,
  CloseTicketTool,
  AssignTicketTool,
  EscalateToPmTool,
} from "../tools/ToolRegistry";
import { SearchProjectDocsTool } from "../tools/search-project-docs/SearchProjectDocsTool";
import { SearchCodebaseTool } from "../tools/SearchCodebaseTool";
import { GitSyncService } from "../services/GitSyncService";
import { PieceAdapter } from "../piece-adapter/PieceAdapter";
import { PieceMcpTool } from "../piece-adapter/PieceMcpTool";
import { DynamicMcpTool } from "../tools/DynamicMcpTool";
import { PromptXMcpClient } from "../mcp/PromptXMcpClient";
import { TakeoverManager } from "../human-takeover/TakeoverManager";
import { TrafficSplitter } from "../aiops/prompt-control/TrafficSplitter";
import { MetricAggregator } from "../aiops/dashboard/MetricAggregator";
import { IngestionService } from "../aiops/ragops/IngestionService";
import { EvalTestRunner } from "../aiops/llmops/EvalTestRunner";
import { registerAdminRoutes } from "./routes/admin";
import { registerAuthRoutes } from "./routes/auth";
import { registerMasterDataRoutes } from "./routes/masterData";
import { registerAdminPlaneIntegrationRoutes } from "./routes/adminPlaneIntegrationRoutes";
import { registerPortalRoutes } from "./routes/portal";
import { registerLineWebhookRoutes } from "./routes/lineWebhook";
import { LineMessageBatchingService } from "../services/LineMessageBatchingService";
import { AgentSessionQueueService } from "../services/AgentSessionQueueService";
import { AgentSessionQueueWorker } from "../services/AgentSessionQueueWorker";
import { registerGitRepositoryRoutes } from "./routes/gitRepoRoutes";
import { SLAMatrixService } from "../services/SLAMatrixService";
import { PolicyEngine } from "../policy/PolicyEngine";
import { RuntimeContextResolver } from "../services/RuntimeContextResolver";
import { ExecutionTraceService } from "../execution/ExecutionTrace";
import { McpToolRouter } from "../mcp/McpToolRouter";
import { MemoryService } from "../memory/MemoryService";
import { HumanReplyService } from "../services/humanReplyService";
import { PlaneService } from "../services/planeService";
import { PlaneWebhookService, verifyPlaneWebhookSignature } from "../services/planeWebhookService";
import { PlaneReverseSyncPoller } from "../services/PlaneReverseSyncPoller";
import { InactivityTimerService } from "../services/InactivityTimerService";
import { EmailNotificationService } from "../services/EmailNotificationService";
import { CloseTicketInputSchema, RestoreTicketInputSchema } from "../schemas/validation";
import { AgentManager } from "../agent/AgentRuntime";
import { Orchestrator } from "../orchestrator/Orchestrator";
import { InboundMessageSchema } from "../schemas/validation";
import rootLogger, { createLogger } from "../observability/logger";
import { startTimer } from "../observability/timing";
import { authHook, authenticateToken, internalApiGuard } from "../middleware/auth";
import { AuthPrincipal } from "../infrastructure/security/SessionTokenService";
import { tenantScopeHook, resolveProjectFilter, resolveTenantScope, canAccessProject } from "../middleware/tenantScope";
import { requireExecutionContext } from "../middleware/executionContext";
import {
  authorizeTicket,
  authorizationStatus,
  findTicketByReference,
  AuthorizedTicket,
} from "../domain/execution/ResourceAuthorization";
import { executionContextService } from "../domain/execution/ExecutionContextService";
import { traceRecorder } from "../observability/TraceRecorder";
import { adminSocketRegistry } from "./AdminSocketRegistry";
import { JwtUtil } from "../shared/jwt";
import { getWebchatJwtSecret } from "../middleware/customerAuth";
import { webhookSignatureHook } from "../middleware/webhookSignature";
import { rateLimitHook } from "../middleware/rateLimit";
import { SmsNotificationService } from "../services/SmsNotificationService";
import { pool } from "../adapters/postgres/PostgresAdapter";
import { nextSequenceId, syncSerialSequences } from "../adapters/postgres/sequences";
import { BackupManager } from "../adapters/postgres/BackupManager";
import { QueueFactory } from "../queue/QueueFactory";
import { startConfigWatcher } from "../cache/ConfigWatcher";
import { GracefulShutdownService } from "./GracefulShutdownService";
import { CacheService } from "../cache/CacheService";
import { randomUUID } from "crypto";
import { MetricsService } from "../observability/MetricsService";
import { initOpenTelemetry } from "../observability/openTelemetry";
import { ConfigLoaderService } from "../services/ConfigLoaderService";
import { OutboxProcessor } from "../infrastructure/db/OutboxProcessor";
import { requestContextStorage } from "../shared/context/RequestContextHolder";
import websocketPlugin from "@fastify/websocket";
import { tenantPlugin } from "./plugins/tenantPlugin";
import WebChatGateway, { broadcastWebChatOutbound } from "../presentation/http/routes/WebChatGateway";
import Redis from "ioredis";
import { LineProjectOnboardingService } from "../services/LineProjectOnboardingService";

const serverLogger = createLogger("server");
const fastify = Fastify({ loggerInstance: rootLogger as any, bodyLimit: 50 * 1024 * 1024 }); // 50MB body limit for image uploads
// LINE signs the exact raw request bytes. Preserve those bytes while keeping
// parsed JSON behavior unchanged for every existing route.
fastify.removeContentTypeParser("application/json");
fastify.addContentTypeParser("application/json", { parseAs: "buffer" }, (request, body, done) => {
  try {
    request.rawBody = body as Buffer;
    const str = (body as Buffer).toString("utf8").trim();
    if (!str) {
      done(null, {});
      return;
    }
    done(null, JSON.parse(str));
  } catch (error: any) {
    done(error, undefined);
  }
});

// Support raw binary buffers for direct file uploads (images, pdf, octet-stream)
fastify.addContentTypeParser(
  [
    "application/octet-stream",
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "application/pdf",
  ],
  { parseAs: "buffer" },
  (request, body, done) => {
    done(null, body);
  }
);
fastify.register(websocketPlugin);
fastify.register(tenantPlugin);
/**
 * Publisher for outbound WebChat delivery.
 *
 * Only constructed when Redis is actually the configured provider. It used to
 * be created unconditionally, so with the default in-memory providers the
 * process emitted a continuous stream of
 * "[ioredis] Unhandled error event: connect ECONNREFUSED 127.0.0.1:6379".
 * That noise is what buried the fatal error behind RUN-02.
 */
const redisEnabled = config.QUEUE_PROVIDER === "redis" || config.CACHE_PROVIDER === "redis";
const redisPub: Redis | null = redisEnabled
  ? new Redis(config.REDIS_URL, { maxRetriesPerRequest: null })
  : null;

if (redisPub) {
  // Without a listener, ioredis emits an unhandled 'error' event.
  redisPub.on("error", (err: any) => {
    serverLogger.warn({ error: err?.message }, "Redis publisher error");
  });
} else {
  serverLogger.info(
    { queueProvider: config.QUEUE_PROVIDER, cacheProvider: config.CACHE_PROVIDER },
    "Redis publisher disabled; WebChat outbound events will not be published"
  );
}

/** Publishes to Redis for multi-instance clusters, falling back to direct in-memory broadcast only when Redis is unavailable. */
async function publishOutbound(channel: string, payload: string): Promise<void> {
  let parsed: any = null;
  try {
    parsed = JSON.parse(payload);
    if (!parsed.id) {
      parsed.id = randomUUID();
      payload = JSON.stringify(parsed);
    }
  } catch {}

  let publishedToRedis = false;
  if (redisPub) {
    try {
      await redisPub.publish(channel, payload);
      publishedToRedis = true;
    } catch (err: any) {
      serverLogger.warn({ error: err.message, channel }, "Failed to publish outbound event to Redis; falling back to direct broadcast");
    }
  }

  // If Redis is not configured or publish failed, perform in-memory broadcast
  if (!publishedToRedis && parsed) {
    try {
      broadcastWebChatOutbound(parsed);
    } catch (err: any) {
      serverLogger.warn({ error: err.message }, "Direct in-memory broadcast error");
    }
  }
}


// 1. Initialize Core Services (Adapter & Service Layers)
const dbAdapter = AdapterFactory.getAdapter();
const ticketService = new TicketService(dbAdapter);
const runtimeContextResolver = new RuntimeContextResolver(dbAdapter);

const embeddingService = new EmbeddingService();
const vectorStore =
  config.DATABASE_PROVIDER === "postgres" ? new PgVectorStore() : new InMemoryVectorStore(embeddingService);
const knowledgeRetriever = new VectorStoreRetriever(embeddingService, vectorStore);
const knowledgeService = new KnowledgeService(dbAdapter, knowledgeRetriever);

// 2. Initialize Policy, Tool Registry & MCP routing
const toolRegistry = new ToolRegistry();
const policyEngine = new PolicyEngine(toolRegistry);
const traceService = new ExecutionTraceService(dbAdapter);
const mcpRouter = new McpToolRouter(policyEngine, traceService, toolRegistry);

// 3. Setup Memory, Agent Manager, and Orchestrator
const memoryService = new MemoryService(dbAdapter);
const agentManager = new AgentManager(memoryService, mcpRouter, policyEngine, traceService);

const takeoverManager = new TakeoverManager();
const trafficSplitter = new TrafficSplitter();
const metricAggregator = new MetricAggregator(dbAdapter);
const ingestionService = new IngestionService(vectorStore, embeddingService);
const humanReplyService = new HumanReplyService(dbAdapter);
const slaService = new SLAMatrixService();
const planeService = new PlaneService(dbAdapter);
const planeWebhookService = new PlaneWebhookService(dbAdapter);
const planeReverseSyncPoller = new PlaneReverseSyncPoller(planeWebhookService);
const inactivityTimerService = new InactivityTimerService(dbAdapter);
inactivityTimerService.startMonitor();
const evalTestRunner = new EvalTestRunner(agentManager, dbAdapter);
const smsNotificationService = new SmsNotificationService(pool);
const emailNotificationService = new EmailNotificationService();
const projectJoinCodePepper =
  config.PROJECT_JOIN_CODE_PEPPER ||
  config.LINE_CHANNEL_ACCESS_TOKEN ||
  "automationx_default_pepper_key_2026";
const lineProjectOnboardingService = new LineProjectOnboardingService(
  pool,
  projectJoinCodePepper,
  config.LINE_ONBOARDING_MODE
);

async function requestHumanTakeover(input: {
  conversationId: string;
  role?: string;
  content?: string;
  reasonCode?: string;
  reasonDetail?: string;
  source?: string;
  recipientId?: string;
}) {
  const { conversationId, role, content, reasonCode, reasonDetail, source, recipientId } = input;

  // Ordered deliberately. Everything before the broadcast delays the operator's
  // alert, so only two things are allowed to precede it: the lease that stops
  // AgentX replying over the operator, and the project id the broadcast is
  // scoped by. Persistence that nothing downstream is waiting on runs after the
  // caller has its answer.

  // 1. The lease. Awaited for both callers: /api/v1/internal/conversations/takeover
  //    returns suppress_reply to AgentX on the strength of it.
  const pendingDurationMs = config.HUMAN_PENDING_TIMEOUT_MINUTES * 60 * 1000;
  const takeoverState = await takeoverManager.setTakeoverState(
    conversationId,
    "PENDING_HUMAN",
    undefined,
    pendingDurationMs
  );

  // 2. Owning project, by primary key. This replaced a three-table join that
  //    also resolved the customer's name; the name is not worth holding the
  //    alert for, and the console already knows it from the conversation list.
  let conversationProjectId: string | null = null;
  try {
    const result = await pool.query(`SELECT project_id FROM conversations WHERE id = $1::integer`, [conversationId]);
    const rawProjectId = result.rows[0]?.project_id;
    conversationProjectId = rawProjectId === null || rawProjectId === undefined ? null : String(rawProjectId);
  } catch (err: any) {
    serverLogger.error({ error: err.message, conversationId }, "Failed to resolve project for takeover broadcast");
  }

  // 3. The operator's alert.
  //
  //    Scoped to the conversation's project. This previously fell back to
  //    project "1" when the lookup failed, which delivered one project's
  //    takeover to another project's operators. An unresolved project now
  //    means no broadcast: the 30s console poll still surfaces the request,
  //    and a missed alert is recoverable where a cross-tenant one is not.
  if (conversationProjectId) {
    const notification = JSON.stringify({
      event: "NEW_HUMAN_REQUEST",
      data: {
        conversationId,
        customerName: null,
        lastMessage: content || "Human assistance required",
        reasonCode: reasonCode || "CUSTOMER_REQUESTED_HUMAN",
        reasonDetail: reasonDetail || null,
        source: source || "workflow",
        expiresAt: takeoverState.leaseExpiresAt,
      },
    });
    adminSocketRegistry.broadcastToProject(conversationProjectId, notification);
  } else {
    serverLogger.warn(
      { conversationId },
      "Takeover broadcast skipped: conversation has no resolvable project. Refusing to guess a tenant"
    );
  }

  // 4. The durable record of the handoff, awaited.
  //
  //    Issued directly rather than through dbAdapter.updateHandoffState, which
  //    pairs this UPDATE with a BackupManager mirror that reads and rewrites
  //    the entire encrypted conversations file using synchronous fs calls —
  //    blocking the event loop, and with it every other request including the
  //    socket write above. The mirror still happens, in the background block.
  try {
    await pool.query(`UPDATE conversations SET handled_by = 'human', updated_at = NOW() WHERE id = $1::integer`, [
      conversationId,
    ]);
  } catch (err: any) {
    serverLogger.error({ error: err.message, conversationId }, "Failed to persist handoff state for takeover");
    throw err;
  }

  // 5. Work no caller waits on. Each branch carries its own catch: an
  //    unhandled rejection here would take the process down.
  void (async () => {
    // Backup mirror, matching what updateHandoffState would have written.
    try {
      const conversations = await BackupManager.readFromBackup<any>("conversations");
      const match = conversations.find((c: any) => String(c.id) === String(conversationId));
      if (match) {
        match.handled_by = "human";
        match.status = "escalated";
        await BackupManager.saveToBackup("conversations", match, "id");
      }
    } catch (err: any) {
      serverLogger.warn({ error: err.message, conversationId }, "Takeover backup mirror failed");
    }

    // Never persist sentinel strings into messages table
    if (content && content.trim().toLowerCase() !== "handled_by_human") {
      try {
        const messageRole = role || "customer";
        let alreadyStored = false;
        if (typeof (dbAdapter as any).hasRecentMessage === "function") {
          alreadyStored = await (dbAdapter as any).hasRecentMessage(conversationId, messageRole, content, 5);
        } else {
          const recent = (await dbAdapter.getMessages(conversationId)).slice(-5);
          alreadyStored = recent.some((m: any) => m.content === content);
        }
        if (!alreadyStored) {
          await dbAdapter.saveMessage(conversationId, messageRole, content);
        }
      } catch (err: any) {
        serverLogger.error({ error: err.message, conversationId }, "Failed to persist takeover message");
      }
    }

    await publishOutbound(
      "webchat:outbound",
      JSON.stringify({
        conversationId,
        recipientId: recipientId || undefined,
        channel: "WebChat",
        event: "takeover_started",
        data: {
          conversation_id: String(conversationId),
          conversationId: String(conversationId),
          state: "PENDING_HUMAN",
          status: "PENDING_HUMAN",
          reason: reasonCode || "ai_escalation",
          reasonCode: reasonCode || "CUSTOMER_REQUESTED_HUMAN"
        },
        status: "PENDING_HUMAN",
        state: "PENDING_HUMAN",
        reasonCode: reasonCode || "CUSTOMER_REQUESTED_HUMAN",
        sentAt: new Date().toISOString()
      })
    );

    // Legacy AgentX/MCP flows may dispatch SMS themselves after the internal
    // takeover call. The direct Main AI human-notify path owns backend SMS.
    if ((source || "workflow") !== "agentx") {
      let customerName = `Customer #${conversationId}`;
      try {
        const nameResult = await pool.query(
          `SELECT p.name FROM conversations c
           JOIN identities i ON c.identity_id = i.id
           JOIN profiles p ON i.profile_id = p.id
           WHERE c.id = $1::integer`,
          [conversationId]
        );
        customerName = nameResult.rows[0]?.name || customerName;
      } catch (err: any) {
        serverLogger.error({ error: err.message, conversationId }, "Failed to resolve customer name for takeover SMS");
      }

      try {
        await smsNotificationService.sendTakeoverAlert({
          conversationId,
          customerName,
          reasonCode: reasonCode || "CUSTOMER_REQUESTED_HUMAN",
          reasonDetail,
          lastMessage: content,
        });
      } catch (error: any) {
        serverLogger.error({ error: error.message, conversationId }, "Failed to send takeover SMS alert");
      }
    }
  })().catch((err: any) => {
    serverLogger.error({ error: err?.message, conversationId }, "Takeover background work failed");
  });

  // The operator's phone number, the SMS provider URL and a base64 provider
  // credential used to be assembled here and returned. Neither caller read any
  // of it, so it cost two queries on the critical path and put a credential in
  // a value that could be logged. Removed; SmsNotificationService owns dispatch.
  return takeoverState;
}

const orchestrator = new Orchestrator(memoryService, agentManager, takeoverManager);
const promptXMcpClient = new PromptXMcpClient();

// 4. Initialize Job Queue
const jobQueue = QueueFactory.getQueue();

policyEngine.registerRule({
  ruleId: "rule-allow-core",
  name: "Allow Core Tool Commands",
  type: "permission",
  action: "allow",
  mcpToolNames: [
    "create_ticket",
    "get_ticket",
    "get_ticket_status",
    "update_summary",
    "find_ticket",
    "merge_ticket",
    "reopen_ticket",
    "close_ticket",
    "assign_ticket",
    "escalate_to_pm",
    "search_project_docs",
    "activepieces.nocodb_create_record"
  ],
});

// Register Middleware Hooks
fastify.addHook("onRequest", (request, reply, done) => {
  const correlationId = (request.headers["x-correlation-id"] as string) || (request.headers["x-request-id"] as string) || randomUUID();
  const requestId = (request.headers["x-request-id"] as string) || randomUUID();
  const projectId = (request.headers["x-project-id"] as string) || (request.query as any)?.projectId || "1";

  const context = {
    correlationId,
    requestId,
    projectId,
    clientChannel: (request.headers["x-client-channel"] as string) || "WebAdmin",
    channelRef: (request.headers["x-channel-ref"] as string) || "admin",
  };

  requestContextStorage.run(context, () => {
    reply.header("x-correlation-id", correlationId);
    done();
  });
});

// Origins permitted to make credentialed browser requests. Reflecting an
// arbitrary Origin alongside Access-Control-Allow-Credentials would let any
// site issue authenticated cross-origin calls, so the header is only echoed
// back for origins on this list.
const allowedOrigins = new Set(
  config.CORS_ALLOWED_ORIGINS.split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0)
);

fastify.addHook("onRequest", async (request, reply) => {
  const origin = request.headers.origin;

  // Vary is required whenever the response depends on Origin, otherwise a
  // shared cache can serve one origin's CORS headers to another.
  reply.header("Vary", "Origin");

  if (origin && allowedOrigins.has(origin)) {
    reply.header("Access-Control-Allow-Origin", origin);
    reply.header("Access-Control-Allow-Credentials", "true");
    reply.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
    reply.header(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Org-Id, x-org-id, X-Identity-Id, x-identity-id, X-Project-Id, x-project-id, x-correlation-id, x-request-id, x-trace-id"
    );
    reply.header("Access-Control-Max-Age", "600");
  } else if (origin) {
    serverLogger.warn({ origin, url: request.url }, "Rejected cross-origin request from unlisted origin");
  }

  if (request.method === "OPTIONS") {
    // A preflight from an unlisted origin gets no CORS headers, so the browser
    // blocks the real request regardless of the status code returned here.
    return reply.code(origin && allowedOrigins.has(origin) ? 204 : 403).send();
  }
});

/**
 * Global error handler.
 *
 * Without one, Fastify serialises the thrown error straight to the client —
 * a database failure surfaced as {"statusCode":500,"code":"22P02",...},
 * disclosing the driver, the error taxonomy and sometimes the query. Clients
 * now get a correlation id they can quote; the detail stays in the log.
 */
fastify.setErrorHandler((error: any, request, reply) => {
  const statusCode = error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
  const correlationId = (reply.getHeader("x-correlation-id") as string) || request.id;

  if (statusCode >= 500) {
    serverLogger.error(
      { correlationId, url: request.url, method: request.method, code: error.code, error: error.message, stack: error.stack },
      "Unhandled error while serving request"
    );
    return reply.status(500).send({
      error: "Internal Server Error",
      message: "The request could not be completed",
      correlationId,
    });
  }

  // 4xx are caller errors: the message is safe and useful to return.
  serverLogger.warn({ correlationId, url: request.url, statusCode, error: error.message }, "Request rejected");
  return reply.status(statusCode).send({
    error: error.name || "Bad Request",
    message: error.message,
    correlationId,
  });
});

fastify.addHook("onRequest", rateLimitHook);
fastify.addHook("onRequest", authHook);
// Service-only gate for /api/v1/internal/*. Runs after authHook so the
// principal is known; a human session must not confer machine access.
fastify.addHook("onRequest", internalApiGuard);
// preHandler, not onRequest: it must observe request.principal (authHook) and
// the base tenantContext (tenantPlugin, registered as a plugin and therefore
// hooked during boot rather than here).
fastify.addHook("preHandler", tenantScopeHook);
fastify.addHook("preValidation", webhookSignatureHook);
fastify.addHook("onRequest", async (request) => {
  if (request.url === "/webhook/message" && request.method === "POST") {
    MetricsService.getInstance().recordRequest();
  }
});

/**
 * Registers the local tool implementations.
 *
 * Lifted out of bootstrap() so tests can wire the real tools without also
 * starting the BullMQ worker and config watcher, which need Redis. A test that
 * hand-registers its own subset is testing its own wiring; this way it tests
 * the wiring that ships.
 */
export function registerLocalTools(): void {
  if (toolRegistry.getLocalTool("create_ticket")) return;
  toolRegistry.registerTool(new CreateTicketTool(ticketService));
  toolRegistry.registerTool(new SearchProjectDocsTool(knowledgeService));
  toolRegistry.registerTool(new SearchCodebaseTool(knowledgeService));
  toolRegistry.registerTool(new GetTicketTool());
  toolRegistry.registerTool(new GetTicketStatusTool());
  toolRegistry.registerTool(new UpdateSummaryTool(planeService));
  toolRegistry.registerTool(new FindTicketTool());
  toolRegistry.registerTool(new MergeTicketTool(planeService));
  toolRegistry.registerTool(new ReopenTicketTool(planeService));
  toolRegistry.registerTool(new CloseTicketTool(planeService));
  toolRegistry.registerTool(new AssignTicketTool());
  toolRegistry.registerTool(new EscalateToPmTool());
}

async function bootstrap() {
  initOpenTelemetry();
  serverLogger.info("Initializing AutomationX V2 API Server bootstrap...");

  // Realign any SERIAL sequence that sits below its table's MAX(id) before we
  // accept traffic. Migration 043 does this once, but a restore, a seed file,
  // or a hand-written INSERT with an explicit id can reintroduce the drift —
  // and the symptom is a duplicate-key 503 on the LINE webhook, not a startup
  // failure, so it stays invisible until a real user hits it.
  try {
    await syncSerialSequences(pool);
  } catch (err: any) {
    serverLogger.error({ error: err.message }, "SERIAL sequence sync failed at bootstrap");
  }

  // Register graceful shutdown handlers
  GracefulShutdownService.register(fastify);

  // Start dynamic config watcher for hot reloading
  startConfigWatcher();

  registerLocalTools();

  // Register the job processor callback
  jobQueue.process(async (job) => {
    if (job.data.channel === "WebChat") {
      try {
        const webhookUrl = `${config.PROMPTX_FLOW_WEBHOOK_URL}/sync`;

        // Resolve the real project and organization for this customer.
        //
        // These used to be the literals "1" and "org_default", which pinned
        // every WebChat conversation to one project no matter who was talking:
        // a customer whose tickets live in another project saw an empty portal
        // and a bot with the wrong tenant context. Both values now come from
        // the customer's own open WebChat conversation, falling back to the old
        // literals only when nothing resolves, so behaviour is unchanged for
        // anyone who really is in project 1.
        let convProjectId = "1";
        let convOrgId = "org_default";
        let resolvedSenderRef = job.data.senderId;
        let resolvedConvId: string | null = null;
        try {
          const targetConvIdNum = job.data.conversationId ? parseInt(String(job.data.conversationId), 10) : 0;
          if (targetConvIdNum > 0) {
            const convRes = await pool.query(
              `SELECT c.id, c.project_id, p.org_id, i.channel_ref
               FROM conversations c
               JOIN identities i ON i.id = c.identity_id
               LEFT JOIN projects p ON p.id = c.project_id
               WHERE c.id = $1 AND c.status = 'open'
               LIMIT 1`,
              [targetConvIdNum]
            );
            if (convRes.rows.length > 0) {
              resolvedConvId = String(convRes.rows[0].id);
              if (convRes.rows[0].project_id) convProjectId = String(convRes.rows[0].project_id);
              if (convRes.rows[0].org_id) convOrgId = String(convRes.rows[0].org_id);
              if (convRes.rows[0].channel_ref) resolvedSenderRef = convRes.rows[0].channel_ref;
            }
          }

          if (!resolvedConvId) {
            const identRef = job.data.senderId;
            if (identRef) {
              const convRes = await pool.query(
                `SELECT c.id, c.project_id, p.org_id, i.channel_ref
                 FROM conversations c
                 JOIN identities i ON i.id = c.identity_id
                 LEFT JOIN projects p ON p.id = c.project_id
                 WHERE (i.channel_ref = $1 OR i.channel_ref = 'cust_' || $1 OR i.id::text = $1)
                   AND LOWER(c.channel) = 'webchat' AND c.status = 'open'
                 ORDER BY (CASE WHEN c.project_id IS NOT NULL THEN 0 ELSE 1 END), c.id DESC LIMIT 1`,
                [identRef]
              );
              if (convRes.rows.length > 0) {
                resolvedConvId = String(convRes.rows[0].id);
                if (convRes.rows[0].project_id) convProjectId = String(convRes.rows[0].project_id);
                if (convRes.rows[0].org_id) convOrgId = String(convRes.rows[0].org_id);
                if (convRes.rows[0].channel_ref) resolvedSenderRef = convRes.rows[0].channel_ref;
              }
            }
          }
        } catch (lookupErr: any) {
          serverLogger.warn({ error: lookupErr.message }, "[BullMQ Worker] WebChat project lookup failed");
        }

        // Rule 3: Fail-Closed Context.
        // If projectId is missing or unverified, FAIL CLOSED: prompt customer for join code. NEVER fall back to project '1' or 'org_default'.
        if (!convProjectId || convProjectId === "1" || convProjectId === "undefined" || convProjectId === "null") {
          serverLogger.warn({ conversationId: resolvedConvId, senderRef: resolvedSenderRef }, "[BullMQ Worker] Customer has no verified project context; failing closed");
          const promptJoinText = "กรุณาระบุรหัสโครงการ (Join Code) เพื่อเข้าใช้งานระบบค่ะ";
          const targetConv = resolvedConvId || (job.data.conversationId ? String(job.data.conversationId) : null);
          if (targetConv) {
            await pool.query(
              `INSERT INTO messages (conversation_id, role, content, message_type, created_at)
               VALUES ($1, 'ai', $2, 'text', NOW())`,
              [parseInt(targetConv, 10), promptJoinText]
            );
            await publishOutbound(
              "webchat:outbound",
              JSON.stringify({
                conversationId: targetConv,
                recipientId: resolvedSenderRef,
                channel: "WebChat",
                text: promptJoinText,
                sentAt: new Date().toISOString()
              })
            );
          }
          return { text: promptJoinText, recipientId: resolvedSenderRef, channel: "WebChat" };
        }

        // Ensure local conversation and identity exist first for the stable customer identity
        const localConvId = resolvedConvId || await memoryService.ensureConversation(resolvedSenderRef, convProjectId, "WebChat");
        serverLogger.info(`[BullMQ Worker] Ensured local conversation (ID: ${localConvId}) for customer: ${resolvedSenderRef} in Project: ${convProjectId}`);

        serverLogger.info(`[BullMQ Worker] Forwarding WebChat message to PromptX Flow: ${webhookUrl}`);

        const promptxPayload: any = {
          channel: "webchat",
          customer_ref: resolvedSenderRef,
          message: job.data.text,
          project_id: convProjectId,
          org_id: convOrgId,
          destination: "default",
          external_id: job.data.externalId || job.data.tempId,
          message_id: job.data.messageId,
          temp_id: job.data.tempId || job.data.externalId,
          received_at: new Date().toISOString()
        };

        // Forward attachment metadata and image URL if present
        if (job.data.attachments && Array.isArray(job.data.attachments) && job.data.attachments.length > 0) {
          promptxPayload.attachments = job.data.attachments;
          const firstImg = job.data.attachments.find((a: any) =>
            a.fileType?.startsWith("image/") || (a.fileUrl && /\.(jpeg|jpg|png|webp|gif)/i.test(a.fileUrl))
          );
          if (firstImg) {
            promptxPayload.image_url = firstImg.fileUrl;
            promptxPayload.file_url = firstImg.fileUrl;
          }
        }

        const response = await axios.post(webhookUrl, promptxPayload, { timeout: 180000 });

        const data = response.data || {};
        const replyText = String(
          data.reply_text ||
          data.reply ||
          data.text ||
          data.message ||
          data.body?.reply_text ||
          data.data?.reply_text ||
          ""
        );
        const convId = data.conversation_id || data.body?.conversation_id;
        const targetConvId = resolvedConvId || (convId ? String(convId) : null) || localConvId;

        const takeoverStatus = String(
          data.takeover_status ||
          data.body?.takeover_status ||
          data.status ||
          data.body?.status ||
          ""
        ).trim().toUpperCase();

        const normalizedReplyText = replyText.trim().toLowerCase();

        // Rule 5 & 6: Handle "handled_by_human" / escalation sentinel
        const isHandledByHuman =
          normalizedReplyText === "handled_by_human" ||
          takeoverStatus === "PENDING_HUMAN" ||
          takeoverStatus === "ACTIVE_HUMAN" ||
          takeoverStatus === "HANDLED_BY_HUMAN" ||
          takeoverStatus === "HUMAN" ||
          data.action === "handled_by_human" ||
          data.handled_by === "human";

        if (isHandledByHuman) {
          serverLogger.info({ convId: targetConvId, takeoverStatus, replyText }, "[BullMQ Worker] PromptX signaled handled_by_human/escalation; triggering human takeover");

          // 1. MUST NOT insert as AI message in messages table!
          // 2. Trigger human takeover (sets PENDING_HUMAN, alerts operator, and broadcasts canonical takeover_started event once)
          try {
            await requestHumanTakeover({
              conversationId: String(targetConvId),
              role: "customer",
              content: job.data.text || "[Customer requested assistance]",
              reasonCode: "AI_ESCALATED_HUMAN",
              reasonDetail: "PromptX flow escalated to human",
              source: "workflow",
              recipientId: resolvedSenderRef
            });
          } catch (takeoverErr: any) {
            serverLogger.error({ error: takeoverErr.message, convId: targetConvId }, "[BullMQ Worker] Failed requesting human takeover");
          }

          return { status: "handled_by_human", recipientId: resolvedSenderRef, channel: "WebChat", suppressReply: true };
        }

        const suppressReply = data.suppress_reply === true || replyText.trim().length === 0;

        serverLogger.info(`[BullMQ Worker] Received sync reply from PromptX Flow: "${replyText}" (convId: ${convId})`);

        if (!suppressReply && replyText.trim().length > 0) {
          // Ensure AI reply is persisted into messages table if PromptX flow didn't already insert it
          try {
            const existing = await pool.query(
              `SELECT id FROM messages WHERE conversation_id = $1 AND role = 'ai' AND content = $2 AND created_at > NOW() - INTERVAL '1 minute' LIMIT 1`,
              [parseInt(targetConvId, 10), replyText]
            );
            if (existing.rows.length === 0) {
              await pool.query(
                `INSERT INTO messages (conversation_id, role, content, message_type, created_at)
                 VALUES ($1, 'ai', $2, 'text', NOW())`,
                [parseInt(targetConvId, 10), replyText]
              );
            }
          } catch (insertErr: any) {
            serverLogger.warn({ error: insertErr.message }, "[BullMQ Worker] Failed ensuring AI message insertion in DB");
          }

          const outboundPayload = {
            conversationId: targetConvId,
            recipientId: resolvedSenderRef,
            channel: "WebChat",
            text: replyText,
            sentAt: new Date().toISOString()
          };
          // Broadcast single outbound payload
          await publishOutbound("webchat:outbound", JSON.stringify(outboundPayload));
        }

        return { text: replyText, recipientId: resolvedSenderRef, channel: "WebChat", suppressReply };
      } catch (err: any) {
        const responseData = err.response?.data;
        serverLogger.error({ error: err.message, responseData }, "[BullMQ Worker] Failed calling PromptX Flow webhook");
        throw err;
      }
    } else {
      const result = await orchestrator.handleIncomingMessage(job.data, job.metadata.requestId);
      return result;
    }
  });

  // Boot background Ticket Intelligence workers
  if (typeof (jobQueue as any).startTicketWorkers === "function") {
    serverLogger.info("Starting background Ticket Intelligence Workers...");
    (jobQueue as any).startTicketWorkers();
  }

  // Register Piece Adapter Tool
  try {
    const pieceAdapter = new PieceAdapter();
    const nocodbCreateRecordDef = await pieceAdapter.generateMcpDefinition(
      "@activepieces/piece-nocodb",
      "nocodb-create-record"
    );
    const nocodbPieceTool = new PieceMcpTool(
      pieceAdapter,
      "@activepieces/piece-nocodb",
      "nocodb-create-record",
      nocodbCreateRecordDef
    );
    toolRegistry.registerTool(nocodbPieceTool);
    serverLogger.info("Registered Piece Adapter: activepieces.nocodb_create_record");
  } catch (err: any) {
    serverLogger.error({ error: err.message }, "Failed to register Piece Adapter");
  }

  // Dynamic MCP Tool Discovery
  try {
    serverLogger.info("Querying remote PromptX MCP for tool discovery...");
    const remoteTools = await promptXMcpClient.listTools();
    serverLogger.info(`Found ${remoteTools.length} remote tools on PromptX MCP.`);

    for (const tool of remoteTools) {
      if (tool.name === "chat") {
        continue; // Skip orchestration chat agent tool
      }

      const remoteName = `promptx.${tool.name}`;

      // Ensure policy allows the namespaced tool
      policyEngine.registerRule({
        ruleId: `rule-allow-${remoteName}`,
        name: `Allow dynamic remote tool ${remoteName}`,
        type: "permission",
        action: "allow",
        mcpToolNames: [remoteName],
      });

      const dynamicTool = new DynamicMcpTool(
        remoteName,
        tool.description || "Discovered remote tool",
        tool.inputSchema || { type: "object", properties: {} },
        promptXMcpClient,
        "promptx",
        "1.0.0"
      );

      toolRegistry.registerTool(dynamicTool);
      serverLogger.info(`Dynamically registered and allowed remote tool: '${remoteName}'`);
    }
  } catch (err: any) {
    serverLogger.warn({ error: err.message }, "Dynamic MCP Tool Discovery failed or was skipped");
  }

  // 5. Start background outbox polling loop
  const outboxProcessor = new OutboxProcessor();
  outboxProcessor.start(10000);
  planeReverseSyncPoller.start();

  fastify.addHook("onClose", async () => {
    serverLogger.info("Stopping background outbox processor...");
    outboxProcessor.stop();
    planeReverseSyncPoller.stop();
  });
}

// Routes
fastify.post("/webhook/message", async (request, reply) => {
  const requestId = (request.headers["x-request-id"] as string) || randomUUID();
  const timer = startTimer();

  try {
    const parsedInput = InboundMessageSchema.safeParse(request.body);
    if (!parsedInput.success) {
      serverLogger.warn({ requestId, issues: parsedInput.error.issues }, "Bad request validation failed");
      return reply.code(400).send({
        error: "Bad Request",
        message: parsedInput.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join(", "),
      });
    }

    serverLogger.info({ requestId, component: "server" }, "Enqueuing webhook message job");

    const jobId = await jobQueue.enqueue({
      type: "webhook_message",
      data: parsedInput.data,
      metadata: {
        requestId,
        receivedAt: new Date().toISOString(),
      },
    });

    if (config.QUEUE_PROVIDER === "redis") {
      const durationMs = timer();
      MetricsService.getInstance().recordLatency(durationMs);
      return reply.code(202).send({
        jobId,
        status: "QUEUED",
      });
    }

    const job = await jobQueue.getJob(jobId);
    if (!job) {
      throw new Error(`Job ${jobId} not found after enqueuing.`);
    }

    if (job.status === "FAILED") {
      throw new Error(job.error || "Job execution failed");
    }

    const durationMs = timer();
    MetricsService.getInstance().recordLatency(durationMs);
    serverLogger.info({ requestId, durationMs, component: "server" }, "Webhook message job completed successfully");
    return reply.code(200).send(job.result);
  } catch (err: any) {
    const durationMs = timer();
    MetricsService.getInstance().recordError();
    MetricsService.getInstance().recordLatency(durationMs);
    serverLogger.error({ requestId, durationMs, error: err.message, component: "server" }, "Webhook handler failed");
    return reply.code(500).send({
      error: "Internal Server Error",
      message: err.message,
    });
  }
});

fastify.post("/api/v1/internal/debug-log", async (request, reply) => {
  serverLogger.info({ debugData: request.body }, "[Cloud Debug Log]");
  return reply.code(200).send({ success: true });
});

fastify.get("/api/v1/media/file", async (request, reply) => {
  try {
    const query = request.query as any;
    const storageKey = query.key;
    if (!storageKey) {
      return reply.code(400).send({ error: "Missing storage key" });
    }

    const { S3MediaStorageService } = await import("../media/services/S3MediaStorageService");
    const mediaService = new S3MediaStorageService({});

    // Enforce HMAC signature check or authorized session
    const { expires, signature } = query;
    if (signature && expires) {
      const isValid = mediaService.verifyPresignedUrl(storageKey, expires, signature);
      if (!isValid) {
        return reply.code(403).send({ error: "Forbidden", message: "Invalid or expired media signature" });
      }
    } else {
      // Check for valid Authorization header or session cookie
      const authHeader = request.headers.authorization;
      const sessionCookie = (request.headers.cookie || "").match(/webchat_session=([^;]+)/);
      let isAuthorized = false;

      if (authHeader && authHeader.startsWith("Bearer ")) {
        try {
          const token = authHeader.slice(7).trim();
          JwtUtil.verify(token, config.SESSION_SECRET || getWebchatJwtSecret());
          isAuthorized = true;
        } catch {
          try {
            JwtUtil.verify(authHeader.slice(7).trim(), getWebchatJwtSecret());
            isAuthorized = true;
          } catch {}
        }
      }

      if (!isAuthorized && sessionCookie) {
        try {
          JwtUtil.verify(sessionCookie[1], getWebchatJwtSecret());
          isAuthorized = true;
        } catch {}
      }

      if (!isAuthorized) {
        return reply.code(403).send({ error: "Forbidden", message: "Valid signature or authorized session required" });
      }
    }

    const { buffer, mimeType } = await mediaService.download(storageKey);
    return reply.type(mimeType).send(buffer);
  } catch (err: any) {
    return reply.code(404).send({ error: "Media file not found", details: err.message });
  }
});


fastify.get("/health", async (request, reply) => {
  if (GracefulShutdownService.checkShuttingDown()) {
    return reply.code(503).send({
      status: "service_unavailable",
      message: "Server is shutting down",
    });
  }

  let mcpStatus = "disconnected";
  try {
    const res = await axios.get(config.PROMPTX_MCP_URL, {
      headers: { Authorization: `Bearer ${config.PROMPTX_MCP_TOKEN}` },
      timeout: 2000,
    });
    if (res.status >= 200 && res.status < 500) {
      mcpStatus = "connected";
    }
  } catch (err: any) {
    if (err.response && err.response.status >= 200 && err.response.status < 500) {
      mcpStatus = "connected";
    } else {
      mcpStatus = "disconnected";
    }
  }

  const queueDepth =
    typeof (jobQueue as any).getQueueDepth === "function" ? await (jobQueue as any).getQueueDepth() : 0;

  return reply.code(200).send({
    status: "healthy",
    apiStatus: "ok",
    databaseProvider: config.DATABASE_PROVIDER,
    mcpStatus,
    redisCacheActive: CacheService.getInstance().isRedisActive(),
    queueDepth,
    breakerState: PromptXMcpClient.circuitBreaker.getState(),
    registeredToolsCount: toolRegistry.listTools().length,
    registeredTools: toolRegistry.listTools().map((t) => ({
      name: t.definition.name,
      source: t.definition.source || "local",
      version: t.definition.version || "1.0.0",
      description: t.definition.description,
    })),
  });
});

fastify.get("/metrics", async (request, reply) => {
  const mainMetrics = MetricsService.getInstance().getMetrics();
  const cacheMetrics = CacheService.getInstance().getMetrics();
  return reply.code(200).send({
    ...mainMetrics,
    cache: cacheMetrics,
  });
});

fastify.get("/metrics/prometheus", async (request, reply) => {
  const mainMetrics = MetricsService.getInstance().getMetrics();
  const cacheMetrics = CacheService.getInstance().getMetrics();

  let qDepth = 0;
  try {
    qDepth = typeof (jobQueue as any).getQueueDepth === "function" ? await (jobQueue as any).getQueueDepth() : 0;
  } catch (err: any) {
    serverLogger.warn({ error: err.message }, "Failed to get queue depth for Prometheus metrics");
  }

  let prometheusText = "";

  // 1. Requests Total
  prometheusText += `# HELP automationx_requests_total Total number of inbound webhook requests.\n`;
  prometheusText += `# TYPE automationx_requests_total counter\n`;
  prometheusText += `automationx_requests_total ${mainMetrics.requestCount}\n\n`;

  // 2. Errors Total
  prometheusText += `# HELP automationx_errors_total Total number of failed requests.\n`;
  prometheusText += `# TYPE automationx_errors_total counter\n`;
  prometheusText += `automationx_errors_total ${mainMetrics.errors}\n\n`;

  // 3. Latency Summary
  prometheusText += `# HELP automationx_request_latency_seconds_sum Total request duration in seconds.\n`;
  prometheusText += `# TYPE automationx_request_latency_seconds_sum counter\n`;
  prometheusText += `automationx_request_latency_seconds_sum ${mainMetrics.latency.sum / 1000}\n\n`;

  prometheusText += `# HELP automationx_request_latency_seconds_count Total number of measured requests.\n`;
  prometheusText += `# TYPE automationx_request_latency_seconds_count counter\n`;
  prometheusText += `automationx_request_latency_seconds_count ${mainMetrics.latency.count}\n\n`;

  // 4. Agent Calls
  prometheusText += `# HELP automationx_agent_calls_total Number of calls to different agents.\n`;
  prometheusText += `# TYPE automationx_agent_calls_total counter\n`;
  for (const [agent, count] of Object.entries(mainMetrics.agentCalls)) {
    prometheusText += `automationx_agent_calls_total{agent="${agent}"} ${count}\n`;
  }
  prometheusText += `\n`;

  // 5. Tool Calls
  prometheusText += `# HELP automationx_tool_calls_total Number of executions of MCP tools.\n`;
  prometheusText += `# TYPE automationx_tool_calls_total counter\n`;
  for (const [tool, count] of Object.entries(mainMetrics.toolCalls)) {
    prometheusText += `automationx_tool_calls_total{tool="${tool}"} ${count}\n`;
  }
  prometheusText += `\n`;

  // 6. Routing Decisions
  prometheusText += `# HELP automationx_routing_decisions_total Number of routing decisions made.\n`;
  prometheusText += `# TYPE automationx_routing_decisions_total counter\n`;
  for (const [decision, count] of Object.entries(mainMetrics.routingDecisions)) {
    prometheusText += `automationx_routing_decisions_total{decision="${decision}"} ${count}\n`;
  }
  prometheusText += `\n`;

  // 7. Cache Metrics
  prometheusText += `# HELP automationx_cache_hits_total Number of cache hits.\n`;
  prometheusText += `# TYPE automationx_cache_hits_total counter\n`;
  prometheusText += `# HELP automationx_cache_misses_total Number of cache misses.\n`;
  prometheusText += `# TYPE automationx_cache_misses_total counter\n`;
  prometheusText += `# HELP automationx_cache_hit_ratio Cache hit ratio percentage.\n`;
  prometheusText += `# TYPE automationx_cache_hit_ratio gauge\n`;

  for (const [tenant, data] of Object.entries(cacheMetrics)) {
    const cacheData = data as { hits: number; misses: number; ratio: number };
    prometheusText += `automationx_cache_hits_total{tenant="${tenant}"} ${cacheData.hits}\n`;
    prometheusText += `automationx_cache_misses_total{tenant="${tenant}"} ${cacheData.misses}\n`;
    prometheusText += `automationx_cache_hit_ratio{tenant="${tenant}"} ${cacheData.ratio}\n`;
  }
  prometheusText += `\n`;

  // 8. Queue depth
  prometheusText += `# HELP automationx_queue_depth Current depth of message queues.\n`;
  prometheusText += `# TYPE automationx_queue_depth gauge\n`;
  prometheusText += `automationx_queue_depth ${qDepth}\n`;

  return reply.type("text/plain; version=0.0.4").send(prometheusText);
});

fastify.get("/traces", async (request, reply) => {
  const traces = await traceService.listTraces();
  return reply.code(200).send(traces);
});

fastify.get("/tools", async (request, reply) => {
  const tools = toolRegistry.listTools().map((t) => ({
    name: t.name || t.definition.name,
    source: t.definition.source || "local",
    version: t.version || t.definition.version || "1.0.0",
    description: t.description || t.definition.description,
    owner: t.owner || t.definition.owner || "platform-engineering",
    asyncSyncCapability: t.asyncSyncCapability || t.definition.asyncSyncCapability || "sync",
    requiredPermissions: t.requiredPermissions || t.definition.requiredPermissions || [t.name || t.definition.name],
    inputSchema: t.definition.inputSchema,
  }));
  return reply.code(200).send(tools);
});

fastify.get("/agents", async (request, reply) => {
  const agents = orchestrator.agentManager.agentRouter.listAgents().map((a) => ({
    id: a.id,
    name: a.name,
  }));
  return reply.code(200).send(agents);
});

fastify.post("/api/v1/internal/tickets", { preHandler: requireExecutionContext }, async (request, reply) => {
  const body = request.body as any;
  const payload = body.data ? { ...body.data } : body;

  // A ticket must be attached to an explicitly identified conversation.
  //
  // This used to fall back to `SELECT id FROM conversations WHERE
  // status = 'open' ORDER BY created_at DESC LIMIT 1` — unscoped by
  // organization or project — so a request with a missing or malformed
  // conversationId silently attached the ticket to whichever conversation
  // was most recently opened anywhere on the platform, potentially another
  // customer in another organization.
  const conversationId = payload.conversationId;
  const parsedConvId = parseInt(String(conversationId), 10);
  if (!conversationId || isNaN(parsedConvId) || parsedConvId <= 0) {
    serverLogger.warn(
      { conversationId, projectId: payload.projectId },
      "Rejected internal ticket creation without a valid conversationId"
    );
    return reply.code(400).send({
      error: "Bad Request",
      code: "CONVERSATION_ID_REQUIRED",
      message: "A valid conversationId is required to create a ticket",
    });
  }

  // The conversation must exist, and the ticket must be filed against that
  // conversation's own project rather than a caller-supplied one.
  const convRes = await pool.query(
    `SELECT id, project_id, org_id FROM conversations
      WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
    [parsedConvId]
  );
  if (convRes.rows.length === 0) {
    return reply.code(404).send({
      error: "Not Found",
      code: "CONVERSATION_NOT_FOUND",
      message: `Conversation ${parsedConvId} does not exist`,
    });
  }

  const conversation = convRes.rows[0];
  const requestedProjectId = payload.projectId ? String(payload.projectId) : null;
  if (requestedProjectId && String(conversation.project_id) !== requestedProjectId) {
    serverLogger.warn(
      { conversationId: parsedConvId, requestedProjectId, actualProjectId: conversation.project_id },
      "Rejected internal ticket creation with mismatched project"
    );
    return reply.code(409).send({
      error: "Conflict",
      code: "PROJECT_MISMATCH",
      message: `Conversation ${parsedConvId} belongs to project ${conversation.project_id}`,
    });
  }

  const result = await ticketService.createTicket({
    conversationId: String(conversation.id),
    subject: payload.subject || "No Subject Provided",
    summary: payload.summary || "No Summary Provided",
    severity: payload.severity || "Medium",
    priority: payload.priority || "P3",
    // Derived from the conversation, never defaulted to "1".
    projectId: String(conversation.project_id),
  });
  if (!result.success || !result.data) {
    return reply.code(200).send(result);
  }
  const ticket = result.data;
  const ticketId = ticket.ticket_id || ticket.ticketId;
  const dueDate = ticket.due_date || ticket.dueDate;

  // B-5: bind the ticket to the execution that caused it, so the chain can be
  // walked back to the LINE event later. Written before the reply so a caller
  // that immediately queries the chain sees it.
  const trusted = request.trustedContext;
  if (trusted) {
    await pool
      .query(
        `UPDATE tickets SET execution_context_id = $1, correlation_id = $2 WHERE ticket_id = $3`,
        [trusted.contextId, trusted.correlationId, ticketId]
      )
      .catch((err) =>
        serverLogger.warn({ error: err.message, ticketId }, "Could not bind ticket to execution context")
      );

    await traceRecorder.record({
      correlationId: trusted.correlationId,
      component: "ticketx",
      eventType: "ticket_created",
      conversationId: trusted.conversationId,
      projectId: trusted.projectId,
      orgId: trusted.orgId,
      identityId: trusted.identityId,
      lineEventId: trusted.lineEventId,
      ticketId: Number(ticket.id) || null,
      detail: { ticketNumber: ticketId, subject: String(payload.subject || "").slice(0, 120) },
    });
  }

  return reply.code(200).send({
    success: true,
    ticketId,
    dueDate,
    data: {
      ticketId,
      status: ticket.status || "Open",
      enrichmentState: ticket.enrichmentState || "PENDING",
      aiConfidenceMetrics: ticket.aiConfidenceMetrics || {
        title: 0.00,
        summary: 0.00,
        duplicate: 0.00
      }
    }
  });
});

fastify.post("/api/v1/tickets", async (request, reply) => {
  const body = request.body as any;
  const result = await ticketService.createTicket({
    conversationId: body.conversationId,
    subject: body.subject,
    summary: body.summary,
    severity: body.severity,
    priority: body.priority,
    projectId: body.projectId || "1",
  });
  if (!result.success || !result.data) {
    return reply.code(result.success ? 200 : 500).send(result);
  }
  const ticket = result.data;
  const ticketId = ticket.ticket_id || ticket.ticketId;
  return reply.code(200).send({
    success: true,
    data: {
      ticketId,
      status: ticket.status || "Open",
      enrichmentState: ticket.enrichmentState || "PENDING",
      aiConfidenceMetrics: ticket.aiConfidenceMetrics || {
        title: 0.00,
        summary: 0.00,
        duplicate: 0.00
      }
    }
  });
});

/**
 * One authorization boundary, two kinds of principal.
 *
 * `/tickets/close` and `/tickets/:id/restore` are reachable both from the
 * agent (through MCP) and from the console (an operator clicking a button).
 * Requiring an execution context outright would lock operators out; accepting
 * either without a check would be the hole this whole phase exists to close.
 *
 * So: an execution context is authoritative when present. An operator is
 * authorized against their OWN principal scope. A caller that presents a bad
 * context is refused outright rather than retried as an operator — falling
 * back on a failed credential is how a boundary quietly becomes optional.
 */
async function authorizeTicketOperation(
  request: any,
  reply: any,
  reference: unknown
): Promise<{ ticket: AuthorizedTicket; orgId: string; viaContext: boolean } | null> {
  const presentedToken =
    (request.headers["x-execution-context"] as string) ||
    ((request.body as any)?.executionContextToken as string) ||
    ((request.body as any)?.data?.executionContextToken as string) ||
    "";

  if (presentedToken) {
    const resolution = await executionContextService.resolve(presentedToken);
    if (!resolution.ok || !resolution.context) {
      reply.code(403).send({
        error: "Forbidden",
        code: "EXECUTION_CONTEXT_REQUIRED",
        message: "The execution context presented is not valid",
        failure: resolution.failure,
      });
      return null;
    }
    const ctx = resolution.context;
    request.trustedContext = ctx;
    const authorization = await authorizeTicket(ctx, reference);
    if (!authorization.ok || !authorization.resource) {
      reply.code(authorizationStatus(authorization.failure)).send({
        error: authorization.failure === "RESOURCE_REFERENCE_INVALID" ? "Bad Request" : "Not Found",
        code: authorization.failure,
        message: authorization.reason,
      });
      return null;
    }
    return { ticket: authorization.resource, orgId: ctx.orgId, viaContext: true };
  }

  const principal = request.principal;
  if (!principal) {
    reply.code(401).send({ error: "Unauthorized", message: "Authentication required" });
    return null;
  }
  if (principal.kind === "service") {
    // A service credential alone says nothing about which tenant this call is
    // acting for. Automation must present a context.
    reply.code(403).send({
      error: "Forbidden",
      code: "EXECUTION_CONTEXT_REQUIRED",
      message: "A server-issued execution context is required for automated callers",
    });
    return null;
  }

  const ticket = await findTicketByReference(reference);
  if (!ticket) {
    return (reply.code(404).send({
      error: "Not Found",
      code: "RESOURCE_NOT_FOUND",
      message: "Ticket not found",
    }), null);
  }
  if (!canAccessProject(request, ticket.projectId)) {
    serverLogger.warn(
      { ticketId: ticket.id, projectId: ticket.projectId, principal: principal.subject },
      "Refused a ticket operation outside the operator's project scope"
    );
    // Same shape as not-found: confirming the ticket exists elsewhere leaks it.
    return (reply.code(404).send({
      error: "Not Found",
      code: "RESOURCE_NOT_FOUND",
      message: "Ticket not found",
    }), null);
  }
  return { ticket, orgId: ticket.orgId, viaContext: false };
}

/**
 * Knowledge-base search for the agent — B-0b.
 *
 * Replaces `MCP Tool - search_project_docs`, where conversation_id was an
 * agent input that selected which project's documents were searched, via SQL
 * issued straight from the flow.
 *
 * The agent supplies the query and paging. The project is taken from the
 * execution context and nothing the caller sends can change it.
 */
fastify.post("/api/v1/internal/knowledge/search", { preHandler: requireExecutionContext }, async (request, reply) => {
  const ctx = request.trustedContext!;
  const body = (request.body || {}) as any;
  const input = body.data ? { ...body.data } : { ...body };

  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query) {
    return reply.code(400).send({
      error: "Bad Request",
      code: "QUERY_REQUIRED",
      message: "A search query is required",
    });
  }

  const tool = toolRegistry.getLocalTool("search_project_docs");
  if (!tool) return reply.code(500).send({ error: "Tool search_project_docs not found" });

  // Recorded before the search runs, not after. The scoping decision is made
  // here and is what this trace is evidence of; whether the search backend
  // then succeeds is a separate question, and tying the two together would
  // lose the security record whenever the backend was unavailable.
  await traceRecorder.record({
    correlationId: ctx.correlationId,
    component: "mcp",
    eventType: "knowledge_search_scoped",
    conversationId: ctx.conversationId,
    projectId: ctx.projectId,
    orgId: ctx.orgId,
    // No "claimed" fields here: requireExecutionContext strips and overwrites
    // them before this handler runs, so anything read back would echo the
    // context rather than the attempt. The genuine attempt is recorded by the
    // middleware as forbidden_fields_ignored.
    detail: { queryLength: query.length },
  });

  try {
    const result = await tool.execute(
      // projectId is overwritten, never merged: whatever the caller sent is
      // discarded rather than used as a default.
      { query, projectId: String(ctx.projectId), orgId: ctx.orgId },
      { correlationId: ctx.correlationId, traceId: request.headers["x-trace-id"] }
    );
    return reply.code(200).send(result);
  } catch (err: any) {
    await traceRecorder.record({
      correlationId: ctx.correlationId,
      component: "mcp",
      eventType: "knowledge_search_failed",
      status: "failed",
      conversationId: ctx.conversationId,
      projectId: ctx.projectId,
      orgId: ctx.orgId,
      errorMessage: err.message,
    });
    return reply.code(500).send({ error: err.message });
  }
});

/**
 * Ticket search for the agent — B-0b.
 *
 * Replaces `MCP Tool - find_ticket`, which took projectId, conversation_id,
 * profileId and identityId from the model and ran SQL straight against
 * Postgres from the flow. No middleware could intervene there, so the model
 * chose which tenant's tickets it read.
 *
 * Here the agent supplies only search criteria. Every scoping field is
 * injected from the execution context and whatever the caller sent is
 * discarded, so a request naming another project simply searches its own.
 */
fastify.post("/api/v1/internal/tickets/find", { preHandler: requireExecutionContext }, async (request, reply) => {
  const ctx = request.trustedContext!;
  const body = (request.body || {}) as any;
  const criteria = body.data ? { ...body.data } : { ...body };

  // A ticket reference, when given, must belong to this execution.
  if (criteria.ticket_id || criteria.ticketId) {
    const reference = criteria.ticket_id || criteria.ticketId;
    const authorization = await authorizeTicket(ctx, reference);
    if (!authorization.ok || !authorization.resource) {
      return reply.code(authorizationStatus(authorization.failure)).send({
        error: authorization.failure === "RESOURCE_REFERENCE_INVALID" ? "Bad Request" : "Not Found",
        code: authorization.failure,
        message: authorization.reason,
        tickets: [],
      });
    }
    const t = authorization.resource;
    return reply.code(200).send({
      tickets: [
        {
          id: String(t.id),
          ticket_id: t.ticketNumber || t.ticketId,
          conversation_id: t.conversationId === null ? null : String(t.conversationId),
          project_id: String(t.projectId),
          status: t.status,
          plane_issue_id: t.planeIssueId,
        },
      ],
    });
  }

  // Scope is server-owned. conversationId and projectId come from the context;
  // profileId and identityId are not accepted at all, because they select a
  // customer and the context already names the only one this turn may see.
  const tickets = await dbAdapter.listAllTickets(
    String(ctx.conversationId),
    String(ctx.projectId),
    undefined,
    undefined,
    ctx.orgId
  );

  const wanted = typeof criteria.status === "string" ? criteria.status.trim().toUpperCase() : null;
  const subject = typeof criteria.incident_subject === "string" ? criteria.incident_subject.trim().toLowerCase() : null;

  // Normalised explicitly rather than passing the adapter's row through. The
  // adapter's shape omits project_id, which left the agent - and any caller
  // auditing this - unable to see which tenant a ticket belongs to. The scope
  // is server-owned, so it is stated in the response rather than implied.
  const filtered = (tickets || [])
    .filter((t: any) => {
      if (wanted && String(t.status || "").toUpperCase() !== wanted) return false;
      if (subject && !String(t.subject || "").toLowerCase().includes(subject)) return false;
      return true;
    })
    .map((t: any) => ({
      id: String(t.id ?? ""),
      ticket_id: t.ticket_id ?? t.ticketId ?? null,
      conversation_id: String(t.conversation_id ?? t.conversationId ?? ctx.conversationId),
      project_id: String(ctx.projectId),
      org_id: ctx.orgId,
      subject: t.subject ?? null,
      summary: t.summary ?? null,
      status: t.status ?? null,
      priority: t.priority ?? null,
      severity: t.severity ?? null,
      plane_issue_id: t.plane_issue_id ?? t.planeIssueId ?? null,
      due_date: t.due_date ?? t.dueDate ?? null,
    }));

  await traceRecorder.record({
    correlationId: ctx.correlationId,
    component: "mcp",
    eventType: "find_ticket_scoped",
    conversationId: ctx.conversationId,
    projectId: ctx.projectId,
    orgId: ctx.orgId,
    // See the note on knowledge_search_scoped: the attempt itself is recorded
    // by the middleware, which runs before anything here can observe it.
    detail: { matched: filtered.length },
  });

  return reply.code(200).send({ tickets: filtered });
});

fastify.get("/api/v1/internal/tickets/status", { preHandler: requireExecutionContext }, async (request, reply) => {
  // Scope is taken from the execution context, not the query string. The
  // query used to supply projectId, conversationId, profileId and identityId
  // directly, so the caller chose which tenant's tickets it saw.
  const ctx = request.trustedContext!;
  const projectId = String(ctx.projectId);

  const tickets = await dbAdapter.listAllTickets(
    String(ctx.conversationId),
    projectId,
    undefined,
    undefined,
    ctx.orgId
  );
  return reply.code(200).send(tickets);
});

fastify.post(
  "/api/v1/internal/conversations/takeover",
  { preHandler: requireExecutionContext },
  async (request, reply) => {
  const ctx = request.trustedContext!;
  const body = request.body as any;
  const payload = body.data ? { ...body.data } : body;

  // Escalation is a backend operation, not a flow one. The conversation is
  // taken from the execution context, never from the caller: PromptX used to
  // write conversations.takeover_state directly by SQL with an id it chose.
  const conversationId = ctx.conversationId;

  await traceRecorder.record({
    correlationId: ctx.correlationId,
    component: "ticketx",
    eventType: "takeover_requested",
    conversationId: ctx.conversationId,
    projectId: ctx.projectId,
    orgId: ctx.orgId,
    detail: {
      reasonCode: payload.reasonCode || payload.reason_code || null,
      source: payload.source || "agentx",
      // No "claimed" field here: requireExecutionContext strips conversationId
      // before this handler runs, so it would always read back as absent. The
      // real attempt is recorded by the middleware as forbidden_fields_ignored.
    },
  });

  const state = await requestHumanTakeover({
    conversationId: String(conversationId),
    role: payload.role,
    content: payload.content,
    reasonCode: payload.reasonCode || payload.reason_code,
    reasonDetail: payload.reasonDetail || payload.reason_detail,
    source: payload.source || "agentx",
  });
  return reply.code(200).send({
    success: true,
    handled_by: "human",
    status: state.status,
    suppress_reply: true,
    expires_at: state.leaseExpiresAt,
    conversation_id: conversationId,
  });
});

fastify.post("/api/v1/internal/notifications/sms", async (request, reply) => {
  const body = request.body as any;
  const payload = body.data ? { ...body.data } : body;
  const conversationId = payload.conversationId;
  if (!conversationId) {
    return reply.code(400).send({ error: "Bad Request", message: "conversationId is required" });
  }

  const result = await smsNotificationService.sendTakeoverAlert({
    conversationId: String(conversationId),
    customerName: payload.customerName,
    reasonCode: payload.reasonCode || payload.reason_code,
    reasonDetail: payload.reasonDetail || payload.reason_detail,
    lastMessage: payload.content,
  });

  return reply.code(200).send({ success: true, sent: result });
});

/**
 * Admin realtime socket.
 *
 * Registered through fastify.register() rather than declared inline: routes
 * added at module scope are processed before @fastify/websocket installs its
 * onRoute hook, so `{ websocket: true }` was silently ignored and the route
 * answered the upgrade with a plain HTTP 200. It never upgraded at all.
 */
export async function registerAdminSocketRoute(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/admin/socket", { websocket: true }, async (connection: any, req: any) => {
  // @fastify/websocket v11 passes the WebSocket directly; older versions
  // wrapped it in { socket }. Support both so the guard cannot be skipped by
  // an undefined reference.
  const socket = (connection as any).socket || (connection as any);

  const closeWith = (code: number, reason: string) => {
    try {
      socket.close(code, reason);
    } catch {
      /* socket already gone */
    }
  };

  // authHook already authenticated the upgrade request, but @fastify/websocket
  // does not carry request decorations through to this handler, so the
  // credential is re-verified here via the same shared helper. Browsers cannot
  // set headers on a handshake, hence the ?token= parameter.
  //
  // The previous guard read `if (config.API_KEY && token !== API_KEY)`, which
  // short-circuited to "accept" whenever API_KEY was unset — which it was.
  // @fastify/websocket does not populate req.query for upgrade requests, so
  // the parameters are read from the raw URL.
  const wsParams = new URL(req.url || "", "http://localhost").searchParams;

  const rawToken = String(
    wsParams.get("token") || (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "")
  ).trim();

  const principal: AuthPrincipal | null = authenticateToken(rawToken);
  if (!principal) {
    serverLogger.warn({ ip: req.ip }, "Rejected WebSocket connection with invalid credential");
    closeWith(4001, "Unauthorized");
    return;
  }

  let scope;
  try {
    scope = await resolveTenantScope(principal);
  } catch (err: any) {
    serverLogger.error({ error: err.message }, "Failed to resolve tenant scope for WebSocket");
    closeWith(4011, "Scope unavailable");
    return;
  }

  // A socket may narrow itself to one project, but never widen beyond its
  // principal's scope. The requested project used to be trusted verbatim.
  const requestedProjectId = String(wsParams.get("projectId") || "").trim();
  let projectIds: number[] | null = scope.unrestricted ? null : scope.projectIds;

  if (requestedProjectId && requestedProjectId.toLowerCase() !== "all") {
    if (!/^[0-9]+$/.test(requestedProjectId)) {
      closeWith(4003, "Invalid projectId");
      return;
    }
    const requested = parseInt(requestedProjectId, 10);
    if (!scope.unrestricted && !scope.projectIds.includes(requested)) {
      serverLogger.warn(
        { ip: req.ip, principal: principal.subject, requested, allowed: scope.projectIds },
        "Rejected WebSocket subscription to an out-of-scope project"
      );
      closeWith(4003, "Forbidden");
      return;
    }
    projectIds = [requested];
  }

  if (projectIds !== null && projectIds.length === 0) {
    serverLogger.warn({ principal: principal.subject }, "Rejected WebSocket for account with no project access");
    closeWith(4003, "Forbidden");
    return;
  }

  serverLogger.info(
    { principal: principal.subject, role: principal.role, projectIds: projectIds ?? "all" },
    "Admin WebSocket connection established"
  );
  adminSocketRegistry.add(socket, { principal, projectIds });

  socket.on("close", () => {
    adminSocketRegistry.remove(socket);
    serverLogger.info({ principal: principal.subject }, "Admin WebSocket connection closed");
  });

  socket.on("error", (err: any) => {
    // Without this listener a socket-level error becomes an unhandled 'error'
    // event, which terminates the process (see RUN-02).
    serverLogger.warn({ error: err?.message }, "Admin WebSocket error");
    adminSocketRegistry.remove(socket);
  });
});
}

fastify.post("/api/v1/webhooks/human_notify", async (request, reply) => {
  const body = request.body as any;
  const { conversationId, role, content, reasonCode, reasonDetail, source } = body;

  serverLogger.info({ conversationId, role, content }, "Received human_notify takeover webhook");

  if (!conversationId) {
    return reply.code(400).send({ error: "Bad Request", message: "conversationId is required" });
  }

  const state = await requestHumanTakeover({
    conversationId: String(conversationId),
    role,
    content,
    reasonCode,
    reasonDetail,
    source,
  });
  return reply.code(200).send({ success: true, status: state.status, expires_at: state.leaseExpiresAt });
});

fastify.post("/api/v1/internal/conversations/reply", async (request, reply) => {
  const body = request.body as any;
  const currentTakeover = await takeoverManager.getTakeoverState(body.conversationId);
  if (currentTakeover.status !== "ACTIVE_HUMAN") {
    return reply.code(409).send({
      error: "Takeover required",
      message: "Claim the conversation before sending a human reply.",
      status: currentTakeover.status,
    });
  }
  const rawReplyTo = body.replyToMessageId || body.reply_to_message_id || body.reply_to_id || body.replyToId;
  const replyToId = rawReplyTo ? parseInt(String(rawReplyTo), 10) : undefined;
  const result = await humanReplyService.sendReply(body.conversationId, body.message, replyToId);
  if (takeoverManager) {
    const leaseDurationMs = config.HUMAN_ACTIVE_TIMEOUT_MINUTES * 60 * 1000;
    await takeoverManager.setTakeoverState(body.conversationId, "ACTIVE_HUMAN", "human_agent_admin", leaseDurationMs, true);
  }
  return reply.code(200).send(result);
});

// B-0: the tenant comes from the server-owned execution context, never from
// the caller. requireExecutionContext resolves it, discards any
// tenant-determining field the agent supplied, and fails closed when no valid
// context is presented.
fastify.post("/api/v1/internal/tickets/promote", { preHandler: requireExecutionContext }, async (request, reply) => {
  try {
    const body = (request.body || {}) as any;
    const ctx = request.trustedContext!;
    const payload = body.data && typeof body.data === "object" ? body.data : body;

    // Authoritative values, overwriting whatever arrived on the wire.
    payload.conversationId = ctx.conversationId;
    payload.conversation_id = ctx.conversationId;
    payload.projectId = ctx.projectId;
    payload.project_id = ctx.projectId;
    payload.orgId = ctx.orgId;
    payload.org_id = ctx.orgId;

    await traceRecorder.record({
      correlationId: ctx.correlationId,
      component: "ticketx",
      eventType: "promote_received",
      conversationId: ctx.conversationId,
      projectId: ctx.projectId,
      orgId: ctx.orgId,
      lineEventId: ctx.lineEventId,
      detail: { subject: String(payload.subject || "").slice(0, 120) },
    });

    const result = await planeService.promoteTicketToPlane(body);
    console.log("[Server] Promotion result:", JSON.stringify(result));

    await traceRecorder.record({
      correlationId: ctx.correlationId,
      component: "plane",
      eventType: "promote_completed",
      status: result?.planeIssueId ? "ok" : "failed",
      conversationId: ctx.conversationId,
      projectId: ctx.projectId,
      orgId: ctx.orgId,
      // Plane's own id when it gave one; null otherwise. Never invented.
      planeIssueId: result?.planeIssueId ? String(result.planeIssueId) : null,
      detail: { ticketNumber: result?.ticketId ?? null, alreadyPromoted: !!result?.alreadyPromoted },
    });

    return reply.code(200).send(result);
  } catch (err: any) {
    await traceRecorder.record({
      correlationId: request.trustedContext?.correlationId || `promote-failed-${request.id}`,
      component: "plane",
      eventType: "promote_failed",
      status: "failed",
      conversationId: request.trustedContext?.conversationId ?? null,
      projectId: request.trustedContext?.projectId ?? null,
      orgId: request.trustedContext?.orgId ?? null,
      errorMessage: err?.message || String(err),
    });
    console.error("[Server] /api/v1/internal/tickets/promote error:", err);
    return reply.code(500).send({
      statusCode: 500,
      error: "Internal Server Error",
      message: err.message || String(err),
    });
  }
});

/**
 * B-5: the causal chain for one ticket, back to the LINE event.
 *
 * Console-scoped: it exposes who talked to whom inside a tenant, so it is
 * behind the same authentication and project scoping as ticket reads.
 * missingLinks names the hops genuinely absent rather than presenting a
 * partial chain as complete.
 */
fastify.get("/api/v1/tickets/:id/trace", async (request, reply) => {
  // authHook (global onRequest) has already established the principal.
  if (!request.principal) {
    return reply.code(401).send({ error: "Unauthorized", message: "Authentication required" });
  }
  const { id } = request.params as { id: string };
  if (!/^[0-9]+$/.test(String(id))) {
    return reply.code(400).send({ error: "Bad Request", message: "Ticket id must be numeric" });
  }
  const ticketId = Number(id);

  const owner = await pool.query(`SELECT project_id FROM tickets WHERE id = $1 LIMIT 1`, [ticketId]);
  if (owner.rows.length === 0) {
    return reply.code(404).send({ error: "Not Found", message: `Ticket ${ticketId} does not exist` });
  }
  if (!canAccessProject(request, owner.rows[0].project_id)) {
    return reply.code(403).send({ error: "Forbidden", message: "Ticket is outside your project scope" });
  }

  const chain = await traceRecorder.chainForTicket(ticketId);
  return reply.code(200).send(chain);
});

fastify.post("/api/v1/internal/messages", async (request, reply) => {
  const body = request.body as any;
  await dbAdapter.saveMessage(
    body.conversationId,
    body.role || "human",
    body.content,
    body.externalId || body.external_id,
    body.messageType || body.message_type,
    body.replyToMessageId || body.reply_to_message_id,
    body.quoteToken || body.quote_token
  );
  return reply.code(200).send({ success: true });
});

fastify.get("/api/v1/internal/messages", async (request, reply) => {
  const query = request.query as any;
  const messages = await dbAdapter.getMessages(query.conversationId);
  const list = messages.map((m: any) => ({
    id: m.id,
    fields: {
      id: m.id,
      role: m.role,
      content: m.content,
      conversation_id: m.conversation_id
    }
  }));
  return reply.code(200).send(list);
});

fastify.get("/api/v1/internal/conversations/identity", async (request, reply) => {
  const query = request.query as any;
  const conversationId = query.conversationId;
  const parsed = parseInt(String(conversationId), 10);
  if (isNaN(parsed) || parsed <= 0 || String(conversationId) === "null" || String(conversationId) === "undefined") {
    return reply.code(400).send({ error: "Bad Request", message: "Invalid conversationId" });
  }
  const ident = await dbAdapter.getConversationIdent(query.conversationId);
  return reply.code(200).send(ident);
});

fastify.get("/api/v1/internal/tickets/details", async (request, reply) => {
  const query = request.query as any;
  const result = await dbAdapter.getTicketCompanyContext(query.ticketId);
  return reply.code(200).send(result);
});

fastify.post("/api/v1/internal/tickets/update-plane", async (request, reply) => {
  const body = request.body as any;
  const payload = body.data ? { ...body.data } : body;
  await dbAdapter.updateTicketPlaneIssue(payload.ticketId, payload.planeIssueId);
  return reply.code(200).send({ success: true });
});

fastify.post("/api/v1/webhooks/plane", async (request, reply) => {
  if (!config.PLANE_WEBHOOK_SECRET) {
    return reply.code(503).send({ error: "Plane webhook is not configured" });
  }

  const signature = request.headers["x-plane-signature"] as string | undefined;
  if (!verifyPlaneWebhookSignature(request.body, signature, config.PLANE_WEBHOOK_SECRET)) {
    return reply.code(403).send({ error: "Invalid Plane webhook signature" });
  }

  try {
    const result = await planeWebhookService.sync(request.body as any);
    serverLogger.info(
      {
        deliveryId: request.headers["x-plane-delivery"],
        planeIssueId: result.planeIssueId,
        processed: result.processed,
        matched: result.matched,
        reason: result.reason,
      },
      "Plane webhook handled"
    );
    return reply.code(200).send({ success: true, ...result });
  } catch (error: any) {
    serverLogger.error(
      { deliveryId: request.headers["x-plane-delivery"], error: error.message },
      "Plane webhook failed"
    );
    return reply.code(503).send({ error: "Plane webhook processing failed" });
  }
});

fastify.post("/api/v1/internal/tickets/close", async (request, reply) => {
  const body = request.body as any;
  const payload = body.data ? { ...body.data } : body;

  const rawReason = payload.cancellation_reason || payload.cancellationReason || payload.reason || payload.resolutionReason || payload.reasonDetail;
  const ticketId = payload.ticketId || payload.ticket_id || payload.id;
  // Tenant scope is derived, never supplied.
  //
  // This used to read org_id from a header or the body, so the agent named its
  // own tenant - and because the filter was appended only when a value was
  // present, OMITTING it matched the ticket number across every organization.
  // The org is no longer an input from either kind of caller.

  // Authorization runs BEFORE input validation, and before the tool.
  //
  // Two reasons, both learned here. First, the tool closes the ticket through
  // its own TransactionManager - a different connection from `client` below -
  // so the scoped UPDATE failing and this handler calling ROLLBACK did NOT
  // undo the tool's write; a cross-tenant caller got a 404 while the ticket
  // really had been closed. Second, validating first let an uncredentialed
  // caller probe the endpoint's field rules and learn it exists.
  const authority = await authorizeTicketOperation(request, reply, ticketId);
  if (!authority) return reply; // authorizeTicketOperation already replied
  const orgId = authority.orgId;

  const parseResult = CloseTicketInputSchema.safeParse({
    ticketId: String(ticketId || ""),
    cancellation_reason: typeof rawReason === "string" ? rawReason.trim() : "",
  });

  if (!parseResult.success) {
    return reply.code(400).send({
      error: "Bad Request",
      message: parseResult.error.issues[0]?.message || "A valid cancellation_reason (at least 10 characters) is required.",
    });
  }

  const validatedData = parseResult.data;
  const tool = toolRegistry.getLocalTool("close_ticket");
  if (!tool) return reply.code(500).send({ error: "Tool close_ticket not found" });
  const context = { correlationId: request.headers["x-correlation-id"], traceId: request.headers["x-trace-id"] };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const result = await tool.execute({ ...payload, cancellation_reason: validatedData.cancellation_reason }, context);

    // Save cancellation reason and update status within transaction
    const updateRes = await client.query(
      // 'cancelled' lowercase is not one of the eleven lifecycle statuses and
      // fails tickets_status_lifecycle_check, so every close through this
      // route errored at the update. The "OR org_id IS NULL" arm is gone too:
      // no ticket has a null org_id, so it protected nothing and only widened
      // the match beyond the caller's tenant.
      `UPDATE tickets
       SET cancellation_reason = $1, status = 'CANCELLED', updated_at = NOW()
       WHERE (ticket_number = $2 OR id = $3) AND org_id = $4
       RETURNING id, ticket_number, org_id`,
      [
        validatedData.cancellation_reason,
        validatedData.ticketId,
        parseInt(validatedData.ticketId, 10) || 0,
        String(orgId),
      ]
    );

    if (updateRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return reply.code(404).send({ error: "Not Found", message: `Ticket ${validatedData.ticketId} not found or tenant access denied` });
    }

    const closedTicket = updateRes.rows[0];

    // Atomic Audit logging in admin_audit_logs inside transaction
    await client.query(
      // admin_audit_logs has no action_type, actor_id or payload column - the
      // real shape is (action, actor, changes), as admin.ts already writes.
      // These inserts threw on every close and every restore.
      `INSERT INTO admin_audit_logs (action, entity_type, entity_id, actor, changes, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, NOW())`,
      [
        "TICKET_CLOSED",
        "Ticket",
        String(closedTicket.id),
        "system",
        JSON.stringify({ ticketId: closedTicket.ticket_number || closedTicket.id, cancellation_reason: validatedData.cancellation_reason, timestamp: new Date().toISOString() })
      ]
    );

    await client.query("COMMIT");
    return reply.code(200).send(result);
  } catch (err: any) {
    await client.query("ROLLBACK");
    serverLogger.error({ error: err.message, ticketId: validatedData.ticketId }, "Failed to close ticket atomically");
    return reply.code(500).send({ error: "Internal Server Error", message: err.message });
  } finally {
    client.release();
  }
});

fastify.post("/api/v1/internal/tickets/:id/restore", async (request, reply) => {
  const params = request.params as any;
  const ticketIdStr = String(params.id || "");

  const parseResult = RestoreTicketInputSchema.safeParse({ ticketId: ticketIdStr });
  if (!parseResult.success) {
    return reply.code(400).send({
      error: "Bad Request",
      message: parseResult.error.issues[0]?.message || "Invalid ticket ID",
    });
  }

  // Scope came from an x-org-id header, and the filter was appended only when
  // that header was present - so omitting it restored across every
  // organization. Same defect as the close route had.
  const authority = await authorizeTicketOperation(request, reply, ticketIdStr);
  if (!authority) return reply;
  const orgId = authority.orgId;

  const isNumeric = /^\d+$/.test(ticketIdStr);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Restoring a cancelled ticket is a REOPENED transition. This wrote the
    // literal 'open' before, which is in neither vocabulary and now violates
    // the tickets_status_lifecycle_check constraint added in migration 040.
    const query = isNumeric
      ? `UPDATE tickets SET status = 'REOPENED', plane_status = 'Open', cancellation_reason = NULL, lifecycle_changed_at = NOW(), updated_at = NOW() WHERE id = $1 AND org_id = $2 RETURNING *`
      : `UPDATE tickets SET status = 'REOPENED', plane_status = 'Open', cancellation_reason = NULL, lifecycle_changed_at = NOW(), updated_at = NOW() WHERE ticket_number = $1 AND org_id = $2 RETURNING *`;
    
    const queryArgs = [isNumeric ? parseInt(ticketIdStr, 10) : ticketIdStr, String(orgId)] as any[];
    const { rows } = await client.query(query, queryArgs);

    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return reply.code(404).send({ error: "Not Found", message: `Ticket ${ticketIdStr} not found or tenant access denied` });
    }

    const ticket = rows[0];

    // Log ticket event inside transaction
    await client.query(
      `INSERT INTO ticket_events (ticket_id, event_type, payload) VALUES ($1, $2, $3)`,
      [ticket.id, "RESTORED", JSON.stringify({ restoredAt: new Date().toISOString(), restoredBy: "admin" })]
    );

    // Atomic audit logging in admin_audit_logs inside transaction
    await client.query(
      // admin_audit_logs has no action_type, actor_id or payload column - the
      // real shape is (action, actor, changes), as admin.ts already writes.
      // These inserts threw on every close and every restore.
      `INSERT INTO admin_audit_logs (action, entity_type, entity_id, actor, changes, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, NOW())`,
      [
        "TICKET_RESTORED",
        "Ticket",
        String(ticket.id),
        "system",
        JSON.stringify({ ticketId: ticket.ticket_number || ticket.id, restoredAt: new Date().toISOString() })
      ]
    );

    await client.query("COMMIT");

    return reply.code(200).send({
      success: true,
      message: `Ticket ${ticket.ticket_number || ticket.id} has been restored successfully.`,
      ticket: {
        id: String(ticket.id),
        ticketId: ticket.ticket_number || ticket.ticket_id,
        status: ticket.status,
        createdByType: ticket.created_by_type || "CUSTOMER",
        createdByName: ticket.created_by_name || null,
        cancellationReason: null,
      },
    });
  } catch (err: any) {
    await client.query("ROLLBACK");
    serverLogger.error({ error: err.message, ticketId: ticketIdStr }, "Failed to restore ticket atomically");
    return reply.code(500).send({ error: "Internal Server Error", message: err.message });
  } finally {
    client.release();
  }
});

/**
 * Runs a ticket tool only after every ticket the agent named has been proven
 * to belong to this execution.
 *
 * The agent chooses WHAT to operate on; this decides WHETHER it may. The
 * reference is then rewritten to the canonical identifier of the row that was
 * actually authorized, so the tool cannot act on a different one.
 *
 * Applies to reads as much as writes: a cross-tenant read is a security
 * failure even though nothing is mutated.
 */
async function runGuardedTicketTool(
  request: any,
  reply: any,
  toolName: string,
  referenceFields: string[]
) {
  const ctx = request.trustedContext!;
  const body = (request.body || {}) as any;
  const payload = body.data ? { ...body.data } : { ...body };

  const tool = toolRegistry.getLocalTool(toolName);
  if (!tool) return reply.code(500).send({ error: `Tool ${toolName} not found` });

  const authorized: Record<string, AuthorizedTicket> = {};
  for (const field of referenceFields) {
    const reference = payload[field];
    if (reference === undefined || reference === null || String(reference).trim() === "") {
      return reply.code(400).send({
        error: "Bad Request",
        code: "TICKET_REFERENCE_REQUIRED",
        message: `${field} is required`,
      });
    }

    const result = await authorizeTicket(ctx, reference);
    if (!result.ok || !result.resource) {
      return reply.code(authorizationStatus(result.failure)).send({
        error: result.failure === "RESOURCE_REFERENCE_INVALID" ? "Bad Request" : "Not Found",
        code: result.failure,
        message: result.reason,
      });
    }

    authorized[field] = result.resource;
    payload[field] =
      result.resource.ticketNumber || result.resource.ticketId || String(result.resource.id);
  }

  await traceRecorder.record({
    correlationId: ctx.correlationId,
    component: "mcp",
    eventType: `${toolName}_authorized`,
    conversationId: ctx.conversationId,
    projectId: ctx.projectId,
    orgId: ctx.orgId,
    ticketId: authorized[referenceFields[0]]?.id ?? null,
    detail: { tool: toolName, tickets: Object.values(authorized).map((t) => t.id) },
  });

  try {
    const result = await tool.execute(payload, {
      correlationId: ctx.correlationId,
      traceId: request.headers["x-trace-id"],
    });
    return reply.code(200).send(result);
  } catch (err: any) {
    await traceRecorder.record({
      correlationId: ctx.correlationId,
      component: "mcp",
      eventType: `${toolName}_failed`,
      status: "failed",
      conversationId: ctx.conversationId,
      projectId: ctx.projectId,
      orgId: ctx.orgId,
      errorMessage: err.message,
    });
    return reply.code(500).send({ error: err.message });
  }
}

fastify.post("/api/v1/internal/tickets/assign", { preHandler: requireExecutionContext }, async (request, reply) =>
  runGuardedTicketTool(request, reply, "assign_ticket", ["ticketId"])
);

fastify.post("/api/v1/internal/tickets/merge", { preHandler: requireExecutionContext }, async (request, reply) =>
  runGuardedTicketTool(request, reply, "merge_ticket", ["ticketId", "primaryTicketId"])
);

fastify.post("/api/v1/internal/tickets/reopen", { preHandler: requireExecutionContext }, async (request, reply) =>
  runGuardedTicketTool(request, reply, "reopen_ticket", ["ticketId"])
);

fastify.post("/api/v1/internal/tickets/update-summary", { preHandler: requireExecutionContext }, async (request, reply) =>
  runGuardedTicketTool(request, reply, "update_summary", ["ticketId"])
);

fastify.get("/api/v1/internal/identities/search", async (request, reply) => {
  const query = request.query as any;
  const channel = query.channel;
  const channelRef = query.channelRef || query.channel_ref;

  const res = await pool.query(
    `SELECT * FROM identities WHERE channel = $1 AND channel_ref = $2 LIMIT 1`,
    [channel, channelRef]
  );

  if (res.rows.length === 0) {
    return reply.code(200).send([]);
  }

  const ident = res.rows[0];
  return reply.code(200).send([
    {
      id: ident.id,
      fields: {
        profile_id: ident.profile_id ? { id: ident.profile_id } : null
      }
    }
  ]);
});

fastify.get("/api/v1/internal/identities/details", async (request, reply) => {
  const query = request.query as any;
  const identityId = query.identityId || query.identity_id;
  const res = await pool.query(
    `SELECT * FROM identities WHERE id = $1 LIMIT 1`,
    [identityId]
  );
  if (res.rows.length === 0) {
    return reply.code(404).send({ error: "Identity not found" });
  }
  const ident = res.rows[0];
  return reply.code(200).send({
    id: ident.id,
    fields: {
      id: ident.id,
      profile_id: ident.profile_id ? { id: ident.profile_id } : null,
      channel: ident.channel,
      channel_ref: ident.channel_ref
    }
  });
});

fastify.get("/api/v1/internal/profiles/details", async (request, reply) => {
  const query = request.query as any;
  const profileId = query.profileId || query.profile_id;

  if (!profileId || profileId === "null" || profileId === "undefined") {
    return reply.code(200).send({
      id: null,
      fields: {
        company_id: { id: null },
        name: null
      }
    });
  }

  const res = await pool.query(
    `SELECT * FROM profiles WHERE id = $1 LIMIT 1`,
    [profileId]
  );

  if (res.rows.length === 0) {
    return reply.code(200).send({
      id: null,
      fields: {
        company_id: { id: null },
        name: null
      }
    });
  }

  const prof = res.rows[0];
  return reply.code(200).send({
    id: prof.id,
    fields: {
      company_id: prof.company_id ? { id: prof.company_id } : { id: null },
      name: prof.name
    }
  });
});

fastify.get("/api/v1/internal/companies/details", async (request, reply) => {
  const query = request.query as any;
  const companyId = query.companyId || query.company_id;

  if (!companyId || companyId === "null" || companyId === "undefined") {
    return reply.code(200).send({
      id: null,
      fields: {
        name: null,
        ai_profile_context: "ผู้ใช้นี้ยังไม่มีข้อมูลบัญชีที่เชื่อมโยงในระบบ กรุณาขอข้อมูลชื่อและชื่อบริษัทของลูกค้าก่อนให้บริการ"
      }
    });
  }

  const res = await pool.query(
    `SELECT * FROM companies WHERE id = $1 LIMIT 1`,
    [companyId]
  );

  if (res.rows.length === 0) {
    return reply.code(200).send({
      id: null,
      fields: {
        name: null,
        ai_profile_context: "ผู้ใช้นี้ยังไม่มีข้อมูลบัญชีที่เชื่อมโยงในระบบ กรุณาขอข้อมูลชื่อและชื่อบริษัทของลูกค้าก่อนให้บริการ"
      }
    });
  }

  const comp = res.rows[0];
  return reply.code(200).send({
    id: comp.id,
    fields: {
      name: comp.name,
      ai_profile_context: comp.ai_profile_context
    }
  });
});

fastify.all("/api/v1/internal/rag", async (request, reply) => {
  const method = request.method;
  let query: string;
  let projectId: string;

  if (method === "GET" || method === "DELETE") {
    const q = request.query as any;
    query = q.query;
    projectId = q.projectId || q.project_id || "1";
  } else {
    const body = (request.body || {}) as any;
    const payload = body.data ? { ...body.data } : body;
    query = payload.query;
    projectId = payload.projectId || payload.project_id || "1";
  }

  const orgId = request.tenantContext?.orgId;
  const results = await knowledgeService.searchKnowledgeBase(query || "", String(projectId), orgId);
  return reply.code(200).send({
    success: true,
    data: { results }
  });
});

fastify.get("/api/v1/internal/config/prompts", async (request, reply) => {
  const query = request.query as any;
  const projectId = query.projectId || request.headers["x-project-id"] || "1";
  const config = await ConfigLoaderService.getInstance().getPromptConfig(String(projectId));
  return reply.code(200).send(config);
});

fastify.get("/api/v1/internal/conversations/search", async (request, reply) => {
  const query = request.query as any;
  const identityId = query.identityId || query.identity_id;
  const conversationId = query.conversationId || query.conversation_id;
  const subject = typeof query.subject === "string" ? query.subject.trim() : "";
  const status = query.status || "open";
  const projectId = query.projectId || request.headers["x-project-id"];

  // Every branch below resolves to exactly one conversation by an identifier
  // the caller supplied. None of them falls back to "the most recent open
  // conversation" — that fallback previously attached callers to unrelated
  // customers, and in the PromptX branch it also rewrote the other
  // conversation's promptx_conversation_id, permanently hijacking the thread.
  let res;
  const parsedConversationId = parseInt(String(conversationId), 10);
  const parsedProjectId = projectId ? parseInt(String(projectId), 10) : NaN;
  const hasProjectScope = Number.isInteger(parsedProjectId) && parsedProjectId > 0;

  if (conversationId && Number.isInteger(parsedConversationId) && parsedConversationId > 0) {
    // Direct lookup by id, constrained to the caller's project when one is
    // supplied so an id from another project cannot be probed.
    res = hasProjectScope
      ? await pool.query(
          `SELECT * FROM conversations WHERE id = $1 AND status = $2 AND project_id = $3 AND deleted_at IS NULL LIMIT 1`,
          [parsedConversationId, status, parsedProjectId]
        )
      : await pool.query(
          `SELECT * FROM conversations WHERE id = $1 AND status = $2 AND deleted_at IS NULL LIMIT 1`,
          [parsedConversationId, status]
        );
  } else {
    const isPromptXId = String(identityId).startsWith("convo_") ||
      /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(String(identityId));

    if (isPromptXId) {
      // Exact match only. An unknown PromptX conversation id resolves to
      // nothing, which the caller sees as an empty result.
      res = await pool.query(
        `SELECT * FROM conversations WHERE promptx_conversation_id = $1 AND deleted_at IS NULL LIMIT 1`,
        [identityId]
      );
    } else if (hasProjectScope) {
      // identityId may be an internal numeric identity id or a channel
      // reference (a LINE user id). conversations.identity_id is numeric, so
      // passing a channel reference straight into the comparison produced a
      // Postgres 22P02 and a 500.
      const numericIdentityId = /^[0-9]+$/.test(String(identityId)) ? String(identityId) : null;

      res = numericIdentityId
        ? await pool.query(
            `SELECT * FROM conversations
              WHERE identity_id = $1 AND status = $2 AND project_id = $3 AND deleted_at IS NULL
              ORDER BY created_at DESC LIMIT 1`,
            [numericIdentityId, status, parsedProjectId]
          )
        : await pool.query(
            `SELECT c.* FROM conversations c
               JOIN identities i ON c.identity_id = i.id
              WHERE i.channel_ref = $1 AND c.status = $2 AND c.project_id = $3 AND c.deleted_at IS NULL
              ORDER BY c.created_at DESC LIMIT 1`,
            [String(identityId), status, parsedProjectId]
          );
    } else {
      // An identity can be enrolled in several projects, so resolving by
      // identity alone can return a conversation from a project the caller
      // did not mean. Require the project to be named.
      serverLogger.warn(
        { identityId },
        "Rejected conversation search by identity without a project scope"
      );
      return reply.code(400).send({
        error: "Bad Request",
        code: "PROJECT_SCOPE_REQUIRED",
        message: "projectId is required when searching by identityId",
      });
    }
  }

  if (!res || res.rows.length === 0) {
    return reply.code(200).send([]);
  }

  const conv = res.rows[0];
  let tickets: Array<{ id: number; fields: Record<string, unknown> }> = [];
  if (subject) {
    const ticketRes = await pool.query(
      `SELECT id, ticket_number, ticket_id, status, due_date
       FROM tickets
       WHERE conversation_id = $1
         -- Terminal lifecycle states. RESOLVED is deliberately NOT here: a
         -- resolved ticket is still open business until the customer confirms.
         AND status NOT IN ('CLOSED', 'CANCELLED', 'CUSTOMER_CONFIRMED')
         AND LOWER(REGEXP_REPLACE(TRIM(COALESCE(subject, '')), '\\s+', ' ', 'g'))
             = LOWER(REGEXP_REPLACE(TRIM($2::text), '\\s+', ' ', 'g'))
       ORDER BY created_at DESC
       LIMIT 1`,
      [conv.id, subject]
    );
    tickets = ticketRes.rows.map((ticket: any) => ({
      id: ticket.id,
      fields: {
        id1: ticket.ticket_number || ticket.ticket_id || String(ticket.id),
        status: ticket.status,
        due_date: ticket.due_date,
      },
    }));
  }

  return reply.code(200).send([
    {
      id: conv.id,
      fields: {
        id: conv.id,
        identity_id: conv.identity_id,
        project_id: conv.project_id,
        channel: conv.channel,
        status: conv.status,
        handled_by: conv.handled_by,
        assigned_pm: conv.assigned_pm,
        Tickets: tickets,
      }
    }
  ]);
});

fastify.post("/api/v1/internal/conversations", async (request, reply) => {
  const body = request.body as any;
  const identityId = body.identityId || body.identity_id;
  const channel = body.channel;
  const status = body.status || "open";
  const handledBy = body.handledBy || body.handled_by || "ai";
  let projectId = body.projectId || body.project_id || request.headers["x-project-id"];
  let parsedProjectId = projectId ? (parseInt(String(projectId), 10) || null) : null;

  if (!parsedProjectId && body.destination) {
    const channelRes = await pool.query(
      "SELECT project_id FROM project_channels WHERE channel_id = $1 LIMIT 1",
      [body.destination]
    );
    if (channelRes.rows.length > 0) {
      parsedProjectId = channelRes.rows[0].project_id;
    }
  }

  // Allocate from the table's own sequence — MAX(id)+1 left the sequence behind
  // and collided with the DEFAULT nextval() writers (see migration 043).
  const nextId = await nextSequenceId(pool, "conversations");

  const res = await pool.query(
    `INSERT INTO conversations (id, identity_id, channel, status, handled_by, project_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [nextId, identityId, channel, status, handledBy, parsedProjectId]
  );

  const conv = res.rows[0];
  return reply.code(200).send({
    id: conv.id,
    fields: {
      id: conv.id,
      identity_id: conv.identity_id,
      project_id: conv.project_id,
      channel: conv.channel,
      status: conv.status,
      handled_by: conv.handled_by,
      assigned_pm: conv.assigned_pm
    }
  });
});

fastify.get("/api/v1/internal/conversations/details", async (request, reply) => {
  const query = request.query as any;
  const conversationId = query.conversationId;
  const parsed = parseInt(String(conversationId), 10);
  if (isNaN(parsed) || parsed <= 0 || String(conversationId) === "null" || String(conversationId) === "undefined") {
    return reply.code(400).send({ error: "Bad Request", message: "Invalid conversationId" });
  }
  const conv = await dbAdapter.getConversation(query.conversationId);
  if (!conv) {
    return reply.code(404).send({ error: "Conversation not found" });
  }
  return reply.code(200).send(conv);
});

fastify.post("/api/v1/internal/sessions/resolve", async (request, reply) => {
  let body = request.body as any;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) {}
  }
  const payload = body.data ? (body.data.data ? body.data.data : body.data) : (body.body ? (body.body.data ? body.body.data : body.body) : body);

  const senderId = payload.senderId || payload.sender_ref || payload.customer_ref || payload.channel_ref || payload.channelRef;
  const channel = payload.channel || "LINE";
  const rawText = payload.messageText 
    || payload.message_text 
    || payload.message 
    || payload.text 
    || payload.event?.message?.text 
    || payload.message?.text 
    || payload.body?.message?.text 
    || payload.body?.text 
    || body.messageText 
    || body.message_text 
    || body.message?.text 
    || body.text 
    || body.event?.message?.text 
    || payload.postbackData 
    || payload.postback_data 
    || payload.postback?.data 
    || payload.event?.postback?.data 
    || body.postbackData 
    || body.postback?.data 
    || "";
  const messageText = typeof rawText === "string" ? rawText : (typeof rawText === "object" ? (rawText.text || "") : String(rawText || ""));
  const isMentioned = payload.isMentioned === true || payload.isMentioned === "true";
  
  // Unify all LINE Gateway / Activepieces / PromptX field aliases (bulletproof deep lookup)
  const eventObj = payload.event || (Array.isArray(payload.events) ? payload.events[0] : null) || body.event || (Array.isArray(body.events) ? body.events[0] : null) || null;
  const msgObj = eventObj?.message || payload.message || body.message || null;

  const rawMessageType = payload.messageType 
    || payload.message_type 
    || msgObj?.type 
    || eventObj?.type 
    || payload.type 
    || body.messageType 
    || body.message_type;

  const explicitImageId = payload.line_image_id 
    || payload.lineImageId 
    || payload.imageId 
    || payload.line_image 
    || body.line_image_id 
    || body.imageId;

  const isImageMessage = rawMessageType === "image" || msgObj?.type === "image" || !!explicitImageId;
  const messageType = isImageMessage ? "image" : (rawMessageType === "sticker" ? "sticker" : "text");

  const imageId = explicitImageId || (isImageMessage ? (msgObj?.id || payload.externalId || payload.external_id || body.external_id || null) : null);

  const rawQuoteToken = payload.quote_token 
    || payload.quoteToken 
    || payload.event?.message?.quote_token
    || payload.event?.message?.quoteToken 
    || payload.body?.quote_token 
    || payload.body?.quoteToken 
    || body.quote_token 
    || body.quoteToken 
    || body.data?.quote_token
    || body.data?.quoteToken
    || body.event?.message?.quoteToken 
    || null;
  const quote_token = (rawQuoteToken && String(rawQuoteToken).trim()) ? String(rawQuoteToken).trim() : null;

  // LINE's quotedMessageId identifies the original message the user replied to (LINE Messaging API feature)
  const rawQuotedMessageId = payload.quotedMessageId
    || payload.quoted_message_id
    || payload.event?.message?.quotedMessageId
    || payload.event?.message?.quoted_message_id
    || payload.message?.quotedMessageId
    || payload.message?.quoted_message_id
    || payload.body?.quotedMessageId
    || payload.body?.quoted_message_id
    || payload.body?.message?.quotedMessageId
    || payload.body?.event?.message?.quotedMessageId
    || body.quotedMessageId
    || body.quoted_message_id
    || body.event?.message?.quotedMessageId
    || body.event?.message?.quoted_message_id
    || body.message?.quotedMessageId
    || body.message?.quoted_message_id
    || body.data?.quotedMessageId
    || body.data?.quoted_message_id
    || body.data?.message?.quotedMessageId
    || null;
  const quotedMessageId = rawQuotedMessageId ? String(rawQuotedMessageId).trim() : null;

  const replyToken = payload.replyToken 
    || payload.reply_token 
    || payload.event?.replyToken 
    || payload.body?.reply_token 
    || body.reply_token 
    || null;

  const externalId = payload.externalId 
    || payload.external_id 
    || imageId 
    || payload.event?.message?.id 
    || body.external_id 
    || body.event?.message?.id 
    || null;

  serverLogger.info({ senderId, messageText, messageType, imageId, quote_token, quotedMessageId, replyToken, channel }, "[Webhook] Inbound customer message payload received");

  if (!senderId) {
    return reply.code(400).send({ error: "Bad Request", message: "Missing senderId" });
  }

  try {
    // 1. Ensure conversation and identity exist first for the customer
    await memoryService.ensureConversation(senderId, "1", channel);

    // 2. Load context
    const sessionContext = await memoryService.loadSessionContext(senderId, channel);
    const conversationId = sessionContext.conversationId;

    // Save or update customer message in DB if not created yet by gateway
    let currentMsgRecord: any = null;
    if (conversationId) {
      const incomingMessageId = payload.messageId || payload.message_id || body.message_id || body.messageId || null;
      const incomingExternalId = externalId || payload.tempId || payload.temp_id || body.tempId || body.temp_id || null;

      // Check if message was already persisted (e.g. by WebChatGateway or LINE webhook)
      if (incomingMessageId) {
        try {
          const res = await pool.query(
            `SELECT * FROM messages WHERE id = $1 AND conversation_id = $2 LIMIT 1`,
            [parseInt(String(incomingMessageId), 10), conversationId]
          );
          if (res.rows.length > 0) {
            currentMsgRecord = res.rows[0];
            serverLogger.info({ messageId: currentMsgRecord.id, conversationId }, "[sessions/resolve] Reusing existing message by message_id");
          }
        } catch (e: any) {
          serverLogger.warn({ err: e.message }, "[sessions/resolve] Error querying existing message by message_id");
        }
      }

      if (!currentMsgRecord && incomingExternalId) {
        try {
          const res = await pool.query(
            `SELECT * FROM messages WHERE conversation_id = $1 AND external_id = $2 LIMIT 1`,
            [conversationId, String(incomingExternalId)]
          );
          if (res.rows.length > 0) {
            currentMsgRecord = res.rows[0];
            serverLogger.info({ messageId: currentMsgRecord.id, externalId: incomingExternalId, conversationId }, "[sessions/resolve] Reusing existing message by external_id");
          }
        } catch (e: any) {
          serverLogger.warn({ err: e.message }, "[sessions/resolve] Error querying existing message by external_id");
        }
      }

      // For WebChat channel, WebChatGateway owns customer message persistence.
      // If a customer message was already persisted in this conversation recently, reuse it and NEVER insert a duplicate.
      if (!currentMsgRecord && (channel.toLowerCase() === "webchat" || channel.toLowerCase() === "web")) {
        try {
          const res = await pool.query(
            `SELECT * FROM messages 
             WHERE conversation_id = $1 
               AND role = 'customer' 
               AND created_at > NOW() - INTERVAL '5 minutes'
             ORDER BY id DESC LIMIT 1`,
            [conversationId]
          );
          if (res.rows.length > 0) {
            currentMsgRecord = res.rows[0];
            serverLogger.info({ messageId: currentMsgRecord.id, conversationId }, "[sessions/resolve] WebChat customer message already persisted by Gateway; skipping duplicate insert");
          }
        } catch (e: any) {
          serverLogger.warn({ err: e.message }, "[sessions/resolve] Error querying recent WebChat customer message");
        }
      }

      // Only if NO existing message record exists: persist new customer message
      if (!currentMsgRecord) {
        // Resolve reply_to_message_id from quotedMessageId (LINE reply feature)
        let replyToMessageId: number | undefined = undefined;
        if (quotedMessageId) {
          try {
            const quotedRes = await pool.query(
              `SELECT id FROM messages WHERE external_id = $1 ORDER BY id DESC LIMIT 1`,
              [quotedMessageId]
            );
            if (quotedRes.rows.length > 0) {
              replyToMessageId = parseInt(String(quotedRes.rows[0].id), 10) || undefined;
              serverLogger.info({ quotedMessageId, replyToMessageId }, "[Webhook] Resolved quotedMessageId -> reply_to_message_id");
            } else {
              serverLogger.warn({ quotedMessageId }, "[Webhook] Could not find parent message for quotedMessageId");
            }
          } catch (e: any) {
            serverLogger.warn({ quotedMessageId, err: e.message }, "[Webhook] Failed to resolve quotedMessageId");
          }
        }

        currentMsgRecord = await dbAdapter.saveMessage(
          conversationId,
          "customer",
          messageText,
          incomingExternalId || undefined,
          messageType,
          replyToMessageId,
          quote_token || undefined
        );
      }
    }

    // Auto-ingest LINE image if imageId is provided or messageType is image
    if (imageId || messageType === "image") {
      try {
        const { LINEAdapter } = await import("../presentation/http/adapters/LINEAdapter");
        const { S3MediaStorageService } = await import("../media/services/S3MediaStorageService");
        const mediaStorage = new S3MediaStorageService({});
        const lineToken = (config.LINE_CHANNEL_ACCESS_TOKEN || "").trim();
        const lineAdapter = new LINEAdapter(mediaStorage, lineToken);

        const targetImageId = imageId || (externalId && !externalId.startsWith("msg_") ? externalId : null);
        if (targetImageId) {
          const lineEvent = {
            type: "message",
            message: { type: "image", id: targetImageId, quote_token },
            source: { userId: senderId },
            timestamp: Date.now()
          };

          const normalized = await lineAdapter.adaptEvent(lineEvent);
          if (normalized && normalized.attachments.length > 0) {
            const att = normalized.attachments[0];

            let messageId = currentMsgRecord?.id ? parseInt(String(currentMsgRecord.id), 10) : null;
            if (!messageId) {
              const existingMsgResult = await pool.query(
                `SELECT m.id FROM messages m
                 LEFT JOIN message_attachments ma ON ma.message_id = m.id
                 WHERE m.conversation_id = $1
                   AND m.message_type = 'image'
                   AND ma.id IS NULL
                 ORDER BY m.id DESC
                 LIMIT 1`,
                [String(conversationId)]
              );
              if (existingMsgResult.rows.length > 0) {
                messageId = existingMsgResult.rows[0].id;
              }
            }

            if (messageId) {
              await pool.query(
                `INSERT INTO message_attachments 
                  (message_id, file_url, thumbnail_url, file_name, file_type, file_size, storage_key, attachment_status, metadata)
                 VALUES 
                  ($1, $2, $3, $4, $5, $6, $7, 'READY', $8)
                 ON CONFLICT DO NOTHING`,
                [
                  messageId,
                  att.fileUrl,
                  att.thumbnailUrl || att.fileUrl,
                  att.fileName,
                  att.fileType,
                  att.fileSize,
                  att.storageKey,
                  JSON.stringify(att.metadata || { sourceChannel: "line", lineImageId: targetImageId })
                ]
              );
              serverLogger.info({ messageId, storageKey: att.storageKey, targetImageId }, "[LINEAdapter] Image attachment saved to DB successfully");
            }
          }
        }
      } catch (mediaErr: any) {
        serverLogger.error({ error: mediaErr.message, senderId, imageId }, "Failed to auto-process incoming LINE image webhook");
      }
    }



    // 3. Find identity & profile details
    const identityResult = await pool.query(
      `SELECT i.id AS identity_id, i.profile_id, p.company_id, p.name AS profile_name
       FROM identities i
       JOIN profiles p ON p.id = i.profile_id
       WHERE LOWER(i.channel) = LOWER($1) AND i.channel_ref = $2
       LIMIT 1`,
      [channel, senderId]
    );

    const identityRow = identityResult.rows[0];
    const profileId = identityRow?.profile_id;
    const profileName = identityRow?.profile_name || "Unknown Customer";
    const companyId = identityRow?.company_id || 1;

    // Get company details
    const companyResult = await pool.query(`SELECT id, name FROM companies WHERE id = $1 LIMIT 1`, [companyId]);
    const companyName = companyResult.rows[0]?.name || "Default Company";

    // 4. Check group policy / shouldProcess
    const policyCheck = await orchestrator.conversationResolver.shouldProcess({
      senderId,
      channel,
      message: messageText,
      isMentioned
    } as any, conversationId);

    // 5. Get active ticket details
    const activeTicket = await dbAdapter.getLatestTicketForConversation(conversationId);

    // 6. Build response components
    const identity = {
      id: identityRow?.identity_id,
      profile_id: profileId,
      channel,
      channel_ref: senderId,
      name: profileName
    };

    const profile = {
      id: profileId,
      company_id: companyId,
      name: profileName
    };

    const company = {
      id: companyId,
      name: companyName
    };

    const takeoverState = await orchestrator.takeoverManager.getTakeoverState(conversationId);
    if (takeoverState.status === "ACTIVE_AI" && sessionContext.handledBy === "human") {
      await dbAdapter.updateHandoffState(conversationId, "ai");
      sessionContext.handledBy = "ai";
    }

    const conversation = {
      id: conversationId,
      identity_id: identityRow?.identity_id,
      status: policyCheck.shouldProcess ? sessionContext.status : "muted",
      handledBy: sessionContext.handledBy,
      // snake_case alias too: the flow that replaced its own SQL with this
      // endpoint reads handled_by, and silently returning undefined would look
      // like "no human is handling this".
      handled_by: sessionContext.handledBy,
      channel,
      muteReason: policyCheck.shouldProcess ? null : policyCheck.reason
    };

    const ticket = activeTicket ? {
      id: activeTicket.id,
      ticketCode: activeTicket.ticket_id,
      status: activeTicket.status,
      priority: activeTicket.priority,
      slaBreached: activeTicket.sla_breached || false
    } : null;

    // Check if human takeover is active
    const isHumanTakeover = takeoverState.status === "ACTIVE_HUMAN" || takeoverState.status === "PENDING_HUMAN" || sessionContext.handledBy === "human";

    // Build runtimeFlags
    const runtimeFlags = {
      allowReply: policyCheck.shouldProcess && !isHumanTakeover,
      allowToolExecution: policyCheck.shouldProcess && !isHumanTakeover,
      allowWorkflow: policyCheck.shouldProcess,
      allowMemoryWrite: policyCheck.shouldProcess && !isHumanTakeover
    };

    // Load message history
    const history = await memoryService.getConversationHistory(conversationId, 10);
    const historySummary = history.map(h => `${h.role === 'customer' ? 'Customer' : h.role === 'ai' ? 'Assistant' : 'Support'}: ${h.content}`).join("\n");

    const projectResult = await pool.query(
      `SELECT project_id
       FROM conversations
       WHERE id = $1::integer
         AND deleted_at IS NULL
       LIMIT 1`,
      [conversationId]
    );
    const conversationProjectId = String(projectResult.rows[0]?.project_id || "");
    // Carried on the conversation so callers do not have to resolve it again.
    (conversation as any).project_id = conversationProjectId || null;

    // Notify only Admin UI WebSockets connected to the conversation's project.
    const notifyPayload = JSON.stringify({
      event: "NEW_MESSAGE",
      data: {
        conversationId: String(conversationId),
        projectId: conversationProjectId,
        channel,
        customerName: profileName,
        messageType
      }
    });
    adminSocketRegistry.broadcastToProject(conversationProjectId, notifyPayload);

    // ------------------------------------------------------------------
    // Mint the execution capability for this turn.
    //
    // This is the only point in the NEW PromptX path where the backend has
    // resolved WHO is talking, from channel identifiers, before any AI has
    // seen the message. So it is the only honest place to issue authority.
    //
    // The flow receives an opaque token it can do nothing with except pass
    // on. Every tenant fact is read from the row this token names, so the
    // Gate Agent's output can never become tenant authority.
    //
    // Minting never fails the resolve: a session that cannot be given a
    // capability still returns, and the downstream call then fails closed at
    // the guard rather than here. Returning null is honest; inventing a
    // token would not be.
    let executionContextToken: string | null = null;
    let executionCorrelationId: string | null = null;
    let executionContextId: string | null = null;

    if (conversationId && conversationProjectId) {
      try {
        const orgRow = await pool.query(
          `SELECT org_id FROM conversations WHERE id = $1 LIMIT 1`,
          [conversationId]
        );
        const resolvedOrgId = orgRow.rows[0]?.org_id;
        if (resolvedOrgId) {
          const minted = await executionContextService.create({
            channel: String(channel || "line").toLowerCase(),
            lineEventId: payload.external_id || payload.externalId || null,
            identityId: identityRow?.identity_id ?? null,
            conversationId: Number(conversationId),
            projectId: Number(conversationProjectId),
            orgId: String(resolvedOrgId),
          });
          executionContextToken = minted.token;
          executionCorrelationId = minted.context.correlationId;
          executionContextId = minted.context.contextId;

          await traceRecorder.record({
            correlationId: minted.context.correlationId,
            component: "line_webhook",
            eventType: "session_resolved",
            conversationId: Number(conversationId),
            projectId: Number(conversationProjectId),
            orgId: String(resolvedOrgId),
            identityId: identityRow?.identity_id ?? null,
            detail: { channel, via: "sessions/resolve" },
          });
        }
      } catch (mintErr: any) {
        serverLogger.warn(
          { error: mintErr.message, conversationId },
          "Could not mint an execution context for this session; downstream calls will fail closed"
        );
      }
    }

    return reply.code(200).send({
      identity,
      profile,
      company,
      conversation,
      ticket,
      // Opaque capability for this turn. Pass through unchanged; never log,
      // never store, never place in message content.
      execution: {
        execution_context_token: executionContextToken,
        correlation_id: executionCorrelationId,
        execution_context_id: executionContextId,
      },
      runtimeFlags,
      policy: {
        shouldProcess: policyCheck.shouldProcess,
        reason: policyCheck.reason
      },
      sessionMetadata: {
        resolvedAt: new Date().toISOString()
      },
      historySummary
    });
  } catch (err: any) {
    serverLogger.error({ error: err.message, senderId }, "Failed to resolve session context");
    return reply.code(500).send({ error: "Internal Server Error", message: err.message });
  }
});

// Register Phase 9 Admin Routes
registerAdminRoutes(fastify, {
  metricAggregator,
  ingestionService,
  evalTestRunner,
  trafficSplitter,
  dbAdapter,
  takeoverManager,
});

// Register WebChat Gateway and WebSockets
fastify.register(WebChatGateway);

// Register Auth, Master Data, & Customer Portal Routes
fastify.register(registerAdminSocketRoute);
fastify.register(registerAuthRoutes);
fastify.register(registerMasterDataRoutes);
fastify.register(registerAdminPlaneIntegrationRoutes);
fastify.register(registerGitRepositoryRoutes);
registerPortalRoutes(fastify, { dbAdapter, slaService, emailService: emailNotificationService });
const agentSessionQueueService = new AgentSessionQueueService(pool);
const agentSessionQueueWorker = new AgentSessionQueueWorker(agentSessionQueueService, {
  dmGatewayUrl: config.LINE_DM_GATEWAY_WEBHOOK_URL,
  leaseDurationMs: 120000,
  maxAttempts: 2,
  watchdogIntervalMs: 30000,
});
const lineMessageBatchingService = new LineMessageBatchingService(
  {
    LINE_BATCH_ENABLED: config.LINE_BATCH_ENABLED,
    LINE_BATCH_WINDOW_MS: config.LINE_BATCH_WINDOW_MS,
    LINE_DM_GATEWAY_WEBHOOK_URL: config.LINE_DM_GATEWAY_WEBHOOK_URL,
  },
  agentSessionQueueService,
  agentSessionQueueWorker
);
registerLineWebhookRoutes(
  fastify,
  lineProjectOnboardingService,
  lineMessageBatchingService,
  agentSessionQueueService,
  agentSessionQueueWorker
);

// Flush any in-flight LINE message batches and gracefully stop worker before server closes
fastify.addHook("onClose", async () => {
  await lineMessageBatchingService.flushAll();
  await agentSessionQueueWorker.stop();
});


const start = async () => {
  try {
    await bootstrap();
    const port = config.PORT || 3000;
    await fastify.listen({ port, host: "0.0.0.0" });
    serverLogger.info(`[Server] AutomationX V2 Server running at http://localhost:${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

if (require.main === module) {
  start();
}

export { fastify, bootstrap, toolRegistry, orchestrator, dbAdapter, traceService };
