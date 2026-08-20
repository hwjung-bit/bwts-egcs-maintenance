-- 011: folder trash queue
--
-- 수리이력을 삭제하면 그 건의 Drive 작업폴더도 함께 정리한다.
-- GAS 워커가 폴더를 휴지통으로 보내고(영구삭제 아님, Drive 휴지통에서
-- 복구 가능) drive_folders 색인에서 지운다.
--
-- 대상은 작업폴더(YYYY-MM-DD 제목)뿐이다. 선박 폴더는 21척 공용이라
-- 프론트에서 요청 자체를 만들지 않는다.
--
-- Run once in Supabase SQL Editor, after 010.

CREATE TABLE IF NOT EXISTS folder_trash_requests (
  folder_id    TEXT PRIMARY KEY,
  repair_id    TEXT,
  ship_code    TEXT,
  system       TEXT,
  folder_name  TEXT DEFAULT '',
  status       TEXT DEFAULT 'pending',   -- pending | trashed | error
  note         TEXT DEFAULT '',
  created_at   TIMESTAMPTZ DEFAULT now(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS folder_trash_status_idx
  ON folder_trash_requests (status);

ALTER TABLE folder_trash_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read_folder_trash" ON folder_trash_requests;
CREATE POLICY "read_folder_trash" ON folder_trash_requests
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "insert_folder_trash" ON folder_trash_requests;
CREATE POLICY "insert_folder_trash" ON folder_trash_requests
  FOR INSERT WITH CHECK (
    auth.jwt() ->> 'email' LIKE '%@ekmtc.com'
  );

-- 상태 갱신은 GAS 워커(service_role)가 하므로 RLS 를 우회한다.
