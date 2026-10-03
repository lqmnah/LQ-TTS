CREATE TABLE sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  name text NOT NULL,
  email text NOT NULL,
  plan text NOT NULL,
  paid boolean NOT NULL,
  lang text NOT NULL DEFAULT 'id' CHECK (lang IN ('id', 'en')),
  balance double precision,
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX sessions_user_live ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expires ON sessions (expires_at);

CREATE TABLE jobs (
  id uuid PRIMARY KEY,
  user_id text NOT NULL,
  voice_id uuid NOT NULL,
  voice_name text NOT NULL,
  title text NOT NULL,
  chars integer NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed', 'canceled')),
  revision integer NOT NULL DEFAULT 1,
  audio_seconds real,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  deleted_at timestamptz
);
CREATE INDEX jobs_user_created ON jobs (user_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX jobs_user_voice ON jobs (user_id, voice_id) WHERE deleted_at IS NULL;

CREATE TABLE charges (
  id bigserial PRIMARY KEY,
  user_id text NOT NULL,
  job_id uuid REFERENCES jobs (id),
  revision integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('job', 'regenerate')),
  sentence_idx integer,
  chars integer NOT NULL,
  credits integer NOT NULL CHECK (credits > 0),
  hold_id text NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'held' CHECK (state IN ('held', 'settled', 'refunded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  flagged_at timestamptz
);
CREATE INDEX charges_held ON charges (created_at) WHERE state = 'held';
CREATE INDEX charges_job ON charges (job_id, revision);
CREATE INDEX charges_user_created ON charges (user_id, created_at DESC);

CREATE TABLE voice_consents (
  voice_id uuid PRIMARY KEY,
  user_id text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  ip text NOT NULL,
  consent_version text NOT NULL
);
CREATE INDEX voice_consents_user ON voice_consents (user_id);
