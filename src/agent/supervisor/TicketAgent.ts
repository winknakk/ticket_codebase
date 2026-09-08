import { AgentResult, IAgent } from "./types";
import { InboundMessage } from "../../schemas/validation";
import { IMcpToolRouter } from "../AgentRuntime";
import { createLogger } from "../../observability/logger";
import { startTimer } from "../../observability/timing";
import { MetricsService } from "../../observability/MetricsService";
import { getProjectId } from "../../kernel/context/RequestContextHolder";
import { DiagnosticAnalyzer } from "../diagnostic/DiagnosticAnalyzer";
import { TransactionManager } from "../../shared/repositories/TransactionManager";
import { PostgresTicketRepository } from "../../infrastructure/db/PostgresTicketRepository";

const logger = createLogger("TicketAgent");

type TicketIntent = "create" | "status" | "find" | "close" | "merge" | "assign" | "update_summary";

type RememberedTicket = {
  id?: string;
  ticketId: string;
  subject?: string;
  summary?: string;
  runningSummary?: string;
  status?: string;
};

type TicketResolution =
  | { kind: "resolved"; ticket: RememberedTicket; confidence: number }
  | { kind: "ambiguous"; tickets: RememberedTicket[] }
  | { kind: "none" };

const CLOSED_STATUSES = new Set(["closed", "done", "cancelled", "canceled", "merged", "resolved"]);
const LOW_SIGNAL_REFERENCES = [
  "เลขอะไรนะ",
  "ปิดอันนี้",
  "ปิดเลย",
  "อันนี้",
  "อันเมื่อกี้",
  "เมื่อกี้",
  "เรื่องเดิม",
  "เปิดใหม่",
  "รวมสองใบ",
  "อัปเดตอันเดิม",
  "อัพเดตอันเดิม",
  "update this",
  "same one",
  "previous one",
  "this one",
];

export class TicketAgent implements IAgent {
  readonly id = "ticket";
  readonly name = "Ticket Agent";
  private mcpToolRouter: IMcpToolRouter;
  private lastCreatedTicket: RememberedTicket | null = null;
  private lastReferencedTicket: RememberedTicket | null = null;

  constructor(mcpToolRouter: IMcpToolRouter) {
    this.mcpToolRouter = mcpToolRouter;
  }

  async handle(message: InboundMessage, sessionContext: any): Promise<AgentResult> {
    MetricsService.getInstance().recordAgentCall("ticket");

    const reqId = sessionContext.requestId;
    const conversationId = sessionContext.conversationId;

    this.rememberFromHistory(sessionContext.history || []);

    logger.info({ requestId: reqId, conversationId, component: "TicketAgent" }, "Ticket Agent handling message");

    const projectId = getProjectId() || sessionContext.projectId || "1";

    const intent = this.classifyTicketIntent(message.text);

    logger.info(
      { requestId: reqId, conversationId, intent, component: "TicketAgent" },
      `Ticket Agent intent classified: "${intent}"`
    );

    switch (intent) {
      case "status":
        return this.handleStatusCheck(message, sessionContext, projectId);
      case "find":
        return this.handleFindTickets(message, sessionContext, projectId);
      case "close":
        return this.handleCloseTicket(message, sessionContext, projectId);
      case "merge":
        return this.handleMergeTicket(message, sessionContext, projectId);
      case "assign":
        return this.handleAssignTicket(message, sessionContext, projectId);
      case "update_summary":
        return this.handleUpdateSummary(message, sessionContext, projectId);
      case "create":
      default:
        return this.handleCreateTicket(message, sessionContext, projectId);
    }
  }

