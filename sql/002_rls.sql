-- Row Level Security policies
-- Run after 001_schema.sql

-- Enable RLS on all tables
ALTER TABLE ships ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE repairs ENABLE ROW LEVEL SECURITY;
ALTER TABLE calibrations ENABLE ROW LEVEL SECURITY;

-- Read: anyone authenticated can read
CREATE POLICY "read_ships" ON ships
  FOR SELECT USING (true);

CREATE POLICY "read_mail_log" ON mail_log
  FOR SELECT USING (true);

CREATE POLICY "read_repairs" ON repairs
  FOR SELECT USING (true);

CREATE POLICY "read_calibrations" ON calibrations
  FOR SELECT USING (true);

-- Write: only ekmtc.com users
CREATE POLICY "update_mail_log" ON mail_log
  FOR UPDATE USING (
    auth.jwt() ->> 'email' LIKE '%@ekmtc.com'
  );

CREATE POLICY "insert_mail_log" ON mail_log
  FOR INSERT WITH CHECK (
    auth.jwt() ->> 'email' LIKE '%@ekmtc.com'
  );

CREATE POLICY "update_repairs" ON repairs
  FOR UPDATE USING (
    auth.jwt() ->> 'email' LIKE '%@ekmtc.com'
  );

CREATE POLICY "insert_repairs" ON repairs
  FOR INSERT WITH CHECK (
    auth.jwt() ->> 'email' LIKE '%@ekmtc.com'
  );

CREATE POLICY "update_calibrations" ON calibrations
  FOR UPDATE USING (
    auth.jwt() ->> 'email' LIKE '%@ekmtc.com'
  );

-- Service role (Python collector) bypasses RLS
-- No additional policy needed — use service_role key
