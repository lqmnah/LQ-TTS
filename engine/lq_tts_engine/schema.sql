CREATE SCHEMA IF NOT EXISTS {schema};
SET search_path TO {schema};

CREATE TABLE IF NOT EXISTS voices (
  id uuid PRIMARY KEY,
  caller text NOT NULL,
  owner_ref text NOT NULL,
  name text NOT NULL,
  language text,
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'ready', 'failed')),
  error_code text,
  source_path text NOT NULL,
  user_transcript text,
  ref_audio_path text,
  ref_transcript text,
  ref_seconds real,
  clip_start_s real,
  clip_end_s real,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS voices_owner ON voices (caller, owner_ref) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY,
  voice_id uuid NOT NULL REFERENCES voices(id),
  caller text NOT NULL,
  text text NOT NULL,
  settings jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed', 'canceled')),
  error_code text,
  priority int NOT NULL DEFAULT 0,
  revision int NOT NULL DEFAULT 1,
  attempts int NOT NULL DEFAULT 0,
  lease_until timestamptz,
  cancel_requested boolean NOT NULL DEFAULT false,
  chars int NOT NULL,
  audio_seconds real,
  callback_url text,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  deleted_at timestamptz,
  UNIQUE (caller, idempotency_key)
);
CREATE INDEX IF NOT EXISTS jobs_queue ON jobs (priority DESC, created_at) WHERE status = 'queued';

CREATE TABLE IF NOT EXISTS sentences (
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  idx int NOT NULL,
  paragraph_idx int NOT NULL,
  text text NOT NULL,
  style text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'needs_review')),
  takes int NOT NULL DEFAULT 0,
  score real,
  asr_text text,
  audio_path text,
  duration_s real,
  start_s real,
  end_s real,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, idx)
);

CREATE TABLE IF NOT EXISTS worker_state (
  id int PRIMARY KEY CHECK (id = 1),
  beat_at timestamptz NOT NULL,
  model_loaded boolean NOT NULL,
  device text NOT NULL,
  rtf real
);
