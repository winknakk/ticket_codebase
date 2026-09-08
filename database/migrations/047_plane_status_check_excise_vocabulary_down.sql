-- Down for 047: fold the Excise labels back into the legacy four, then
-- restore the 040 constraint.
UPDATE tickets SET plane_status = CASE
  WHEN plane_status IN ('Todo', 'Triaged', 'Re-Open') THEN 'Backlog'
  WHEN plane_status IN ('In Progress', 'Test Failed', 'Waiting for Customer', 'Delivery to Customer') THEN 'Open'
  WHEN plane_status = 'Close' THEN 'Done'
  ELSE plane_status END
WHERE plane_status IS NOT NULL;

ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_plane_status_check;
ALTER TABLE tickets
  ADD CONSTRAINT tickets_plane_status_check
  CHECK (plane_status IS NULL OR plane_status IN ('Backlog', 'Open', 'Done', 'Cancelled'));

DELETE FROM schema_migrations WHERE version = '047_plane_status_check_excise_vocabulary.sql';
