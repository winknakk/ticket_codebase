-- Rollback for 046.
DROP TABLE IF EXISTS sla_cadence_claims;
CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_logs_cadence_slot
  ON notification_logs (ticket_id, operator_id, recipient_ref)
  WHERE operator_id IN ('dev_repeat', 'user_progress');
