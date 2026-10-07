-- Additive E4 business storage; legacy invitation tables remain untouched.
CREATE TABLE IF NOT EXISTS cloud_content_versions (
  content_id text NOT NULL, version text NOT NULL,
  type text NOT NULL CHECK (type IN ('DEMAND','ORDINARY','LINKED','TIP','SYSTEM')),
  payload jsonb NOT NULL, body_checksum text NOT NULL, payload_checksum text NOT NULL,
  PRIMARY KEY (content_id,version)
);
CREATE OR REPLACE FUNCTION cloud_immutable_content() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Cloud content versions are immutable'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS cloud_content_immutable ON cloud_content_versions;
CREATE TRIGGER cloud_content_immutable BEFORE UPDATE ON cloud_content_versions
FOR EACH ROW EXECUTE FUNCTION cloud_immutable_content();

CREATE TABLE IF NOT EXISTS cloud_state (
  cat_id uuid PRIMARY KEY, account_id uuid NOT NULL, revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  FOREIGN KEY(cat_id,account_id) REFERENCES cat_profiles(id,account_id)
);
CREATE INDEX IF NOT EXISTS cloud_state_account ON cloud_state(account_id);
CREATE TABLE IF NOT EXISTS cloud_trips (
  id text NOT NULL, cat_id uuid NOT NULL, account_id uuid NOT NULL,
  scene text NOT NULL, status text NOT NULL CHECK(status IN ('ACTIVE','COMPLETE')),
  started_at timestamptz, ended_at timestamptz, planned_start_at timestamptz, planned_end_at timestamptz,
  origin text NOT NULL DEFAULT 'SERVER' CHECK(origin IN ('SERVER','LEGACY')),
  PRIMARY KEY(cat_id,id), UNIQUE(account_id,cat_id,id),
  FOREIGN KEY(cat_id,account_id) REFERENCES cat_profiles(id,account_id)
);
CREATE INDEX IF NOT EXISTS cloud_trips_account ON cloud_trips(account_id,cat_id);
CREATE UNIQUE INDEX IF NOT EXISTS cloud_one_active_trip ON cloud_trips(cat_id) WHERE status='ACTIVE';
CREATE TABLE IF NOT EXISTS cloud_letters (
  id text NOT NULL, cat_id uuid NOT NULL, account_id uuid NOT NULL,
  type text NOT NULL CHECK(type IN ('DEMAND','POSTCARD')),
  content_id text, content_version text, snapshot jsonb NOT NULL,
  trip_id text, story_id text, calendar_node_id text,
  delivered_at timestamptz NOT NULL DEFAULT now(), planned_at timestamptz, effective_at timestamptz,
  read_at timestamptz, skipped_at timestamptz,
  origin text NOT NULL DEFAULT 'SERVER' CHECK(origin IN ('SERVER','LEGACY')),
  PRIMARY KEY(cat_id,id), UNIQUE(account_id,cat_id,id),
  FOREIGN KEY(cat_id,account_id) REFERENCES cat_profiles(id,account_id),
  FOREIGN KEY(account_id,cat_id,trip_id) REFERENCES cloud_trips(account_id,cat_id,id),
  FOREIGN KEY(content_id,content_version) REFERENCES cloud_content_versions(content_id,version),
  CHECK ((content_id IS NULL)=(content_version IS NULL)),
  CHECK (jsonb_typeof(snapshot)='object' AND snapshot ?& ARRAY['title','body','catName'] AND jsonb_typeof(snapshot->'title')='string'
    AND jsonb_typeof(snapshot->'body')='string' AND jsonb_typeof(snapshot->'catName')='string'),
  CHECK (jsonb_typeof(COALESCE(snapshot->'tip','null'::jsonb)) IN ('string','null')
    AND jsonb_typeof(COALESCE(snapshot->'scene','null'::jsonb)) IN ('string','null')
    AND jsonb_typeof(COALESCE(snapshot->'season','null'::jsonb)) IN ('string','null')
    AND jsonb_typeof(COALESCE(snapshot->'timeOfDay','null'::jsonb)) IN ('string','null')
    AND jsonb_typeof(COALESCE(snapshot->'contentId','null'::jsonb)) IN ('string','null')
    AND jsonb_typeof(COALESCE(snapshot->'contentVersion','null'::jsonb)) IN ('string','null')),
  CHECK (snapshot - ARRAY['title','body','catName','tip','scene','season','timeOfDay','contentId','contentVersion'] = '{}'::jsonb),
  CHECK(skipped_at IS NULL OR type='DEMAND')
);
CREATE INDEX IF NOT EXISTS cloud_letters_account ON cloud_letters(account_id,cat_id);
CREATE INDEX IF NOT EXISTS cloud_letters_trip ON cloud_letters(account_id,cat_id,trip_id);
CREATE INDEX IF NOT EXISTS cloud_letters_content ON cloud_letters(content_id,content_version);
CREATE INDEX IF NOT EXISTS cloud_letters_mailbox ON cloud_letters(cat_id,delivered_at DESC,id);
CREATE UNIQUE INDEX IF NOT EXISTS cloud_letter_content_once ON cloud_letters(cat_id,content_id) WHERE content_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS cloud_one_postcard_per_trip ON cloud_letters(cat_id,trip_id) WHERE type='POSTCARD' AND trip_id IS NOT NULL;
CREATE OR REPLACE FUNCTION cloud_immutable_letter() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-ARRAY['read_at','skipped_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['read_at','skipped_at'])
  THEN RAISE EXCEPTION 'Delivered cloud letters are immutable'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS cloud_letter_immutable ON cloud_letters;
CREATE TRIGGER cloud_letter_immutable BEFORE UPDATE ON cloud_letters
FOR EACH ROW EXECUTE FUNCTION cloud_immutable_letter();

CREATE TABLE IF NOT EXISTS cloud_responses (
  id text NOT NULL, cat_id uuid NOT NULL, account_id uuid NOT NULL, letter_id text NOT NULL,
  current_revision integer NOT NULL CHECK(current_revision>0),
  status text NOT NULL CHECK(status IN ('ACTIVE','DELETED')),
  created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  PRIMARY KEY(cat_id,id), UNIQUE(account_id,cat_id,id), UNIQUE(cat_id,letter_id),
  FOREIGN KEY(cat_id,account_id) REFERENCES cat_profiles(id,account_id),
  FOREIGN KEY(account_id,cat_id,letter_id) REFERENCES cloud_letters(account_id,cat_id,id)
);
CREATE INDEX IF NOT EXISTS cloud_responses_account_letter ON cloud_responses(account_id,cat_id,letter_id);
CREATE TABLE IF NOT EXISTS cloud_response_revisions (
  cat_id uuid NOT NULL, account_id uuid NOT NULL, response_id text NOT NULL,
  revision integer NOT NULL CHECK(revision>0), text text, at timestamptz,
  PRIMARY KEY(cat_id,response_id,revision), UNIQUE(account_id,cat_id,response_id,revision),
  FOREIGN KEY(cat_id,account_id) REFERENCES cat_profiles(id,account_id),
  FOREIGN KEY(account_id,cat_id,response_id) REFERENCES cloud_responses(account_id,cat_id,id),
  CHECK(text IS NULL OR char_length(text) BETWEEN 1 AND 2000)
);
CREATE INDEX IF NOT EXISTS cloud_revisions_account ON cloud_response_revisions(account_id,cat_id,response_id);
DO $$ BEGIN
  ALTER TABLE cloud_responses ADD CONSTRAINT cloud_response_current_revision
    FOREIGN KEY(cat_id,id,current_revision) REFERENCES cloud_response_revisions(cat_id,response_id,revision)
    DEFERRABLE INITIALLY DEFERRED;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS cloud_reviews (
  id text NOT NULL, cat_id uuid NOT NULL, account_id uuid NOT NULL, trip_id text NOT NULL,
  story_id text NOT NULL, fallback_id text NOT NULL, kind text NOT NULL CHECK(kind IN ('LINKED','ORDINARY')),
  status text NOT NULL CHECK(status IN ('SELECTED','NEEDS_REVIEW','DELIVERED','EXPIRED')), reason text NOT NULL DEFAULT '',
  PRIMARY KEY(cat_id,id), UNIQUE(account_id,cat_id,id),
  FOREIGN KEY(cat_id,account_id) REFERENCES cat_profiles(id,account_id),
  FOREIGN KEY(account_id,cat_id,trip_id) REFERENCES cloud_trips(account_id,cat_id,id)
);
CREATE INDEX IF NOT EXISTS cloud_reviews_trip ON cloud_reviews(account_id,cat_id,trip_id);
CREATE TABLE IF NOT EXISTS cloud_letter_sources (
  cat_id uuid NOT NULL, account_id uuid NOT NULL, letter_id text NOT NULL, source_order integer NOT NULL CHECK(source_order>=0),
  response_id text NOT NULL, revision integer NOT NULL, claim text NOT NULL,
  start_offset integer NOT NULL CHECK(start_offset>=0), end_offset integer NOT NULL CHECK(end_offset>start_offset),
  assessment text NOT NULL CHECK(assessment IN ('SUPPORTED','NEGATED','CONDITION_MISMATCH','UNCERTAIN')),
  attested boolean NOT NULL DEFAULT false,
  PRIMARY KEY(cat_id,letter_id,source_order),
  FOREIGN KEY(cat_id,account_id) REFERENCES cat_profiles(id,account_id),
  FOREIGN KEY(account_id,cat_id,letter_id) REFERENCES cloud_letters(account_id,cat_id,id),
  FOREIGN KEY(account_id,cat_id,response_id,revision) REFERENCES cloud_response_revisions(account_id,cat_id,response_id,revision)
);
CREATE INDEX IF NOT EXISTS cloud_letter_sources_owner ON cloud_letter_sources(account_id,cat_id,letter_id);
CREATE INDEX IF NOT EXISTS cloud_letter_sources_response ON cloud_letter_sources(account_id,cat_id,response_id,revision);
DROP TRIGGER IF EXISTS cloud_letter_sources_immutable ON cloud_letter_sources;
CREATE TRIGGER cloud_letter_sources_immutable BEFORE UPDATE ON cloud_letter_sources
FOR EACH ROW EXECUTE FUNCTION cloud_immutable_content();
CREATE TABLE IF NOT EXISTS cloud_review_sources (
  cat_id uuid NOT NULL, account_id uuid NOT NULL, review_id text NOT NULL, source_order integer NOT NULL CHECK(source_order>=0),
  response_id text NOT NULL, revision integer NOT NULL, claim text NOT NULL,
  start_offset integer NOT NULL CHECK(start_offset>=0), end_offset integer NOT NULL CHECK(end_offset>start_offset),
  assessment text NOT NULL CHECK(assessment IN ('SUPPORTED','NEGATED','CONDITION_MISMATCH','UNCERTAIN')),
  attested boolean NOT NULL DEFAULT false,
  PRIMARY KEY(cat_id,review_id,source_order),
  FOREIGN KEY(cat_id,account_id) REFERENCES cat_profiles(id,account_id),
  FOREIGN KEY(account_id,cat_id,review_id) REFERENCES cloud_reviews(account_id,cat_id,id),
  FOREIGN KEY(account_id,cat_id,response_id,revision) REFERENCES cloud_response_revisions(account_id,cat_id,response_id,revision)
);
CREATE INDEX IF NOT EXISTS cloud_review_sources_owner ON cloud_review_sources(account_id,cat_id,review_id);
CREATE INDEX IF NOT EXISTS cloud_review_sources_response ON cloud_review_sources(account_id,cat_id,response_id,revision);
CREATE TABLE IF NOT EXISTS cloud_requests (
  account_id uuid NOT NULL, cat_id uuid NOT NULL,
  operation text NOT NULL CHECK(operation IN ('SEND_RESPONSE','EDIT_RESPONSE','DELETE_RESPONSE')),
  key uuid NOT NULL, payload_hash text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(account_id,operation,key),
  FOREIGN KEY(cat_id,account_id) REFERENCES cat_profiles(id,account_id),
  CHECK(jsonb_typeof(result)='object' AND result - ARRAY['message','responseId','revision','stateRevision','safety'] = '{}'::jsonb)
);
CREATE INDEX IF NOT EXISTS cloud_requests_cat ON cloud_requests(cat_id,account_id);
