-- 010: folder request queue
--
-- 대시보드에서 메일을 수리이력으로 옮길 때, 그 건의 Drive 작업폴더가
-- 아직 없으면 여기에 요청을 남긴다. GAS 워커가 읽어서 폴더를 찾거나
-- 만들고 drive_folders 색인까지 갱신한다.
--
-- 중복 방지: repair_id 가 PK 이므로 한 수리이력당 요청은 하나뿐이고,
-- 워커는 폴더를 만들기 전에 색인을 먼저 조회한다.
--
-- Run once in Supabase SQL Editor, after 009.

CREATE TABLE IF NOT EXISTS folder_requests (
  repair_id    TEXT PRIMARY KEY,
  ship_code    TEXT NOT NULL,
  system       TEXT NOT NULL,        -- BWTS | EGCS
  req_date     DATE,
  title        TEXT DEFAULT '',
  status       TEXT DEFAULT 'pending',
  -- pending | linked (색인에 이미 있었음) | created | error
  folder_id    TEXT,
  note         TEXT DEFAULT '',
  created_at   TIMESTAMPTZ DEFAULT now(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS folder_requests_status_idx
  ON folder_requests (status);

ALTER TABLE folder_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read_folder_requests" ON folder_requests;
CREATE POLICY "read_folder_requests" ON folder_requests
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "insert_folder_requests" ON folder_requests;
CREATE POLICY "insert_folder_requests" ON folder_requests
  FOR INSERT WITH CHECK (
    auth.jwt() ->> 'email' LIKE '%@ekmtc.com'
  );

-- 상태 갱신은 GAS 워커(service_role)가 하므로 RLS 를 우회한다.
