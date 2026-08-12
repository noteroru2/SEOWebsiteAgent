CREATE TABLE IF NOT EXISTS evidence_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  type text NOT NULL,
  requirement text NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'OPEN',
  source text NOT NULL,
  required boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT evidence_request_status_check CHECK (status IN ('OPEN','RESOLVED','NOT_AVAILABLE','SUPERSEDED'))
);
CREATE UNIQUE INDEX IF NOT EXISTS evidence_request_current_idx
  ON evidence_requests(opportunity_id,type,requirement) WHERE status<>'SUPERSEDED';
CREATE INDEX IF NOT EXISTS evidence_request_opportunity_idx ON evidence_requests(opportunity_id,status);

CREATE TABLE IF NOT EXISTS evidence_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES evidence_requests(id) ON DELETE CASCADE,
  source_type text NOT NULL,
  evidence jsonb NOT NULL,
  evidence_hash text NOT NULL,
  observed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS evidence_item_identity_idx ON evidence_items(request_id,evidence_hash);
CREATE INDEX IF NOT EXISTS evidence_item_request_idx ON evidence_items(request_id,created_at);
