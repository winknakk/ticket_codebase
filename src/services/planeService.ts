import * as fs from "fs";
import * as path from "path";
import axios from "axios";
import { randomUUID } from "crypto";
import { DatabaseAdapter } from "../adapters/types";
import { pool } from "../adapters/postgres/PostgresAdapter";
import { config } from "../config/env";
import { mapTicketPriorityToPlanePriority } from "./planeWebhookService";
import { parseSummaryHistory } from "../shared/summaryHistory";
import { S3MediaStorageService } from "../media/services/S3MediaStorageService";

export interface PlaneStateSummary {
  id?: string;
  name?: string;
  group?: string;
}

export interface PlaneTicketClosureResult {
  synced: boolean;
  reason?: "not_linked";
  planeIssueId?: string;
  stateId?: string;
  stateName?: string;
  stateGroup?: string;
}

export interface PlaneTicketSummaryResult {
  synced: boolean;
  reason?: "not_linked";
  planeIssueId?: string;
}

export interface PlaneTicketReopenResult {
  synced: boolean;
  reason?: "not_linked";
  planeIssueId?: string;
  stateId?: string;
  stateName?: string;
  stateGroup?: string;
}

export type PlaneTicketMergeResult = PlaneTicketReopenResult;

export interface PlaneWorkItemPayload {
  name: string;
  description_html: string;
  priority: string;
  external_source: "TicketX";
  external_id: string;
  target_date?: string;
  labels?: string[];
}

function escapePlaneHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizePlaneTargetDate(value: unknown): string | undefined {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;

  const datePrefix = raw.match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
  if (datePrefix) return datePrefix;

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString().slice(0, 10);
}

import { sanitizeSensitiveData } from "../domain/diagnostic/DeveloperDiagnostic";

