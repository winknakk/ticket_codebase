-- ============================================================
-- AutomationX V3 — Migration 014: Production Readiness
-- 014_production_readiness.sql
-- Date: 2026-07-20
-- Author: Database Architecture Review
-- Purpose: Fix all critical issues before production deployment
--          Must run AFTER migrations 001-013
-- ============================================================

-- ============================================================
-- SECTION 1: OPERATORS TABLE (Critical — FK anchor for all user references)
-- ============================================================

CREATE TABLE IF NOT EXISTS operators (
  id            SERIAL PRIMARY KEY,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  email         VARCHAR(255) NOT NULL,
  name          VARCHAR(255) NOT NULL,
  display_name  VARCHAR(255),
  avatar_url    TEXT,
  role          VARCHAR(50) NOT NULL DEFAULT 'agent'
                CHECK (role IN ('super_admin','admin','manager','agent','readonly')),
  status        VARCHAR(50) NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','inactive','suspended')),
  password_hash TEXT,
  last_login_at TIMESTAMPTZ,
  settings      JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, email)
);

CREATE TABLE IF NOT EXISTS operator_project_access (
  operator_id INTEGER NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role        VARCHAR(50) NOT NULL DEFAULT 'agent'
              CHECK (role IN ('manager','agent','readonly')),
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  granted_by  INTEGER REFERENCES operators(id) ON DELETE SET NULL,
  PRIMARY KEY (operator_id, project_id)
);

CREATE INDEX IF NOT EXISTS idx_operators_company_status ON operators(company_id, status);
CREATE INDEX IF NOT EXISTS idx_operators_email          ON operators(email);
CREATE INDEX IF NOT EXISTS idx_op_access_project        ON operator_project_access(project_id);

-- ============================================================
-- SECTION 2: FIX conversations TABLE
-- ============================================================

-- Add conversation_type for group/multi-party support (Milestone 3)
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS conversation_type VARCHAR(50) NOT NULL DEFAULT 'direct';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'conversations_type_check'
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_type_check
      CHECK (conversation_type IN ('direct','group','multi_party','internal'));
  END IF;
END $$;

-- Add operator FK (replace VARCHAR assigned_pm)
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS operator_id INTEGER REFERENCES operators(id) ON DELETE SET NULL;

-- Add takeover state (persistent, Redis is ephemeral)
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS takeover_state VARCHAR(50) NOT NULL DEFAULT 'none';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'conversations_takeover_check'
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_takeover_check
      CHECK (takeover_state IN ('none','requested','active','released'));
  END IF;
END $$;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS takeover_operator_id INTEGER REFERENCES operators(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS takeover_expires_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_message_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closed_at             TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS metadata              JSONB NOT NULL DEFAULT '{}';

-- Add status CHECK if not exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'conversations_status_check'
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_status_check
      CHECK (status IN ('open','pending','escalated','resolved','closed'));
  END IF;
END $$;

-- Fix handled_by CHECK
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'conversations_handled_by_check'
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_handled_by_check
      CHECK (handled_by IN ('ai','human','bot','system'));
  END IF;
END $$;

-- Missing indexes for inbox performance
CREATE INDEX IF NOT EXISTS idx_conv_project_status_last
  ON conversations(project_id, status, last_message_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_conv_operator
  ON conversations(operator_id) WHERE operator_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conv_takeover_active
  ON conversations(takeover_state) WHERE takeover_state = 'active';

-- ============================================================
-- SECTION 3: FIX messages TABLE (Generic Message Architecture)
-- ============================================================

-- Add message_type for rich content support
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS message_type VARCHAR(50) NOT NULL DEFAULT 'text';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'messages_type_check'
  ) THEN
    ALTER TABLE messages
      ADD CONSTRAINT messages_type_check
      CHECK (message_type IN (
        'text','image','audio','video','file','sticker',
        'location','template','carousel','quick_reply',
        'internal_note','system_event','ai_thinking'
      ));
  END IF;
END $$;

-- Add sender identity columns
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS sender_type  VARCHAR(20) NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS sender_id    VARCHAR(255),         -- operator id or identity channel_ref
  ADD COLUMN IF NOT EXISTS operator_id  INTEGER REFERENCES operators(id) ON DELETE SET NULL;

-- Add structured content for rich messages
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS content_json JSONB NOT NULL DEFAULT '{}';

-- Add message state columns
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS is_recalled           BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS recalled_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS edited_at             TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_visible_to_customer BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS is_visible_to_operator BOOLEAN NOT NULL DEFAULT TRUE;

-- Add AI performance metadata
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS ai_model       VARCHAR(100),
  ADD COLUMN IF NOT EXISTS ai_confidence  NUMERIC(4,3),
  ADD COLUMN IF NOT EXISTS processing_ms  INTEGER;

-- Add CHECK for role
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'messages_role_check'
  ) THEN
    ALTER TABLE messages
      ADD CONSTRAINT messages_role_check
      CHECK (role IN ('customer','ai','human','system','bot','internal'));
  END IF;
