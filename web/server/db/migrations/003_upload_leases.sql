CREATE TABLE upload_leases (
  user_id text PRIMARY KEY,
  token uuid NOT NULL,
  until timestamptz NOT NULL
);
