-- 022: 현황 탭 변경 히스토리
--
-- 현황 탭(ships.<계통>_status/_memo)은 덮어쓰기라 이력이 안 남는다.
-- 저장할 때마다 (선박, 계통) 스냅샷을 이 테이블에 남긴다.
-- 병합 규칙(웹 클라이언트): 같은 (선박, 계통)의 마지막 스냅샷이 5분 이내면
-- 새 행 대신 그 행을 갱신한다 — 저장 직후 바로 고치는 경우 이력 한 건으로 합침.
--
-- 재실행 가능. Run in Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS status_history (
  id         BIGSERIAL PRIMARY KEY,
  ship_code  TEXT NOT NULL,
  system     TEXT NOT NULL,               -- bwts | egcs_wms | egcs_cems | egcs_body
  status     TEXT,                        -- 저장 시점 상태
  memo       TEXT,                        -- 저장 시점 메모
  changed_by TEXT,                        -- 로그인 이메일
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()  -- 5분 병합 갱신 시각
);

CREATE INDEX IF NOT EXISTS status_history_ship_idx
  ON status_history (ship_code, system, id DESC);

ALTER TABLE status_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read_status_history"   ON status_history;
DROP POLICY IF EXISTS "insert_status_history" ON status_history;
DROP POLICY IF EXISTS "update_status_history" ON status_history;
CREATE POLICY "read_status_history" ON status_history
  FOR SELECT TO authenticated USING (app_is_staff());
CREATE POLICY "insert_status_history" ON status_history
  FOR INSERT TO authenticated WITH CHECK (app_is_staff());
CREATE POLICY "update_status_history" ON status_history
  FOR UPDATE TO authenticated USING (app_is_staff()) WITH CHECK (app_is_staff());
