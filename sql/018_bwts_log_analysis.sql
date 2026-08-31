-- 018: BWTS 로그 분석 결과 (선박 × 월)
--
-- pipelines/bwts_log/publish_supabase.py 가 upsert 하는 테이블. 1행 = 1 vessel-month.
-- 자동 판정(grade)과 검토 결과(final_grade·review_*)를 같은 행에 둔다 —
-- publish 는 review_* 컬럼을 건드리지 않으므로 재분석해도 검토 결과가 보존된다.
--
-- grade 값: 운전양호 / 점검필요 / 수리후정상 / 미운전 / 미수신 / 데이터불량 / 판독실패
-- review_status: auto | requested | reviewed | overridden
--
-- 재실행 가능. Run in Supabase SQL Editor. (017 → 018 → 019 → 020 → 021)

CREATE TABLE IF NOT EXISTS bwts_log_analysis (
  ship_code        TEXT NOT NULL REFERENCES ships(code),
  period           TEXT NOT NULL,                 -- 'YYYY-MM'
  grade            TEXT NOT NULL,                 -- 자동 판정 (integrity 적용 후)
  grade_rule       TEXT,                          -- integrity 적용 전 룰 판정
  grade_reasons    JSONB NOT NULL DEFAULT '[]',
  reception        TEXT,
  ballast_count    INTEGER NOT NULL DEFAULT 0,
  deballast_count  INTEGER NOT NULL DEFAULT 0,
  op_days          INTEGER NOT NULL DEFAULT 0,
  tro_b_avg        NUMERIC,
  tro_b_min        NUMERIC,
  tro_d_max        NUMERIC,
  tro_b_in_range   BOOLEAN,
  tro_d_compliant  BOOLEAN,
  trip_count       INTEGER NOT NULL DEFAULT 0,
  alarm_count      INTEGER NOT NULL DEFAULT 0,
  chattering       JSONB NOT NULL DEFAULT '[]',
  recovery_pattern JSONB NOT NULL DEFAULT '{}',
  integrity        JSONB NOT NULL DEFAULT '{}',   -- {hits:[I1..I7], detail:[...], regrade:bool}
  summary          JSONB NOT NULL DEFAULT '{}',   -- compute_vessel_summary 전체 (session_summaries 포함)
  analyzer_version TEXT,
  analyzed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 검토 루프 (웹 탭 + /bwts-review 스킬이 쓴다; publish 는 건드리지 않음)
  review_status    TEXT NOT NULL DEFAULT 'auto',
  final_grade      TEXT,
  review_note      TEXT,
  reviewed_by      TEXT,
  reviewed_at      TIMESTAMPTZ,
  PRIMARY KEY (ship_code, period)
);

CREATE INDEX IF NOT EXISTS bwts_log_analysis_period_idx ON bwts_log_analysis (period DESC);
CREATE INDEX IF NOT EXISTS bwts_log_analysis_review_idx
  ON bwts_log_analysis (review_status) WHERE review_status <> 'auto';

-- RLS: 014 패턴 그대로 — 인증된 @ekmtc.com 만 읽고 쓴다. 서비스 키(파이프라인)는 RLS 우회.
ALTER TABLE bwts_log_analysis ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read_bwts_log"   ON bwts_log_analysis;
DROP POLICY IF EXISTS "update_bwts_log" ON bwts_log_analysis;
CREATE POLICY "read_bwts_log" ON bwts_log_analysis
  FOR SELECT TO authenticated USING (app_is_staff());
-- 웹에서는 검토 컬럼만 바꾼다 (등급 수정·재검토 요청). INSERT/DELETE 는 파이프라인 전용.
CREATE POLICY "update_bwts_log" ON bwts_log_analysis
  FOR UPDATE TO authenticated USING (app_is_staff()) WITH CHECK (app_is_staff());

-- 표시용 등급: 검토가 있으면 그것, 없으면 자동 판정
CREATE OR REPLACE VIEW v_bwts_log_grades AS
SELECT ship_code, period, grade, grade_rule,
       COALESCE(final_grade, grade) AS display_grade,
       review_status, grade_reasons, integrity, analyzed_at, reviewed_at
FROM bwts_log_analysis;
