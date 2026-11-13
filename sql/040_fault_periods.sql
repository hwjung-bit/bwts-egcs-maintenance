-- 040: equipment downtime source for the 공무팀 Dash 가동률 (2026-11-12, rev 2026-11-13)
-- Owner decisions:
--   * downtime = periods the system could NOT be operated (운전 불가) only.
--     Defects where the system still ran (현황 탭 '운용가능') are not downtime.
--   * repair-ledger dates are not fault periods (completed_at = bulk-close days).
--   * 현황 탭 statuses: 정상 / 운용가능 (문제 있으나 운전됨) / 문제 (운전 불가).
--     Old value '수리중' is read as 운용가능.
-- Sources of v_env2_downtime:
--   (a) fault_periods — owner-confirmed 운전 불가 periods up to the cutoff
--       (2026-01-01 ~ 2026-11-13 re-count, and any later correction)
--   (b) status_history '문제' periods from the cutoff on (before the cutoff the
--       history did not separate 운전 불가 from 운용가능, so (a) covers it)
-- Rollback: DROP VIEW v_env2_downtime; DROP TABLE fault_periods; re-run 020 for v_env_summary.

-- 현황 탭 EGCS 기타(ETC) 칸 — WMS/CEMS/BODY 외 문제 (펌프·VFD·배관 등)
ALTER TABLE ships ADD COLUMN IF NOT EXISTS egcs_etc_status text;
ALTER TABLE ships ADD COLUMN IF NOT EXISTS egcs_etc_memo   text;
CREATE OR REPLACE VIEW v_env2_ships WITH (security_invoker = on) AS
SELECT code, name, teu, hidden, sort_order, bwts_maker, egcs_maker, bwts_as, wms, cems,
       bwts_status, bwts_memo,
       egcs_wms_status, egcs_wms_memo,
       egcs_cems_status, egcs_cems_memo,
       egcs_body_status, egcs_body_memo,
       egcs_etc_status, egcs_etc_memo
FROM ships;

CREATE TABLE IF NOT EXISTS fault_periods (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ship_code   text NOT NULL REFERENCES ships(code),
  system      text NOT NULL CHECK (system IN ('BWTS', 'EGCS')),
  part        text NOT NULL DEFAULT '',            -- e.g. PRU, CEMS, BODY
  start_date  date NOT NULL,
  end_date    date,                                -- NULL = still down
  status      text NOT NULL DEFAULT '문제' CHECK (status = '문제'),   -- 운전 불가 only
  note        text NOT NULL DEFAULT '',
  source      text NOT NULL DEFAULT '확인',        -- '재집계(2026-11)' etc.
  repair_ids  text[] NOT NULL DEFAULT '{}',        -- related repairs.id
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date IS NULL OR end_date >= start_date)
);
ALTER TABLE fault_periods ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read_fault_periods" ON fault_periods;
DROP POLICY IF EXISTS "write_fault_periods" ON fault_periods;
CREATE POLICY "read_fault_periods" ON fault_periods
  FOR SELECT TO authenticated USING (app_is_staff());
CREATE POLICY "write_fault_periods" ON fault_periods
  FOR ALL TO authenticated USING (app_is_owner()) WITH CHECK (app_is_owner());
REVOKE ALL ON fault_periods FROM anon;

-- one row per down period; overlapping rows are merged by the Dash
CREATE OR REPLACE VIEW v_env2_downtime WITH (security_invoker = on) AS
WITH cut AS (SELECT DATE '2026-11-13' AS d),
h AS (
  SELECT ship_code, system AS sub, status, COALESCE(memo, '') AS memo,
         (created_at AT TIME ZONE 'Asia/Seoul')::date AS d,
         LEAD((created_at AT TIME ZONE 'Asia/Seoul')::date)
           OVER (PARTITION BY ship_code, system ORDER BY created_at) AS next_d
  FROM status_history
),
hist AS (
  SELECT ship_code,
         CASE WHEN sub = 'bwts' THEN 'BWTS' ELSE 'EGCS' END AS system,
         upper(replace(sub, 'egcs_', '')) AS part,
         GREATEST(h.d, cut.d) AS start_date, next_d AS end_date, status, memo AS note,
         '현황'::text AS source
  FROM h, cut
  WHERE status = '문제' AND (next_d IS NULL OR next_d > cut.d)
),
pre AS (   -- currently 문제 but no history row for that part at all
  SELECT s.code AS ship_code, x.system, x.part, cut.d AS start_date,
         NULL::date AS end_date, x.status, COALESCE(x.memo, '') AS note,
         '현황(기록 없음)'::text AS source
  FROM ships s
  CROSS JOIN cut
  CROSS JOIN LATERAL (VALUES
      ('BWTS', 'BWTS', 'bwts',      s.bwts_status,      s.bwts_memo),
      ('EGCS', 'WMS',  'egcs_wms',  s.egcs_wms_status,  s.egcs_wms_memo),
      ('EGCS', 'CEMS', 'egcs_cems', s.egcs_cems_status, s.egcs_cems_memo),
      ('EGCS', 'BODY', 'egcs_body', s.egcs_body_status, s.egcs_body_memo),
      ('EGCS', 'ETC',  'egcs_etc',  s.egcs_etc_status,  s.egcs_etc_memo)
  ) AS x(system, part, sub, status, memo)
  WHERE x.status = '문제'
    AND NOT EXISTS (SELECT 1 FROM status_history sh
                    WHERE sh.ship_code = s.code AND sh.system = x.sub)
)
SELECT ship_code, system, part, start_date, end_date, status, note, source FROM hist
UNION ALL
SELECT ship_code, system, part, start_date, end_date, status, note, source FROM pre
UNION ALL
SELECT ship_code, system, part, start_date, end_date, status, note, source FROM fault_periods;

REVOKE ALL ON v_env2_downtime FROM anon, public;
GRANT SELECT ON v_env2_downtime TO authenticated;

-- v_env_summary (020): '운용가능' counts with the old '수리중' as status_repairing.
-- Same columns and order as 020 — only the repairing filter changes.
CREATE OR REPLACE VIEW v_env_summary AS
WITH sh AS (SELECT * FROM ships WHERE NOT COALESCE(hidden, false)),
st AS (
  SELECT
    COUNT(*) FILTER (WHERE '문제' IN (bwts_status, egcs_wms_status, egcs_cems_status, egcs_body_status, egcs_etc_status)) AS issue,
    COUNT(*) FILTER (WHERE '문제' NOT IN (COALESCE(bwts_status,'-'), COALESCE(egcs_wms_status,'-'), COALESCE(egcs_cems_status,'-'), COALESCE(egcs_body_status,'-'), COALESCE(egcs_etc_status,'-'))
                       AND ('수리중' IN (bwts_status, egcs_wms_status, egcs_cems_status, egcs_body_status, egcs_etc_status)
                         OR '운용가능' IN (bwts_status, egcs_wms_status, egcs_cems_status, egcs_body_status, egcs_etc_status))) AS repairing,
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
ALTER VIEW v_env_summary SET (security_invoker = on);
