-- 046: dedicated idempotency ledger for the SLA cadence engine.
--
-- Migration 044 parked cadence slot claims in notification_logs, but that
-- table's operator_id has a foreign key to operators(id) (human accounts), so
-- every claim with a synthetic operator ('dev_repeat' / 'user_progress')
-- failed with notification_logs_operator_id_fkey and no reminder was ever
-- sent. Slots now live in their own table with the uniqueness the engine
-- relies on, and the misplaced partial index is dropped.
CREATE TABLE IF NOT EXISTS sla_cadence_claims (
  id          SERIAL PRIMARY KEY,
  ticket_id   INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  kind        VARCHAR(16) NOT NULL,          -- 'dev' | 'user'
  slot_key    VARCHAR(120) NOT NULL,         -- ticket:<id>:<kind>:<slot|manual-…>
  channel     VARCHAR(20) NOT NULL,          -- 'email' | 'line'
  status      VARCHAR(16) NOT NULL DEFAULT 'pending',  -- pending | sent | skipped | failed
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at     TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sla_cadence_claims_slot
  ON sla_cadence_claims (ticket_id, kind, slot_key);

CREATE INDEX IF NOT EXISTS idx_sla_cadence_claims_ticket
  ON sla_cadence_claims (ticket_id, created_at DESC);

DROP INDEX IF EXISTS uq_notification_logs_cadence_slot;
