import { pool } from "../adapters/postgres/PostgresAdapter";
import { createLogger } from "../observability/logger";
import { addBusinessDays } from "./BusinessCalendar";

const logger = createLogger("SLAMatrixService");

/**
 * Which levels count "วันทำการ" (business days) instead of clock hours.
 * Urgent/High are incidents and run 24×7; Medium/Low/None follow the
 * working calendar (Mon–Fri, Asia/Bangkok; see BusinessCalendar).
 * Hours in the matrix are still stored as 24 h/day so existing
 * project_sla_policies rows (48 / 120 / 24 / 48) keep their meaning.
 */
const BUSINESS_DAY_LEVELS = new Set(["Medium", "Low", "None"]);
const HOURS_PER_BUSINESS_DAY = 24;

function addSlaHours(base: Date, hours: number, priorityName: string): Date {
  if (BUSINESS_DAY_LEVELS.has(priorityName) && hours >= HOURS_PER_BUSINESS_DAY && hours < 999) {
    return addBusinessDays(base, Math.round(hours / HOURS_PER_BUSINESS_DAY));
  }
  return new Date(base.getTime() + hours * 60 * 60 * 1000);
}

export interface SLAPolicy {
  priority: string;
  priorityName: string;
  responseHours: number;
  resolveHours: number;
  serviceWindow: string;
}

export interface SLACalculationResult {
  dueDate: string;
  responseDueDate: string;
  resolveHours: number;
  responseHours: number;
  priorityName: string;
}

export class SLAMatrixService {
  private static readonly DEFAULT_SLA_MAP: Record<string, { name: string; response: number; resolve: number }> = {
    Urgent:  { name: "Urgent",  response: 0.25, resolve: 4 },
    urgent:  { name: "Urgent",  response: 0.25, resolve: 4 },
    High:    { name: "High",    response: 0.5,  resolve: 8 },
    high:    { name: "High",    response: 0.5,  resolve: 8 },
    Medium:  { name: "Medium",  response: 2,    resolve: 48 },
    medium:  { name: "Medium",  response: 2,    resolve: 48 },
    Low:     { name: "Low",     response: 24,   resolve: 120 },
    low:     { name: "Low",     response: 24,   resolve: 120 },
    None:    { name: "None",    response: 48,   resolve: 999 },
    none:    { name: "None",    response: 48,   resolve: 999 },
    // Legacy P-code aliases for backward compatibility
    P1:      { name: "Urgent",  response: 0.25, resolve: 4 },
    P2:      { name: "High",    response: 0.5,  resolve: 8 },
    P3:      { name: "Medium",  response: 2,    resolve: 48 },
    P4:      { name: "Low",     response: 24,   resolve: 120 },
    P5:      { name: "None",    response: 48,   resolve: 999 },
  };

  async calculateSLADueDate(
    projectId: string | number,
    priority: string,
    createdAt: Date = new Date()
  ): Promise<SLACalculationResult> {
    const normPriority = (priority || "Medium").trim();
    let resolveHours = 24;
    let responseHours = 4;
    let priorityName = "Medium";

    // 1. Check project SLA policy from DB if available
    try {
      const parsedProjectId = typeof projectId === "number" ? projectId : parseInt(String(projectId), 10);
      if (!isNaN(parsedProjectId)) {
        const { rows } = await pool.query(
          `SELECT priority_name, response_hours, resolve_hours 
           FROM project_sla_policies 
           WHERE project_id = $1 AND LOWER(priority) = LOWER($2) LIMIT 1`,
          [parsedProjectId, normPriority]
        );

        if (rows.length > 0) {
          priorityName = rows[0].priority_name || priorityName;
          responseHours = rows[0].response_hours || responseHours;
          resolveHours = rows[0].resolve_hours || resolveHours;
        } else {
          const fallback = SLAMatrixService.DEFAULT_SLA_MAP[normPriority] || SLAMatrixService.DEFAULT_SLA_MAP.Medium;
          priorityName = fallback.name;
          responseHours = fallback.response;
          resolveHours = fallback.resolve;
        }
      }
    } catch (err: any) {
      logger.debug({ error: err.message }, "SLA project policy lookup fallback to default map");
      const fallback = SLAMatrixService.DEFAULT_SLA_MAP[normPriority] || SLAMatrixService.DEFAULT_SLA_MAP.Medium;
      priorityName = fallback.name;
      responseHours = fallback.response;
      resolveHours = fallback.resolve;
    }

    // "ไม่กำหนด" (None) keeps the 999 h sentinel as plain hours; business-day
    // levels convert whole days (48 h → 2 business days) and skip weekends.
    const dueDate = addSlaHours(createdAt, Number(resolveHours), priorityName).toISOString();
    const responseDueDate = addSlaHours(createdAt, Number(responseHours), priorityName).toISOString();

    return {
      dueDate,
      responseDueDate,
      resolveHours,
      responseHours,
      priorityName,
    };
  }

  async checkSLABreachStatus(ticket: {
    createdAt: string | Date;
    dueDate: string | Date;
    status: string;
  }): Promise<{ isBreached: boolean; hoursRemaining: number }> {
    const status = (ticket.status || "").toLowerCase();
    if (status === "done" || status === "closed" || status === "resolved") {
      return { isBreached: false, hoursRemaining: 999 };
    }

    const now = Date.now();
    const dueMs = new Date(ticket.dueDate).getTime();
    const diffMs = dueMs - now;
    const hoursRemaining = Math.round((diffMs / (1000 * 60 * 60)) * 10) / 10;

    return {
      isBreached: diffMs < 0,
      hoursRemaining,
    };
  }
}
