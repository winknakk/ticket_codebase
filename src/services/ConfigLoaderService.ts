import { pool } from "../adapters/postgres/PostgresAdapter";
import { CacheService } from "../cache/CacheService";
import { createLogger } from "../observability/logger";
import { PromptConfig, SlaPolicy, RoutingRules } from "../domain/repositories/IConfigurationRepository";

const logger = createLogger("ConfigLoaderService");

export interface AiSettings {
  confidenceThreshold: number;
  maxHandoffDepth: number;
  vectorMatchThreshold: number;
}

export class ConfigLoaderService {
  private static instance: ConfigLoaderService;
  private cache: CacheService;

  private constructor() {
    this.cache = CacheService.getInstance();
  }

  static getInstance(): ConfigLoaderService {
    if (!ConfigLoaderService.instance) {
      ConfigLoaderService.instance = new ConfigLoaderService();
    }
    return ConfigLoaderService.instance;
  }

  /**
   * Retrieves prompt settings scoped to a specific project.
   */
  async getPromptConfig(projectId: string): Promise<PromptConfig> {
    const cacheKey = `config:project:${projectId}:prompt`;
    const cached = await this.cache.get<PromptConfig>(cacheKey);
    if (cached) return cached;

    logger.info({ projectId }, "Cache miss: loading project prompt config from DB");
    const { rows } = await pool.query(
      `SELECT system_instruction, model_name, temperature, max_tokens 
       FROM project_prompts 
       WHERE project_id = $1 
       ORDER BY id DESC 
       LIMIT 1`,
      [projectId]
    );

    let allowedTools: string[] = [];
    try {
      const permRes = await pool.query(
        "SELECT tool_name FROM project_mcp_permissions WHERE project_id = $1::integer",
        [parseInt(projectId, 10)]
      );
      allowedTools = permRes.rows.map((r: any) => r.tool_name);
    } catch (dbErr: any) {
      logger.warn({ projectId, error: dbErr.message }, "Failed to query permissions for prompt config compilation");
      allowedTools = ["search_project_docs", "create_ticket"];
    }

    let aiProfileContext = "";
    try {
      const compRes = await pool.query(
        `SELECT c.ai_profile_context 
         FROM projects p 
         JOIN companies c ON p.company_id = c.id 
         WHERE p.id = $1::integer 
         LIMIT 1`,
        [parseInt(projectId, 10)]
      );
      if (compRes.rows.length > 0) {
        aiProfileContext = compRes.rows[0].ai_profile_context || "";
      }
    } catch (err: any) {
      logger.warn({ projectId, error: err.message }, "Failed to load company ai_profile_context for prompt config compilation");
    }

    let systemInstruction = rows.length > 0 ? rows[0].system_instruction : "You are an helpful AI Assistant designed to resolve tickets and support customers.";
    
    // Interpolate activepieces company context placeholders if present
    const placeholderRegex = /\{\{\s*step_1\.output\.rows\[0\]\.ai_profile_context\s*\}\}/gi;
    if (placeholderRegex.test(systemInstruction)) {
      systemInstruction = systemInstruction.replace(placeholderRegex, aiProfileContext);
    } else if (aiProfileContext) {
      // Otherwise append company context as a directive
      systemInstruction = `${systemInstruction}\n\n[Company Context]\n${aiProfileContext}`;
    }

    // Append project context scoping and allowed tools
    const dynamicDirective = `\n\n[System Project Context Scope]\nActive Project ID: ${projectId}\nYou are operating strictly under the scope of Project ${projectId}. You can only view knowledge base documents and create/retrieve tickets that are bound to this active project scope. You are authorized to run the following MCP tools: ${allowedTools.join(", ")}. Any other tools are strictly unauthorized and blocked by the platform security policy engine.`;
    
    systemInstruction = systemInstruction + dynamicDirective;

    const config: PromptConfig = {
      systemInstruction,
      modelName: rows.length > 0 ? rows[0].model_name : 'gemini-1.5-pro',
      temperature: rows.length > 0 ? parseFloat(rows[0].temperature) : 0.00,
      maxTokens: rows.length > 0 ? rows[0].max_tokens : 2048
    };

    await this.cache.set(cacheKey, config, 3600); // cache for 1 hour
    return config;
  }

  /**
   * Retrieves SLA policies mapped to a specific project.
   */
  async getSlaPolicy(projectId: string): Promise<SlaPolicy> {
    const cacheKey = `config:project:${projectId}:sla`;
    const cached = await this.cache.get<SlaPolicy>(cacheKey);
    if (cached) return cached;

    logger.info({ projectId }, "Cache miss: loading project SLA policy from DB");
    const { rows } = await pool.query(
      `SELECT priority, resolve_hours 
       FROM project_sla_policies 
       WHERE project_id = $1`,
      [projectId]
    );

    const policies = rows.map(r => ({
      priority: r.priority,
      resolveHours: r.resolve_hours
    }));

    const config: SlaPolicy = { policies };
    await this.cache.set(cacheKey, config, 3600);
    return config;
  }

