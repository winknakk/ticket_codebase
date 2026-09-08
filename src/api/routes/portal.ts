import { FastifyInstance } from "fastify";
import { DatabaseAdapter } from "../../adapters/types";
import { SLAMatrixService } from "../../services/SLAMatrixService";
import { EmailNotificationService } from "../../services/EmailNotificationService";
import { customerAuthHook } from "../../middleware/customerAuth";
import { pool } from "../../adapters/postgres/PostgresAdapter";
import { TicketStateMachine } from "../../domain/ticket/TicketStateMachine";
import { isLifecycleStatus, TicketLifecycleStatus } from "../../domain/ticket/TicketLifecycle";
import { z } from "zod";

const CreatePortalTicketSchema = z.object({
  customerId: z.string().optional(),
  projectId: z.string().optional(),
  subject: z.string().min(1),
  summary: z.string().min(1),
  priority: z.enum(["Urgent", "High", "Medium", "Low", "None", "P1", "P2", "P3", "P4", "P5"]).default("Medium"),
  severity: z.enum(["Critical", "High", "Medium", "Low"]).default("Medium"),
});

const TransitionPortalTicketSchema = z.object({
  targetStatus: z.string().min(1),
  reason: z.string().optional(),
});

export function registerPortalRoutes(
  fastify: FastifyInstance,
  deps: { dbAdapter: DatabaseAdapter; slaService: SLAMatrixService; emailService?: EmailNotificationService }
) {
  const stateMachine = new TicketStateMachine();

  // 1. Create ticket from Portal
  fastify.post("/api/portal/tickets", { preHandler: [customerAuthHook] }, async (request, reply) => {
    const p = request.principal;
    if (!p || p.kind !== "customer" || !p.profileId || !p.projectIds || p.projectIds.length === 0) {
      return reply.code(403).send({ error: "Forbidden", message: "Customer authentication required" });
    }

    const tenantCtx = request.tenantContext;
    const body = CreatePortalTicketSchema.parse(request.body);

    // Overwrite client-supplied customerId, projectId and orgId with authoritative principal values
    const authoritativeCustomerId = p.subject;
    const authoritativeProjectId = String(p.projectIds[0]);
    const authoritativeOrgId = p.orgId || tenantCtx.orgId;

    // Resolve authoritative numeric companyId from project for conversation creation
    let authoritativeCompanyId = "1";
    try {
      const projRes = await pool.query("SELECT company_id FROM projects WHERE id = $1 LIMIT 1", [parseInt(authoritativeProjectId, 10)]);
      if (projRes.rows.length > 0 && projRes.rows[0].company_id) {
        authoritativeCompanyId = String(projRes.rows[0].company_id);
      }
    } catch {}

    let convId: string;
    const identityIdNum = parseInt(authoritativeCustomerId, 10);
    const openConvRes = await pool.query(
      `SELECT id FROM conversations WHERE identity_id = $1 AND (project_id = $2 OR project_id IS NULL) ORDER BY created_at DESC LIMIT 1`,
      [identityIdNum, parseInt(authoritativeProjectId, 10)]
    );

    if (openConvRes.rows.length > 0) {
      convId = String(openConvRes.rows[0].id);
    } else {
      const identRes = await pool.query("SELECT channel_ref, channel FROM identities WHERE id = $1 LIMIT 1", [identityIdNum]);
      const channelRef = identRes.rows[0]?.channel_ref || authoritativeCustomerId;
      const channel = identRes.rows[0]?.channel || "WebChat";
      convId = await deps.dbAdapter.ensureConversation(channelRef, authoritativeCompanyId, channel);
    }

    const slaInfo = await deps.slaService.calculateSLADueDate(authoritativeProjectId, body.priority);

    const randomSuffix = Math.floor(10000 + Math.random() * 90000);
    const ticketNumber = `TCK-${new Date().getFullYear()}-${randomSuffix}`;

    const result = await deps.dbAdapter.createTicket(
      {
        conversationId: convId,
        projectId: authoritativeProjectId,
        subject: body.subject,
        summary: body.summary,
        priority: body.priority,
        severity: body.severity,
      },
      slaInfo.dueDate,
      ticketNumber,
      tenantCtx
    );

    // Server-resolved email from profile rather than hardcoded recipient
    if (deps.emailService && p.profileId) {
      try {
        const profRes = await pool.query("SELECT email FROM profiles WHERE id = $1 LIMIT 1", [parseInt(p.profileId, 10)]);
        const recipientEmail = profRes.rows[0]?.email;
        if (recipientEmail) {
          await deps.emailService.notifyTicketCreated(recipientEmail, ticketNumber, body.subject, tenantCtx).catch(() => undefined);
        }
      } catch {}
    }

    return reply.code(201).send({
      success: true,
      ticketNumber,
      dueDate: slaInfo.dueDate,
      result,
    });
  });

  // 2. List tickets for Customer Portal (Strictly scoped by customer profile and project)
  fastify.get("/api/portal/tickets", { preHandler: [customerAuthHook] }, async (request, reply) => {
    const p = request.principal;
    if (!p || p.kind !== "customer" || !p.profileId || !p.projectIds || p.projectIds.length === 0) {
      return reply.code(403).send({ error: "Forbidden", message: "Customer authentication required" });
    }

    const tenantCtx = request.tenantContext;
    const projectId = String(p.projectIds[0]);
    const profileId = p.profileId;

    const tickets = await deps.dbAdapter.listAllTickets(undefined, projectId, profileId, undefined, tenantCtx);
    return reply.code(200).send({
      success: true,
      tenantOrgId: tenantCtx.orgId,
      tickets,
    });
  });

  // 3. Get single ticket detail for Portal (Scoped lookup first)
  fastify.get("/api/portal/tickets/:id", { preHandler: [customerAuthHook] }, async (request, reply) => {
    const p = request.principal;
    if (!p || p.kind !== "customer" || !p.profileId || !p.projectIds || p.projectIds.length === 0) {
      return reply.code(403).send({ error: "Forbidden", message: "Customer authentication required" });
    }

    const tenantCtx = request.tenantContext;
    const projectId = String(p.projectIds[0]);
    const profileId = p.profileId;
    const params = request.params as any;
    const ticketIdStr = String(params.id);

    // Query customer's own tickets first
    const tickets = await deps.dbAdapter.listAllTickets(undefined, projectId, profileId, undefined, tenantCtx);
    const match = tickets.find((t: any) => String(t.id) === ticketIdStr || t.ticket_number === ticketIdStr || t.ticket_id === ticketIdStr);

    if (!match) {
      // Indistinguishable from nonexistent ID
      return reply.code(404).send({ error: "Ticket not found" });
    }

    const breachStatus = await deps.slaService.checkSLABreachStatus(match);

    return reply.code(200).send({
      success: true,
      ticket: match,
      slaStatus: breachStatus,
    });
  });

  // 4. Customer Ticket Lifecycle Transition (Confirm resolution or Reopen)
  fastify.post("/api/portal/tickets/:id/transition", { preHandler: [customerAuthHook] }, async (request, reply) => {
    const p = request.principal;
    if (!p || p.kind !== "customer" || !p.profileId || !p.projectIds || p.projectIds.length === 0) {
      return reply.code(403).send({ error: "Forbidden", message: "Customer authentication required" });
    }

    const tenantCtx = request.tenantContext;
    const projectId = String(p.projectIds[0]);
    const profileId = p.profileId;
    const params = request.params as any;
    const ticketIdStr = String(params.id);

    const body = TransitionPortalTicketSchema.parse(request.body);
    if (!isLifecycleStatus(body.targetStatus)) {
      return reply.code(400).send({ error: "Bad Request", code: "UNKNOWN_STATUS", message: `Unknown target status '${body.targetStatus}'` });
    }

    // Verify ticket ownership first
    const tickets = await deps.dbAdapter.listAllTickets(undefined, projectId, profileId, undefined, tenantCtx);
    const match = tickets.find((t: any) => String(t.id) === ticketIdStr || t.ticket_number === ticketIdStr || t.ticket_id === ticketIdStr);

    if (!match) {
      return reply.code(404).send({ error: "Ticket not found" });
    }

    // Execute state machine transition as actor "customer"
    const result = await stateMachine.transition({
      ticketRef: match.id,
      to: body.targetStatus as TicketLifecycleStatus,
      actor: "customer",
      actorRef: p.subject,
      reason: body.reason || "Customer portal transition",
    });

    if (!result.applied) {
      return reply.code(400).send({
        error: "Bad Request",
        code: result.code || "TRANSITION_REFUSED",
        message: result.reason || "Transition not permitted",
      });
    }

    return reply.code(200).send({
      success: true,
      ticketId: match.id,
      ticketNumber: match.ticket_number,
      from: result.from,
      to: result.to,
    });
  });

  // 5. Customer Profile Context
  fastify.get("/api/portal/profile", { preHandler: [customerAuthHook] }, async (request, reply) => {
    const p = request.principal;
    if (!p || p.kind !== "customer" || !p.profileId) {
      return reply.code(403).send({ error: "Forbidden", message: "Customer authentication required" });
    }

    try {
      const profRes = await pool.query(
        `SELECT p.id, p.name, p.email, p.phone, p.company_id, c.name as company_name
         FROM profiles p
         LEFT JOIN companies c ON c.id = p.company_id
         WHERE p.id = $1 LIMIT 1`,
        [parseInt(p.profileId, 10)]
      );

      if (profRes.rows.length === 0) {
        return reply.code(200).send({
          success: true,
          profile: {
            id: p.profileId,
            name: "Customer",
            role: "customer",
          }
        });
      }

      const row = profRes.rows[0];
      return reply.code(200).send({
        success: true,
        profile: {
          id: String(row.id),
          name: row.name || "Customer",
          email: row.email,
          phone: row.phone,
          companyName: row.company_name || undefined,
          role: "customer",
        }
      });
    } catch (err: any) {
      return reply.code(500).send({ error: "Internal Server Error", message: err.message });
    }
  });
}