export function formatDeveloperDiagnosticHtml(diag: any): string {
  if (!diag) return "";

  // Check if this is the P6 CanonicalDiagnosticObject structure
  if (diag.issue_details || diag.technical_evidence || (diag.overview && diag.sla)) {
    const overview = diag.overview || {};
    const issue = diag.issue_details || {};
    const sla = diag.sla || {};
    const tech = diag.technical_evidence || {};
    const completeness = diag.completeness || {};
    const evStatus = tech.evidence_status || {};

    const formatBadge = (status?: string) => {
      const s = (status || "UNKNOWN").toUpperCase();
      let color = "#6b7280"; // gray
      if (s === "CONFIRMED") color = "#059669"; // green
      else if (s === "LIKELY") color = "#d97706"; // amber
      else if (s === "NOT_FOUND_IN_KNOWLEDGE_BASE") color = "#dc2626"; // red
      return ` <span style="background-color:${color};color:#ffffff;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:600;">${escapePlaneHtml(s)}</span>`;
    };

    const reproSteps: string[] = Array.isArray(issue.reproduction_steps) ? issue.reproduction_steps : [];
    const reproHtml = reproSteps.length > 0
      ? `<h4>🧪 Steps to Reproduce</h4><ol>` +
      reproSteps.map((step: string) => `<li>${escapePlaneHtml(sanitizeSensitiveData(step))}</li>`).join("") +
      `</ol>`
      : "";

    const codeEvidenceList: any[] = Array.isArray(tech.code_evidence) ? tech.code_evidence : [];
    const codeHtml = codeEvidenceList.length > 0
      ? `<h4>💻 Code Evidence (Git Repository)</h4><ul>` +
      codeEvidenceList.map((code: any) => {
        const file = escapePlaneHtml(code.file || code.filePath || "File");
        const symbol = code.symbol || code.symbolName ? ` (Symbol: <code>${escapePlaneHtml(code.symbol || code.symbolName)}</code>)` : "";
        const lines = code.lines || code.lineStart ? ` [Lines ${escapePlaneHtml(code.lines || code.lineStart + (code.lineEnd ? `-${code.lineEnd}` : ""))}]` : "";
        const snippet = code.snippet ? `<br><pre><code>${escapePlaneHtml(sanitizeSensitiveData(code.snippet))}</code></pre>` : "";
        return `<li><strong>${file}</strong>${symbol}${lines}${snippet}</li>`;
      }).join("") +
      `</ul>`
      : "";

    const rawReport = tech.raw_customer_report || issue.symptom || "";
    const rawHtml = rawReport
      ? `<details style="margin-top:12px;padding:8px;background-color:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;"><summary style="cursor:pointer;font-weight:600;">🔽 Raw Customer Report</summary><p style="margin-top:8px;">${escapePlaneHtml(sanitizeSensitiveData(rawReport)).replace(/\r?\n/g, "<br>")}</p></details>`
      : "";

    return [
      `<h3>📋 1. ข้อมูลทั่วไป (Overview)</h3><ul>`,
      overview.ticket_id ? `<li><strong>Ticket ID:</strong> ${escapePlaneHtml(overview.ticket_id)}</li>` : "",
      overview.project_name ? `<li><strong>Project / System:</strong> ${escapePlaneHtml(overview.project_name)}</li>` : "",
      overview.notifier ? `<li><strong>Notifier:</strong> ${escapePlaneHtml(overview.notifier)}</li>` : "",
      overview.channel ? `<li><strong>Channel:</strong> ${escapePlaneHtml(overview.channel)}</li>` : "",
      overview.impact_scope ? `<li><strong>Impact Scope:</strong> ${escapePlaneHtml(overview.impact_scope)}</li>` : "",
      `</ul>`,

      `<h3>🔍 2. รายละเอียดสำหรับ Developer (Issue Details)</h3><ul>`,
      `<li><strong>Feature / Screen / Report:</strong> ${escapePlaneHtml(issue.feature_screen_report || "ยังไม่ได้ระบุ")}</li>`,
      `<li><strong>Symptom / Actual Behavior:</strong> ${escapePlaneHtml(issue.actual_behavior || issue.symptom || "ยังไม่ได้ระบุ")}</li>`,
      `<li><strong>Expected Behavior:</strong> ${escapePlaneHtml(issue.expected_behavior || "ระบบต้องทำงานได้ถูกต้องตามปกติ")}</li>`,
      `</ul>`,
      reproHtml,

      `<h3>⏱️ 3. ระดับความสำคัญและเวลา (SLA & Severity)</h3><ul>`,
      `<li><strong>Severity / Priority:</strong> ${escapePlaneHtml(sla.severity || "Normal")} / ${escapePlaneHtml(sla.priority || "P3")}</li>`,
      sla.sla_hours ? `<li><strong>SLA Target:</strong> ภายใน ${escapePlaneHtml(sla.sla_hours)} ชั่วโมง</li>` : "",
      sla.due_date ? `<li><strong>Due Date:</strong> ${escapePlaneHtml(sla.due_date)}</li>` : "",
      `</ul>`,

      `<h3>🛠️ 4. ข้อมูลทางเทคนิคและหลักฐาน (Technical & Evidence)</h3><ul>`,
      `<li><strong>Suspected Layer:</strong> ${escapePlaneHtml(tech.layer || "Application Layer")}${formatBadge(evStatus.layer)}</li>`,
      `<li><strong>Suspected Component:</strong> ${escapePlaneHtml(tech.suspected_component || "UNKNOWN")}${formatBadge(evStatus.suspected_component)}</li>`,
      `<li><strong>Error Code / Message:</strong> <code>${escapePlaneHtml(tech.error_code || "None")}</code>${formatBadge(evStatus.error_code)}</li>`,
      completeness.status ? `<li><strong>Triage Status:</strong> <code>${escapePlaneHtml(completeness.status)}</code> (Completeness Score: ${escapePlaneHtml(Math.round((completeness.score || 0) * 100))}%)</li>` : "",
      `</ul>`,
      codeHtml,
      rawHtml,
    ].filter(Boolean).join("");
  }

  const getFieldValue = (
    field: any,
    defaultVal = "UNKNOWN"
  ): { value: string; source: string; confidence: number; isHypothesis: boolean } => {
    if (!field) return { value: defaultVal, source: "UNKNOWN", confidence: 0, isHypothesis: true };
    if (typeof field === "string") {
      return { value: field, source: "AI_INFERENCE", confidence: 50, isHypothesis: true };
    }
    return {
      value: field.value || defaultVal,
      source: field.source || "AI_INFERENCE",
      confidence: typeof field.confidence === "number" ? field.confidence : 0,
      isHypothesis: field.isHypothesis !== false,
    };
  };

  const projectField = getFieldValue(diag.project);
  const moduleField = getFieldValue(diag.module);
  const featureField = getFieldValue(diag.feature);
  const layerField = getFieldValue(diag.suspected_layer);
  const componentField = getFieldValue(diag.suspected_component);
  const apiField = getFieldValue(diag.suspected_api, "NOT_FOUND_IN_KNOWLEDGE_BASE");
  const dbField = getFieldValue(diag.suspected_database_object, "NOT_FOUND_IN_KNOWLEDGE_BASE");
  const rootCauseField = getFieldValue(diag.root_cause_hypothesis);

  const customerReport = sanitizeSensitiveData(diag.customer_report || "");
  const expectedBehavior = sanitizeSensitiveData(
    diag.expected_behavior || "System should function normally without errors"
  );
  const actualBehavior = sanitizeSensitiveData(diag.actual_behavior || customerReport);
  const overallConfidence =
    typeof diag.confidence === "number" ? diag.confidence : rootCauseField.confidence;
  const nextAction = sanitizeSensitiveData(
    diag.recommended_next_action || "Review customer logs and reproduce in staging environment"
  );

  const evidenceList: any[] = Array.isArray(diag.customer_evidence) ? diag.customer_evidence : [];
  const evidenceHtml =
    evidenceList.length > 0
      ? `<h3>🔎 Customer Evidence</h3><ul>` +
      evidenceList
        .map((e) => {
          const type = escapePlaneHtml(e.type || "Evidence");
          const val = escapePlaneHtml(sanitizeSensitiveData(e.value || ""));
          const src = escapePlaneHtml(e.source || "CUSTOMER_REPORTED");
          return `<li><strong>[${src}] ${type}:</strong> <code>${val}</code></li>`;
        })
        .join("") +
      `</ul>`
      : "";

  const reproSteps: string[] = Array.isArray(diag.reproduction_steps) ? diag.reproduction_steps : [];
  const reproHtml =
    reproSteps.length > 0
      ? `<h3>🧪 Steps to Reproduce</h3><ol>` +
      reproSteps
        .map((step) => `<li>${escapePlaneHtml(sanitizeSensitiveData(step))}</li>`)
        .join("") +
      `</ol>`
      : "";

  const kbSources: any[] = Array.isArray(diag.knowledge_sources) ? diag.knowledge_sources : [];
  const kbHtml =
    kbSources.length > 0
      ? `<h3>📚 Evidence Sources (Knowledge Base)</h3><ul>` +
      kbSources
        .map((kb) => {
          const title = escapePlaneHtml(kb.title || "Project Documentation");
          const score =
            typeof kb.score === "number" ? ` (Score: ${(kb.score * 100).toFixed(0)}%)` : "";
          const snippet = kb.snippet
            ? `<br><em>${escapePlaneHtml(sanitizeSensitiveData(kb.snippet))}</em>`
            : "";
          return `<li><strong>${title}</strong>${score}${snippet}</li>`;
        })
        .join("") +
      `</ul>`
      : "";

  const unknownsList: string[] = Array.isArray(diag.unknowns) ? diag.unknowns : [];
  const unknownsHtml =
    unknownsList.length > 0
      ? `<h3>❓ Unknown Information</h3><ul>` +
      unknownsList
        .map((u) => `<li>${escapePlaneHtml(sanitizeSensitiveData(u))}</li>`)
        .join("") +
      `</ul>`
      : "";

  const codeEvidenceList: any[] = Array.isArray(diag.code_evidence) ? diag.code_evidence : [];
  const codeHtml =
    codeEvidenceList.length > 0
      ? `<h3>💻 Live Code Evidence (Git Repository)</h3><ul>` +
      codeEvidenceList
        .map((code) => {
          const file = escapePlaneHtml(code.filePath || "File");
          const symbol = code.symbolName ? ` (Symbol: <code>${escapePlaneHtml(code.symbolName)}</code>)` : "";
          const lines = code.lineStart ? ` [Lines ${escapePlaneHtml(code.lineStart)}-${escapePlaneHtml(code.lineEnd || "")}]` : "";
          const commit = code.commitSha ? ` [Commit: ${escapePlaneHtml(code.commitSha.slice(0, 7))}]` : "";
          const snippet = code.snippet
            ? `<br><pre><code>${escapePlaneHtml(sanitizeSensitiveData(code.snippet))}</code></pre>`
            : "";
          return `<li><strong>${file}</strong>${symbol}${lines}${commit}${snippet}</li>`;
        })
        .join("") +
      `</ul>`
      : "";

  return [
    `<h3>🎯 Customer Report</h3><p>${escapePlaneHtml(customerReport).replace(/\r?\n/g, "<br>")}</p>`,
    evidenceHtml,
    reproHtml,
    `<h3>🔍 Expected vs Actual</h3><ul>`,
    `<li><strong>Expected:</strong> ${escapePlaneHtml(expectedBehavior)}</li>`,
    `<li><strong>Actual:</strong> ${escapePlaneHtml(actualBehavior)}</li>`,
    `</ul>`,
    `<h3>🛠️ Developer Diagnostics</h3><ul>`,
    `<li><strong>Project:</strong> ${escapePlaneHtml(projectField.value)} <em>[${escapePlaneHtml(projectField.source)}]</em></li>`,
    `<li><strong>Module:</strong> ${escapePlaneHtml(moduleField.value)} <em>[${escapePlaneHtml(moduleField.source)}]</em></li>`,
    `<li><strong>Feature:</strong> ${escapePlaneHtml(featureField.value)} <em>[${escapePlaneHtml(featureField.source)}]</em></li>`,
    `<li><strong>Suspected Layer:</strong> ${escapePlaneHtml(layerField.value)} <em>[${escapePlaneHtml(layerField.source)}]</em></li>`,
    `<li><strong>Suspected Component:</strong> ${escapePlaneHtml(componentField.value)} <em>[${escapePlaneHtml(componentField.source)}]</em></li>`,
    `<li><strong>Suspected API:</strong> <code>${escapePlaneHtml(apiField.value)}</code> <em>[${escapePlaneHtml(apiField.source)}]</em></li>`,
    `<li><strong>Suspected Database Object:</strong> <code>${escapePlaneHtml(dbField.value)}</code> <em>[${escapePlaneHtml(dbField.source)}]</em></li>`,
    `<li><strong>Root Cause Hypothesis:</strong> ${escapePlaneHtml(rootCauseField.value)} <strong style="color:#d97706;">[AI HYPOTHESIS - Confidence: ${overallConfidence}%]</strong></li>`,
    `</ul>`,
    kbHtml,
    codeHtml,
    unknownsHtml,
    `<h3>🚀 Recommended Next Investigation</h3><p>${escapePlaneHtml(nextAction)}</p>`,
  ].join("");
}

