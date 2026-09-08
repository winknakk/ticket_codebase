import fs from "node:fs";
import path from "node:path";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../../config/env";
import { createLogger } from "../../observability/logger";
import { SLACadenceService } from "../../services/SLACadenceService";

const logger = createLogger("sla-console");

/**
 * SLA Cadence Console — a standalone operator page plus its admin API.
 *
 * The page is served under /api/v1/media/ (a public prefix, exactly like the
 * LINE card images) and carries no data itself; every data call goes to
 * /api/v1/admin/sla/*, which the global authHook protects with the Bearer
 * API key the page asks for once. Write endpoints additionally require
 * `confirm: true` and SLA_CONSOLE_ALLOW_WRITES (denied in production unless
 * explicitly enabled).
 */
function consolePagePath(): string {
  return path.resolve(__dirname, "../../../assets/sla-console/index.html");
}

async function requireConfiguredAdminApiKey(_request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!config.API_KEY) {
    await reply.code(503).send({ error: "SLA console API is disabled until API_KEY is configured" });
  }
}

const adminRouteOptions = { preHandler: requireConfiguredAdminApiKey };

function writesGuard(body: any, reply: FastifyReply): boolean {
  if (!SLACadenceService.consoleWritesAllowed()) {
    void reply.code(403).send({ success: false, error: "Console writes are disabled (SLA_CONSOLE_ALLOW_WRITES / production)" });
    return false;
  }
  if (body?.confirm !== true) {
    void reply.code(400).send({ success: false, error: "confirm: true is required for write actions" });
    return false;
  }
  return true;
}

export function registerSlaConsoleRoutes(fastify: FastifyInstance, cadence: SLACadenceService): void {
  // --- the page (public prefix; no data inside) ---
  fastify.get("/api/v1/media/sla-console", async (_request, reply) => {
    try {
      const html = await fs.promises.readFile(consolePagePath(), "utf8");
      return reply.header("Content-Type", "text/html; charset=utf-8").header("Cache-Control", "no-store").send(html);
    } catch (err: any) {
      logger.error({ error: err.message }, "SLA console page missing");
      return reply.code(404).send("SLA console page not found");
    }
  });

  // --- reads ---
  fastify.get("/api/v1/admin/sla/engine", adminRouteOptions, async (_request, reply) => {
    return reply.send({ success: true, data: cadence.getEngineState() });
  });

  fastify.get("/api/v1/admin/sla/recent", adminRouteOptions, async (request, reply) => {
    const limit = Number((request.query as any)?.limit || 20);
    return reply.send({ success: true, data: await cadence.listRecentTickets(limit) });
  });

  /** Filtered picker / overview board. */
  fastify.get("/api/v1/admin/sla/tickets", adminRouteOptions, async (request, reply) => {
    const q = (request.query || {}) as any;
    const data = await cadence.listTickets({
      scope: ["cadence", "open", "closed", "all"].includes(String(q.scope)) ? q.scope : "cadence",
      priority: q.priority ? String(q.priority) : undefined,
      channel: q.channel ? String(q.channel).toLowerCase() : undefined,
      projectId: q.projectId ? Number(q.projectId) : undefined,
      q: q.q ? String(q.q) : undefined,
      sort: ["recent", "next", "due"].includes(String(q.sort)) ? q.sort : "recent",
      limit: q.limit ? Number(q.limit) : undefined,
    });
    return reply.send({ success: true, data });
  });

  fastify.get("/api/v1/admin/sla/projects", adminRouteOptions, async (_request, reply) => {
    return reply.send({ success: true, data: await cadence.listProjects() });
  });

  fastify.get("/api/v1/admin/sla/tickets/:ref", adminRouteOptions, async (request, reply) => {
    const ref = String((request.params as any).ref || "");
    const data = await cadence.inspectTicket(ref);
    if (!data) return reply.code(404).send({ success: false, error: "Ticket not found" });
    return reply.send({ success: true, data });
  });

  // --- writes ---
  fastify.post("/api/v1/admin/sla/run", adminRouteOptions, async (request, reply) => {
    const body = (request.body || {}) as any;
    const dryRun = body.dryRun === true;
    if (!dryRun && !writesGuard(body, reply)) return;
    try {
      const result = await cadence.runNow({ dryRun });
      return reply.send({ success: true, data: { ...result, dryRun } });
    } catch (err: any) {
      // Surface the real cause (e.g. a database constraint) instead of a bare
      // 500 — the console shows this text to the operator.
      logger.error({ error: err.message, dryRun }, "SLA console run failed");
      return reply.code(500).send({ success: false, error: `Cadence run failed: ${err.message}` });
    }
  });

  fastify.post("/api/v1/admin/sla/tickets/:ref/shift-clock", adminRouteOptions, async (request, reply) => {
    const body = (request.body || {}) as any;
    if (!writesGuard(body, reply)) return;
    const result = await cadence.shiftTicketClock(String((request.params as any).ref || ""), Number(body.minutes ?? 61));
    return reply.code(result.ok ? 200 : 400).send({ success: result.ok, data: result });
  });

  fastify.post("/api/v1/admin/sla/tickets/:ref/force", adminRouteOptions, async (request, reply) => {
    const body = (request.body || {}) as any;
    if (!writesGuard(body, reply)) return;
    const kind = body.kind === "user" ? "user" : "dev";
    const result = await cadence.forceTestSend(String((request.params as any).ref || ""), kind);
    return reply.code(result.ok ? 200 : 400).send({ success: result.ok, data: result });
  });

  fastify.post("/api/v1/admin/sla/tickets/:ref/close", adminRouteOptions, async (request, reply) => {
    const body = (request.body || {}) as any;
    if (!writesGuard(body, reply)) return;
    const mode = body.mode === "closed" ? "closed" : "cancelled";
    const result = await cadence.closeTicket(String((request.params as any).ref || ""), mode, body.reason);
    return reply.code(result.ok ? 200 : 400).send({ success: result.ok, data: result });
  });

  fastify.post("/api/v1/admin/sla/tickets/:ref/reset", adminRouteOptions, async (request, reply) => {
    const body = (request.body || {}) as any;
    if (!writesGuard(body, reply)) return;
    const result = await cadence.resetTicketTestData(String((request.params as any).ref || ""));
    return reply.code(result.ok ? 200 : 400).send({ success: result.ok, data: result });
  });
}
