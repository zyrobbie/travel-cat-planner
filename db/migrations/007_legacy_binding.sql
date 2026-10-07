-- An explicit single local archive binds once; no anonymous IDs become auth IDs.
ALTER TABLE legacy_bindings ADD COLUMN IF NOT EXISTS logical_cat_id text;
ALTER TABLE legacy_bindings ADD COLUMN IF NOT EXISTS bundle_hash text;
ALTER TABLE legacy_bindings ADD COLUMN IF NOT EXISTS provenance jsonb;
DO $$ BEGIN
  ALTER TABLE legacy_bindings ADD CONSTRAINT legacy_binding_metadata CHECK(
    logical_cat_id IS NOT NULL AND logical_cat_id=source_experience_id
    AND bundle_hash IS NOT NULL AND bundle_hash ~ '^[a-f0-9]{64}$'
    AND provenance IS NOT NULL AND jsonb_typeof(provenance)='object'
    AND provenance ?& ARRAY['sourceSchema','controlRevision','tripCount','omitted','unknownTimes']
    AND provenance - ARRAY['sourceSchema','controlRevision','tripCount','omitted','unknownTimes'] = '{}'::jsonb);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS legacy_binding_cat ON legacy_bindings(cat_id,account_id);
CREATE TABLE IF NOT EXISTS legacy_binding_requests (
  account_id uuid NOT NULL REFERENCES accounts(id), key uuid NOT NULL,
  cat_id uuid NOT NULL, bundle_hash text NOT NULL CHECK(bundle_hash ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(account_id,key),
  FOREIGN KEY(cat_id,account_id) REFERENCES cat_profiles(id,account_id),
  CHECK(jsonb_typeof(result)='object'
    AND result ?& ARRAY['catId','logicalCatId','importBatchId','bundleHash','stateRevision']
    AND result - ARRAY['catId','logicalCatId','importBatchId','bundleHash','stateRevision'] = '{}'::jsonb)
);
CREATE INDEX IF NOT EXISTS legacy_binding_request_cat ON legacy_binding_requests(cat_id,account_id);

-- Legacy schema 3 did not keep deletion/creation timestamps on response records.
-- A null is explicit provenance, never a fabricated date of importing as history.
ALTER TABLE cloud_responses ALTER COLUMN created_at DROP NOT NULL;
ALTER TABLE cloud_responses ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'SERVER'
  CHECK(origin IN ('SERVER','LEGACY'));
DO $$ BEGIN
  ALTER TABLE cloud_responses ADD CONSTRAINT cloud_response_known_created CHECK(origin='LEGACY' OR created_at IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The approved local schema allows an empty, already exhausted calendar.
ALTER TABLE cloud_calendars DROP CONSTRAINT IF EXISTS cloud_calendars_node_count_check;
ALTER TABLE cloud_calendars ADD CONSTRAINT cloud_calendars_node_count_check CHECK(node_count BETWEEN 0 AND 10000);
