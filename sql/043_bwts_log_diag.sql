-- 043: per ship-month log diagnostic for the BWTS 로그 tab detail panel (2026-11-27)
-- pipelines/bwts_log/log_diag.py upserts one row per (ship_code, period).
-- payload = {op, alarms[], devices[], sessions[], kpi{}, findings[], status, sig, files}
-- Kept out of bwts_log_analysis.summary so a re-publish of the monthly analysis
-- does not wipe it, and so the matrix query stays light.
-- Rollback: DROP TABLE bwts_log_diag;
CREATE TABLE IF NOT EXISTS bwts_log_diag (
  ship_code   text NOT NULL,
  period      text NOT NULL,
  payload     jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ship_code, period)
);
ALTER TABLE bwts_log_diag ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read_bwts_log_diag" ON bwts_log_diag;
DROP POLICY IF EXISTS "write_bwts_log_diag" ON bwts_log_diag;
CREATE POLICY "read_bwts_log_diag" ON bwts_log_diag
  FOR SELECT TO authenticated USING (app_is_staff());
CREATE POLICY "write_bwts_log_diag" ON bwts_log_diag
  FOR ALL TO authenticated USING (app_is_owner()) WITH CHECK (app_is_owner());
REVOKE ALL ON bwts_log_diag FROM anon;