  private classifyTicketIntent(text: string): TicketIntent {
    const lower = text.toLowerCase();
    const hasTicketId = /TCK-\d{4}-\d+/i.test(text);

    if (lower.includes("เปิดใหม่") || lower.includes("เปิดเรื่อง") || lower.includes("สร้าง") || lower.includes("open ticket")) {
      return "create";
    }

    if (
      lower.includes("เลขอะไร") ||
      lower.includes("สถานะ") ||
      lower.includes("status") ||
      lower.includes("ความคืบหน้า") ||
      lower.includes("ติดตาม") ||
      lower.includes("follow up") ||
      lower.includes("เป็นยังไง") ||
      lower.includes("ถึงไหน")
    ) {
      return hasTicketId ? "status" : "status";
    }

    if (lower.includes("ปิด") || lower.includes("close") || lower.includes("resolved") || lower.includes("แก้ไขแล้ว")) {
      return "close";
    }

    if (lower.includes("รวมสองใบ") || lower.includes("รวม") || lower.includes("merge") || lower.includes("duplicate")) {
      return "merge";
    }

    if (lower.includes("มอบหมาย") || lower.includes("assign") || lower.includes("โอนให้")) {
      return "assign";
    }

    if (
      hasTicketId ||
      lower.includes("อัปเดตอันเดิม") ||
      lower.includes("อัพเดตอันเดิม") ||
      lower.includes("ข้อมูลเพิ่มของเรื่องเดิม") ||
      lower.includes("ข้อมูลเพิ่มเติมของเรื่องเดิม") ||
      lower.includes("update existing")
    ) {
      return "update_summary";
    }

    if (
      lower.includes("ค้นหา") ||
      lower.includes("find") ||
      lower.includes("หาตั๋ว") ||
      lower.includes("เรื่องเดิม") ||
      lower.includes("ตั๋วทั้งหมด") ||
      lower.includes("list")
    ) {
      return "find";
    }

    return "create";
  }

  private extractTicketId(text: string): string | null {
    const match = text.match(/TCK-\d{4}-\d+/i);
    return match ? match[0] : null;
  }

  private async handleCreateTicket(
    message: InboundMessage,
    sessionContext: any,
    projectId: string
  ): Promise<AgentResult> {
    // Every newly reported incident goes through create_ticket. The persistence
    // layer owns exact normalized-subject idempotency; fuzzy conversation-memory
    // matching must never append a distinct failure to an existing ticket.
    return this.createTicketFromText(message.text, message, sessionContext, projectId);
  }

  private async createTicketFromText(
    text: string,
    message: InboundMessage,
    sessionContext: any,
    projectId: string
  ): Promise<AgentResult> {
    const conversationId = sessionContext.conversationId;
    const conversationIdNum = parseInt(conversationId, 10);
    const subject = this.buildSubject(text);

    // Fast-path idempotency check: Check if active ticket exists BEFORE running PromptX diagnostic
    if (!isNaN(conversationIdNum) && conversationIdNum > 0) {
      try {
        const txManager = new TransactionManager();
        const ticketRepo = new PostgresTicketRepository(txManager);
        const existing = await ticketRepo.findActiveByConversationAndSubject(conversationIdNum, subject);
        if (existing) {
          logger.info(
            { conversationId, subject, ticketId: existing.ticketId, component: "TicketAgent" },
            "Active ticket already exists for conversation and subject; skipping PromptX re-execution"
          );
          return {
            text: `Ticket already active for this issue (${existing.ticketId})`,
            handoffContext: {
              id: existing.id.toString(),
              ticketId: existing.ticketId,
              conversationId: existing.conversationId.toString(),
              subject: existing.subject,
              summary: existing.summary,
              status: existing.status,
              source: "postgres_idempotent",
            },
          };
        }
      } catch (err: any) {
        logger.warn({ error: err.message }, "Pre-diagnostic idempotency check query failed; continuing ticket flow");
      }
    }

    const timer = startTimer();

    // Perform structured Developer Diagnostic Analysis
    const analyzer = new DiagnosticAnalyzer();
    const knowledgeResults =
      sessionContext?.knowledgeResults ||
      sessionContext?.handoffContext?.results ||
      [];

    const diagnostic = await analyzer.analyzeAsync({
      customerText: text,
      conversationContext: `Channel: ${message.channel}, Sender: ${message.senderId || "User"}`,
      knowledgeResults,
      projectId,
      tenantId: sessionContext?.tenantId || sessionContext?.orgId,
    });

    const ticketResult = await this.mcpToolRouter.callTool(
      "create_ticket",
      {
        conversationId,
        subject: this.buildSubject(text),
        summary: `User reported issue: "${text}" on channel ${message.channel}`,
        priority: "Medium",
        severity: "Medium",
        projectId: String(projectId),
        diagnostic,
      },
      sessionContext
    );

    logger.info(
      {
        requestId: sessionContext.requestId,
        conversationId,
        durationMs: timer(),
        component: "TicketAgent",
        success: ticketResult.success,
      },
      "Ticket Agent ticket creation completed"
    );

    if (!ticketResult.success) {
      return {
        text: `ขออภัยค่ะ ไม่สามารถสร้างตั๋วใบงานได้ในขณะนี้: ${ticketResult.error}`,
      };
    }

    const ticket = this.normalizeTicket(ticketResult.data);
    this.rememberCreatedTicket(ticket);
    return {
      text: `สร้างตั๋วใบงานเรียบร้อยแล้วค่ะ หมายเลขตั๋ว: ${ticket.ticketId} ทีมซัพพอร์ตจะติดต่อกลับโดยเร็วที่สุดค่ะ`,
    };
  }

