-- 019: 재검토 요청/답변 이력
--
-- 웹 BWTS 로그 탭의 「재검토 요청」이 행을 만들고, 로컬 Claude 스킬(/bwts-review)이
-- 원본을 다시 읽어 answer 를 채운다. 사용자 질문과 판정 근거가 남으므로
-- 파서 보강·임계값 조정의 라벨 데이터가 된다.
--
-- 재실행 가능. Run in Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS bwts_reviews (
  id           BIGSERIAL PRIMARY KEY,
  ship_code    TEXT NOT NULL,
  period       TEXT NOT NULL,                  -- 'YYYY-MM'
  question     TEXT NOT NULL DEFAULT '',
  requested_by TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | answered
  answer       TEXT,
  answered_by  TEXT,                           -- 'claude' | 이메일
  answered_at  TIMESTAMPTZ,
  FOREIGN KEY (ship_code, period) REFERENCES bwts_log_analysis(ship_code, period) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS bwts_reviews_pending_idx ON bwts_reviews (status, created_at) WHERE status = 'pending';

ALTER TABLE bwts_reviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read_bwts_reviews"   ON bwts_reviews;
DROP POLICY IF EXISTS "insert_bwts_reviews" ON bwts_reviews;
DROP POLICY IF EXISTS "update_bwts_reviews" ON bwts_reviews;
CREATE POLICY "read_bwts_reviews" ON bwts_reviews
  FOR SELECT TO authenticated USING (app_is_staff());
CREATE POLICY "insert_bwts_reviews" ON bwts_reviews
  FOR INSERT TO authenticated WITH CHECK (app_is_staff());
CREATE POLICY "update_bwts_reviews" ON bwts_reviews
  FOR UPDATE TO authenticated USING (app_is_staff()) WITH CHECK (app_is_staff());
