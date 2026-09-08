import * as fs from "fs";
import * as path from "path";
import { CacheService } from "../../cache/CacheService";
import { DatabaseAdapter } from "../types";
import {
  TicketInput,
  ExecutionResult,
  AuditLog,
  AuditLogSchema,
} from "../../schemas/validation";
import { SessionContext, CompanyContext } from "../../memory/types";
import {
  DbCompanySchema,
  DbIdentitySchema,
  DbProfileSchema,
  DbProjectSchema,
  DbConversationSchema,
  DbMessageSchema,
  DbTicketSchema,
} from "../../schemas/database.schema";
import { randomUUID } from "crypto";
import { TakeoverManager } from "../../human-takeover/TakeoverManager";

export class LocalDataAdapter implements DatabaseAdapter {
  private takeoverManager = new TakeoverManager();
  private getFilePath(tableName: string): string {
    const candidates = [
      path.resolve(__dirname, "../../../data"),
      path.resolve(process.cwd(), "data"),
      path.resolve(process.cwd(), "ticket_codebase/data"),
    ];

    let dataDir = candidates[0];
    for (const cand of candidates) {
      if (fs.existsSync(cand)) {
        const files = fs.readdirSync(cand);
        const hasData = files.some(
          (f) =>
            f.endsWith(".json") &&
            (f.includes("Tickets") || f.includes("Messages") || f.includes("Projects"))
        );
        if (hasData) {
          dataDir = cand;
          break;
        }
      }
    }

    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    const files = fs.readdirSync(dataDir);
    const match =
      files.find((f) => f.includes(`(${tableName})`) && f.endsWith(".json")) ||
      files.find((f) => f.includes(tableName) && f.endsWith(".json"));
    if (!match) {
      const defaultFilename = `Ticket V.2 - ${tableName} (${tableName}).json`;
      const filePath = path.join(dataDir, defaultFilename);
      fs.writeFileSync(filePath, "[]", "utf-8");
      return filePath;
    }
    return path.join(dataDir, match);
  }

  private readTable<T>(tableName: string, schema: any): T[] {
    const filePath = this.getFilePath(tableName);
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);