  private async handleStatusCheck(
    message: InboundMessage,
    sessionContext: any,
    projectId: string
  ): Promise<AgentResult> {
    const resolution = await this.resolveTicket(message.text, sessionContext, projectId);
    if (resolution.kind === "none") {
      return { text: "ยังไม่พบตั๋วที่อ้างถึงค่ะ" };
    }
    if (resolution.kind === "ambiguous") {
      return this.askWhichTicket(resolution.tickets, "ต้องการดูสถานะตั๋วใบไหนคะ");
    }

    const ticketId = resolution.ticket.ticketId;
    const result = await this.mcpToolRouter.callTool("get_ticket_status", { ticketId }, sessionContext);

    if (!result.success) {
      return { text: `ขออภัยค่ะ ไม่พบข้อมูลตั๋วหมายเลข ${ticketId}` };
    }

    const t = this.normalizeTicket({ ...resolution.ticket, ...result.data });
    this.rememberReferencedTicket(t);
    return {
      text: `หมายเลขตั๋วคือ ${t.ticketId}\nสถานะ: ${t.status || "ไม่ทราบ"}\nหัวข้อ: ${t.subject || "-"}`,
    };
  }

  private async handleFindTickets(
    message: InboundMessage,
    sessionContext: any,
    projectId: string
  ): Promise<AgentResult> {
    const tickets = await this.findActiveTickets(sessionContext, projectId);
    if (tickets.length === 0) {
      return { text: "ไม่พบตั๋วใบงานที่เปิดอยู่ในระบบค่ะ" };
    }

    if (tickets.length === 1 || this.isLowSignalReference(message.text)) {
      const selected = tickets.length === 1 ? tickets[0] : this.bestTicketMatch(message.text, tickets).ticket;
      this.rememberReferencedTicket(selected);
      return {
        text: `ตั๋วที่อ้างถึงคือ ${selected.ticketId}: ${selected.subject || "-"} (สถานะ: ${selected.status || "-"})`,
      };
    }

    const scored = this.bestTicketMatch(message.text, tickets);
    if (this.isConfidentMatch(scored)) {
      this.rememberReferencedTicket(scored.ticket);
      return {
        text: `ตั๋วที่ตรงที่สุดคือ ${scored.ticket.ticketId}: ${scored.ticket.subject || "-"} (สถานะ: ${scored.ticket.status || "-"})`,
      };
    }

    return this.askWhichTicket(tickets, "พบตั๋วที่เกี่ยวข้องหลายใบค่ะ กรุณาระบุว่าเป็นใบไหน");
  }

