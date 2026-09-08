-- 045: tickets.first_response_at was a legacy VARCHAR column. The SLA program
--      (migration 044 + Ticket Operations Hub) now writes real timestamps into
--      it and the SLA console does interval arithmetic on it, so it must be a
--      TIMESTAMPTZ like created_at / response_due_at / due_date.
--      Only ISO-formatted values exist (verified: 1 populated row, written by
--      the hub as NOW()); anything unparsable becomes NULL rather than failing.
ALTER TABLE tickets
  ALTER COLUMN first_response_at TYPE TIMESTAMPTZ
  USING CASE
    WHEN first_response_at IS NULL OR first_response_at = '' THEN NULL
    WHEN first_response_at ~ '^\d{4}-\d{2}-\d{2}' THEN first_response_at::timestamptz
    ELSE NULL
  END;
