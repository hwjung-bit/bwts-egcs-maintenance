-- 039: env-contract-2 views for the 공무팀 Dash 환경파트 tab rebuild (2026-11-12)
-- Goal: the Dash shows exactly what the owner sees in this app.
--   * Calibration levels/dates replicate js/tabs/bwtsCal.js + egcsCal.js
--     (JS addMonths overflow, KST "today", EGCS one row per sensor, warn_days).
--   * Repairs keep every BWTS/EGCS row with a derived end date so the Dash can
--     count down-days per period (open = until today).
-- The env-contract-1 views (020/028/031) stay untouched until the Dash switches.
-- All views: security_invoker on, anon revoked, authenticated SELECT only.

-- JS Date.setMonth overflow: first day of target month + (day-1) days
CREATE OR REPLACE FUNCTION app_js_add_months(d date, m int) RETURNS date
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN d IS NULL OR m IS NULL THEN NULL
         ELSE ((date_trunc('month', d) + make_interval(months => m))::date
               + (extract(day FROM d)::int - 1)) END
$$;

CREATE OR REPLACE FUNCTION app_today_kst() RETURNS date
LANGUAGE sql STABLE AS $$ SELECT (now() AT TIME ZONE 'Asia/Seoul')::date $$;

-- repairs.history is jsonb but legacy rows hold a JSON *string* scalar;
-- never let one bad row break the view
CREATE OR REPLACE FUNCTION app_history_array(h jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF h IS NULL THEN RETURN '[]'::jsonb; END IF;
  IF jsonb_typeof(h) = 'string' THEN h := (h #>> '{}')::jsonb; END IF;
  IF jsonb_typeof(h) = 'array' THEN RETURN h; END IF;
  RETURN '[]'::jsonb;
EXCEPTION WHEN others THEN
  RETURN '[]'::jsonb;
END $$;

-- ── ships + equipment status (현황 탭) ──────────────────────────────────
CREATE OR REPLACE VIEW v_env2_ships WITH (security_invoker = on) AS
SELECT code, name, teu, hidden, sort_order, bwts_maker, egcs_maker, bwts_as, wms, cems,
       bwts_status, bwts_memo,
       egcs_wms_status, egcs_wms_memo,
       egcs_cems_status, egcs_cems_memo,
       egcs_body_status, egcs_body_memo
FROM ships;

-- ── BWTS calibration (bwtsCal.js bwtsDue/bwtsLevel) ─────────────────────
CREATE OR REPLACE VIEW v_env2_cal_bwts WITH (security_invoker = on) AS
WITH th AS (
  SELECT (value->>'interval_months')::int AS months,
         (value->>'soon_days')::int AS soon,
         COALESCE((value->>'stale_after_days')::int, 365) AS stale
  FROM app_thresholds WHERE key = 'bwts_calibration'
),
b AS (
  SELECT c.ship_code, c.equip, c.last_date::date AS last_date,
         app_js_add_months(c.last_date::date, th.months) AS due_date,
         c.cert_url, c.report_url, c.note, c.model, c.serial, th.soon, th.stale
  FROM calibrations c CROSS JOIN th
  WHERE c.system = 'BWTS'
)
SELECT ship_code, equip, last_date, due_date,
       due_date - app_today_kst() AS days_left,
       CASE WHEN due_date IS NULL THEN 'unknown'
            WHEN due_date - app_today_kst() <= 0 THEN 'expired'
            WHEN due_date - app_today_kst() <= soon THEN 'soon'
            ELSE 'ok' END AS level,
       (due_date - app_today_kst()) < -stale AS stale,
       cert_url, report_url, note, model, serial
FROM b;

-- ── EGCS WMS calibration, one row per sensor (egcsCal.js egcsCellStatus) ─
CREATE OR REPLACE VIEW v_env2_cal_egcs WITH (security_invoker = on) AS
WITH th AS (
  SELECT (value->>'warn_days')::int AS warn,
         COALESCE((value->>'stale_after_days')::int, 365) AS stale
  FROM app_thresholds WHERE key = 'egcs_calibration'
),
e AS (
  SELECT c.ship_code, regexp_replace(COALESCE(c.equip, ''), '-', '/') AS equip,
         c.last_date::date AS last_date, c.model AS raw_model, c.serial, c.note, c.cert_url,
         CASE WHEN upper(COALESCE(s.wms, '')) LIKE '%TRI%' THEN 'TRIOS'
              WHEN upper(COALESCE(s.wms, '')) LIKE '%GI%'
                OR upper(COALESCE(s.wms, '')) LIKE '%GREEN%' THEN 'GI' END AS wms_maker
  FROM calibrations c JOIN ships s ON s.code = c.ship_code
  WHERE c.system = 'EGCS'
),
m AS (
  SELECT e.*,
         CASE WHEN equip LIKE '%PAH%' THEN 'PAH' WHEN equip LIKE '%TURB%' THEN 'TURB'
              ELSE 'PH' END AS sensor
  FROM e
),
r AS (
  SELECT m.*,
         CASE m.wms_maker
           WHEN 'TRIOS' THEN CASE m.sensor WHEN 'PAH' THEN 'enviroFlu'
                                           WHEN 'TURB' THEN 'TTurb' ELSE 'TpH-D' END
           WHEN 'GI' THEN CASE m.sensor WHEN 'TURB' THEN 'G6120' WHEN 'PH' THEN 'G6130'
                               ELSE (SELECT sc.model FROM sensor_cycles sc
                                     WHERE sc.model = m.raw_model) END
         END AS model
  FROM m
),
d AS (
  SELECT r.*, sc.cal_months, sc.repl_months,
         app_js_add_months(r.last_date, sc.cal_months) AS cal_due,
         app_js_add_months(r.last_date, sc.repl_months) AS repl_due
  FROM r LEFT JOIN sensor_cycles sc ON sc.model = r.model
),
f AS (
  SELECT d.*, COALESCE(cal_due, repl_due) AS due_date,
         COALESCE(cal_due, repl_due) - app_today_kst() AS days_left
  FROM d
)
SELECT f.ship_code, f.equip, f.sensor, f.model, f.last_date, f.cal_due, f.repl_due,
       f.due_date, f.days_left,
       (f.cal_months IS NULL AND f.repl_months IS NOT NULL) AS repl_only,
       CASE WHEN f.last_date IS NULL THEN 'unknown'
            WHEN f.repl_months IS NULL THEN 'unknown'
            WHEN f.days_left <= 0 THEN 'expired'
            WHEN f.days_left <= th.warn THEN 'soon'
            ELSE 'ok' END AS level,
       CASE WHEN f.last_date IS NULL THEN '검교정일 미기재'
            WHEN f.repl_months IS NULL THEN '센서 모델 미기재' END AS unknown_reason,
       f.days_left < -th.stale AS stale,
       f.serial, f.note, f.cert_url
FROM f CROSS JOIN th;

-- ── BWTS log grades, all periods (bwtsLog.js disp = final_grade || grade) ─
CREATE OR REPLACE VIEW v_env2_bwts_log WITH (security_invoker = on) AS
SELECT ship_code, period,
       COALESCE(NULLIF(final_grade, ''), grade) AS display_grade,
       grade AS auto_grade, review_status, review_note,
       grade_reasons, ballast_count, deballast_count, trip_count, alarm_count,
       tro_b_avg, tro_d_max, analyzed_at
FROM bwts_log_analysis;

-- ── BWTS/EGCS repairs with derived end date (down-days source) ──────────
-- end_date: completed_at > legacy history 'done' event > last linked
-- service-report visit. Open rows: end_date NULL (Dash counts until today).
CREATE OR REPLACE VIEW v_env2_repairs WITH (security_invoker = on) AS
WITH h AS (
  SELECT r.id,
         MAX(left(COALESCE(NULLIF(ev->>'date', ''), ev->>'at'), 10)::date) AS hist_done
  FROM repairs r
  CROSS JOIN LATERAL jsonb_array_elements(app_history_array(r.history)) ev
  WHERE r.system IN ('BWTS', 'EGCS') AND jsonb_typeof(ev) = 'object'
    AND ev->>'stage' IN ('done', '완료')
    AND COALESCE(NULLIF(ev->>'date', ''), ev->>'at') ~ '^\d{4}-\d{2}-\d{2}'
  GROUP BY r.id
),
sr AS (
  SELECT repair_id,
         MAX(COALESCE(visit_end, visit_start, (mail_at AT TIME ZONE 'Asia/Seoul')::date)) AS sr_last
  FROM service_reports
  WHERE repair_id IS NOT NULL AND NOT COALESCE(excluded, false)
  GROUP BY repair_id
)
SELECT r.id, r.ship_code, r.system,
       COALESCE(NULLIF(r.equip, ''), r.category) AS equip,
       COALESCE(NULLIF(r.symptom, ''), r.title) AS symptom,
       COALESCE(NULLIF(r.action, ''), r.last_action) AS action,
       r.status, r.origin, r.urgency, r.date AS start_date,
       CASE WHEN r.status <> '완료' THEN NULL
            ELSE COALESCE(r.completed_at, h.hist_done, sr.sr_last) END AS end_date,
       CASE WHEN r.status <> '완료' THEN '진행중'
            WHEN r.completed_at IS NOT NULL THEN '완료일'
            WHEN h.hist_done IS NOT NULL THEN '처리이력'
            WHEN sr.sr_last IS NOT NULL THEN '방선일'
            ELSE '미상' END AS end_basis,
       r.email_link, r.file_url
FROM repairs r
LEFT JOIN h ON h.id = r.id
LEFT JOIN sr ON sr.repair_id = r.id
WHERE r.system IN ('BWTS', 'EGCS');

-- ── grants ──────────────────────────────────────────────────────────────
REVOKE ALL ON v_env2_ships, v_env2_cal_bwts, v_env2_cal_egcs, v_env2_bwts_log, v_env2_repairs
  FROM anon, public;
GRANT SELECT ON v_env2_ships, v_env2_cal_bwts, v_env2_cal_egcs, v_env2_bwts_log, v_env2_repairs
  TO authenticated;
