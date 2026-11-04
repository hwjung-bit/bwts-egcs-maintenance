-- 036: BSR 알림 조치 메모 — 알림 1건 = 1행
--   BSR 대시보드(archive/bsr/index.html)는 매주 재생성되는 정적 페이지라
--   메모를 페이지에 넣으면 날아간다. 그래서 여기 따로 두고, 알림의
--   (kind|code|date|section|grade) 키로 다시 붙인다.
--
-- 쓰는 쪽: BSR 대시보드 알림 탭 「조치」 칸 (관리대장 ⛽ BSR 탭 iframe 안,
--   부모 창의 supabase 클라이언트·로그인 세션을 빌려 씀).
--
-- 재실행 가능. Run in Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS bsr_notes (
  key        TEXT PRIMARY KEY,               -- 'kind|code|date|section|grade'
  code       TEXT NOT NULL,
  date       TEXT DEFAULT '',
  section    TEXT DEFAULT '',                -- FO | DO
  grade      TEXT DEFAULT '',
  kind       TEXT DEFAULT '',                -- deviation | density | stale
  status     TEXT NOT NULL DEFAULT '미확인'
             CHECK (status IN ('미확인', '본선문의', '조치필요', '확인완료')),
  note       TEXT DEFAULT '',
  updated_by TEXT DEFAULT (auth.jwt() ->> 'email'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bsr_notes_code_idx ON bsr_notes (code, date DESC);

ALTER TABLE bsr_notes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read_bsr_notes"  ON bsr_notes;
DROP POLICY IF EXISTS "write_bsr_notes" ON bsr_notes;
CREATE POLICY "read_bsr_notes" ON bsr_notes
  FOR SELECT TO authenticated USING (app_is_staff());
CREATE POLICY "write_bsr_notes" ON bsr_notes
  FOR ALL TO authenticated USING (app_is_staff()) WITH CHECK (app_is_staff());