export interface PlaneCreatorInfo {
  label: string;
  prefix: string;
  suffix?: string;
  labelName: string;
  labelColor: string;
}

export function getPlaneCreatorInfo(
  rawCreatorType?: string,
  creatorName?: string
): PlaneCreatorInfo {
  const type = String(rawCreatorType || "CUSTOMER").toUpperCase();
  const name = String(creatorName || "").trim();

  if (type.includes("AI")) {
    return {
      label: `🤖 AI Bot${name ? ` (${name})` : ""}`,
      prefix: `[🤖 AI]`,
      suffix: `[🤖 AI]`,
      labelName: "AI-Generated",
      labelColor: "#6366f1",
    };
  }
  if (type.includes("HUMAN") || type.includes("AGENT")) {
    return {
      label: `🎧 Human Agent${name ? ` (${name})` : ""}`,
      prefix: `[🎧 Human]`,
      suffix: `[🎧 Human]`,
      labelName: "Human-Agent",
      labelColor: "#10b981",
    };
  }
  if (type.includes("PLANE")) {
    return {
      label: `✈️ Plane.io User${name ? ` (${name})` : ""}`,
      prefix: `[✈️ Plane]`,
      suffix: `[✈️ Plane]`,
      labelName: "Plane-User",
      labelColor: "#3b82f6",
    };
  }
  return {
    label: name ? `👤 Customer (${name})` : "👤 Customer",
    prefix: `[👤 Customer]`,
    suffix: `[👤 Customer]`,
    labelName: "Customer",
    labelColor: "#f59e0b",
  };
}

export function extractImageUrls(ticket: any): string[] {
  const urls: string[] = [];
  const addIfUrl = (val: any) => {
    if (typeof val === "string" && (val.startsWith("http://") || val.startsWith("https://"))) {
      urls.push(val.trim());
    }
  };

  addIfUrl(ticket.attachment_url || ticket.attachmentUrl);
  addIfUrl(ticket.image_url || ticket.imageUrl);

  const rawMedia = ticket.media_urls || ticket.mediaUrls;
  if (Array.isArray(rawMedia)) {
    for (const item of rawMedia) {
      if (typeof item === "string") addIfUrl(item);
      else if (item?.url) addIfUrl(item.url);
    }
  }

  const rawAttachments = ticket.attachments;
  if (Array.isArray(rawAttachments)) {
    for (const item of rawAttachments) {
      if (typeof item === "string") addIfUrl(item);
      else if (item?.url) addIfUrl(item.url);
    }
  } else if (typeof rawAttachments === "string" && rawAttachments.trim()) {
    try {
      const parsed = JSON.parse(rawAttachments);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === "string") addIfUrl(item);
          else if (item?.url) addIfUrl(item.url);
        }
      } else {
        addIfUrl(rawAttachments);
      }
    } catch {
      addIfUrl(rawAttachments);
    }
  }

  const textContent = `${ticket.summary || ""} ${ticket.description || ""}`;
  const matchedUrls = textContent.match(/https?:\/\/[^\s<"']+\.(?:png|jpg|jpeg|gif|webp|svg)/gi);
  if (matchedUrls) {
    matchedUrls.forEach((u) => urls.push(u));
  }

  return Array.from(new Set(urls));
}

interface CustomerImageAttachment {
  id: number;
  external_id: string | null;
  storage_key: string;
  file_name: string;
  file_type: string;
  file_size: number;
}

export function buildPlaneWorkItemPayload(
  ticket: Record<string, any>,
  companyName = "Unknown",
  labelIds?: string[]
): PlaneWorkItemPayload {
  const ticketNumber = String(
    ticket.ticket_number || ticket.ticket_id || ticket.id1 || ticket.id || "UNKNOWN"
  ).trim();
  const subject = String(ticket.subject || ticket.title || "No Subject").trim();
  const source = String(ticket.channel || ticket.created_via || "TicketX").trim();
  const conversationId = String(ticket.conversation_id || "").trim();
  const severity = String(ticket.severity || "").trim();
  const priority = mapTicketPriorityToPlanePriority(ticket.priority) || "none";
  const dueDate = normalizePlaneTargetDate(ticket.due_date || ticket.dueDate);
  const summary = String(ticket.summary || "No Summary").trim();
  const runningSummary = String(ticket.running_summary || ticket.runningSummary || "").trim();
  const lastAiSummary = String(ticket.last_ai_summary || ticket.lastAiSummary || "").trim();
  const httpStatus = `${subject} ${summary}`.match(/\b[1-5]\d{2}\b/)?.[0];

  const rawCreatorType = String(
    ticket.created_by_type || ticket.createdByType || (ticket as any).createdBy || "CUSTOMER"
  ).toUpperCase();
  const creatorName = String(ticket.created_by_name || ticket.createdByName || "").trim();

  const creatorInfo = getPlaneCreatorInfo(rawCreatorType, creatorName);
  const creatorLabel = creatorInfo.label;
  const creatorPrefix = creatorInfo.prefix;
  const creatorSuffix = creatorInfo.suffix || "";

  const rawSubject = ticket.plane_title || ticket.planeTitle || subject;
  const cleanSubject = rawSubject
    .replace(/^(\[(🤖\s*AI|AI-test|AI|🎧\s*Human|👤\s*Customer|✈️\s*Plane)\]\s*|\[TCK-[^\]]+\]\s*)*/gi, "")
    .replace(/\s*\[(🤖\s*AI|🎧\s*Human|👤\s*Customer|✈️\s*Plane)\]\s*$/i, "")
    .trim();
  const visibleTitle = `${creatorPrefix} [${ticketNumber}] ${cleanSubject}`;

  const metadata = [
    ["TicketX ID", ticketNumber],
    ["Conversation", conversationId ? `#${conversationId}` : ""],
    ["Source", source],
    ["Creator", creatorLabel],
    ["Customer / Company", companyName === "Unknown" ? "" : companyName],
    ["Severity", severity],
    ["Priority", String(ticket.priority || priority)],
    ["HTTP status", httpStatus || ""],
    ["SLA target", dueDate || ""],
  ].filter(([, value]) => value);

  const metadataHtml = metadata
    .map(
      ([label, value]) =>
        `<li><strong>${escapePlaneHtml(label)}:</strong> ${escapePlaneHtml(value)}</li>`
    )
    .join("");

  const runningSummaryItems = parseSummaryHistory(runningSummary);
  const runningSummaryHtml = runningSummaryItems
    .map((item) => `<li>${escapePlaneHtml(item)}</li>`)
    .join("");

  // Check if ticket carries structured diagnostic
  let diagnosticData = ticket.diagnostic;
  if (!diagnosticData && typeof summary === "string" && summary.startsWith("{") && summary.includes('"customer_report"')) {
    try {
      diagnosticData = JSON.parse(summary);
    } catch {
      // Not JSON, fallback to plain summary
    }
  }

  let mainReportContent = `<h3>Customer report</h3><p>${escapePlaneHtml(sanitizeSensitiveData(summary)).replace(/\r?\n/g, "<br>")}</p>`;
  if (diagnosticData) {
    try {
      mainReportContent = formatDeveloperDiagnosticHtml(diagnosticData);
    } catch (err: any) {
      console.warn("[PlaneService] Failed to format diagnostic HTML, falling back to summary:", err.message);
    }
  }

  const imageUrls = extractImageUrls(ticket);
  const mediaHtml = imageUrls.length > 0
    ? `<h3>📷 Customer Screenshots / Attached Media</h3>` +
    imageUrls
      .map((imgUrl) => `<p><img src="${escapePlaneHtml(imgUrl)}" alt="Customer Problem Screenshot" style="max-width: 100%; border-radius: 8px; border: 1px solid #e2e8f0; margin-top: 8px;" /></p>`)
      .join("")
    : "";

  const summarySections = [
    mainReportContent,
    mediaHtml,
    runningSummary
      ? `<h3>Customer update history</h3><ul>${runningSummaryHtml}</ul>`
      : "",
    lastAiSummary
      ? `<h3>Latest customer update</h3><p>${escapePlaneHtml(sanitizeSensitiveData(lastAiSummary)).replace(/\r?\n/g, "<br>")}</p>`
      : "",
  ].join("");

  const explicitLabels = Array.isArray(labelIds)
    ? labelIds
    : Array.isArray(ticket.labels)
      ? ticket.labels
      : Array.isArray(ticket.label_ids)
        ? ticket.label_ids
        : [];

  return {
    name: visibleTitle,
    description_html:
      `<h3>TicketX support incident</h3>` +
      `<ul>${metadataHtml}</ul>` +
      summarySections,
    priority,
    external_source: "TicketX",
    external_id: ticketNumber,
    ...(dueDate ? { target_date: dueDate } : {}),
    ...(explicitLabels.length > 0 ? { labels: explicitLabels } : {}),
  };
}

