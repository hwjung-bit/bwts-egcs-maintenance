-- 020: 환경파트 요약 뷰 — 공무팀 대시보드(Dash) 데이터 계약
--
-- 이 뷰들이 contracts/env_summary.schema.md 의 필드 정의와 1:1 이다.
-- pipelines/bwts_log/export_contract.py 가 이 뷰를 읽어 G드라이브 JSON 으로 내보내고,
-- 웹 종합 홈(js/tabs/home.js)도 같은 뷰를 읽는다 → 세 소비자가 같은 숫자를 본다.
--
-- 판정 임계값은 contracts/thresholds.json 이 단일 출처다. SQL 은 파일을 읽을 수 없으므로
-- export_contract.py 가 app_thresholds / sensor_cycles 에 미러링한다(실행마다 sync).
-- 이 파일을 처음 실행하면 아래 seed 값이 들어가고, 이후 sync 가 덮어쓴다.
--
-- 선행: sql/012_repair_origin.sql (repairs.origin) — 2026-09-01 운영 DB 에 미적용 상태로 확인돼
-- v_repairs_open 이 42703 으로 실패했다. 012 는 재실행 가능하니 함께 돌릴 것.
-- 재실행 가능. Run in Supabase SQL Editor. (012 → 017 → 018 → 019 → 020 → 021)

