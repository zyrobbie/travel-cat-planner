-- E4-A is additive. Legacy invitation sessions and immutable content stay intact.
CREATE TABLE accounts (
  id uuid PRIMARY KEY,
  email_normalized text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DELETING','DELETED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK ((status = 'DELETED') = (deleted_at IS NOT NULL))
);
CREATE UNIQUE INDEX accounts_live_email ON accounts(email_normalized) WHERE status <> 'DELETED';

CREATE TABLE email_challenges (
  id uuid PRIMARY KEY,
  email_normalized text NOT NULL,
  subject_account_id uuid REFERENCES accounts(id),
  purpose text NOT NULL CHECK (purpose = 'LOGIN'),
  code_hash text NOT NULL,
  failures integer NOT NULL DEFAULT 0 CHECK (failures BETWEEN 0 AND 5),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  delivery_status text NOT NULL CHECK (delivery_status IN ('PENDING','SENT','FAILED'))
);
CREATE INDEX email_challenges_email_time ON email_challenges(email_normalized,created_at DESC);

CREATE TABLE account_sessions (
  token_hash text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX account_sessions_owner ON account_sessions(account_id);

CREATE TABLE cat_profiles (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL UNIQUE REFERENCES accounts(id),
  participant_id uuid NOT NULL UNIQUE REFERENCES participants(id),
  appearance_id text NOT NULL CHECK (appearance_id IN ('cat-01','cat-02','cat-03','cat-04')),
  appearance_version text NOT NULL DEFAULT '1',
  -- Grapheme count is checked by the domain service; SQL bounds storage separately.
  name text NOT NULL CHECK (octet_length(name) BETWEEN 1 AND 1024),
  adopted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,account_id)
);

CREATE TABLE account_requests (
  account_id uuid NOT NULL REFERENCES accounts(id),
  operation text NOT NULL CHECK (operation = 'ADOPT'),
  key uuid NOT NULL,
  payload_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(account_id,operation,key)
);

-- Reserved for E4-B. There is intentionally no client import/bind endpoint in A.
CREATE TABLE legacy_bindings (
  source_namespace text NOT NULL,
  source_experience_id text NOT NULL,
  account_id uuid NOT NULL UNIQUE REFERENCES accounts(id),
  cat_id uuid NOT NULL,
  import_batch_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(source_namespace,source_experience_id),
  FOREIGN KEY(cat_id,account_id) REFERENCES cat_profiles(id,account_id)
);

-- Retained ledger; deletion workers must target account_id, never an email.
CREATE TABLE account_deletions (
  account_id uuid PRIMARY KEY REFERENCES accounts(id),
  request_id uuid NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('PENDING','FAILED','COMPLETE')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK ((status = 'COMPLETE') = (completed_at IS NOT NULL))
);

CREATE TABLE account_rate_limits (
  key text PRIMARY KEY,
  window_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 1
);
