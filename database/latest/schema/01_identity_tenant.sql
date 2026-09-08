-- ============================================================
-- TicketX / PromptX Platform — Identity & Tenant Context Schema
-- /database/latest/schema/01_identity_tenant.sql
-- Target Database: PostgreSQL 16+
-- ============================================================

-- 1. COMPANIES
CREATE TABLE IF NOT EXISTS companies (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(255) NOT NULL,
  slug       VARCHAR(100) NOT NULL UNIQUE,
  plan_tier  VARCHAR(50) NOT NULL DEFAULT 'starter' CHECK (plan_tier IN ('starter','professional','enterprise')),
  status     VARCHAR(50) NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','churned')),
  settings   JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

COMMENT ON TABLE companies IS 'Root tenant entity for multi-tenant isolation';
COMMENT ON COLUMN companies.slug IS 'URL-safe unique identifier for tenant routing';

CREATE INDEX idx_companies_slug ON companies(slug);
CREATE INDEX idx_companies_status ON companies(status) WHERE deleted_at IS NULL;

-- 2. TEAMS
CREATE TABLE IF NOT EXISTS teams (
  id             SERIAL PRIMARY KEY,
  company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name           VARCHAR(255) NOT NULL,
  description    TEXT,
  parent_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  status         VARCHAR(50) NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, name)
);

COMMENT ON TABLE teams IS 'Organizational hierarchy within a tenant company';

CREATE INDEX idx_teams_company ON teams(company_id, status);

-- 3. PROJECTS
CREATE TABLE IF NOT EXISTS projects (
  id           SERIAL PRIMARY KEY,
  company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  team_id      INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  name         VARCHAR(255) NOT NULL,
  slug         VARCHAR(100) NOT NULL,
  project_type VARCHAR(100) DEFAULT 'Support',
  environment  VARCHAR(255) DEFAULT 'production',
  status       VARCHAR(50) NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','suspended')),
  timezone     VARCHAR(100) NOT NULL DEFAULT 'Asia/Bangkok',
  settings     JSONB NOT NULL DEFAULT '{}',
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at   TIMESTAMPTZ,
  UNIQUE (company_id, slug)
);

COMMENT ON TABLE projects IS 'Project workspaces within a tenant company';

CREATE INDEX idx_projects_company ON projects(company_id, status) WHERE deleted_at IS NULL;

-- 4. OPERATORS
CREATE TABLE IF NOT EXISTS operators (
  id              SERIAL PRIMARY KEY,
  company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  primary_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  email           VARCHAR(255) NOT NULL,
  name            VARCHAR(255) NOT NULL,
  display_name    VARCHAR(255),
  avatar_url      TEXT,
  role            VARCHAR(50) NOT NULL DEFAULT 'agent' CHECK (role IN ('super_admin','admin','manager','agent','readonly')),
  status          VARCHAR(50) NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','suspended')),
  password_hash   TEXT,
  last_login_at   TIMESTAMPTZ,
  settings        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ,
  UNIQUE (company_id, email)
);

COMMENT ON TABLE operators IS 'Human support agents, managers, and system administrators';

CREATE INDEX idx_operators_company ON operators(company_id, status) WHERE deleted_at IS NULL;

-- 5. PROFILES
CREATE TABLE IF NOT EXISTS profiles (
  id                     SERIAL PRIMARY KEY,
  company_id             INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name                   VARCHAR(255) NOT NULL DEFAULT 'Unknown Customer',
  display_name           VARCHAR(255),
  email                  VARCHAR(255),
  phone                  VARCHAR(50),
  avatar_url             TEXT,
  locale                 VARCHAR(20) NOT NULL DEFAULT 'th',
  timezone               VARCHAR(100) NOT NULL DEFAULT 'Asia/Bangkok',
  metadata               JSONB NOT NULL DEFAULT '{}',
  gdpr_consent_at        TIMESTAMPTZ,
  gdpr_erased_at         TIMESTAMPTZ,
  is_pii_erased          BOOLEAN NOT NULL DEFAULT FALSE,
  data_region            VARCHAR(20) NOT NULL DEFAULT 'TH',
  merged_into_profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
  merged_at              TIMESTAMPTZ,
  is_merged              BOOLEAN NOT NULL DEFAULT FALSE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at             TIMESTAMPTZ
);

COMMENT ON TABLE profiles IS 'Customer profiles aggregated across channels';