END $$;

-- Better index for chat history loading
CREATE INDEX IF NOT EXISTS idx_messages_conv_created
  ON messages(conversation_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_messages_type
  ON messages(conversation_id, message_type);

CREATE INDEX IF NOT EXISTS idx_messages_operator
  ON messages(operator_id) WHERE operator_id IS NOT NULL;

-- ============================================================
-- SECTION 4: FIX tickets TABLE
-- ============================================================

-- Add operator FK
ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS operator_id INTEGER REFERENCES operators(id) ON DELETE SET NULL;

-- Add SLA tracking columns (REQUIRED for SLA calculation)
ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS first_response_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolved_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closed_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sla_breached         BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS sla_breach_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS response_sla_hours   INTEGER,
  ADD COLUMN IF NOT EXISTS resolution_sla_hours INTEGER,
  ADD COLUMN IF NOT EXISTS updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Make project_id NOT NULL (production requirement)
-- Note: backfill first if needed
UPDATE tickets SET project_id = 1 WHERE project_id IS NULL;
ALTER TABLE tickets ALTER COLUMN project_id SET NOT NULL;

-- Add CHECK constraints for integrity
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tickets_status_check') THEN
    ALTER TABLE tickets ADD CONSTRAINT tickets_status_check
      CHECK (status IN ('Open','In Progress','Resolved','Closed','Duplicate','Cancelled'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tickets_priority_check') THEN
    ALTER TABLE tickets ADD CONSTRAINT tickets_priority_check
      CHECK (priority IN ('Urgent','High','Medium','Low','None'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tickets_severity_check') THEN
    ALTER TABLE tickets ADD CONSTRAINT tickets_severity_check
      CHECK (severity IN ('Critical','High','Medium','Low') OR severity IS NULL);
  END IF;
END $$;

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_tickets_project_status
  ON tickets(project_id, status);

CREATE INDEX IF NOT EXISTS idx_tickets_due_open
  ON tickets(due_date ASC)
  WHERE status NOT IN ('Resolved','Closed','Cancelled');

CREATE INDEX IF NOT EXISTS idx_tickets_sla_breach
  ON tickets(sla_breached, sla_breach_at)
  WHERE sla_breached = TRUE;

CREATE INDEX IF NOT EXISTS idx_tickets_operator
  ON tickets(operator_id) WHERE operator_id IS NOT NULL;

-- ============================================================
-- SECTION 5: FIX document_embeddings (Multi-tenant RAG isolation)
-- ============================================================

-- Add project_id FK (CRITICAL: prevents cross-project vector leakage)
ALTER TABLE document_embeddings
  ADD COLUMN IF NOT EXISTS project_id    INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS company_id    INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS document_type VARCHAR(50) NOT NULL DEFAULT 'knowledge',
  ADD COLUMN IF NOT EXISTS title         VARCHAR(500),
  ADD COLUMN IF NOT EXISTS source_url    TEXT,
  ADD COLUMN IF NOT EXISTS chunk_index   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS chunk_total   INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS language      VARCHAR(20) NOT NULL DEFAULT 'th',
  ADD COLUMN IF NOT EXISTS is_active     BOOLEAN NOT NULL DEFAULT TRUE;

-- Critical: project-isolated search index
CREATE INDEX IF NOT EXISTS idx_doc_embed_project_active
  ON document_embeddings(project_id, is_active)
  WHERE is_active = TRUE;

-- ============================================================
-- SECTION 6: FIX outbox_events (Add aggregate reference)
-- ============================================================

ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS aggregate_type VARCHAR(100),
  ADD COLUMN IF NOT EXISTS aggregate_id   VARCHAR(255),
  ADD COLUMN IF NOT EXISTS project_id     INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS next_retry_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS processed_at   TIMESTAMPTZ;

-- Fix: index for worker polling (was missing `next_retry_at` from index)
DROP INDEX IF EXISTS idx_outbox_events_status;
CREATE INDEX IF NOT EXISTS idx_outbox_status_retry
  ON outbox_events(status, next_retry_at ASC NULLS FIRST)
  WHERE status IN ('pending','failed');

CREATE INDEX IF NOT EXISTS idx_outbox_aggregate
  ON outbox_events(aggregate_type, aggregate_id)
  WHERE aggregate_id IS NOT NULL;

-- ============================================================
-- SECTION 7: FIX traces TABLE (Add project scope)
-- ============================================================

ALTER TABLE traces
  ADD COLUMN IF NOT EXISTS project_id    INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS token_input   INTEGER,
  ADD COLUMN IF NOT EXISTS token_output  INTEGER,
  ADD COLUMN IF NOT EXISTS cost_usd      NUMERIC(10,6),
  ADD COLUMN IF NOT EXISTS latency_ms    INTEGER;

CREATE INDEX IF NOT EXISTS idx_traces_project_time
  ON traces(project_id, called_at DESC)
  WHERE project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_traces_called_at
  ON traces(called_at DESC);

-- ============================================================
-- SECTION 8: FIX message_attachments (Enterprise media support)
-- ============================================================

-- Upgrade file_size to BIGINT
ALTER TABLE message_attachments
  ALTER COLUMN file_size TYPE BIGINT;

ALTER TABLE message_attachments
  ADD COLUMN IF NOT EXISTS mime_type         VARCHAR(100),
  ADD COLUMN IF NOT EXISTS storage_provider  VARCHAR(50) NOT NULL DEFAULT 'local',
  ADD COLUMN IF NOT EXISTS storage_key       TEXT,
  ADD COLUMN IF NOT EXISTS thumbnail_url     TEXT,
  ADD COLUMN IF NOT EXISTS attachment_type   VARCHAR(50) NOT NULL DEFAULT 'file',
  ADD COLUMN IF NOT EXISTS duration_seconds  INTEGER,
  ADD COLUMN IF NOT EXISTS width             INTEGER,
  ADD COLUMN IF NOT EXISTS height            INTEGER,
  ADD COLUMN IF NOT EXISTS is_safe           BOOLEAN,
  ADD COLUMN IF NOT EXISTS scanned_at        TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attachments_type_check') THEN
    ALTER TABLE message_attachments
      ADD CONSTRAINT attachments_type_check
      CHECK (attachment_type IN ('image','audio','video','document','sticker','location','file'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_attachments_message
  ON message_attachments(message_id);

CREATE INDEX IF NOT EXISTS idx_attachments_type
  ON message_attachments(attachment_type);

-- ============================================================
-- SECTION 9: CREATE conversation_participants (Milestone 3 — Group conversations)
-- ============================================================

CREATE TABLE IF NOT EXISTS conversation_participants (
  id               SERIAL PRIMARY KEY,
  conversation_id  INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  identity_id      VARCHAR(255),
  operator_id      INTEGER REFERENCES operators(id) ON DELETE SET NULL,
  participant_type VARCHAR(50) NOT NULL DEFAULT 'customer'
                   CHECK (participant_type IN ('customer','operator','ai','observer')),
  role             VARCHAR(50) NOT NULL DEFAULT 'member'
                   CHECK (role IN ('owner','admin','member')),
  joined_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  left_at          TIMESTAMPTZ,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_participants_conv_active
  ON conversation_participants(conversation_id, is_active)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_participants_identity
  ON conversation_participants(identity_id)
  WHERE identity_id IS NOT NULL;

-- ============================================================
-- SECTION 10: CREATE takeover_sessions (Milestone 5 — Persistent takeover record)
-- ============================================================

CREATE TABLE IF NOT EXISTS takeover_sessions (
  id              SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  operator_id     INTEGER NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status          VARCHAR(50) NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','released','expired','force_released')),
  acquired_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL,
  released_at     TIMESTAMPTZ,
  release_reason  VARCHAR(100),
  notes           TEXT
);

CREATE INDEX IF NOT EXISTS idx_takeover_conv_status
  ON takeover_sessions(conversation_id, status)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_takeover_operator_time
  ON takeover_sessions(operator_id, acquired_at DESC);

CREATE INDEX IF NOT EXISTS idx_takeover_expires
  ON takeover_sessions(expires_at)
  WHERE status = 'active';

-- ============================================================
-- SECTION 11: CREATE internal_notes (Milestone 5 — Operator notes)
-- ============================================================

CREATE TABLE IF NOT EXISTS internal_notes (
  id              SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  ticket_id       INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
  operator_id     INTEGER NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  content         TEXT NOT NULL,
  is_pinned       BOOLEAN NOT NULL DEFAULT FALSE,
  mentioned_ops   INTEGER[] NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notes_conv_time
  ON internal_notes(conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notes_ticket
  ON internal_notes(ticket_id)
  WHERE ticket_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_notes_pinned
  ON internal_notes(conversation_id, is_pinned)
  WHERE is_pinned = TRUE;

-- ============================================================
-- SECTION 12: CREATE company_holiday_calendars (SLA compliance)
-- ============================================================

CREATE TABLE IF NOT EXISTS company_holiday_calendars (
  id           SERIAL PRIMARY KEY,
  company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name         VARCHAR(255) NOT NULL,
  country_code VARCHAR(10) NOT NULL DEFAULT 'TH',
  is_default   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS company_holidays (
  id           SERIAL PRIMARY KEY,
  calendar_id  INTEGER NOT NULL REFERENCES company_holiday_calendars(id) ON DELETE CASCADE,
  holiday_date DATE NOT NULL,
  name         VARCHAR(255) NOT NULL,
  holiday_type VARCHAR(50) NOT NULL DEFAULT 'public'
               CHECK (holiday_type IN ('public','company','regional','optional')),
  is_full_day  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (calendar_id, holiday_date)
);

-- Link project business hours to company holiday calendar
ALTER TABLE project_business_hours
  ADD COLUMN IF NOT EXISTS holiday_calendar_id INTEGER
    REFERENCES company_holiday_calendars(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_company_holidays_cal_date
  ON company_holidays(calendar_id, holiday_date);

-- ============================================================
-- SECTION 13: CREATE ai_thinking_traces (Milestone 6 — Agent reasoning)
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_thinking_traces (
  id               SERIAL PRIMARY KEY,
  trace_id         UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),
  conversation_id  INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id       INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  thinking_content TEXT,
  reasoning_steps  JSONB NOT NULL DEFAULT '[]',
  tool_calls       JSONB NOT NULL DEFAULT '[]',
  final_action     VARCHAR(100),
  confidence_score NUMERIC(4,3),
  input_tokens     INTEGER,
  output_tokens    INTEGER,
  latency_ms       INTEGER,
  model_name       VARCHAR(100),
  policy_flags     JSONB NOT NULL DEFAULT '[]',
  guardrail_result VARCHAR(50)
                   CHECK (guardrail_result IN ('pass','block','warn') OR guardrail_result IS NULL),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_traces_conv_time
  ON ai_thinking_traces(conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_traces_project_time
  ON ai_thinking_traces(project_id, created_at DESC);

-- ============================================================
-- SECTION 14: CREATE ai_memory (Milestone 9 — Long-term memory)
-- ============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vector') THEN
    EXECUTE '
      CREATE TABLE IF NOT EXISTS ai_memory (
        id               SERIAL PRIMARY KEY,
        profile_id       INTEGER REFERENCES profiles(id) ON DELETE CASCADE,
        project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        memory_type      VARCHAR(50) NOT NULL
                         CHECK (memory_type IN (''preference'',''fact'',''issue'',''resolution'',''context'')),
        key              VARCHAR(255) NOT NULL,
        value            TEXT NOT NULL,
        value_embedding  VECTOR(1536),
        source_conv_id   INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
        source_ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
        confidence       NUMERIC(3,2) NOT NULL DEFAULT 1.00,
        expires_at       TIMESTAMPTZ,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    ';
  ELSE
    CREATE TABLE IF NOT EXISTS ai_memory (
      id               SERIAL PRIMARY KEY,
      profile_id       INTEGER REFERENCES profiles(id) ON DELETE CASCADE,
      project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      memory_type      VARCHAR(50) NOT NULL
                       CHECK (memory_type IN ('preference','fact','issue','resolution','context')),
      key              VARCHAR(255) NOT NULL,
      value            TEXT NOT NULL,
      value_embedding  TEXT,
      source_conv_id   INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
      source_ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
      confidence       NUMERIC(3,2) NOT NULL DEFAULT 1.00,
      expires_at       TIMESTAMPTZ,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ai_memory_profile_project
  ON ai_memory(profile_id, project_id)
  WHERE profile_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ai_memory_type
  ON ai_memory(project_id, memory_type, key);

-- ============================================================
-- SECTION 15: FIX admin_audit_logs (Add operator reference)
-- ============================================================

ALTER TABLE admin_audit_logs
  ADD COLUMN IF NOT EXISTS operator_id INTEGER REFERENCES operators(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ip_address   INET,
  ADD COLUMN IF NOT EXISTS user_agent   TEXT;

CREATE INDEX IF NOT EXISTS idx_audit_project_time
  ON admin_audit_logs(project_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_audit_operator
  ON admin_audit_logs(operator_id, timestamp DESC)
  WHERE operator_id IS NOT NULL;

-- ============================================================
-- SECTION 16: ADD updated_at trigger function (All tables)
-- ============================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply to conversations
DROP TRIGGER IF EXISTS trg_conversations_updated_at ON conversations;
CREATE TRIGGER trg_conversations_updated_at
  BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Apply to tickets
DROP TRIGGER IF EXISTS trg_tickets_updated_at ON tickets;
CREATE TRIGGER trg_tickets_updated_at
  BEFORE UPDATE ON tickets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Apply to operators
DROP TRIGGER IF EXISTS trg_operators_updated_at ON operators;
CREATE TRIGGER trg_operators_updated_at
  BEFORE UPDATE ON operators
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Apply to internal_notes
DROP TRIGGER IF EXISTS trg_notes_updated_at ON internal_notes;
CREATE TRIGGER trg_notes_updated_at
  BEFORE UPDATE ON internal_notes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Apply to ai_memory
DROP TRIGGER IF EXISTS trg_ai_memory_updated_at ON ai_memory;
CREATE TRIGGER trg_ai_memory_updated_at
  BEFORE UPDATE ON ai_memory
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- SECTION 17: SEED default operator for migration compatibility
-- ============================================================

-- Seed default admin operator so existing assigned_pm can map
INSERT INTO operators (id, company_id, email, name, role, status)
VALUES (1, 1, 'admin@automationx.local', 'System Admin', 'super_admin', 'active')
ON CONFLICT DO NOTHING;

-- ============================================================
-- END OF MIGRATION 014
-- ============================================================

-- Summary of changes:
-- [NEW]     operators table + operator_project_access
-- [NEW]     conversation_participants (Milestone 3)
-- [NEW]     takeover_sessions (Milestone 5)
-- [NEW]     internal_notes (Milestone 5)
-- [NEW]     company_holiday_calendars + company_holidays (SLA chain)
-- [NEW]     ai_thinking_traces (Milestone 6)
-- [NEW]     ai_memory (Milestone 9)
-- [FIXED]   conversations: operator_id FK, takeover_state, last_message_at, closed_at
-- [FIXED]   messages: message_type, sender_type, content_json, is_recalled
-- [FIXED]   tickets: operator_id FK, SLA timestamps, NOT NULL project_id, CHECK constraints
-- [FIXED]   document_embeddings: project_id FK (CRITICAL for multi-tenant RAG)
-- [FIXED]   outbox_events: aggregate reference columns
-- [FIXED]   traces: project_id scope, token/cost tracking
-- [FIXED]   message_attachments: mime_type, storage metadata, attachment_type
-- [FIXED]   project_business_hours: holiday_calendar_id FK
-- [ADDED]   updated_at triggers on all major tables
-- [ADDED]   Performance indexes for inbox, SLA, RAG, and analytics queries
