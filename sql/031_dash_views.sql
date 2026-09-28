-- 031: 공무팀 Dash 직접 연결용 뷰 — work_summary.json / ships.json 과 같은 내용
--
-- 020 의 네 뷰(v_env_summary 등)에 더해, export_contract.py 가 Python 에서 계산하던
-- 업무 현황·선박 마스터를 뷰로도 제공한다. Dash 가 REST 로 직접 읽을 때 repairs
-- 원본(상세·비고·비용 포함) 대신 이 뷰만 쓰게 하려는 것.
-- 기한 판정은 KST 기준(export_contract.py 와 동일).
--
-- 재실행 가능. Run in Supabase SQL Editor.

CREATE OR REPLACE VIEW v_work_summary AS
SELECT id, date, ship_code, system, category,
       COALESCE(NULLIF(title, ''), symptom, '') AS title,
       status, due_date, urgency, progress, last_action
FROM repairs
WHERE COALESCE(status, '') <> '완료'
ORDER BY due_date NULLS LAST, date;

CREATE OR REPLACE VIEW v_work_kpi AS
WITH t AS (SELECT status, due_date, urgency FROM repairs WHERE COALESCE(status, '') <> '완료'),
     d AS (SELECT (now() AT TIME ZONE 'Asia/Seoul')::date AS today)
SELECT count(*)                                                        AS open,
       count(*) FILTER (WHERE due_date < d.today)                      AS overdue,
       count(*) FILTER (WHERE due_date BETWEEN d.today AND d.today + 7) AS due_7d,
       count(*) FILTER (WHERE urgency = '상')                           AS urgent,
       jsonb_build_object(
         '대기',     count(*) FILTER (WHERE status = '대기'),
         '확인',     count(*) FILTER (WHERE status = '확인'),
         '준비중',   count(*) FILTER (WHERE status = '준비중'),
         '방선예정', count(*) FILTER (WHERE status = '방선예정'),
         '진행',     count(*) FILTER (WHERE status = '진행'),
         '보류',     count(*) FILTER (WHERE status = '보류'))       AS by_status
FROM t, d
GROUP BY d.today;

CREATE OR REPLACE VIEW v_ships AS
SELECT code, name, teu, hidden, sort_order, bwts_maker, egcs_maker
FROM ships
ORDER BY sort_order;

REVOKE ALL ON v_work_summary, v_work_kpi, v_ships FROM anon;
GRANT SELECT ON v_work_summary, v_work_kpi, v_ships TO authenticated;
ALTER VIEW v_work_summary SET (security_invoker = on);
ALTER VIEW v_work_kpi     SET (security_invoker = on);
ALTER VIEW v_ships        SET (security_invoker = on);
