-- Rollback for 044. Data edits (metadata seed, severity casing) are left in
-- place: they are valid under the previous code as well.
DROP INDEX IF EXISTS uq_notification_logs_cadence_slot;
ALTER TABLE tickets DROP COLUMN IF EXISTS response_due_at;
DROP FUNCTION IF EXISTS ticketx_add_business_days(TIMESTAMPTZ, INTEGER);
DELETE FROM system_constants WHERE constant_key = 'DEV_NOTIFICATION_FALLBACK_EMAIL';
-- system_constants itself is kept: ConstantSystemService tolerates it either way.
