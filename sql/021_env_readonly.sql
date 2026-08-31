-- 021: 계약 뷰 접근 권한
--
-- 뷰는 소유자(postgres) 권한으로 실행되므로 기반 테이블의 RLS 를 우회한다.
-- 따라서 뷰 자체의 GRANT 가 곧 접근 통제다: anon 은 막고 authenticated(@ekmtc.com
-- 로그인, app_is_staff 는 뷰 안에서 강제되지 않으니 로그인 자체가 게이트)만 읽는다.
--
-- 공무팀 Dash 가 REST 로 읽고 싶으면: Supabase Auth 에 전용 계정(예 dashboard@ekmtc.com)
-- 을 만들어 그 JWT 로 GET /rest/v1/v_env_summary. 1순위 계약은 G드라이브 JSON 이므로
-- 이 경로는 선택이다.
--
-- 재실행 가능. Run in Supabase SQL Editor.

REVOKE ALL ON v_calibration_status, v_repairs_open, v_bwts_log_latest, v_env_summary, v_bwts_log_grades FROM anon;
GRANT SELECT ON v_calibration_status, v_repairs_open, v_bwts_log_latest, v_env_summary, v_bwts_log_grades TO authenticated;

-- 뷰가 staff 만 통과시키도록 security_invoker 를 켜면 기반 테이블 RLS(app_is_staff)가
-- 적용된다 (Postgres 15+, Supabase 지원). 로그인은 됐지만 사외 계정인 경우까지 막는다.
ALTER VIEW v_calibration_status SET (security_invoker = on);
ALTER VIEW v_repairs_open       SET (security_invoker = on);
ALTER VIEW v_bwts_log_latest    SET (security_invoker = on);
ALTER VIEW v_env_summary        SET (security_invoker = on);
ALTER VIEW v_bwts_log_grades    SET (security_invoker = on);
