-- Cancellation and confirmation serialize on the same active account row.
-- Keep only the idempotency key/hash: no archive, email, or response plaintext.
CREATE TABLE IF NOT EXISTS legacy_binding_cancellations (
  account_id uuid NOT NULL REFERENCES accounts(id),
  key uuid NOT NULL,
  bundle_hash text NOT NULL CHECK (bundle_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, key)
);
