ALTER TABLE jobs ADD COLUMN regen_lease uuid, ADD COLUMN regen_until timestamptz;
