CREATE TABLE IF NOT EXISTS owner_fact_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  provenance text NOT NULL CHECK (provenance='OWNER_CONFIRMED_DIRECT'),
  confirmed_by text NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  review_status text NOT NULL CHECK (review_status='OWNER_CONFIRMED'),
  source_context text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_context IS NULL OR char_length(source_context)<=200)
);

CREATE INDEX IF NOT EXISTS owner_fact_confirmations_site_idx
  ON owner_fact_confirmations(site_id,confirmed_at DESC);

ALTER TABLE owner_facts
  ALTER COLUMN source_evidence_item_id DROP NOT NULL;

ALTER TABLE owner_facts
  ADD COLUMN IF NOT EXISTS direct_confirmation_id uuid
    REFERENCES owner_fact_confirmations(id) ON DELETE RESTRICT;

DO $$ BEGIN
  ALTER TABLE owner_facts ADD CONSTRAINT owner_facts_exactly_one_provenance_check
    CHECK (num_nonnulls(source_evidence_item_id,direct_confirmation_id)=1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS owner_fact_confirmation_links (
  fact_id uuid NOT NULL REFERENCES owner_facts(id) ON DELETE CASCADE,
  confirmation_id uuid NOT NULL REFERENCES owner_fact_confirmations(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(fact_id,confirmation_id)
);

CREATE INDEX IF NOT EXISTS owner_fact_confirmation_links_confirmation_idx
  ON owner_fact_confirmation_links(confirmation_id);
