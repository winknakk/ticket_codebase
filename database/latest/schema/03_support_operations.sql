-- ============================================================
-- TicketX / PromptX Platform — Support Operations Context Schema
-- /database/latest/schema/03_support_operations.sql
-- Target Database: PostgreSQL 16+
-- ============================================================

-- 1. TICKETS
CREATE TABLE IF NOT EXISTS tickets (
  id                         SERIAL PRIMARY KEY,
  ticket_id                  VARCHAR(255) UNIQUE,
  conversation_id            INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  project_id                 INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_ticket_id           INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
  operator_id                INTEGER REFERENCES operators(id) ON DELETE SET NULL,
  assigned_pm                VARCHAR(255),
  subject                    VARCHAR(500),
  title                      VARCHAR(500),
  summary                    TEXT,
  original_problem_statement TEXT,
  running_summary            TEXT,
  last_ai_summary            TEXT,
  status                     VARCHAR(50) NOT NULL DEFAULT 'Open' CHECK (status IN ('Open','In Progress','Resolved','Closed','Duplicate','Cancelled')),
  priority                   VARCHAR(10) NOT NULL DEFAULT 'Medium' CHECK (priority IN ('Urgent','High','Medium','Low','None')),
  severity                   VARCHAR(20) DEFAULT 'Medium' CHECK (severity IN ('Critical','High','Medium','Low') OR severity IS NULL),
  issue_category             VARCHAR(100),
  created_via                VARCHAR(100) DEFAULT 'AI',
  plane_issue_id             VARCHAR(255),
  due_date                   TIMESTAMPTZ,
  first_response_at          TIMESTAMPTZ,
  resolved_at                TIMESTAMPTZ,
  closed_at                  TIMESTAMPTZ,
  sla_breached               BOOLEAN NOT NULL DEFAULT FALSE,
  sla_breach_at              TIMESTAMPTZ,
  response_sla_hours         INTEGER,
  resolution_sla_hours       INTEGER,
  sla_response_due_at        TIMESTAMPTZ,
  sla_resolve_due_at         TIMESTAMPTZ,
  sla_response_breached      BOOLEAN NOT NULL DEFAULT FALSE,
  sla_resolve_breached       BOOLEAN NOT NULL DEFAULT FALSE,
  total_sla_exposure_minutes INTEGER NOT NULL DEFAULT 0,
  reopened_count             INTEGER NOT NULL DEFAULT 0,
  last_reopened_at           TIMESTAMPTZ,
  duplicate_of_ticket_id     INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
  duplicate_score            NUMERIC(4,3),
  duplicate_reason           TEXT,
  ai_confidence_metrics      JSONB NOT NULL DEFAULT '{}',
  searchable_text            TEXT,
  enrichment_state           VARCHAR(50) DEFAULT 'pending',
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at                 TIMESTAMPTZ
);

COMMENT ON TABLE tickets IS 'Support Operations Context Aggregate Root — tracks issues, cases, and SLA performance';

CREATE INDEX idx_tickets_project_status ON tickets(project_id, status) WHERE deleted_at IS NULL;
CREATE INDEX idx_tickets_due_open ON tickets(due_date ASC) WHERE status NOT IN ('Resolved','Closed','Cancelled') AND deleted_at IS NULL;
CREATE INDEX idx_tickets_sla_breach ON tickets(sla_breached, sla_breach_at) WHERE sla_breached = TRUE;
CREATE INDEX idx_tickets_operator ON tickets(operator_id) WHERE operator_id IS NOT NULL;
CREATE INDEX idx_tickets_parent ON tickets(parent_ticket_id) WHERE parent_ticket_id IS NOT NULL;
CREATE INDEX idx_tickets_category ON tickets(project_id, issue_category) WHERE issue_category IS NOT NULL;

-- 2. TICKET EVENTS
CREATE TABLE IF NOT EXISTS ticket_events (
  id          SERIAL PRIMARY KEY,
  ticket_id   INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  event_type  VARCHAR(100) NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}',
  created_by  VARCHAR(255) DEFAULT 'system',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE ticket_events IS 'Audit history of state transitions for tickets';

CREATE INDEX idx_ticket_events_ticket ON ticket_events(ticket_id, created_at ASC);

-- 3. TICKET EMBEDDINGS
CREATE TABLE IF NOT EXISTS ticket_embeddings (
  id          SERIAL PRIMARY KEY,
  ticket_id   INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  embedding   TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. TAKEOVER SESSIONS
CREATE TABLE IF NOT EXISTS takeover_sessions (
  id              SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  ticket_id       INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
  operator_id     INTEGER NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status          VARCHAR(50) NOT NULL DEFAULT 'active' CHECK (status IN ('active','released','expired','force_released')),
  acquired_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL,
  released_at     TIMESTAMPTZ,
  release_reason  VARCHAR(100),
  notes           TEXT
);

COMMENT ON TABLE takeover_sessions IS 'Tracks human operator control sessions over support conversations/tickets';

CREATE INDEX idx_takeover_conv_status ON takeover_sessions(conversation_id, status) WHERE status = 'active';
CREATE INDEX idx_takeover_operator_time ON takeover_sessions(operator_id, acquired_at DESC);
CREATE INDEX idx_takeover_ticket ON takeover_sessions(ticket_id) WHERE ticket_id IS NOT NULL;

-- 5. CONVERSATION HANDOFFS
CREATE TABLE IF NOT EXISTS conversation_handoffs (
  id               SERIAL PRIMARY KEY,
  conversation_id  INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ticket_id        INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
  from_owner       VARCHAR(20) NOT NULL CHECK (from_owner IN ('ai','human','system')),
  to_owner         VARCHAR(20) NOT NULL CHECK (to_owner IN ('ai','human','system')),
  from_operator_id INTEGER REFERENCES operators(id) ON DELETE SET NULL,
  to_operator_id   INTEGER REFERENCES operators(id) ON DELETE SET NULL,
  trigger_type     VARCHAR(50) NOT NULL DEFAULT 'unknown' CHECK (trigger_type IN ('customer_request','ai_escalation','operator_claim','operator_release','timeout_expired','force_release','sla_breach','system')),
  trigger_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  reason           TEXT,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at         TIMESTAMPTZ,
  context_snapshot JSONB NOT NULL DEFAULT '{}'
);

COMMENT ON TABLE conversation_handoffs IS 'Full audit trail of AI to Human ownership handoffs';

CREATE INDEX idx_handoffs_conversation ON conversation_handoffs(conversation_id, started_at DESC);
CREATE INDEX idx_handoffs_operator ON conversation_handoffs(to_operator_id, started_at DESC) WHERE to_operator_id IS NOT NULL;
CREATE INDEX idx_handoffs_ticket ON conversation_handoffs(ticket_id) WHERE ticket_id IS NOT NULL;

-- 6. INTERNAL NOTES
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

COMMENT ON TABLE internal_notes IS 'Operator-only internal notes attached to conversations or tickets';

CREATE INDEX idx_notes_conv ON internal_notes(conversation_id, created_at DESC);
CREATE INDEX idx_notes_ticket ON internal_notes(ticket_id) WHERE ticket_id IS NOT NULL;