  /**
   * Retrieves routing rules mapped to a specific project.
   */
  async getRoutingRules(projectId: string): Promise<RoutingRules> {
    const cacheKey = `config:project:${projectId}:routing`;
    const cached = await this.cache.get<RoutingRules>(cacheKey);
    if (cached) return cached;

    logger.info({ projectId }, "Cache miss: loading project routing rules from DB");
    const { rows } = await pool.query(
      `SELECT rule_type, conditions, target_handler 
       FROM project_routing_rules 
       WHERE project_id = $1`,
      [projectId]
    );

    const rules = rows.map(r => ({
      ruleType: r.rule_type,
      conditions: r.conditions,
      targetHandler: r.target_handler
    }));

    const config: RoutingRules = { rules };
    await this.cache.set(cacheKey, config, 3600);
    return config;
  }

  /**
   * Retrieves AI Settings mapped to a specific project.
   */
  async getAiSettings(projectId: string): Promise<AiSettings> {
    const cacheKey = `config:project:${projectId}:ai_settings`;
    const cached = await this.cache.get<AiSettings>(cacheKey);
    if (cached) return cached;

    logger.info({ projectId }, "Cache miss: loading project AI settings from DB");
    const { rows } = await pool.query(
      `SELECT confidence_threshold, max_handoff_depth, vector_match_threshold 
       FROM project_ai_settings 
       WHERE project_id = $1 
       LIMIT 1`,
      [projectId]
    );

    const config: AiSettings = rows.length > 0 ? {
      confidenceThreshold: parseFloat(rows[0].confidence_threshold),
      maxHandoffDepth: rows[0].max_handoff_depth,
      vectorMatchThreshold: parseFloat(rows[0].vector_match_threshold)
    } : {
      confidenceThreshold: 0.70,
      maxHandoffDepth: 5,
      vectorMatchThreshold: 0.60
    };

    await this.cache.set(cacheKey, config, 3600);
    return config;
  }

  /**
   * Resolves a project's feature flag value dynamically.
   */
  async getFeatureFlag(projectId: string, flagName: string): Promise<boolean> {
    const cacheKey = `config:project:${projectId}:flag:${flagName}`;
    const cached = await this.cache.get<boolean>(cacheKey);
    if (cached !== null) return cached;

    logger.info({ projectId, flagName }, "Cache miss: loading project feature flag from DB");
    const { rows } = await pool.query(
      `SELECT is_enabled 
       FROM project_feature_flags 
       WHERE project_id = $1 AND flag_name = $2 
       LIMIT 1`,
      [projectId, flagName]
    );

    const isEnabled = rows.length > 0 ? rows[0].is_enabled : false;
    await this.cache.set(cacheKey, isEnabled, 300); // short TTL for feature flags (5 minutes)
    return isEnabled;
  }

  /**
   * Retrieves Dev Notification Emails mapped to a specific project.
   */
  async getDevNotificationEmails(projectId: string): Promise<string[]> {
    const cacheKey = `config:project:${projectId}:dev_emails`;
    const cached = await this.cache.get<string[]>(cacheKey);
    if (cached) return cached;

    logger.info({ projectId }, "Cache miss: loading project dev notification emails from DB");
    // projects has a `metadata` JSONB column (there is no `settings` column —
    // the previous query threw 42703 on every call). The key is a JSON array;
    // the legacy singular string key is honoured as a fallback.
    const { rows } = await pool.query(
      `SELECT metadata->'dev_notification_emails' AS dev_emails,
              metadata->>'dev_notification_email' AS legacy_email
       FROM projects
       WHERE id = $1
       LIMIT 1`,
      [projectId]
    );

    let devEmails: string[] = [];
    if (rows.length > 0) {
      const parsed = rows[0].dev_emails;
      if (Array.isArray(parsed)) {
        devEmails = parsed.map((v: unknown) => String(v).trim()).filter(Boolean);
      } else if (rows[0].legacy_email) {
        devEmails = [String(rows[0].legacy_email).trim()];
      }
    }

    await this.cache.set(cacheKey, devEmails, 3600);
    return devEmails;
  }

  /**
   * Invalidates all configurations cached for a specific project.
   */
  async invalidateProjectCache(projectId: string): Promise<void> {
    logger.info({ projectId }, "Invalidating cached configurations for project");
    await this.cache.delete(`config:project:${projectId}:prompt`);
    await this.cache.delete(`config:project:${projectId}:sla`);
    await this.cache.delete(`config:project:${projectId}:routing`);
    await this.cache.delete(`config:project:${projectId}:ai_settings`);
    await this.cache.delete(`config:project:${projectId}:dev_emails`);
  }
}
