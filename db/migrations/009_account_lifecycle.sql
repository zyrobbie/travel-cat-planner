-- E4-C defaults closed; only explicit reconciliation opens this database.
CREATE TABLE lifecycle_control (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 status text NOT NULL DEFAULT 'CLOSED' CHECK(status IN ('CLOSED','READY')),
 ledger_id uuid, ledger_sequence bigint NOT NULL DEFAULT 0 CHECK(ledger_sequence>=0),
 ledger_hash text NOT NULL DEFAULT '', reconciled_at timestamptz
);
INSERT INTO lifecycle_control(singleton) VALUES(true);
CREATE TABLE deletion_preparations (
 request_id uuid PRIMARY KEY, account_id uuid NOT NULL UNIQUE REFERENCES accounts(id),
 request_key uuid NOT NULL, receipt_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(account_id,request_key)
);
ALTER TABLE account_deletions ADD COLUMN phase text NOT NULL DEFAULT 'QUEUED' CHECK(phase IN ('QUEUED','ERASING','COMPLETE'));
ALTER TABLE account_deletions ADD COLUMN last_error text;
ALTER TABLE account_deletions ADD COLUMN attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0);
ALTER TABLE account_deletions ADD COLUMN receipt_closed boolean NOT NULL DEFAULT false;
CREATE TABLE erased_legacy_sources (
 source_hash text PRIMARY KEY CHECK(source_hash ~ '^[a-f0-9]{64}$'),
 account_id uuid NOT NULL, request_id uuid NOT NULL, erased_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE account_exports (
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts(id), request_key uuid NOT NULL,
 status text NOT NULL CHECK(status IN ('QUEUED','BUILDING','READY','FAILED','EXPIRED','REVOKED')),
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz,
 cat_id uuid, captured_revision bigint, artifact_name text, artifact_hash text, artifact_bytes bigint,
 lease_token uuid, lease_until timestamptz, attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0), last_error text,
 UNIQUE(account_id,request_key),
 CHECK ((status='BUILDING')=(lease_token IS NOT NULL AND lease_until IS NOT NULL)),
 CHECK (status<>'READY' OR (artifact_name IS NOT NULL AND artifact_hash IS NOT NULL AND expires_at IS NOT NULL)),
 CHECK(artifact_name IS NULL OR artifact_name ~ '^[a-f0-9-]{36}\.[a-f0-9-]{36}\.json$')
);
CREATE INDEX account_exports_owner ON account_exports(account_id,created_at DESC);
CREATE INDEX account_exports_due ON account_exports(status,lease_until) WHERE status IN ('QUEUED','BUILDING');
