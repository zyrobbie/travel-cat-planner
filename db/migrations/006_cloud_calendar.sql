-- No backfill: existing A/B1 cats do not silently acquire a fresh calendar.
CREATE TABLE IF NOT EXISTS cloud_calendars (
  cat_id uuid PRIMARY KEY, account_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK(version=1),
  initialized_at timestamptz NOT NULL, base_at timestamptz NOT NULL,
  offset_ms bigint NOT NULL DEFAULT 0 CHECK(offset_ms>=0 AND offset_ms<=8000000000000000),
  last_effective_at timestamptz NOT NULL,
  processed_count integer NOT NULL DEFAULT 0 CHECK(processed_count>=0),
  node_count integer NOT NULL DEFAULT 13 CHECK(node_count BETWEEN 1 AND 10000),
  UNIQUE(account_id,cat_id),
  FOREIGN KEY(cat_id,account_id) REFERENCES cat_profiles(id,account_id)
);
CREATE TABLE IF NOT EXISTS cloud_calendar_nodes (
  cat_id uuid NOT NULL, account_id uuid NOT NULL, id text NOT NULL,
  planned_at timestamptz NOT NULL, node_order integer NOT NULL CHECK(node_order>=0),
  kind text NOT NULL CHECK(kind IN ('DEMAND','START','POSTCARD','END')),
  trip_id text, scene text CHECK(scene IN ('RHINE','FIREFLY','LIGHTHOUSE')), content_id text,
  origin text NOT NULL DEFAULT 'FIXED' CHECK(origin IN ('FIXED','LEGACY','MANUAL')),
  result_outcome text CHECK(result_outcome IN ('APPLIED','SKIPPED')),
  result_reason text, written_at timestamptz, effective_at timestamptz, letter_id text,
  PRIMARY KEY(cat_id,id), UNIQUE(cat_id,node_order),
  FOREIGN KEY(account_id,cat_id) REFERENCES cloud_calendars(account_id,cat_id),
  FOREIGN KEY(account_id,cat_id,letter_id) REFERENCES cloud_letters(account_id,cat_id,id),
  CHECK((kind='DEMAND' AND content_id IS NOT NULL AND trip_id IS NULL AND scene IS NULL)
    OR (kind IN ('START','POSTCARD','END') AND content_id IS NULL AND trip_id IS NOT NULL AND scene IS NOT NULL)),
  CHECK((result_outcome IS NULL AND result_reason IS NULL AND written_at IS NULL AND effective_at IS NULL AND letter_id IS NULL)
    OR (result_outcome IS NOT NULL AND result_reason IS NOT NULL AND written_at IS NOT NULL AND effective_at IS NOT NULL)),
  CHECK(letter_id IS NULL OR (result_outcome='APPLIED' AND kind IN ('DEMAND','POSTCARD')))
);
CREATE INDEX IF NOT EXISTS cloud_nodes_owner ON cloud_calendar_nodes(account_id,cat_id);
CREATE INDEX IF NOT EXISTS cloud_nodes_letter ON cloud_calendar_nodes(account_id,cat_id,letter_id);
CREATE INDEX IF NOT EXISTS cloud_nodes_due ON cloud_calendar_nodes(cat_id,planned_at,node_order) WHERE result_outcome IS NULL;
CREATE TABLE IF NOT EXISTS cloud_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), cat_id uuid NOT NULL UNIQUE, account_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'READY' CHECK(status IN ('READY','LEASED','FAILED','COMPLETE')),
  next_run_at timestamptz, lease_token uuid, lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0), last_error text,
  FOREIGN KEY(account_id,cat_id) REFERENCES cloud_calendars(account_id,cat_id),
  CHECK((status='LEASED' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
    OR (status<>'LEASED' AND lease_token IS NULL AND lease_until IS NULL)),
  CHECK((status='COMPLETE' AND next_run_at IS NULL) OR (status<>'COMPLETE' AND next_run_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS cloud_jobs_account ON cloud_jobs(account_id,cat_id);
CREATE INDEX IF NOT EXISTS cloud_jobs_due ON cloud_jobs(next_run_at) WHERE status IN ('READY','LEASED');

ALTER TABLE cloud_reviews ADD COLUMN IF NOT EXISTS review_authority text NOT NULL DEFAULT 'UNVERIFIED'
  CHECK(review_authority IN ('UNVERIFIED','INTERNAL_ADMIN'));
ALTER TABLE cloud_reviews ADD COLUMN IF NOT EXISTS reviewed_by text;
ALTER TABLE cloud_reviews ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
DO $$ BEGIN
  ALTER TABLE cloud_reviews ADD CONSTRAINT cloud_review_authority_fields CHECK(
    (review_authority='UNVERIFIED' AND reviewed_by IS NULL AND reviewed_at IS NULL)
    OR (review_authority='INTERNAL_ADMIN' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS cloud_review_requests (
  cat_id uuid NOT NULL, account_id uuid NOT NULL, key uuid NOT NULL,
  payload_hash text NOT NULL, review_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(account_id,key),
  FOREIGN KEY(account_id,cat_id,review_id) REFERENCES cloud_reviews(account_id,cat_id,id)
);
CREATE INDEX IF NOT EXISTS cloud_review_request_owner ON cloud_review_requests(account_id,cat_id,review_id);
