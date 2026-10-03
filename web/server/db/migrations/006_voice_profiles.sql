CREATE TABLE voice_profiles (
  voice_id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{1,40}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  gender text NOT NULL CHECK (gender IN ('male', 'female', 'neutral')),
  language text NOT NULL CHECK (language IN ('id', 'en')),
  description_id text NOT NULL,
  description_en text NOT NULL,
  tags jsonb NOT NULL CHECK (CASE WHEN jsonb_typeof(tags) = 'array' THEN jsonb_array_length(tags) BETWEEN 1 AND 12 ELSE false END),
  best_for_id text NOT NULL,
  best_for_en text NOT NULL,
  consent_subject text NOT NULL,
  consent_attested_by text NOT NULL,
  consent_scope text NOT NULL,
  consent_granted_at timestamptz NOT NULL,
  active boolean NOT NULL DEFAULT true,
  sort integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX voice_profiles_active ON voice_profiles (sort, name) WHERE active;
