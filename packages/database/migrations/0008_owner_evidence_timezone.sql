ALTER TABLE evidence_items ADD COLUMN IF NOT EXISTS observed_timezone text;
CREATE INDEX IF NOT EXISTS evidence_items_observed_timezone_idx
  ON evidence_items(observed_timezone) WHERE observed_timezone IS NOT NULL;
