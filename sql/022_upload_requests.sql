-- 022: 웹 업로드 큐 — 수리이력에서 서비스리포트 등을 직접 올려 Drive 작업폴더로
--
-- 흐름: 웹(js/tabs/repairs.js) → Supabase Storage 'repair_uploads' 에 파일 저장 +
--       upload_requests 행 → GAS processUploadRequests_ (5분 트리거) 가 파일을 내려받아
--       선박/시스템/날짜 작업폴더(없으면 생성)에 넣고 repairs.attachments 에 링크 기록 후
--       Storage 객체 삭제. 큐 규약(pending/processing/done/error, attempts, locked_at)은
--       folder_requests 와 같다.
--
-- 재실행 가능. Run in Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS upload_requests (
  id           BIGSERIAL PRIMARY KEY,
  repair_id    TEXT NOT NULL REFERENCES repairs(id) ON DELETE CASCADE,
  ship_code    TEXT NOT NULL,
  system       TEXT NOT NULL,
  req_date     DATE,
  title        TEXT,
  object_path  TEXT NOT NULL,          -- storage path: repair_uploads/<repair_id>/<file>
  file_name    TEXT NOT NULL,
  file_size    BIGINT,
  user_note    TEXT,                   -- 사용자가 함께 적은 조치 내용 (repairs.action 에도 반영됨)
  note         TEXT,                   -- 큐 처리 메시지 (claimRequests_/finishRequest_ 가 씀)
  requested_by TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',   -- pending | processing | done | error
  folder_id    TEXT,
  file_url     TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  locked_at    TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS upload_requests_status_idx ON upload_requests (status, created_at);
CREATE INDEX IF NOT EXISTS upload_requests_repair_idx ON upload_requests (repair_id);

ALTER TABLE upload_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read_upload_requests"   ON upload_requests;
DROP POLICY IF EXISTS "insert_upload_requests" ON upload_requests;
DROP POLICY IF EXISTS "update_upload_requests" ON upload_requests;
CREATE POLICY "read_upload_requests" ON upload_requests
  FOR SELECT TO authenticated USING (app_is_staff());
CREATE POLICY "insert_upload_requests" ON upload_requests
  FOR INSERT TO authenticated WITH CHECK (app_is_staff());
CREATE POLICY "update_upload_requests" ON upload_requests
  FOR UPDATE TO authenticated USING (app_is_staff()) WITH CHECK (app_is_staff());

-- ── Storage 버킷 (비공개). 파일은 GAS 가 Drive 로 옮긴 뒤 지운다 ─────────
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('repair_uploads', 'repair_uploads', false, 52428800)   -- 50 MB
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "staff_upload_repair_files" ON storage.objects;
DROP POLICY IF EXISTS "staff_read_repair_files"   ON storage.objects;
DROP POLICY IF EXISTS "staff_delete_repair_files" ON storage.objects;
CREATE POLICY "staff_upload_repair_files" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'repair_uploads' AND app_is_staff());
CREATE POLICY "staff_read_repair_files" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'repair_uploads' AND app_is_staff());
CREATE POLICY "staff_delete_repair_files" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'repair_uploads' AND app_is_staff());
