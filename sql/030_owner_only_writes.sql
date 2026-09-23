-- 030: 쓰기는 소유자(hwjung@ekmtc.com)만. 읽기는 그대로 ekmtc 직원 전체.
--
-- 업무관리대장 흡수 후 이 앱이 업무 원본인데, 014 이후 쓰기 정책이 전부
-- app_is_staff()(= @ekmtc.com 누구나)라 다른 직원도 수정·삭제가 가능했다.
-- 옛 업무대장처럼 편집은 소유자만.
--
-- public·storage 스키마의 INSERT/UPDATE/DELETE/ALL 정책 중 app_is_staff() 를
-- 쓰는 것을 찾아 app_is_owner() 로 바꾼다 (SELECT 정책은 안 건드림).
-- 파이프라인·GAS·Actions 는 service_role 이라 RLS 를 우회 — 영향 없음.
--
-- 되돌리기: 아래 DO 블록에서 app_is_owner ↔ app_is_staff 를 바꿔 다시 실행.
-- 재실행 가능.

CREATE OR REPLACE FUNCTION app_is_owner() RETURNS boolean
  LANGUAGE sql STABLE
AS $$
  SELECT coalesce(auth.jwt() ->> 'email', '') = 'hwjung@ekmtc.com'
$$;

DO $$
DECLARE
  p record;
  q text;
  c text;
BEGIN
  FOR p IN
    SELECT schemaname, tablename, policyname, cmd, qual, with_check
    FROM pg_policies
    WHERE schemaname IN ('public', 'storage')
      AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
      AND (coalesce(qual, '') LIKE '%app_is_staff()%'
           OR coalesce(with_check, '') LIKE '%app_is_staff()%')
  LOOP
    q := replace(p.qual, 'app_is_staff()', 'app_is_owner()');
    c := replace(p.with_check, 'app_is_staff()', 'app_is_owner()');
    IF p.cmd = 'INSERT' THEN
      EXECUTE format('ALTER POLICY %I ON %I.%I WITH CHECK (%s)',
                     p.policyname, p.schemaname, p.tablename, c);
    ELSIF p.cmd = 'DELETE' THEN
      EXECUTE format('ALTER POLICY %I ON %I.%I USING (%s)',
                     p.policyname, p.schemaname, p.tablename, q);
    ELSE
      EXECUTE format('ALTER POLICY %I ON %I.%I USING (%s)%s',
                     p.policyname, p.schemaname, p.tablename, q,
                     CASE WHEN c IS NOT NULL THEN format(' WITH CHECK (%s)', c) ELSE '' END);
    END IF;
  END LOOP;
END
$$;

-- 014 이전 형식(auth.jwt() ->> 'email' LIKE '%@ekmtc.com')으로 남은 ships DELETE 도 소유자로.
DO $$
DECLARE p record;
BEGIN
  FOR p IN SELECT policyname FROM pg_policies
           WHERE schemaname = 'public' AND tablename = 'ships' AND cmd = 'DELETE'
             AND coalesce(qual, '') LIKE '%ekmtc%'
  LOOP
    EXECUTE format('ALTER POLICY %I ON public.ships USING (app_is_owner())', p.policyname);
  END LOOP;
END
$$;

-- 확인: 쓰기 정책 목록 (전부 app_is_owner 여야 함)
SELECT json_agg(t)::text AS j FROM (
  SELECT schemaname || '.' || tablename AS tbl, policyname, cmd,
         coalesce(qual, with_check) AS expr
  FROM pg_policies
  WHERE schemaname IN ('public', 'storage') AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  ORDER BY 1, 3
) t;