    return parsed.filter((row: any) => row.id1 !== null).map((row: any) => schema.parse(row)) as T[];
  }

  private writeTable<T>(tableName: string, data: T[]): void {
    const filePath = this.getFilePath(tableName);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  }

  async findProject(projectId: string): Promise<any> {
    const projects = this.readTable<any>("Projects", DbProjectSchema);
    return projects.find((p) => p.id1 === projectId);
  }

  async getConversation(conversationId: string): Promise<any> {
    const conversations = this.readTable<any>("Conversations", DbConversationSchema);
    return conversations.find((c) => c.id1 === conversationId);
  }

  async saveMessage(conversationId: string, role: string, content: string, externalId?: string, messageType?: string, replyToMessageId?: number, quoteToken?: string): Promise<any> {
    const messages = this.readTable<any>("Messages", DbMessageSchema);

    const maxId = messages.reduce((max, m) => {
      const id = parseInt(m.id1 || "0", 10);
      return id > max ? id : max;
    }, 0);

    const newMessage = {
      id1: String(maxId + 1),
      conversation_id: conversationId,
      role,
      content,
      created_at: new Date().toISOString(),
      conversation: conversationId,
    };

    messages.push(newMessage);
    this.writeTable("Messages", messages);
    return newMessage;
  }

  async getLatestTicketForConversation(conversationId: string): Promise<any> {
    const tickets = this.readTable<any>("Tickets", DbTicketSchema);
    return tickets.find((t) => String(t.conversation_id) === conversationId && t.status !== "Closed") || null;
  }

  async createTicket(input: TicketInput, slaDueDate: string, ticketNumber: string, tenantCtx?: any): Promise<ExecutionResult> {
    const executionId = randomUUID();
    const tickets = this.readTable<any>("Tickets", DbTicketSchema);

    const maxId = tickets.reduce((max, t) => {
      const id = parseInt(t.id1 || "0", 10);
      return id > max ? id : max;
    }, 0);

    const newTicket = {
      id1: String(maxId + 1),
      ticket_id: ticketNumber,
      conversation_id: input.conversationId,
      subject: input.subject,
      summary: input.summary,
      status: "open",
      priority: ["urgent", "high", "p1", "p2"].includes(String(input.priority || "").toLowerCase()) ? "urgent" : "normal",
      assigned_pm: "pm_lek",
      created_via: "ai",
      plane_issue_id: null,
      conversation: input.conversationId,
      severity: input.severity,
      due_date: slaDueDate,
    };

    tickets.push(newTicket);
    this.writeTable("Tickets", tickets);

    const ticketData = {
      ticketId: ticketNumber,
      conversationId: input.conversationId,
      subject: input.subject,
      summary: input.summary,
      severity: input.severity,
      priority: input.priority,
      projectId: input.projectId,
      status: "Open" as const,
      startDate: new Date().toISOString(),
      dueDate: slaDueDate,
      createdBy: "AI Support Agent",
    };

    return {
      success: true,
      data: ticketData,
      error: null,
      source: "local",
      executionId,
    };
  }

  async ensureConversation(senderId: string, companyId: string, channel: string): Promise<string> {
    const identities = this.readTable<any>("Identities", DbIdentitySchema);
    const conversations = this.readTable<any>("Conversations", DbConversationSchema);

    let identity = identities.find(
      (id) => id.channel_ref === senderId && id.channel?.toLowerCase() === channel.toLowerCase()
    );

    if (!identity) {
      const maxId = identities.reduce((max, id) => {
        const idVal = parseInt(id.id1 || "0", 10);
        return idVal > max ? idVal : max;
      }, 0);

      const profiles = this.readTable<any>("Profiles", DbProfileSchema);
      const profile = profiles.find((p) => p.company === companyId) || profiles[0];

      identity = {
        id1: String(maxId + 1),
        profile_id: profile.id1,
        channel: channel.toLowerCase(),
        channel_ref: senderId,
        profile: profile.id1,
        Conversations: "",
      };

      identities.push(identity);
      this.writeTable("Identities", identities);
    }

    let conversation = conversations.find((c) => c.identity_id === identity!.id1 && c.status === "open");

    if (!conversation) {
      const maxId = conversations.reduce((max, c) => {
        const idVal = parseInt(c.id1 || "0", 10);
        return idVal > max ? idVal : max;
      }, 0);

      const projects = this.readTable<any>("Projects", DbProjectSchema);
      const project = projects.find((p) => p.company_id === companyId) || projects[0];

      conversation = {
        id1: String(maxId + 1),
        identity_id: identity.id1,
        project_id: project.id1,
        channel: channel.toLowerCase(),
        status: "open",
        handled_by: "ai",
        assigned_pm: null,
        updated_at: new Date().toISOString(),
        identity: identity.id1,
        project: project.id1,
        Messages: "",
        Tickets: "",
      };

      conversations.push(conversation);
      this.writeTable("Conversations", conversations);
    }

    return conversation.id1!;
  }

  async loadSessionContext(senderId: string, channel: string): Promise<SessionContext> {
    const identities = this.readTable<any>("Identities", DbIdentitySchema);
    const profiles = this.readTable<any>("Profiles", DbProfileSchema);
    const companies = this.readTable<any>("Companies", DbCompanySchema);
    const projects = this.readTable<any>("Projects", DbProjectSchema);

    let identity = identities.find(
      (id) => id.channel_ref === senderId && id.channel?.toLowerCase() === channel.toLowerCase()
    );

    if (!identity) {
      const conversationId = await this.ensureConversation(senderId, "1", channel);
      identity = identities.find((id) => id.id1 === conversationId);
      if (!identity) {
        identity = identities[0];
      }
    }

    const profile = profiles.find((p) => p.id1 === identity!.profile_id) || profiles[0];

    const company = companies.find((c) => c.id1 === profile.company) || companies[0];
    const companyId = company.id1!;

    const cacheKey = `tenant:${companyId}:config`;
    let companyContext = await CacheService.getInstance().get<CompanyContext>(cacheKey);

    if (!companyContext) {
      const companyProjects = projects
        .filter((p) => p.company_id === companyId)
        .map((p) => ({
          projectId: p.id1!,
          projectName: p.name!,
          projectType: p.Companies || "Support",
        }));

      const slaConfig = companyProjects
        .map((p) => [
          { projectId: p.projectId, severity: "Critical", responseTimeHours: 1, resolveTimeHours: 4 },
          { projectId: p.projectId, severity: "High", responseTimeHours: 4, resolveTimeHours: 12 },
          { projectId: p.projectId, severity: "Medium", responseTimeHours: 24, resolveTimeHours: 48 },
          { projectId: p.projectId, severity: "Low", responseTimeHours: 72, resolveTimeHours: 120 },
        ])
        .flat();

      companyContext = {
        companyId,
        companyName: company.name || "Default Company",
        status: "Active" as const,
        aiPromptTemplate: `คุณคือ Support Agent AI สำหรับช่วยเหลือผู้ใช้ระบบ IT ของบริษัท ${company.name}`,
        projects: companyProjects,
        slaConfig,
      };
      await CacheService.getInstance().set(cacheKey, companyContext, 300);
    }

    const conversationId = await this.ensureConversation(senderId, companyId, channel);
    const conversation = await this.getConversation(conversationId);

    return {
      sessionId: `sess_${conversationId}`,
      companyId,
      conversationId,
      customerRef: senderId,
      companyContext,
      status: conversation.status || "open",
      handledBy: conversation.handled_by || "ai",
    };
  }

  async getConversationHistory(conversationId: string, limit: number = 10): Promise<any[]> {
    const messages = this.readTable<any>("Messages", DbMessageSchema);
    const filtered = messages
      .filter((m) => m.conversation_id === conversationId)
      .map((m) => ({
        role: m.role as "customer" | "ai" | "system",
        content: m.content || "",
        timestamp: m.created_at || new Date().toISOString(),
      }));
    return filtered.slice(-limit);
  }

  async updateHandoffState(conversationId: string, handledBy: "ai" | "human"): Promise<void> {
    const conversations = this.readTable<any>("Conversations", DbConversationSchema);
    const conv = conversations.find((c) => c.id1 === conversationId);
    if (conv) {
      conv.handled_by = handledBy;
      conv.status = handledBy === "human" ? "escalated" : "open";
      this.writeTable("Conversations", conversations);
    }
  }

  async searchKnowledge(query: string, filters?: { projectId?: string; orgId?: string }, tenantCtx?: any): Promise<any[]> {
    const lowerQuery = query.toLowerCase();
    const queryWords = lowerQuery.split(/\s+/).filter((w) => w.length > 2);
    const matches: any[] = [];

    // 1. Search Messages (resolved answers by AI or human)
    try {
      const messages = this.readTable<any>("Messages", DbMessageSchema);
      const conversations = this.readTable<any>("Conversations", DbConversationSchema);

      messages.forEach((m) => {
        const content = m.content || "";
        const lowerContent = content.toLowerCase();

        // Scope to tenant and project
        const conv = conversations.find((c) => String(c.id1 || c.id) === String(m.conversation_id));
        if (filters?.projectId && conv && String(conv.project_id) !== String(filters.projectId)) {
          return;
        }
        if (filters?.orgId && filters.orgId !== "org_all" && conv && conv.org_id && conv.org_id !== filters.orgId) {
          return;
        }

        // Calculate simple keyword overlap
        let overlapCount = 0;
        if (queryWords.length > 0) {
          queryWords.forEach((word) => {
            if (lowerContent.includes(word)) overlapCount++;
          });
        } else if (lowerContent.includes(lowerQuery)) {
          overlapCount = 1;
        }

        if (overlapCount > 0) {
          const score = queryWords.length > 0 ? overlapCount / queryWords.length : 0.5;
          matches.push({
            id: m.id1 || "msg-unknown",
            type: "message",
            content,
            score,
            metadata: {
              conversationId: m.conversation_id,
              role: m.role,
            },
          });
        }
      });
    } catch (e) {
      console.warn("[LocalDataAdapter] Failed reading Messages during search:", e);
    }

    // 2. Search Tickets (historical issues and descriptions)
    try {
      const tickets = this.readTable<any>("Tickets", DbTicketSchema);
      const conversations = this.readTable<any>("Conversations", DbConversationSchema);
      tickets.forEach((t) => {
        const subject = t.subject || "";
        const summary = t.summary || "";
        const textToSearch = `${subject} ${summary}`.toLowerCase();

        const conv = conversations.find((c) => String(c.id1 || c.id) === String(t.conversation_id));
        if (filters?.projectId) {
          if (conv && String(conv.project_id) !== String(filters.projectId)) return;
          if (!conv && t.project_id && String(t.project_id) !== String(filters.projectId)) return;
        }
        if (filters?.orgId && filters.orgId !== "org_all" && conv && conv.org_id && conv.org_id !== filters.orgId) {
          return;
        }

        let overlapCount = 0;
        if (queryWords.length > 0) {
          queryWords.forEach((word) => {
            if (textToSearch.includes(word)) overlapCount++;
          });
        } else if (textToSearch.includes(lowerQuery)) {
          overlapCount = 1;
        }

        if (overlapCount > 0) {
          const score = queryWords.length > 0 ? overlapCount / queryWords.length : 0.5;
          matches.push({
            id: t.id1 || "tck-unknown",
            type: "ticket",
            content: `Subject: ${subject}\nSummary: ${summary}`,
            score,
            metadata: {
              status: t.status,
              priority: t.priority,
              plane_issue_id: t.plane_issue_id,
            },
          });
        }
      });
    } catch (e) {
      console.warn("[LocalDataAdapter] Failed reading Tickets during search:", e);
    }

    // Sort by score descending
    return matches.sort((a, b) => b.score - a.score);
  }

  async saveTrace(trace: AuditLog): Promise<void> {
    const traces = this.readTable<AuditLog>("Traces", AuditLogSchema);
    const index = traces.findIndex((t) => t.traceId === trace.traceId);
    if (index !== -1) {
      traces[index] = trace;
    } else {
      traces.push(trace);
    }
    this.writeTable("Traces", traces);
  }

  async getTrace(traceId: string): Promise<AuditLog | null> {
    const traces = this.readTable<AuditLog>("Traces", AuditLogSchema);
    return traces.find((t) => t.traceId === traceId) || null;
  }

  async listTraces(sessionId: string): Promise<AuditLog[]> {
    const traces = this.readTable<AuditLog>("Traces", AuditLogSchema);
    return traces.filter((t) => t.sessionId === sessionId);
  }

  async listAllTraces(): Promise<AuditLog[]> {
    return this.readTable<AuditLog>("Traces", AuditLogSchema);
  }

  async listAllTickets(conversationId?: string, projectId?: string, profileId?: string, identityId?: string, tenantCtx?: any): Promise<any[]> {
    try {
      let tickets = this.readTable<any>("Tickets", DbTicketSchema);
      if (conversationId) {
        tickets = tickets.filter((t) => String(t.conversation_id) === String(conversationId));
      }
      if (projectId && projectId.toLowerCase() !== 'all') {
        tickets = tickets.filter((t) => String(t.project_id || 1) === String(projectId));
      }
      if (identityId) {
        const conversations = this.readTable<any>("Conversations", DbConversationSchema);
        const matchingConvIds = conversations.filter(c => String(c.identity_id) === String(identityId)).map(c => String(c.id));
        tickets = tickets.filter(t => matchingConvIds.includes(String(t.conversation_id)));
      }
      if (profileId) {
        const identities = this.readTable<any>("Identities", DbIdentitySchema);
        const matchingIdentIds = identities.filter(i => String(i.profile_id) === String(profileId)).map(i => String(i.id));
        const conversations = this.readTable<any>("Conversations", DbConversationSchema);
        const matchingConvIds = conversations.filter(c => matchingIdentIds.includes(String(c.identity_id))).map(c => String(c.id));
        tickets = tickets.filter(t => matchingConvIds.includes(String(t.conversation_id)));
      }
      return tickets;
    } catch {
      return [];
    }
  }

  async listAllConversations(projectId?: string, tenantCtx?: any): Promise<any[]> {
    let conversations = this.readTable<any>("Conversations", DbConversationSchema);
    if (projectId && projectId.toLowerCase() !== 'all') {
      conversations = conversations.filter((c) => String(c.project_id || 1) === String(projectId));
    }
    const identities = this.readTable<any>("Identities", DbIdentitySchema);
    const messages = this.readTable<any>("Messages", DbMessageSchema);
    const profiles = this.readTable<any>("Profiles", DbProfileSchema);
    const companies = this.readTable<any>("Companies", DbCompanySchema);
    const tickets = this.readTable<any>("Tickets", DbTicketSchema);

    return Promise.all(conversations.map(async (c) => {
      const ident = identities.find((i) => String(i.id1) === String(c.identity_id));
      const convMsgs = messages.filter((m) => String(m.conversation_id) === String(c.id1));
      const lastMsg = convMsgs.sort(
        (a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
      )[0];

      const cid = String(c.id1);
      const takeover = await this.takeoverManager.getTakeoverState(cid);
      if (String(c.handled_by || "ai") === "human" && takeover.status === "ACTIVE_AI") {
        await this.updateHandoffState(cid, "ai");
        c.handled_by = "ai";
      }

      let profileName = "Nattapong";
      let avatarUrl: string | null = null;
      let profileId = "unknown";
      let profileEmail: string | null = null;
      let profilePhone: string | null = null;
      let companyName = "Orbit Retail";

      if (ident) {
        const profile = profiles.find((p) => String(p.id1) === String(ident.profile_id));
        if (profile) {
          profileName = profile.display_name || profile.name || "Nattapong";
          avatarUrl = profile.avatar_url || null;
          profileId = String(profile.id1 || profile.Id || "unknown");
          profileEmail = profile.email || null;
          profilePhone = profile.phone || null;

          const company = companies.find((co) => String(co.id1) === String(profile.company));
          if (company) {
            companyName = company.name || "Orbit Retail";
          }
        }
      }

      const convTickets = tickets.filter((t) => String(t.conversation_id) === cid);
      const highestSeverity = convTickets.reduce((max: string, t: any) => {
        const sev = t.severity || 'Low';
        const priorityMap: Record<string, number> = { 'Critical': 4, 'High': 3, 'Medium': 2, 'Low': 1 };
        if ((priorityMap[sev] || 0) > (priorityMap[max] || 0)) {
          return sev;
        }
        return max;
      }, 'Low');

      const ticketIds = convTickets.map((t: any) => String(t.ticket_id || t.Id || '')).join(' ');
      const messageContents = convMsgs.map((m: any) => String(m.content || '')).join(' ');

      return {
        id: cid,
        id1: cid,
        customer: ident ? String(ident.channel_ref) : "unknown",
        channel: String(c.channel),
        status: String(c.status),
        last_message: lastMsg ? String(lastMsg.content || "") : "",
        last_message_timestamp: lastMsg ? lastMsg.created_at : null,
        last_message_role: lastMsg ? lastMsg.role : null,
        max_ticket_severity: highestSeverity,
        company_name: companyName,
        ticket_ids: ticketIds,
        message_contents: messageContents,
        handled_by: String(c.handled_by || "ai"),
        takeover_status: takeover?.status || "ACTIVE_AI",
        assigned_pm: takeover?.assignedHumanAgentId || null,
        human_session_started_at: takeover?.human_session_started_at || null,
        human_session_expire_at: takeover?.human_session_expire_at || null,
        last_human_reply_at: takeover?.last_human_reply_at || null,
        profile_id: profileId,
        profile_name: profileName,
        avatar_url: avatarUrl,
        profile_email: profileEmail,
        profile_phone: profilePhone,
      };
    }));
  }

  /**
   * Bounded duplicate check, matching PostgresAdapter.hasRecentMessage.
   * Fails open for the same reason: duplicating a message beats losing one.
   */
  async hasRecentMessage(conversationId: string, role: string, content: string, limit: number = 5): Promise<boolean> {
    try {
      const recent = (await this.getMessages(conversationId)).slice(-limit);
      return recent.some((m: any) => m.content === content && m.role === role);
    } catch {
      return false;
    }
  }

  async getMessages(conversationId: string): Promise<any[]> {
    const messages = this.readTable<any>("Messages", DbMessageSchema);
    return messages
      .filter((m) => String(m.conversation_id) === String(conversationId))
      .sort((a, b) => new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime())
      .map((m) => ({
        role: m.role,
        content: m.content,
        timestamp: m.created_at,
      }));
  }

  async getConversationIdent(conversationId: string): Promise<any> {
    const conversations = this.readTable<any>("Conversations", DbConversationSchema);
    const identities = this.readTable<any>("Identities", DbIdentitySchema);
    const localConv = conversations.find((c) => String(c.id1) === String(conversationId));
    const ident = localConv ? identities.find((i) => String(i.id1) === String(localConv.identity_id)) : null;
    if (ident) {
      return {
        channel: ident.channel,
        channel_ref: ident.channel_ref,
      };
    }
    return null;
  }

  async updateTicketPlaneIssue(ticketId: string, planeIssueId: string): Promise<void> {
    const tickets = this.readTable<any>("Tickets", DbTicketSchema);
    const idx = tickets.findIndex((t) => String(t.id1) === String(ticketId));
    if (idx !== -1) {
      tickets[idx].plane_issue_id = planeIssueId;
      tickets[idx].status = "In Progress";
      this.writeTable("Tickets", tickets);
    }
  }

  async updateTicketPlaneSnapshot(
    ticketId: string,
    workspaceSlug: string,
    planeProjectId: string,
    planeIssueId: string
  ): Promise<void> {
    const tickets = this.readTable<any>("Tickets", DbTicketSchema);
    const idx = tickets.findIndex((t) => String(t.id1) === String(ticketId) || String(t.ticket_number) === String(ticketId));
    if (idx !== -1) {
      tickets[idx].plane_workspace_slug = workspaceSlug;
      tickets[idx].plane_project_id = planeProjectId;
      tickets[idx].plane_issue_id = planeIssueId;
      tickets[idx].status = "In Progress";
      this.writeTable("Tickets", tickets);
    }
  }

  async syncTicketFromPlane(
    planeIssueId: string,
    changes: { status?: string; priority?: string }
  ): Promise<import("../types").PlaneTicketSyncResult> {
    const tickets = this.readTable<any>("Tickets", DbTicketSchema);
    const idx = tickets.findIndex((ticket) => String(ticket.plane_issue_id) === String(planeIssueId));
    if (idx === -1) return { matched: false, statusChanged: false };

    const previousStatus = tickets[idx].status;
    if (changes.status) tickets[idx].status = changes.status;
    if (changes.priority) tickets[idx].priority = changes.priority;
    this.writeTable("Tickets", tickets);
    return {
      matched: true,
      statusChanged: Boolean(
        changes.status &&
        String(previousStatus || "").trim().toLowerCase() !== String(tickets[idx].status || "").trim().toLowerCase()
      ),
      previousStatus,
      currentStatus: tickets[idx].status,
    };
  }

  async getTicketCompanyContext(ticketId: string): Promise<{ ticket: any; companyName: string }> {
    const tickets = this.readTable<any>("Tickets", DbTicketSchema);
    const ticket = tickets.find((t) => String(t.id1) === String(ticketId));
    let companyName = "Unknown";

    if (ticket) {
      const conversations = this.readTable<any>("Conversations", DbConversationSchema);
      const identities = this.readTable<any>("Identities", DbIdentitySchema);
      const profiles = this.readTable<any>("Profiles", DbProfileSchema);
      const companies = this.readTable<any>("Companies", DbCompanySchema);

      const conv = conversations.find((c) => String(c.id1) === String(ticket.conversation_id));
      const ident = conv ? identities.find((i) => String(i.id1) === String(conv.identity_id)) : null;
      const profile = ident ? profiles.find((p) => String(p.id1) === String(ident.profile_id)) : null;
      const company = profile ? companies.find((c) => String(c.id1) === String(profile.company)) : null;
      if (company) {
        companyName = company.name || "Unknown";
      }
    }

    return { ticket, companyName };
  }
}