export function selectPlaneTerminalState(states: PlaneStateSummary[]): PlaneStateSummary | undefined {
  const byGroup = (group: string) =>
    states.filter((state) => state.group?.trim().toLowerCase() === group && state.id);
  const completed = byGroup("completed");
  const cancelled = byGroup("cancelled");

  const pickPreferred = (candidates: PlaneStateSummary[], names: string[]) => {
    for (const name of names) {
      const match = candidates.find((state) => state.name?.trim().toLowerCase() === name);
      if (match) return match;
    }
    return candidates[0];
  };

  return (
    pickPreferred(completed, ["done", "completed", "closed", "resolved"]) ||
    pickPreferred(cancelled, ["cancelled", "canceled"])
  );
}

export function selectPlaneBacklogState(states: PlaneStateSummary[]): PlaneStateSummary | undefined {
  const candidates = states.filter((state) => state.id);
  return (
    candidates.find((state) => state.name?.trim().toLowerCase() === "backlog") ||
    candidates.find((state) => state.group?.trim().toLowerCase() === "backlog") ||
    candidates.find((state) => state.group?.trim().toLowerCase() === "unstarted")
  );
}

export function selectPlaneCancelledState(states: PlaneStateSummary[]): PlaneStateSummary | undefined {
  const candidates = states.filter((state) => state.id);
  return (
    candidates.find((state) => ["cancelled", "canceled"].includes(state.name?.trim().toLowerCase() || "")) ||
    candidates.find((state) => state.group?.trim().toLowerCase() === "cancelled")
  );
}

export function selectPlaneTodoState(states: PlaneStateSummary[]): PlaneStateSummary | undefined {
  const candidates = states.filter((state) => state.id);
  return (
    candidates.find((state) => ["todo", "to do", "unstarted"].includes(state.name?.trim().toLowerCase() || "")) ||
    candidates.find((state) => state.group?.trim().toLowerCase() === "unstarted")
  );
}

export function selectPlaneInProgressState(states: PlaneStateSummary[]): PlaneStateSummary | undefined {
  const candidates = states.filter((state) => state.id);
  return (
    candidates.find((state) => ["in progress", "started", "in_progress"].includes(state.name?.trim().toLowerCase() || "")) ||
    candidates.find((state) => state.group?.trim().toLowerCase() === "started")
  );
}

export function selectPlaneDoneState(states: PlaneStateSummary[]): PlaneStateSummary | undefined {
  const candidates = states.filter((state) => state.id);
  return (
    candidates.find((state) => ["done", "completed", "resolved", "closed", "close"].includes(state.name?.trim().toLowerCase() || "")) ||
    candidates.find((state) => state.group?.trim().toLowerCase() === "completed")
  );
}

