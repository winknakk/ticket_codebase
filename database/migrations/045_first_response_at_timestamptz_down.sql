-- Rollback for 045: back to the legacy VARCHAR representation.
ALTER TABLE tickets
  ALTER COLUMN first_response_at TYPE VARCHAR
  USING CASE WHEN first_response_at IS NULL THEN NULL ELSE first_response_at::text END;