  private async handleCloseTicket(
    message: InboundMessage,
    sessionContext: any,
    projectId: string
  ): Promise<AgentResult> {
    const resolution = await this.resolveTicket(message.text, sessionContext, projectId);
    if (resolution.kind === "none") {
      return { text: "ยังไม่พบตั๋วที่ต้องการปิดค่ะ" };
    }
    if (resolution.kind === "ambiguous") {
      return this.askWhichTicket(resolution.tickets, "ต้องการปิดตั๋วใบไหนคะ");
    }

    const ticketId = resolution.ticket.ticketId;
    const result = await this.mcpToolRouter.callTool("close_ticket", { ticketId }, sessionContext);
    if (!result.success) {
      return { text: `ขออภัยค่ะ ไม่สามารถปิดตั๋ว ${ticketId} ได้: ${result.error}` };
    }

    this.rememberReferencedTicket({ ...resolution.ticket, status: "Done" });
    return { text: `ปิดตั๋ว ${ticketId} เรียบร้อยแล้วค่ะ` };
  }

  private async handleMergeTicket(
    message: InboundMessage,
    sessionContext: any,
    projectId: string
  ): Promise<AgentResult> {
    const explicitIds = message.text.match(/TCK-\d{4}-\d+/gi) || [];
    let primaryTicketId = explicitIds[0];
    let ticketId = explicitIds[1];

    if (!primaryTicketId || !ticketId) {
      const tickets = await this.findActiveTickets(sessionContext, projectId);
      if (tickets.length === 2) {
        primaryTicketId = tickets[0].ticketId;
        ticketId = tickets[1].ticketId;
      } else if (this.lastReferencedTicket && this.lastCreatedTicket && this.lastReferencedTicket.ticketId !== this.lastCreatedTicket.ticketId) {
        primaryTicketId = this.lastReferencedTicket.ticketId;
        ticketId = this.lastCreatedTicket.ticketId;
      }
    }

    if (!primaryTicketId || !ticketId) {
      const tickets = await this.findActiveTickets(sessionContext, projectId);
      return this.askWhichTicket(tickets, "ต้องการรวมตั๋วสองใบไหนคะ");
    }

    const result = await this.mcpToolRouter.callTool(
      "merge_ticket",
      { ticketId, primaryTicketId, reason: `Merged by customer follow-up: ${message.text}` },
      sessionContext
    );

    if (!result.success) {
      return { text: `ขออภัยค่ะ ไม่สามารถรวมตั๋วได้: ${result.error}` };
    }

    this.rememberReferencedTicket({ ticketId: primaryTicketId });
    return { text: `รวมตั๋ว ${ticketId} เข้ากับตั๋วหลัก ${primaryTicketId} เรียบร้อยแล้วค่ะ` };
  }

  private async handleAssignTicket(
    message: InboundMessage,
    sessionContext: any,
    projectId: string
  ): Promise<AgentResult> {
    const resolution = await this.resolveTicket(message.text, sessionContext, projectId);
    if (resolution.kind === "none") {
      return { text: "ยังไม่พบตั๋วที่ต้องการมอบหมายค่ะ" };
    }
    if (resolution.kind === "ambiguous") {
      return this.askWhichTicket(resolution.tickets, "ต้องการมอบหมายตั๋วใบไหนคะ");
    }

    const assigneeMatch = message.text.match(/(?:ให้|to)\s+([^\s,]+)/i);
    const agentId = assigneeMatch ? assigneeMatch[1] : "pm";
    const ticketId = resolution.ticket.ticketId;

    const result = await this.mcpToolRouter.callTool("assign_ticket", { ticketId, agentId }, sessionContext);
    if (!result.success) {
      return { text: `ขออภัยค่ะ ไม่สามารถมอบหมายตั๋ว ${ticketId} ได้: ${result.error}` };
    }

    this.rememberReferencedTicket(resolution.ticket);
    return { text: `มอบหมายตั๋ว ${ticketId} ให้ ${agentId} เรียบร้อยแล้วค่ะ` };
  }

