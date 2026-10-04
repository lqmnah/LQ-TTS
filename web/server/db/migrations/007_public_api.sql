CREATE TABLE api_keys (
  id uuid PRIMARY KEY,
  user_id text NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  key_id text NOT NULL UNIQUE CHECK (key_id ~ '^[a-z2-7]{12}$'),
  secret_hash text NOT NULL CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
  webhook_secret_enc text NOT NULL,
  tv integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text CHECK (revoked_reason IN ('user', 'tv', 'plan', 'suspended', 'account_gone'))
);
CREATE INDEX api_keys_user_active ON api_keys (user_id, created_at DESC) WHERE revoked_at IS NULL;

ALTER TABLE jobs
  ADD COLUMN source text NOT NULL DEFAULT 'web' CHECK (source IN ('web', 'api')),
  ADD COLUMN api_key_id uuid REFERENCES api_keys (id),
  ADD COLUMN webhook_url text;
CREATE INDEX jobs_api_active ON jobs (user_id) WHERE source = 'api' AND deleted_at IS NULL AND status IN ('queued', 'running');

ALTER TABLE charges ADD COLUMN source text NOT NULL DEFAULT 'web' CHECK (source IN ('web', 'api'));

ALTER TABLE voice_profiles ADD COLUMN api_allowed boolean NOT NULL DEFAULT false;

CREATE TABLE api_idempotency (
  user_id text NOT NULL,
  idem_key text NOT NULL,
  job_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, idem_key)
);

CREATE TABLE webhook_deliveries (
  id bigserial PRIMARY KEY,
  api_key_id uuid NOT NULL REFERENCES api_keys (id),
  user_id text NOT NULL,
  job_id uuid NOT NULL UNIQUE,
  event text NOT NULL CHECK (event IN ('job.done', 'job.failed')),
  url text NOT NULL,
  body text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'delivered', 'dropped')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  sending_until timestamptz,
  last_status integer,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries (next_attempt_at) WHERE state = 'pending';
CREATE INDEX webhook_deliveries_key ON webhook_deliveries (api_key_id, created_at DESC);