-- ── 임계값 미러 ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_thresholds (
  key   TEXT PRIMARY KEY,   -- thresholds.json 의 최상위 섹션명
  value JSONB NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO app_thresholds (key, value) VALUES
  ('bwts_calibration', '{"interval_months":12,"soon_days":60}'),
  ('egcs_calibration', '{"soon_days":30}')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS sensor_cycles (
  model       TEXT PRIMARY KEY,
  cal_months  INTEGER,        -- NULL = 검교정 없음(신환만)
  repl_months INTEGER NOT NULL
);
INSERT INTO sensor_cycles (model, cal_months, repl_months) VALUES
  ('enviroFlu', 48, 96), ('TTurb', 48, 96), ('TpH-D', 24, 24),
  ('G6110', 24, 48), ('G6111', 36, 36), ('G6120', NULL, 60), ('G6130', 12, 12)
ON CONFLICT (model) DO NOTHING;

ALTER TABLE app_thresholds ENABLE ROW LEVEL SECURITY;
ALTER TABLE sensor_cycles  ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read_app_thresholds" ON app_thresholds;
DROP POLICY IF EXISTS "read_sensor_cycles"  ON sensor_cycles;
CREATE POLICY "read_app_thresholds" ON app_thresholds FOR SELECT TO authenticated USING (app_is_staff());
CREATE POLICY "read_sensor_cycles"  ON sensor_cycles  FOR SELECT TO authenticated USING (app_is_staff());

-- ── 검교정 상태 (BWTS 1행/장비, EGCS 는 검교정·신환 각 1행) ─────────
-- level: ok | soon | expired | unknown
CREATE OR REPLACE VIEW v_calibration_status AS
WITH th AS (
  SELECT
    (SELECT (value->>'soon_days')::int FROM app_thresholds WHERE key='bwts_calibration') AS bwts_soon,
    (SELECT (value->>'soon_days')::int FROM app_thresholds WHERE key='egcs_calibration') AS egcs_soon
),
bwts AS (
  SELECT c.ship_code, 'BWTS'::text AS system, c.equip, 'cal'::text AS kind,
         c.last_date::date AS last_date,
         (c.last_date::date + make_interval(months => COALESCE(c.interval_months, 12)))::date AS due_date,
         c.note, c.cert_url, c.model, c.serial
  FROM calibrations c WHERE c.system = 'BWTS'
),
egcs_model AS (
  SELECT c.*,
    CASE
      WHEN upper(coalesce(s.wms,'')) LIKE '%TRI%' THEN
        CASE WHEN c.equip ILIKE '%PAH%' THEN 'enviroFlu' WHEN c.equip ILIKE '%TURB%' THEN 'TTurb' ELSE 'TpH-D' END
      WHEN upper(coalesce(s.wms,'')) LIKE '%GI%' OR upper(coalesce(s.wms,'')) LIKE '%GREEN%' THEN
        CASE WHEN c.equip ILIKE '%TURB%' THEN 'G6120' WHEN c.equip ILIKE '%PAH%' THEN
             (SELECT sc.model FROM sensor_cycles sc WHERE sc.model = c.model) ELSE 'G6130' END
    END AS inferred_model
  FROM calibrations c JOIN ships s ON s.code = c.ship_code
  WHERE c.system = 'EGCS'
),
egcs AS (
  SELECT e.ship_code, 'EGCS'::text AS system, e.equip, k.kind,
         e.last_date::date AS last_date,
         CASE k.kind
           WHEN 'cal'  THEN CASE WHEN sc.cal_months IS NULL THEN NULL
                            ELSE (e.last_date::date + make_interval(months => sc.cal_months))::date END
           ELSE (e.last_date::date + make_interval(months => sc.repl_months))::date
         END AS due_date,
         e.note, e.cert_url, COALESCE(e.model, e.inferred_model) AS model, e.serial
  FROM egcs_model e
  LEFT JOIN sensor_cycles sc ON sc.model = e.inferred_model
  CROSS JOIN (VALUES ('cal'), ('repl')) AS k(kind)
  WHERE NOT (k.kind = 'cal' AND sc.cal_months IS NULL)
),
u AS (SELECT * FROM bwts UNION ALL SELECT * FROM egcs)
SELECT u.ship_code, u.system, u.equip, u.kind, u.last_date, u.due_date,
       CASE WHEN u.due_date IS NULL THEN NULL ELSE (u.due_date - CURRENT_DATE) END AS days_left,
       CASE
         WHEN u.due_date IS NULL THEN 'unknown'
         WHEN u.due_date - CURRENT_DATE <= 0 THEN 'expired'
         WHEN u.due_date - CURRENT_DATE <= (CASE u.system WHEN 'BWTS' THEN th.bwts_soon ELSE th.egcs_soon END) THEN 'soon'
         ELSE 'ok'
       END AS level,
       u.model, u.serial, u.note, u.cert_url
FROM u CROSS JOIN th;

-- ── 진행 중 수리 ─────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_repairs_open AS
SELECT id, ship_code, system, date, equip, stage, symptom, action, origin, email_link, file_url
FROM repairs
WHERE COALESCE(stage,'') <> '완료'
ORDER BY CASE stage WHEN '미확인' THEN 0 ELSE 1 END, date DESC;

-- ── BWTS 로그 최근 3개월 ─────────────────────────────────────────────
CREATE OR REPLACE VIEW v_bwts_log_latest AS
SELECT ship_code, period, grade, grade_rule, COALESCE(final_grade, grade) AS display_grade,
       review_status, ballast_count, deballast_count, trip_count, alarm_count,
       tro_b_avg, tro_d_max, grade_reasons, analyzed_at
FROM bwts_log_analysis
WHERE period >= to_char((date_trunc('month', CURRENT_DATE) - interval '3 months')::date, 'YYYY-MM')
ORDER BY period DESC, ship_code;

-- ── 한 줄 KPI ────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_env_summary AS
WITH sh AS (SELECT * FROM ships WHERE NOT COALESCE(hidden, false)),
st AS (
  SELECT
    COUNT(*) FILTER (WHERE '문제' IN (bwts_status, egcs_wms_status, egcs_cems_status, egcs_body_status)) AS issue,
    COUNT(*) FILTER (WHERE '문제' NOT IN (COALESCE(bwts_status,'-'), COALESCE(egcs_wms_status,'-'), COALESCE(egcs_cems_status,'-'), COALESCE(egcs_body_status,'-'))
                       AND '수리중' IN (bwts_status, egcs_wms_status, egcs_cems_status, egcs_body_status)) AS repairing,
    COUNT(*) AS total
  FROM sh
),
cal AS (
  SELECT COUNT(*) FILTER (WHERE level='expired') AS expired,
         COUNT(*) FILTER (WHERE level='soon') AS soon,
         COUNT(*) FILTER (WHERE level='ok') AS ok,
         COUNT(*) FILTER (WHERE level='unknown') AS unknown,
         COUNT(*) FILTER (WHERE system='BWTS' AND level='expired') AS bwts_expired,
         COUNT(*) FILTER (WHERE system='BWTS' AND level='soon') AS bwts_soon,
         COUNT(*) FILTER (WHERE system='EGCS' AND kind='cal' AND level='expired') AS egcs_cal_expired,
         COUNT(*) FILTER (WHERE system='EGCS' AND kind='repl' AND level='expired') AS egcs_repl_expired
  FROM v_calibration_status
),
lg AS (
  SELECT MAX(period) AS latest_period FROM bwts_log_analysis
),
lgc AS (
  SELECT jsonb_object_agg(display_grade, n) AS grades FROM (
    SELECT COALESCE(final_grade, grade) AS display_grade, COUNT(*) AS n
    FROM bwts_log_analysis WHERE period = (SELECT latest_period FROM lg) GROUP BY 1) t
)
SELECT
  (SELECT COUNT(*) FROM sh) AS bwts_target,
  (SELECT COUNT(*) FROM sh WHERE COALESCE(egcs_maker,'') <> '') AS egcs_target,
  st.total - st.issue - st.repairing AS status_ok,
  st.repairing AS status_repairing,
  st.issue AS status_issue,
  (SELECT COUNT(*) FROM v_repairs_open) AS repairs_open,
  cal.expired AS cal_expired, cal.soon AS cal_soon, cal.ok AS cal_ok, cal.unknown AS cal_unknown,
  cal.bwts_expired, cal.bwts_soon, cal.egcs_cal_expired, cal.egcs_repl_expired,
  lg.latest_period AS bwts_log_latest_period,
  COALESCE(lgc.grades, '{}'::jsonb) AS bwts_log_latest_grades,
  (SELECT COUNT(*) FROM bwts_log_analysis WHERE review_status = 'requested') AS bwts_log_review_pending,
  now() AS generated_at
FROM st, cal, lg, lgc;