  private async handleUpdateSummary(
    message: InboundMessage,
    sessionContext: any,
    projectId: string
  ): Promise<AgentResult> {
    const resolution = await this.resolveTicket(message.text, sessionContext, projectId);
    if (resolution.kind === "none") {
      return { text: "ยังไม่พบตั๋วที่ต้องการอัปเดตค่ะ" };
    }
    if (resolution.kind === "ambiguous") {
      return this.askWhichTicket(resolution.tickets, "ต้องการอัปเดตตั๋วใบไหนคะ");
    }

    const ticketId = resolution.ticket.ticketId;
    const runningSummary = this.mergeSummary(resolution.ticket, message.text);
    const result = await this.mcpToolRouter.callTool(
      "update_summary",
      { ticketId, runningSummary, lastAiSummary: message.text },
      sessionContext
    );

    if (!result.success) {
      return { text: `ขออภัยค่ะ ไม่สามารถอัปเดตสรุปตั๋ว ${ticketId} ได้: ${result.error}` };
    }

    this.rememberReferencedTicket({ ...resolution.ticket, runningSummary });
    return { text: `อัปเดตตั๋ว ${ticketId} เรียบร้อยแล้วค่ะ` };
  }

  private async resolveTicket(text: string, sessionContext: any, projectId: string): Promise<TicketResolution> {
    const explicitTicketId = this.extractTicketId(text);
    if (explicitTicketId) {
      const ticket = this.normalizeTicket({ ticketId: explicitTicketId });
      this.rememberReferencedTicket(ticket);
      return { kind: "resolved", ticket, confidence: 1 };
    }

    if (this.isLowSignalReference(text)) {
      const remembered = this.lastReferencedTicket || this.lastCreatedTicket;
      if (remembered) {
        return { kind: "resolved", ticket: remembered, confidence: 0.9 };
      }
    }

    const tickets = await this.findActiveTickets(sessionContext, projectId);
    if (tickets.length === 0) {
      const remembered = this.lastReferencedTicket || this.lastCreatedTicket;
      return remembered ? { kind: "resolved", ticket: remembered, confidence: 0.65 } : { kind: "none" };
    }
    if (tickets.length === 1) {
      this.rememberReferencedTicket(tickets[0]);
      return { kind: "resolved", ticket: tickets[0], confidence: 0.85 };
    }

    const scored = this.bestTicketMatch(text, tickets);
    if (this.isConfidentMatch(scored)) {
      this.rememberReferencedTicket(scored.ticket);
      return { kind: "resolved", ticket: scored.ticket, confidence: scored.score };
    }

    return { kind: "ambiguous", tickets };
  }

  private async findActiveTickets(sessionContext: any, projectId: string): Promise<RememberedTicket[]> {
    const params: Record<string, string> = {
      conversationId: String(sessionContext.conversationId),
      projectId: String(projectId),
    };

    const profileId = sessionContext.profileId || sessionContext.profile_id;
    const identityId = sessionContext.identityId || sessionContext.identity_id;
    if (profileId) params.profileId = String(profileId);
    if (identityId) params.identityId = String(identityId);

    const result = await this.mcpToolRouter.callTool("find_ticket", params, sessionContext);
    if (!result.success || !result.data) return [];

    const tickets = Array.isArray(result.data) ? result.data : result.data.tickets || [result.data];
    return tickets.map((ticket: any) => this.normalizeTicket(ticket)).filter((ticket: RememberedTicket) => this.isActive(ticket));
  }

  private bestTicketMatch(text: string, tickets: RememberedTicket[]): { ticket: RememberedTicket; score: number; secondScore: number } {
    const ranked = tickets
      .map((ticket) => ({ ticket, score: this.ticketMatchScore(text, ticket) }))
      .sort((a, b) => b.score - a.score);

    return { ticket: ranked[0]?.ticket || tickets[0], score: ranked[0]?.score || 0, secondScore: ranked[1]?.score || 0 };
  }

