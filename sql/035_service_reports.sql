-- 035: 메이커 서비스 리포트 대장 — 메일 1통 = 1행
--
-- 채우는 쪽: scripts/sr_import.py (Actions sr-import.yml, 매일 07:00 KST).
--   Gmail Auto Manager GAS 가 첨부를 Drive 에 저장한 메일과 같은 조건
--   (벤더 도메인 + 서비스 리포트 키워드 + 첨부)으로 찾아 넣는다.
--   PDF 는 안 읽는다 — 제목·본문 상단(인용 전)만.
-- 보는 쪽: 웹 📑 서비스 리포트 탭. Drive 폴더는 drive_folders 와
--   (ship_code, system, folder_date = mail_at 의 KST 날짜) 로 이어 붙인다.
--
-- 편집 규칙: 사람이 고친 칸(visit_start/visit_end/work_type/summary/repair_id)은
--   edited=true 가 되고, 가져오기는 그 행의 이 칸들을 다시 덮지 않는다.
--
-- 재실행 가능. Run in Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS service_reports (
  id          TEXT PRIMARY KEY,           -- Gmail message id
  thread_id   TEXT DEFAULT '',
  ship_code   TEXT NOT NULL,
  system      TEXT NOT NULL,              -- BWTS | EGCS
  vendor      TEXT DEFAULT '',            -- 발신 도메인 (lastech.kr …)
  sender      TEXT DEFAULT '',
  mail_at     TIMESTAMPTZ NOT NULL,
  subject     TEXT DEFAULT '',
  body        TEXT DEFAULT '',            -- 인용 전 본문, 3000자
  attachments JSONB DEFAULT '[]',         -- [{name, size}]
  visit_start DATE,                       -- 방선·작업 시작 (본문 추출 또는 수기)
  visit_end   DATE,                       -- 방선·작업 종료
  work_type   TEXT DEFAULT '',            -- 검교정 | 정기점검 | 수리 | 개조·설치 | 기타
  summary     TEXT DEFAULT '',
  repair_id   TEXT REFERENCES repairs(id) ON DELETE SET NULL,
  edited      BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS service_reports_ship_idx
  ON service_reports (ship_code, system, mail_at DESC);
CREATE INDEX IF NOT EXISTS service_reports_repair_idx
  ON service_reports (repair_id);

ALTER TABLE service_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read_service_reports"   ON service_reports;
DROP POLICY IF EXISTS "update_service_reports" ON service_reports;
DROP POLICY IF EXISTS "delete_service_reports" ON service_reports;
CREATE POLICY "read_service_reports" ON service_reports
  FOR SELECT TO authenticated USING (app_is_staff());
-- 030 과 같이 쓰기는 소유자만. 삽입은 가져오기(service_role)만 한다.
CREATE POLICY "update_service_reports" ON service_reports
  FOR UPDATE TO authenticated USING (app_is_owner()) WITH CHECK (app_is_owner());
CREATE POLICY "delete_service_reports" ON service_reports
  FOR DELETE TO authenticated USING (app_is_owner());
