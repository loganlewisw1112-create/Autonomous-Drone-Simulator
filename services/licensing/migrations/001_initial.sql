BEGIN;

CREATE TABLE IF NOT EXISTS licensing_schema_migrations (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS licence_codes (
  id uuid PRIMARY KEY,
  code_digest bytea NOT NULL UNIQUE,
  tier text NOT NULL CHECK (tier IN ('selected_evaluator_demo', 'agency_classroom_pilot')),
  status text NOT NULL CHECK (status IN ('issued', 'consumed', 'expired', 'revoked')),
  recipient_ref_hash text,
  entitlement_id uuid,
  replacement_for_entitlement_id uuid,
  unused_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  consumed_at timestamptz,
  CHECK (octet_length(code_digest) = 32)
);

CREATE TABLE IF NOT EXISTS entitlements (
  id uuid PRIMARY KEY,
  tier text NOT NULL CHECK (tier IN ('selected_evaluator_demo', 'agency_classroom_pilot')),
  status text NOT NULL CHECK (status IN ('active', 'replacement_pending', 'revoked', 'expired')),
  installation_key_thumbprint text,
  activated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  lease_serial integer NOT NULL DEFAULT 1 CHECK (lease_serial > 0),
  replacement_count integer NOT NULL DEFAULT 0 CHECK (replacement_count BETWEEN 0 AND 1),
  minimum_version text NOT NULL,
  maximum_version_exclusive text NOT NULL,
  revoked_at timestamptz,
  revoked_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at > activated_at)
);

ALTER TABLE licence_codes
  ADD CONSTRAINT licence_codes_entitlement_fk
  FOREIGN KEY (entitlement_id) REFERENCES entitlements(id);
ALTER TABLE licence_codes
  ADD CONSTRAINT licence_codes_replacement_fk
  FOREIGN KEY (replacement_for_entitlement_id) REFERENCES entitlements(id);

CREATE TABLE IF NOT EXISTS installation_history (
  id uuid PRIMARY KEY,
  entitlement_id uuid NOT NULL REFERENCES entitlements(id),
  installation_key_thumbprint text NOT NULL UNIQUE,
  activated_at timestamptz NOT NULL,
  deactivated_at timestamptz,
  deactivation_reason text
);

CREATE INDEX IF NOT EXISTS installation_history_entitlement_idx
  ON installation_history(entitlement_id);

CREATE TABLE IF NOT EXISTS activation_challenges (
  id uuid PRIMARY KEY,
  challenge_digest bytea NOT NULL,
  installation_key_thumbprint text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('activation', 'refresh')),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (octet_length(challenge_digest) = 32)
);

CREATE INDEX IF NOT EXISTS activation_challenges_expiry_idx
  ON activation_challenges(expires_at);

CREATE TABLE IF NOT EXISTS licensing_audit_events (
  id uuid PRIMARY KEY,
  event_type text NOT NULL,
  entitlement_id uuid REFERENCES entitlements(id),
  code_id uuid REFERENCES licence_codes(id),
  actor_pseudonym text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS licensing_audit_created_idx
  ON licensing_audit_events(created_at);
CREATE INDEX IF NOT EXISTS licensing_audit_entitlement_idx
  ON licensing_audit_events(entitlement_id, created_at);

CREATE TABLE IF NOT EXISTS licensing_rate_limits (
  subject_pseudonym text NOT NULL,
  action text NOT NULL,
  window_started_at timestamptz NOT NULL,
  attempt_count integer NOT NULL CHECK (attempt_count > 0),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(subject_pseudonym, action)
);

INSERT INTO licensing_schema_migrations(version) VALUES (1)
ON CONFLICT (version) DO NOTHING;

COMMIT;