CREATE INDEX idx_profiles_company ON profiles(company_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_profiles_email ON profiles(email) WHERE email IS NOT NULL;
CREATE INDEX idx_profiles_phone ON profiles(phone) WHERE phone IS NOT NULL;

-- 6. IDENTITIES
CREATE TABLE IF NOT EXISTS identities (
  id                 SERIAL PRIMARY KEY,
  profile_id         INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
  channel            VARCHAR(50) NOT NULL CHECK (channel IN ('line','line_group','line_room','whatsapp','email','webchat','facebook','instagram','telegram','internal')),
  channel_ref        VARCHAR(500) NOT NULL,
  channel_name       VARCHAR(255),
  avatar_url         TEXT,
  account_type       VARCHAR(50) NOT NULL DEFAULT 'individual' CHECK (account_type IN ('individual','corporate','bot','internal','anonymous')),
  is_shared_account  BOOLEAN NOT NULL DEFAULT FALSE,
  is_pii             BOOLEAN NOT NULL DEFAULT TRUE,
  gdpr_erased_at     TIMESTAMPTZ,
  push_token         TEXT,
  token_expires_at   TIMESTAMPTZ,
  metadata           JSONB NOT NULL DEFAULT '{}',
  verified_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at         TIMESTAMPTZ,
  UNIQUE (channel, channel_ref)
);

COMMENT ON TABLE identities IS 'Channel-specific identities mapped to customer profiles';

CREATE INDEX idx_identities_profile ON identities(profile_id) WHERE profile_id IS NOT NULL;
CREATE INDEX idx_identities_channel_ref ON identities(channel, channel_ref);

-- 7. CUSTOMER ENROLLMENTS
CREATE TABLE IF NOT EXISTS customer_enrollments (
  id                SERIAL PRIMARY KEY,
  profile_id        INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  project_id        INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  company_id        INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  enrollment_source VARCHAR(50) NOT NULL DEFAULT 'first_contact' CHECK (enrollment_source IN ('first_contact','imported','invited','proactive','api')),
  enrollment_type   VARCHAR(50) NOT NULL DEFAULT 'customer' CHECK (enrollment_type IN ('customer','vip','internal','blocked')),
  first_contact_at  TIMESTAMPTZ,
  enrolled_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  enrolled_by       INTEGER REFERENCES operators(id) ON DELETE SET NULL,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  notes             TEXT,
  UNIQUE (profile_id, project_id)
);

COMMENT ON TABLE customer_enrollments IS 'Explicit profile membership within projects';

CREATE INDEX idx_enrollments_profile ON customer_enrollments(profile_id, is_active);
CREATE INDEX idx_enrollments_project ON customer_enrollments(project_id, enrollment_type) WHERE is_active = TRUE;

-- 8. PROJECT CHANNELS
CREATE TABLE IF NOT EXISTS project_channels (
  id                        SERIAL PRIMARY KEY,
  project_id                INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  channel_type              VARCHAR(50) NOT NULL CHECK (channel_type IN ('line','whatsapp','email','webchat','instagram','telegram')),
  channel_id                VARCHAR(255) NOT NULL,
  channel_name              VARCHAR(255),
  secret_token              TEXT,
  credentials_json          JSONB NOT NULL DEFAULT '{}',
  secret_token_encrypted   BYTEA,
  credentials_encrypted    BYTEA,
  encryption_key_id        VARCHAR(200),
  encrypted_at             TIMESTAMPTZ,
  webhook_url               TEXT,
  verify_token              VARCHAR(500),
  active                    BOOLEAN NOT NULL DEFAULT TRUE,
  last_verified_at          TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, channel_type, channel_id)
);

COMMENT ON TABLE project_channels IS 'Channel configurations and encrypted API secrets';

-- 9. PROJECT PROMPTS
CREATE TABLE IF NOT EXISTS project_prompts (
  id             SERIAL PRIMARY KEY,
  project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  prompt_text    TEXT NOT NULL,
  version        INTEGER NOT NULL DEFAULT 1,
  version_label  VARCHAR(100),
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  ab_weight      NUMERIC(5,2) NOT NULL DEFAULT 100.00,
  activated_at   TIMESTAMPTZ,
  deactivated_at TIMESTAMPTZ,
  created_by     INTEGER REFERENCES operators(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE project_prompts IS 'AI system prompts and version history';

CREATE UNIQUE INDEX idx_project_prompts_one_active ON project_prompts(project_id) WHERE is_active = TRUE;

-- 10. PROJECT SLA POLICIES
CREATE TABLE IF NOT EXISTS project_sla_policies (
  id            SERIAL PRIMARY KEY,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  priority      VARCHAR(10) NOT NULL CHECK (priority IN ('Urgent','High','Medium','Low','None')),
  response_hours NUMERIC(5,2) NOT NULL,
  resolve_hours  NUMERIC(5,2) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, priority)
);

-- 11. PROJECT AI SETTINGS
CREATE TABLE IF NOT EXISTS project_ai_settings (
  id                  SERIAL PRIMARY KEY,
  project_id          INTEGER NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  auto_reply_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
  confidence_threshold NUMERIC(3,2) NOT NULL DEFAULT 0.75,
  model_name          VARCHAR(100) NOT NULL DEFAULT 'gpt-4o',
  temperature         NUMERIC(3,2) NOT NULL DEFAULT 0.20,
  max_tokens          INTEGER NOT NULL DEFAULT 1000,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 12. PROJECT BUSINESS HOURS
CREATE TABLE IF NOT EXISTS project_business_hours (
  id         SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  day_of_week INT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time TIME NOT NULL,
  end_time   TIME NOT NULL,
  is_working BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (project_id, day_of_week)
);

-- 13. PROJECT HOLIDAYS
CREATE TABLE IF NOT EXISTS project_holidays (
  id           SERIAL PRIMARY KEY,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  holiday_date DATE NOT NULL,
  name         VARCHAR(255) NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, holiday_date)
);

-- 14. PROJECT FEATURE FLAGS
CREATE TABLE IF NOT EXISTS project_feature_flags (
  id           SERIAL PRIMARY KEY,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  flag_key     VARCHAR(100) NOT NULL,
  enabled      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, flag_key)
);
