-- 047: widen tickets.plane_status to the Excise Plane vocabulary.
--
-- Migration 040 pinned plane_status to the four legacy labels
-- ('Backlog','Open','Done','Cancelled'). The state machine now writes the
-- project's real state names (Triaged, In Progress, Test Failed, Waiting for
-- Customer, Delivery to Customer, Re-Open, Close), so every reverse-sync
-- transition into one of those labels failed with
-- tickets_plane_status_check and the poller silently retried it every 30 s
-- (seen live 2026-09-07: EXAI-67 Delivery to Customer never reached the
-- customer; the retries also drove Plane into 429 RATE_LIMIT_EXCEEDED).
--
-- Reversible: 047_..._down.sql restores the 040 constraint after mapping the
-- new labels back to the legacy four.
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_plane_status_check;

ALTER TABLE tickets
  ADD CONSTRAINT tickets_plane_status_check
  CHECK (
    plane_status IS NULL
    OR plane_status IN (
      -- legacy (040)
      'Backlog', 'Open', 'Done', 'Cancelled',
      -- Excise project states (2026-09-07)
      'Todo', 'Triaged', 'In Progress', 'Test Failed', 'Waiting for Customer',
      'Delivery to Customer', 'Re-Open', 'Close'
    )
  );

INSERT INTO schema_migrations (version)
VALUES ('047_plane_status_check_excise_vocabulary.sql')
ON CONFLICT DO NOTHING;
