-- 042: follow-through state for 🛰 관제 items (2026-11-24)
-- key = watch hit key (e.g. 'ECU:KCB', '미수신:KMB', '정체:<task id>').
-- Web writes 요청함 (mail drafted / request made); watch.py sets 해소 when the
-- hit is gone (PMS record, log received, ...) and flags 기한초과 after due_date.
-- Rollback: DROP TABLE watch_actions;
CREATE TABLE IF NOT EXISTS watch_actions (
  key           text PRIMARY KEY,
  kind          text NOT NULL,
  ship_code     text NOT NULL DEFAULT '',
  status        text NOT NULL DEFAULT '요청함' CHECK (status IN ('요청함', '해소')),
  requested_at  date NOT NULL,
  due_date      date NOT NULL,
  round         int  NOT NULL DEFAULT 1,
  note          text NOT NULL DEFAULT '',
  resolved_at   date,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE watch_actions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read_watch_actions" ON watch_actions;
DROP POLICY IF EXISTS "write_watch_actions" ON watch_actions;
CREATE POLICY "read_watch_actions" ON watch_actions
  FOR SELECT TO authenticated USING (app_is_staff());
CREATE POLICY "write_watch_actions" ON watch_actions
  FOR ALL TO authenticated USING (app_is_owner()) WITH CHECK (app_is_owner());
REVOKE ALL ON watch_actions FROM anon;