/** Exact-name lookup after collapsing spaces/underscores/hyphens. */
function findPlaneStateByName(states: PlaneStateSummary[], names: string[]): PlaneStateSummary | undefined {
  const norm = (v: string | undefined) => String(v || "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
  const wanted = names.map(norm);
  return states.find((state) => state.id && wanted.includes(norm(state.name)));
}

/** "Re-Open" when the project defines it, otherwise Backlog (the pre-2026-09 behaviour). */
export function selectPlaneReopenState(states: PlaneStateSummary[]): PlaneStateSummary | undefined {
  return findPlaneStateByName(states, ["re-open", "reopen", "reopened"]) || selectPlaneBacklogState(states);
}

/** "Triaged" when defined, otherwise the unstarted/Todo state, otherwise Backlog. */
export function selectPlaneTriagedState(states: PlaneStateSummary[]): PlaneStateSummary | undefined {
  return findPlaneStateByName(states, ["triaged", "triage"]) || selectPlaneTodoState(states) || selectPlaneBacklogState(states);
}

/** "Delivery to Customer" when defined (customer must confirm), otherwise the completed state. */
export function selectPlaneDeliveryState(states: PlaneStateSummary[]): PlaneStateSummary | undefined {
  return findPlaneStateByName(states, ["delivery to customer", "delivered to customer", "delivered"]) || selectPlaneDoneState(states) || selectPlaneTerminalState(states);
}

/** "Waiting for Customer" when defined, otherwise In Progress. */
export function selectPlaneWaitingCustomerState(states: PlaneStateSummary[]): PlaneStateSummary | undefined {
  return findPlaneStateByName(states, ["waiting for customer", "waiting customer", "waiting on customer"]) || selectPlaneInProgressState(states);
}

/**
 * Maps either vocabulary — a TicketX lifecycle status (RESOLVED, REOPENED …)
 * or a Plane label (Delivery to Customer, Re-Open …) — to the project's
 * actual state, always with a group-based fallback so a project that lacks
 * the specific state still lands somewhere sensible.
 */
export function selectPlaneStateForTicketStatus(states: PlaneStateSummary[], status: string): PlaneStateSummary | undefined {
  const normalized = (status || "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
  if (normalized === "backlog" || normalized === "new") return selectPlaneBacklogState(states);
  if (normalized === "triaged" || normalized === "triage") return selectPlaneTriagedState(states);
  if (normalized === "todo" || normalized === "to do") return selectPlaneTodoState(states) || selectPlaneBacklogState(states);
  if (["in progress", "started", "open", "waiting internal", "test failed"].includes(normalized)) {
    return (normalized === "test failed" && findPlaneStateByName(states, ["test failed"])) || selectPlaneInProgressState(states);
  }
  if (normalized === "waiting customer" || normalized === "waiting for customer") return selectPlaneWaitingCustomerState(states);
  if (["re open", "reopen", "reopened"].includes(normalized)) return selectPlaneReopenState(states);
  // CUSTOMER_CONFIRMED is the pending close question (two-step close): the
  // customer said it works but has not pressed "ยืนยันปิดเคส" yet, so Plane
  // must keep showing Delivery to Customer, never Close.
  if (["resolved", "delivery to customer", "delivered", "customer confirmed"].includes(normalized)) return selectPlaneDeliveryState(states);
  if (["done", "completed", "closed", "close"].includes(normalized)) return selectPlaneDoneState(states) || selectPlaneTerminalState(states);
  if (normalized === "cancelled" || normalized === "canceled") return selectPlaneCancelledState(states);

  const match = states.find((s) => s.name?.trim().toLowerCase() === normalized || s.group?.trim().toLowerCase() === normalized);
  return match || selectPlaneBacklogState(states);
}

export function findMatchingPlaneWorkItem(
  subject: string,
  workItems: Array<{ id?: string; name?: string }>
): { id?: string; name?: string } | undefined {
  const normalize = (val: string) =>
    val
      .trim()
      .toLowerCase()
      .replace(/\[(🤖\s*ai|🎧\s*human|👤\s*customer|✈️\s*plane)\]/gi, "")
      .replace(/\s+/g, " ")
      .trim();

  const normalizedSubject = normalize(subject);
  const exactMatches = workItems.filter(
    (workItem) =>
      workItem.id && normalize(String(workItem.name || "")) === normalizedSubject
  );
  if (exactMatches.length === 1) return exactMatches[0];

  const httpCode = normalizedSubject.match(/\b[1-5]\d{2}\b/)?.[0];
  if (!httpCode) return undefined;
  const codeMatches = workItems.filter(
    (workItem) => workItem.id && String(workItem.name || "").match(/\b[1-5]\d{2}\b/)?.[0] === httpCode
  );
  return codeMatches.length === 1 ? codeMatches[0] : undefined;
}

import { PlaneProjectResolver, PlaneProjectConfig } from "./PlaneProjectResolver";
import { PlaneApiClient } from "./PlaneApiClient";
import { urgentAlertService } from "./UrgentAlertService";

export class PlaneService {
  private dbAdapter: DatabaseAdapter;
  private httpClient: typeof axios;
  private resolver: PlaneProjectResolver;
  private apiClient: PlaneApiClient;
  private labelCache = new Map<string, string>();

  constructor(dbAdapter: DatabaseAdapter, httpClient: typeof axios = axios) {
    this.dbAdapter = dbAdapter;
    this.httpClient = httpClient;
    this.resolver = new PlaneProjectResolver(dbAdapter);
    this.apiClient = new PlaneApiClient(httpClient as any);
  }

  /**
   * Helper to resolve project config for a ticket, using stored historical snapshot if linked,
   * or resolving current active project mapping via PlaneProjectResolver.
   */
  async getProjectConfigForTicket(ticket: any): Promise<PlaneProjectConfig> {
    const storedSlug = ticket.plane_workspace_slug || ticket.planeWorkspaceSlug;
    const storedProjId = ticket.plane_project_id || ticket.planeProjectId;

    // Test G Requirement: Historical Snapshot preservation
    // If ticket has stored historical snapshot, build config from snapshot to preserve historical link
    if (storedSlug && storedProjId) {
      const orgId = String(ticket.org_id || ticket.orgId || "org_default");
      const projectId = Number(ticket.project_id || ticket.projectId);
      try {
        const currentConfig = await this.resolver.resolveByProjectId(projectId, orgId);
        return {
          workspaceSlug: storedSlug,
          planeProjectId: storedProjId,
          apiBaseUrl: currentConfig.apiBaseUrl,
          credentialRef: currentConfig.credentialRef,
        };
      } catch {
        return {
          workspaceSlug: storedSlug,
          planeProjectId: storedProjId,
          apiBaseUrl: config.PLANE_API_URL || "https://projects.oneweb.tech",
          credentialRef: "plane_api_08c97a9323bf4854b6bae958d7577f60",
        };
      }
    }

    // Otherwise resolve current mapping by project_id
    const projectId = Number(ticket.project_id || ticket.projectId);
    const orgId = String(ticket.org_id || ticket.orgId || "org_default");
    if (projectId && !Number.isNaN(projectId)) {
      return await this.resolver.resolveByProjectId(projectId, orgId);
    }

    const ticketId = String(ticket.id || ticket.ticket_id || ticket.ticket_number);
    const { config: resolvedConfig } = await this.resolver.resolveByTicketId(ticketId);
    return resolvedConfig;
  }

  async resolvePlaneWorkItemId(ticketId: string, candidateId: string): Promise<string> {
    const { ticket } = await this.dbAdapter.getTicketCompanyContext(ticketId);
    if (!ticket) throw new Error(`Ticket not found: ${ticketId}`);

    const projectConfig = await this.getProjectConfigForTicket(ticket);
    try {
      await this.apiClient.getWorkItem(projectConfig, String(candidateId));
      return String(candidateId);
    } catch (error: any) {
      const status = error?.response?.status;
      if (status !== 403 && status !== 404) throw error;
    }

    return String(candidateId);
  }

  async syncTicketClosureToPlane(ticketId: string): Promise<PlaneTicketClosureResult> {
    const { ticket } = await this.dbAdapter.getTicketCompanyContext(ticketId);
    if (!ticket) throw new Error(`Ticket not found: ${ticketId}`);

    const planeIssueId = ticket.planeIssueId || ticket.plane_issue_id;
    if (!planeIssueId || String(planeIssueId).startsWith("mock-")) {
      return { synced: false, reason: "not_linked" };
    }

    const projectConfig = await this.getProjectConfigForTicket(ticket);
    const resolvedPlaneIssueId = await this.resolvePlaneWorkItemId(ticketId, String(planeIssueId));

    const states = await this.apiClient.listStates(projectConfig);
    const terminalState = selectPlaneTerminalState(states);
    if (!terminalState?.id) {
      throw new Error("Cannot close linked Plane work item: project has no completed or cancelled state");
    }

    await this.apiClient.patchWorkItem(projectConfig, resolvedPlaneIssueId, { state: terminalState.id });

    return {
      synced: true,
      planeIssueId: resolvedPlaneIssueId,
      stateId: terminalState.id,
      stateName: terminalState.name,
      stateGroup: terminalState.group,
    };
  }

  async syncTicketReopenToPlane(ticketId: string): Promise<PlaneTicketReopenResult> {
    const { ticket } = await this.dbAdapter.getTicketCompanyContext(ticketId);
    if (!ticket) throw new Error(`Ticket not found: ${ticketId}`);

    const planeIssueId = ticket.planeIssueId || ticket.plane_issue_id;
    if (!planeIssueId || String(planeIssueId).startsWith("mock-")) {
      return { synced: false, reason: "not_linked" };
    }

    const projectConfig = await this.getProjectConfigForTicket(ticket);
    const resolvedPlaneIssueId = await this.resolvePlaneWorkItemId(ticketId, String(planeIssueId));

    const states = await this.apiClient.listStates(projectConfig);
    // "Re-Open" where the project defines it (Excise does), else Backlog.
    const backlogState = selectPlaneReopenState(states);
    if (!backlogState?.id) throw new Error("Cannot reopen linked Plane work item: project has no Re-Open or Backlog state");

    await this.apiClient.patchWorkItem(projectConfig, resolvedPlaneIssueId, { state: backlogState.id });

    return {
      synced: true,
      planeIssueId: resolvedPlaneIssueId,
      stateId: backlogState.id,
      stateName: backlogState.name,
      stateGroup: backlogState.group,
    };
  }

  async syncMergedTicketToPlane(ticketId: string): Promise<PlaneTicketMergeResult> {
    const { ticket } = await this.dbAdapter.getTicketCompanyContext(ticketId);
    if (!ticket) throw new Error(`Ticket not found: ${ticketId}`);
    const planeIssueId = ticket.planeIssueId || ticket.plane_issue_id;
    if (!planeIssueId || String(planeIssueId).startsWith("mock-")) {
      return { synced: false, reason: "not_linked" };
    }

    const projectConfig = await this.getProjectConfigForTicket(ticket);
    const resolvedPlaneIssueId = await this.resolvePlaneWorkItemId(ticketId, String(planeIssueId));

    const states = await this.apiClient.listStates(projectConfig);
    const cancelledState = selectPlaneCancelledState(states);
    if (!cancelledState?.id) throw new Error("Cannot synchronize merged Plane work item: project has no Cancelled state");

    await this.apiClient.patchWorkItem(projectConfig, resolvedPlaneIssueId, { state: cancelledState.id });

    return {
      synced: true,
      planeIssueId: resolvedPlaneIssueId,
      stateId: cancelledState.id,
      stateName: cancelledState.name,
      stateGroup: cancelledState.group,
    };
  }

  async getOrCreatePlaneLabel(labelName: string, color = "#6366f1"): Promise<string | undefined> {
    const trimmed = labelName.trim();
    if (!trimmed) return undefined;

    const cacheKey = trimmed.toLowerCase();
    if (this.labelCache.has(cacheKey)) {
      return this.labelCache.get(cacheKey);
    }

    try {
      const defaultProjectConfig: PlaneProjectConfig = {
        workspaceSlug: config.PLANE_WORKSPACE_SLUG || "ask-natapohn",
        planeProjectId: config.PLANE_PROJECT_ID || "4e840554-dc75-4e39-b87d-db31d8bcc1c9",
        apiBaseUrl: config.PLANE_API_URL || "https://projects.oneweb.tech",
        credentialRef: config.PLANE_API_KEY || "plane_api_mock",
      };
      const projectBaseUrl = this.apiClient.getProjectBaseUrl(defaultProjectConfig);
      const requestHeaders = {
        "Content-Type": "application/json",
        "X-API-Key": config.PLANE_API_KEY || "",
      };

      // 1. Fetch existing labels for the project
      const labelsRes = await this.httpClient.get(`${projectBaseUrl}/labels/`, { headers: requestHeaders });
      const labels: Array<{ id: string; name: string }> = Array.isArray(labelsRes.data)
        ? labelsRes.data
        : Array.isArray(labelsRes.data?.results)
          ? labelsRes.data.results
          : [];

      for (const lbl of labels) {
        if (lbl.id && lbl.name) {
          this.labelCache.set(lbl.name.trim().toLowerCase(), String(lbl.id));
        }
      }

      if (this.labelCache.has(cacheKey)) {
        return this.labelCache.get(cacheKey);
      }

      // 2. Create label if it does not exist
      const createRes = await this.httpClient.post(
        `${projectBaseUrl}/labels/`,
        {
          name: trimmed,
          color: color,
        },
        { headers: requestHeaders }
      );

      if (createRes.data && createRes.data.id) {
        const newId = String(createRes.data.id);
        this.labelCache.set(cacheKey, newId);
        return newId;
      }
    } catch (err: any) {
      console.warn(`[PlaneService] Failed to resolve or create Plane label "${labelName}":`, err.response?.data?.message || err.message);
    }
    return undefined;
  }

  async syncTicketSummaryToPlane(ticketId: string): Promise<PlaneTicketSummaryResult> {
    const { ticket, companyName } = await this.dbAdapter.getTicketCompanyContext(ticketId);
    if (!ticket) throw new Error(`Ticket not found: ${ticketId}`);

    const planeIssueId = ticket.planeIssueId || ticket.plane_issue_id;
    if (!planeIssueId || String(planeIssueId).startsWith("mock-")) {
      return { synced: false, reason: "not_linked" };
    }

    const projectConfig = await this.getProjectConfigForTicket(ticket);
    const resolvedPlaneIssueId = await this.resolvePlaneWorkItemId(ticketId, String(planeIssueId));

    let ticketWithSource = ticket;
    if (ticket.conversation_id) {
      try {
        const identity = await this.dbAdapter.getConversationIdent(String(ticket.conversation_id));
        ticketWithSource = { ...ticket, channel: identity?.channel || ticket.channel };
      } catch {
        // Channel enrichment optional
      }
    }

    const payload = buildPlaneWorkItemPayload(ticketWithSource, companyName);
    await this.apiClient.patchWorkItem(projectConfig, resolvedPlaneIssueId, payload);

    return { synced: true, planeIssueId: resolvedPlaneIssueId };
  }

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

    const files = fs.readdirSync(dataDir);
    const match =
      files.find((f) => f.includes(`(${tableName})`) && f.endsWith(".json")) ||
      files.find((f) => f.includes(tableName) && f.endsWith(".json"));
    if (!match) {
      const defaultFilename = `Ticket V.2 - ${tableName} (${tableName}).json`;
      return path.join(dataDir, defaultFilename);
    }
    return path.join(dataDir, match);
  }

  private readTable<T>(tableName: string): T[] {
    const filePath = this.getFilePath(tableName);
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as T[];
  }

  private writeTable<T>(tableName: string, data: T[]): void {
    const filePath = this.getFilePath(tableName);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  }

  /**
   * Copies customer screenshots from a conversation into a Plane work item and
   * embeds them in its description.
   *
   * Shared by two callers: ticket promotion (images that arrived before the
   * ticket existed) and the webhook's late-attach path (images that arrive
   * after it). An attachment is uploaded at most once — the Plane asset id is
   * recorded in message_attachments.metadata, and Plane itself dedupes on the
   * external id — so the two callers cannot double-post the same screenshot.
   *
   * Best-effort by contract: the work item is already usable without evidence,
   * so every failure is logged and swallowed rather than failing the caller.
   */
  async pushConversationImagesToIssue(
    source: { conversationId: number; ticketNumber?: string; lineImageId?: string },
    projectConfig: any,
    planeIssueId: string,
    baseDescriptionHtml: string
  ): Promise<number> {
    // Real intake (Interaction.pdf) attaches more than one screenshot per case,
    // so this takes every unpushed image rather than only the latest.
    const MAX_IMAGES = 5;
    try {
      let imageRows: CustomerImageAttachment[] = [];

      if (source.lineImageId) {
        const { rows } = await pool.query<CustomerImageAttachment>(
          `SELECT ma.id, m.external_id, ma.storage_key, ma.file_name, ma.file_type, ma.file_size
             FROM message_attachments ma
             JOIN messages m ON m.id = ma.message_id
            WHERE m.conversation_id = $1::integer
              AND m.role = 'customer'
              AND m.external_id = $2
              AND ma.attachment_status = 'READY'
              AND ma.storage_key IS NOT NULL
              AND COALESCE(ma.file_type, '') LIKE 'image/%'
              AND COALESCE(ma.metadata->>'planeIssueId', '') = ''
            ORDER BY ma.id ASC
            LIMIT ${MAX_IMAGES}`,
          [source.conversationId, source.lineImageId]
        );
        imageRows = rows;
      }

      if (imageRows.length === 0) {
        const { rows } = await pool.query<CustomerImageAttachment>(
          `SELECT ma.id, m.external_id, ma.storage_key, ma.file_name, ma.file_type, ma.file_size
             FROM message_attachments ma
             JOIN messages m ON m.id = ma.message_id
            WHERE m.conversation_id = $1::integer
              AND m.role = 'customer'
              AND ma.attachment_status = 'READY'
              AND ma.storage_key IS NOT NULL
              AND COALESCE(ma.file_type, '') LIKE 'image/%'
              AND COALESCE(ma.metadata->>'planeIssueId', '') = ''
              AND ma.created_at >= COALESCE(
                (SELECT created_at FROM tickets
                  WHERE conversation_id = $1::integer
                    AND ($2::text IS NULL OR ticket_number <> $2::text)
                  ORDER BY id DESC LIMIT 1),
                NOW() - INTERVAL '2 hours'
              )
            ORDER BY ma.id ASC
            LIMIT ${MAX_IMAGES}`,
          [source.conversationId, source.ticketNumber || null]
        );
        imageRows = rows;
      }

      if (imageRows.length === 0) return 0;

      const uploadedAssetUrls: string[] = [];
      const mediaStorage = new S3MediaStorageService({});

      for (const image of imageRows) {
        try {
          const media = await mediaStorage.download(image.storage_key);
          const uploadRes = await this.apiClient.uploadWorkItemAttachment(projectConfig, planeIssueId, {
            name: image.file_name || `line_${image.external_id || image.id}.jpg`,
            type: image.file_type || media.mimeType || "image/jpeg",
            size: image.file_size || media.buffer.length,
            content: media.buffer,
            externalId: `ticketx-message-attachment-${image.id}`,
          });
          if (uploadRes?.assetUrl) {
            uploadedAssetUrls.push(uploadRes.assetUrl);
            await pool.query(
              `UPDATE message_attachments
                  SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
                WHERE id = $1`,
              [
                image.id,
                JSON.stringify({ planeIssueId, planeAssetUrl: uploadRes.assetUrl }),
              ]
            );
          }
        } catch (uploadErr: any) {
          console.warn("[PlaneService] Individual image upload failed:", {
            attachmentId: image.id,
            error: uploadErr?.message || String(uploadErr),
          });
        }
      }

      if (uploadedAssetUrls.length > 0) {
        const mediaEmbedHtml = `<h3>📷 Customer Screenshots / Attached Media</h3>` +
          uploadedAssetUrls
            .map((url) => `<p><img src="${escapePlaneHtml(url)}" alt="Customer Screenshot" style="max-width: 100%; border-radius: 8px; border: 1px solid #e2e8f0; margin-top: 8px;" /></p>`)
            .join("");

        await this.apiClient.patchWorkItem(projectConfig, planeIssueId, {
          description_html: `${baseDescriptionHtml}\n${mediaEmbedHtml}`,
        });
        console.log(
          `[PlaneService] Embedded ${uploadedAssetUrls.length} image(s) into Plane Work Item ${planeIssueId} description.`
        );
      }
      return uploadedAssetUrls.length;
    } catch (error: any) {
      console.warn("[PlaneService] Failed to attach customer image to Plane", {
        ticketNumber: source.ticketNumber,
        lineImageId: source.lineImageId,
        error: error?.message || String(error),
      });
      return 0;
    }
  }

  /**
   * Attaches screenshots that arrived AFTER the ticket was filed.
   *
   * Customers routinely send the report first and the screenshot seconds later,
   * by which time promotion has already run. This finds the conversation's most
   * recent live ticket and pushes any unattached image into its work item,
   * preserving the description already there.
   *
   * Returns the ticket number when something was attached, so the caller can
   * tell the customer which case the screenshot landed on.
   */
  async attachPendingImagesToOpenTicket(
    conversationId: number
  ): Promise<{ attached: number; ticketNumber?: string; otherOpenCases?: boolean }> {
    try {
      // Two rows on purpose: the newest live case is the attach target, and the
      // presence of a second one means the choice is a guess — the caller then
      // TELLS the customer which case was picked instead of guessing silently.
      const { rows } = await pool.query(
        `SELECT id, ticket_number, plane_issue_id, project_id, org_id,
                plane_workspace_slug, plane_project_id
           FROM tickets
          WHERE conversation_id = $1::integer
            AND deleted_at IS NULL
            AND plane_issue_id IS NOT NULL AND plane_issue_id <> ''
            AND UPPER(COALESCE(status, '')) NOT IN ('CLOSED', 'CANCELLED')
            AND created_at >= NOW() - INTERVAL '24 hours'
          ORDER BY id DESC
          LIMIT 2`,
        [conversationId]
      );
      const ticket = rows[0];
      if (!ticket) return { attached: 0 };
      const otherOpenCases = rows.length > 1;

      const projectConfig = await this.getProjectConfigForTicket(ticket);
      // The description already carries the report; re-fetch it so appending the
      // screenshots cannot overwrite anything Plane or an engineer added.
      const workItem = await this.apiClient.getWorkItem(projectConfig, ticket.plane_issue_id);
      const currentDescription = String(workItem?.description_html || "");

      const attached = await this.pushConversationImagesToIssue(
        { conversationId, ticketNumber: ticket.ticket_number },
        projectConfig,
        ticket.plane_issue_id,
        currentDescription
      );
      return {
        attached,
        ticketNumber: attached > 0 ? ticket.ticket_number : undefined,
        otherOpenCases: attached > 0 ? otherOpenCases : undefined,
      };
    } catch (error: any) {
      console.warn("[PlaneService] Late image attach failed", {
        conversationId,
        error: error?.message || String(error),
      });
      return { attached: 0 };
    }
  }

  /**
   * Attaches the conversation's unpushed screenshots to ONE named case — used
   * when the customer has told us (or confirmed) which case the image belongs
   * to, so no newest-first guessing is involved. The ticket must belong to the
   * same conversation, be Plane-linked and still open.
   */
  async attachPendingImagesToTicketNumber(
    conversationId: number,
    ticketNumber: string
  ): Promise<{ attached: number; ticketNumber?: string }> {
    try {
      const { rows } = await pool.query(
        `SELECT id, ticket_number, plane_issue_id, project_id, org_id,
                plane_workspace_slug, plane_project_id
           FROM tickets
          WHERE conversation_id = $1::integer
            AND UPPER(ticket_number) = UPPER($2)
            AND deleted_at IS NULL
            AND plane_issue_id IS NOT NULL AND plane_issue_id <> ''
            AND UPPER(COALESCE(status, '')) NOT IN ('CLOSED', 'CANCELLED')
          LIMIT 1`,
        [conversationId, ticketNumber]
      );
      const ticket = rows[0];
      if (!ticket) return { attached: 0 };

      const projectConfig = await this.getProjectConfigForTicket(ticket);
      const workItem = await this.apiClient.getWorkItem(projectConfig, ticket.plane_issue_id);
      const attached = await this.pushConversationImagesToIssue(
        { conversationId, ticketNumber: ticket.ticket_number },
        projectConfig,
        ticket.plane_issue_id,
        String(workItem?.description_html || "")
      );
      return { attached, ticketNumber: attached > 0 ? ticket.ticket_number : undefined };
    } catch (error: any) {
      console.warn("[PlaneService] Attach-by-number failed", {
        conversationId,
        ticketNumber,
        error: error?.message || String(error),
      });
      return { attached: 0 };
    }
  }

  async promoteTicketToPlane(ticketIdOrData: any, optionalData?: any): Promise<any> {
    let ticket: any = null;
    let companyName = "Unknown";
    let lookupId = typeof ticketIdOrData === "string" ? ticketIdOrData : (ticketIdOrData?.ticketId || ticketIdOrData?.ticket_id || ticketIdOrData?.ticket_number);

    if (lookupId) {
      try {
        const ctx = await this.dbAdapter.getTicketCompanyContext(lookupId);
        if (ctx && ctx.ticket) {
          ticket = ctx.ticket;
          companyName = ctx.companyName || "Unknown";
        }
      } catch {
        // Fallback to in-flight data if not found in database yet
      }
    }

    if (!ticket && typeof ticketIdOrData === "object") {
      ticket = ticketIdOrData.data || ticketIdOrData;
    } else if (!ticket && optionalData) {
      ticket = optionalData.data || optionalData;
    }

    if (!ticket) {
      throw new Error(`Ticket not found: ${lookupId || JSON.stringify(ticketIdOrData)}`);
    }

    const existingPlaneId = ticket.planeIssueId || ticket.plane_issue_id;
    if (existingPlaneId && !String(existingPlaneId).startsWith("mock-")) {
      console.log(`[PlaneService] Ticket ${lookupId} is already promoted to Plane Work Item ${existingPlaneId}; skipping duplicate promotion.`);
      return {
        id: String(existingPlaneId),
        ticketId: lookupId || ticket.ticket_number,
        planeIssueId: String(existingPlaneId),
        plane_issue_id: String(existingPlaneId),
        webhookTriggered: true,
        alreadyPromoted: true,
      };
    }

    // Resolve authoritative project mapping using project_id + org_id
    // Fail-closed with PLANE_MAPPING_NOT_FOUND if unmapped or missing project_id
    const projectConfig = await this.getProjectConfigForTicket(ticket);

    let ticketWithSource = ticket;
    if (ticket.conversation_id) {
      try {
        const identity = await this.dbAdapter.getConversationIdent(String(ticket.conversation_id));
        let mediaUrls: string[] = Array.isArray(ticket.media_urls) ? [...ticket.media_urls] : [];
        ticketWithSource = {
          ...ticket,
          channel: identity?.channel || ticket.channel,
          media_urls: mediaUrls,
        };
      } catch {
        // Source enrichment is optional; Ticket creation must not fail when
        // an older record has no resolvable conversation identity.
      }
    }

    const payload = buildPlaneWorkItemPayload(ticketWithSource, companyName);

    // Create Work Item in target Plane Project via PlaneApiClient
    const result = await this.apiClient.createWorkItem(projectConfig, payload);
    const planeIssueId = result.id;

    // A LINE image is stored in TicketX immediately, before the debounced AI
    // request, so screenshots the customer sent before the ticket existed are
    // copied into Plane-owned storage here. Images that arrive AFTER this point
    // are handled by attachPendingImagesToOpenTicket, called from the webhook.
    if (ticket.conversation_id) {
      await this.pushConversationImagesToIssue(
        {
          conversationId: Number(ticket.conversation_id),
          ticketNumber: ticket.ticket_number,
          lineImageId: String(ticket.line_image_id || ticket.lineImageId || "").trim(),
        },
        projectConfig,
        planeIssueId,
        payload.description_html
      );
    }

    // ATOMIC UPDATE: Save historical snapshot IF ticket exists in DB
    if (lookupId) {
      try {
        if (this.dbAdapter.updateTicketPlaneSnapshot) {
          await this.dbAdapter.updateTicketPlaneSnapshot(
            lookupId,
            projectConfig.workspaceSlug,
            projectConfig.planeProjectId,
            planeIssueId
          );
        } else {
          await this.dbAdapter.updateTicketPlaneIssue(lookupId, planeIssueId);
        }
      } catch {
        // Optional if ticket inserted later in step_5
      }
    }


    // New Urgent Alert email, originated here instead of by Plane's webhook
    // (which never arrives — ISSUE-070). Fire-and-forget: the flow answers only
    // after Gmail (~20 s) and promotion must not wait for, or fail on, it.
    void urgentAlertService
      .notifyPromoted({ ticketRef: lookupId || ticket.ticket_number || ticket.id, planeIssueId })
      .catch(() => {});

    return {
      id: planeIssueId,
      success: true,
      plane_issue_id: planeIssueId,
      plane_workspace_slug: projectConfig.workspaceSlug,
      plane_project_id: projectConfig.planeProjectId,
      ticket_id: ticket.ticket_id || ticket.id1 || ticket.id,
      status: "In Progress",
    };
  }

  async syncTicketStatusToPlane(ticketId: string, status: string): Promise<PlaneTicketReopenResult> {
    const { ticket } = await this.dbAdapter.getTicketCompanyContext(ticketId);
    if (!ticket) throw new Error(`Ticket not found: ${ticketId}`);
    const planeIssueId = ticket.planeIssueId || ticket.plane_issue_id;
    if (!planeIssueId || String(planeIssueId).startsWith("mock-")) {
      return { synced: false, reason: "not_linked" };
    }

    const projectConfig = await this.getProjectConfigForTicket(ticket);
    const resolvedPlaneIssueId = await this.resolvePlaneWorkItemId(ticketId, String(planeIssueId));

    const states = await this.apiClient.listStates(projectConfig);
    const targetState = selectPlaneStateForTicketStatus(states, status);
    if (!targetState?.id) {
      throw new Error(`Cannot synchronize Plane work item state: no matching state found for status "${status}"`);
    }

    await this.apiClient.patchWorkItem(projectConfig, resolvedPlaneIssueId, { state: targetState.id });

    return {
      synced: true,
      planeIssueId: resolvedPlaneIssueId,
      stateId: targetState.id,
      stateName: targetState.name,
      stateGroup: targetState.group,
    };
  }

  async syncTicketPriorityToPlane(ticketId: string, priority: string): Promise<{ synced: boolean; planeIssueId?: string; priority?: string; reason?: string }> {
    const { ticket } = await this.dbAdapter.getTicketCompanyContext(ticketId);
    if (!ticket) throw new Error(`Ticket not found: ${ticketId}`);
    const planeIssueId = ticket.planeIssueId || ticket.plane_issue_id;
    if (!planeIssueId || String(planeIssueId).startsWith("mock-")) {
      return { synced: false, reason: "not_linked" };
    }

    const planePriority = mapTicketPriorityToPlanePriority(priority);
    if (!planePriority) return { synced: false, reason: "unsupported_priority" };

    const projectConfig = await this.getProjectConfigForTicket(ticket);
    const resolvedPlaneIssueId = await this.resolvePlaneWorkItemId(ticketId, String(planeIssueId));

    await this.apiClient.patchWorkItem(projectConfig, resolvedPlaneIssueId, { priority: planePriority });

    return {
      synced: true,
      planeIssueId: resolvedPlaneIssueId,
      priority: planePriority,
    };
  }

}
