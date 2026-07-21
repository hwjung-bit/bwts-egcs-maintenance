-- Config table for app settings (PAT, etc.)
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- RLS: only authenticated @ekmtc.com users can read
ALTER TABLE config ENABLE ROW LEVEL SECURITY;

CREATE POLICY config_read ON config FOR SELECT
  TO authenticated
  USING (
    (auth.jwt() ->> 'email') LIKE '%@ekmtc.com'
  );
