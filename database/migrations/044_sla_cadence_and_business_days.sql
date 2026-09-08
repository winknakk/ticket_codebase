-- 044: SLA 5-level program — cadence idempotency, business-day arithmetic,
--      response-time column, single source of truth for dev notification emails.
--
-- Everything here is additive and idempotent so the runner can replay it.

-- 1. system_constants: the table ConstantSystemService already reads
--    (constant_key / constant_value). Holds the dev-email fallback so the
--    PromptX flow SQL and the backend read ONE value instead of three
--    hardcoded copies.
CREATE TABLE IF NOT EXISTS system_constants (
  constant_key   VARCHAR(100) PRIMARY KEY,
  constant_value TEXT NOT NULL,
  description    TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO system_constants (constant_key, constant_value, description)
VALUES (
  'DEV_NOTIFICATION_FALLBACK_EMAIL',
  'natapohnagain@gmail.com',
  'Recipient for dev alerts / SLA reminders when a project has no metadata.dev_notification_emails'
)
ON CONFLICT (constant_key) DO NOTHING;

-- 2. Business-day arithmetic (Mon–Fri, Asia/Bangkok, same time-of-day).
--    Public holidays are intentionally not modelled yet.
CREATE OR REPLACE FUNCTION ticketx_add_business_days(base TIMESTAMPTZ, days INTEGER)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  local_ts  TIMESTAMP := base AT TIME ZONE 'Asia/Bangkok';
  remaining INTEGER := GREATEST(days, 0);
BEGIN
  WHILE remaining > 0 LOOP
    local_ts := local_ts + INTERVAL '1 day';
    -- ISODOW: 6 = Saturday, 7 = Sunday
    IF EXTRACT(ISODOW FROM local_ts) < 6 THEN
      remaining := remaining - 1;
    END IF;
  END LOOP;
  RETURN local_ts AT TIME ZONE 'Asia/Bangkok';
END;
$$;

-- 3. Response-time SLA target (Resolution target already lives in due_date).
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS response_due_at TIMESTAMPTZ;

-- 4. Cadence slots must be unique even with two backend instances running.
--    recipient_ref carries the slot key (ticket:<id>:dev:<n> / ticket:<id>:user:<n>).
CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_logs_cadence_slot
  ON notification_logs (ticket_id, operator_id, recipient_ref)
  WHERE operator_id IN ('dev_repeat', 'user_progress');

-- 5. Per-project dev notification recipients (JSON array). Seeded for the two
--    live projects so the fallback is no longer the only path.
UPDATE projects
SET metadata = COALESCE(metadata, '{}'::jsonb)
             || jsonb_build_object('dev_notification_emails', jsonb_build_array('natapohnagain@gmail.com'))
WHERE id IN (1, 101)
  AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'dev_notification_emails');

-- 6. Severity casing hygiene (priority is already name-based everywhere).
UPDATE tickets
SET severity = CASE LOWER(severity)
  WHEN 'low'      THEN 'Low'
  WHEN 'medium'   THEN 'Medium'
  WHEN 'high'     THEN 'High'
  WHEN 'urgent'   THEN 'Critical'
  WHEN 'critical' THEN 'Critical'
  WHEN 'none'     THEN 'None'
  ELSE severity
END
WHERE severity IS NOT NULL
  AND severity <> CASE LOWER(severity)
    WHEN 'low' THEN 'Low' WHEN 'medium' THEN 'Medium' WHEN 'high' THEN 'High'
    WHEN 'urgent' THEN 'Critical' WHEN 'critical' THEN 'Critical' WHEN 'none' THEN 'None'
    ELSE severity END;