  private isConfidentMatch(match: { score: number; secondScore: number }): boolean {
    return match.score >= 0.3 || (match.score > 0 && match.secondScore === 0);
  }

  private ticketMatchScore(text: string, ticket: RememberedTicket): number {
    if (!text.trim()) return 0;

    const haystack = [ticket.ticketId, ticket.subject, ticket.summary, ticket.runningSummary].filter(Boolean).join(" ");
    const textTokens = this.tokens(text);
    const ticketTokens = new Set(this.tokens(haystack));
    if (textTokens.length === 0 || ticketTokens.size === 0) return 0;

    let matches = 0;
    for (const token of textTokens) {
      if (ticketTokens.has(token)) matches += 1;
    }

    const overlap = matches / Math.max(textTokens.length, 1);
    const exactIdBoost = haystack.toLowerCase().includes(text.toLowerCase().trim()) ? 0.2 : 0;
    const rememberedBoost =
      this.lastReferencedTicket?.ticketId === ticket.ticketId || this.lastCreatedTicket?.ticketId === ticket.ticketId
        ? 0.15
        : 0;

    return Math.min(1, overlap + exactIdBoost + rememberedBoost);
  }

  private tokens(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, " ")
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2 && !LOW_SIGNAL_REFERENCES.includes(token));
  }

  private normalizeTicket(ticket: any): RememberedTicket {
    const ticketId = String(ticket?.ticketId || ticket?.ticket_id || ticket?.id1 || ticket?.id || "");
    return {
      id: ticket?.id ? String(ticket.id) : undefined,
      ticketId,
      subject: ticket?.subject || ticket?.title || ticket?.aiTitle,
      summary: ticket?.summary,
      runningSummary: ticket?.runningSummary || ticket?.running_summary,
      status: ticket?.status,
    };
  }

  private isActive(ticket: RememberedTicket): boolean {
    return !CLOSED_STATUSES.has(String(ticket.status || "open").toLowerCase());
  }

  private isLowSignalReference(text: string): boolean {
    const lower = text.toLowerCase().trim();
    return LOW_SIGNAL_REFERENCES.some((phrase) => lower.includes(phrase));
  }

  private rememberCreatedTicket(ticket: RememberedTicket): void {
    this.lastCreatedTicket = ticket;
    this.lastReferencedTicket = ticket;
  }

  private rememberReferencedTicket(ticket: RememberedTicket): void {
    if (!ticket.ticketId) return;
    this.lastReferencedTicket = ticket;
  }

  private rememberFromHistory(history: Array<{ content?: string }>): void {
    if (this.lastCreatedTicket || this.lastReferencedTicket) return;

    for (let i = history.length - 1; i >= 0; i -= 1) {
      const content = history[i]?.content || "";
      const ticketId = this.extractTicketId(content);
      if (ticketId) {
        this.rememberReferencedTicket({ ticketId });
        return;
      }
    }
  }

  private askWhichTicket(tickets: RememberedTicket[], prefix: string): AgentResult {
    if (tickets.length === 0) {
      return { text: "ยังไม่พบตั๋วที่เกี่ยวข้องค่ะ" };
    }

    const ticketList = tickets
      .slice(0, 5)
      .map((ticket, index) => `${index + 1}. ${ticket.ticketId}: ${ticket.subject || "-"} (${ticket.status || "-"})`)
      .join("\n");

    return { text: `${prefix}:\n${ticketList}` };
  }

  private buildSubject(text: string): string {
    const trimmed = text.replace(/\s+/g, " ").trim();
    return trimmed.length > 60 ? `IT support requested: ${trimmed.slice(0, 57)}...` : `IT support requested: ${trimmed}`;
  }

  private mergeSummary(ticket: RememberedTicket, text: string): string {
    const current = ticket.runningSummary || ticket.summary || ticket.subject || "";
    return current ? `${current}\nFollow-up: ${text}` : text;
  }

}
