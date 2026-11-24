-- 041: daily watch snapshot for the 🛰 관제 tab (2026-11-24)
-- pipelines/bwts_log/watch.py upserts one row per (date, system) every weekday.
-- payload = {ships: {...}, hits: [...], candidates: [...], meta: {...}}
-- system leaves room for EGCS / ISS rules later.
-- Rollback: DROP TABLE watch_snapshot;
CREATE TABLE IF NOT EXISTS watch_snapshot (
  date        date NOT NULL,
  system      text NOT NULL DEFAULT 'BWTS',
  payload     jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (date, system)
);
ALTER TABLE watch_snapshot ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read_watch_snapshot" ON watch_snapshot;
DROP POLICY IF EXISTS "write_watch_snapshot" ON watch_snapshot;
CREATE POLICY "read_watch_snapshot" ON watch_snapshot
  FOR SELECT TO authenticated USING (app_is_staff());
CREATE POLICY "write_watch_snapshot" ON watch_snapshot
  FOR ALL TO authenticated USING (app_is_owner()) WITH CHECK (app_is_owner());
REVOKE ALL ON watch_snapshot FROM anon;
