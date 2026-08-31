-- 014: RLS lockdown
--
-- 002/008/010/011 의 SELECT 정책이 `USING (true)` 에 `TO` 절 없이 걸려 있어
-- public(=anon) 롤까지 포함됐다. 리포가 PUBLIC 이라 index.html 의 anon 키를
-- 누구나 가져갈 수 있으므로, 실제로 인터넷에서 mail_log 전문(thread_body 포함)이
-- 조회되는 상태였다. 2026-08-31 curl 로 확인.
--
--   $ curl -s ".../rest/v1/mail_log?select=id&limit=1" -H "apikey: <anon>"
--   HTTP 200  [{"id":"1a03bb63cabf8943"}]
--
-- 이 파일은 SELECT 를 authenticated + @ekmtc.com 으로 닫고,
-- 그동안 빠져 있던 DELETE / INSERT 정책을 함께 채운다.
-- (003_config.sql 은 처음부터 올바른 형태였다 — 그 패턴을 전체에 적용한 것.)
--
-- 재실행 가능. Run in Supabase SQL Editor.

-- ── 판정 함수 하나로 통일 ──────────────────────────────────────────
-- 도메인 규칙이 바뀔 때 정책 20개를 고치지 않도록 한 군데로 모은다.
CREATE OR REPLACE FUNCTION app_is_staff() RETURNS boolean
  LANGUAGE sql STABLE
AS $$
  SELECT coalesce(auth.jwt() ->> 'email', '') LIKE '%@ekmtc.com'
$$;

-- ── SELECT: anon 차단 ─────────────────────────────────────────────
DROP POLICY IF EXISTS "read_ships"          ON ships;
DROP POLICY IF EXISTS "read_mail_log"       ON mail_log;
DROP POLICY IF EXISTS "read_repairs"        ON repairs;
DROP POLICY IF EXISTS "read_calibrations"   ON calibrations;
DROP POLICY IF EXISTS "read_drive_folders"  ON drive_folders;
DROP POLICY IF EXISTS "read_folder_requests" ON folder_requests;
DROP POLICY IF EXISTS "read_folder_trash"   ON folder_trash_requests;

CREATE POLICY "read_ships" ON ships
  FOR SELECT TO authenticated USING (app_is_staff());

CREATE POLICY "read_mail_log" ON mail_log
  FOR SELECT TO authenticated USING (app_is_staff());

CREATE POLICY "read_repairs" ON repairs
  FOR SELECT TO authenticated USING (app_is_staff());

CREATE POLICY "read_calibrations" ON calibrations
  FOR SELECT TO authenticated USING (app_is_staff());

CREATE POLICY "read_drive_folders" ON drive_folders
  FOR SELECT TO authenticated USING (app_is_staff());

CREATE POLICY "read_folder_requests" ON folder_requests
  FOR SELECT TO authenticated USING (app_is_staff());

CREATE POLICY "read_folder_trash" ON folder_trash_requests
  FOR SELECT TO authenticated USING (app_is_staff());

-- ── 기존 쓰기 정책도 TO 절 명시 ───────────────────────────────────
-- 동작은 같지만(익명 JWT 에는 email 이 없어 이미 거부됐다) 의도를 명시한다.
DROP POLICY IF EXISTS "update_mail_log"       ON mail_log;
DROP POLICY IF EXISTS "insert_mail_log"       ON mail_log;
DROP POLICY IF EXISTS "update_repairs"        ON repairs;
DROP POLICY IF EXISTS "insert_repairs"        ON repairs;
DROP POLICY IF EXISTS "update_calibrations"   ON calibrations;
DROP POLICY IF EXISTS "insert_folder_requests" ON folder_requests;
DROP POLICY IF EXISTS "insert_folder_trash"   ON folder_trash_requests;

CREATE POLICY "update_mail_log" ON mail_log
  FOR UPDATE TO authenticated USING (app_is_staff()) WITH CHECK (app_is_staff());

CREATE POLICY "insert_mail_log" ON mail_log
  FOR INSERT TO authenticated WITH CHECK (app_is_staff());

CREATE POLICY "update_repairs" ON repairs
  FOR UPDATE TO authenticated USING (app_is_staff()) WITH CHECK (app_is_staff());

CREATE POLICY "insert_repairs" ON repairs
  FOR INSERT TO authenticated WITH CHECK (app_is_staff());

CREATE POLICY "update_calibrations" ON calibrations
  FOR UPDATE TO authenticated USING (app_is_staff()) WITH CHECK (app_is_staff());

CREATE POLICY "insert_folder_requests" ON folder_requests
  FOR INSERT TO authenticated WITH CHECK (app_is_staff());

CREATE POLICY "insert_folder_trash" ON folder_trash_requests
  FOR INSERT TO authenticated WITH CHECK (app_is_staff());

-- ── 빠져 있던 정책 채우기 ─────────────────────────────────────────
-- DELETE 정책이 어느 테이블에도 없었다. 프론트는 5군데에서 .delete() 를
-- 호출하는데 RLS 가 0행 삭제로 조용히 거부하고, 코드는 결과를 안 봐서
-- "삭제됨" 토스트가 떴다 (새로고침하면 되살아난다).
DROP POLICY IF EXISTS "delete_mail_log" ON mail_log;
CREATE POLICY "delete_mail_log" ON mail_log
  FOR DELETE TO authenticated USING (app_is_staff());

DROP POLICY IF EXISTS "delete_repairs" ON repairs;
CREATE POLICY "delete_repairs" ON repairs
  FOR DELETE TO authenticated USING (app_is_staff());

-- calibrations 는 UPDATE 만 있어 신규 검교정 장비 등록이 막혀 있었다.
DROP POLICY IF EXISTS "insert_calibrations" ON calibrations;
CREATE POLICY "insert_calibrations" ON calibrations
  FOR INSERT TO authenticated WITH CHECK (app_is_staff());

-- ships 는 INSERT/UPDATE 가 아예 없어 선박 마스터 수정이 불가능했다.
DROP POLICY IF EXISTS "insert_ships" ON ships;
CREATE POLICY "insert_ships" ON ships
  FOR INSERT TO authenticated WITH CHECK (app_is_staff());

DROP POLICY IF EXISTS "update_ships" ON ships;
CREATE POLICY "update_ships" ON ships
  FOR UPDATE TO authenticated USING (app_is_staff()) WITH CHECK (app_is_staff());

-- 프론트가 요청을 취소할 때 행을 지우면 GAS 가 이미 처리 중일 수 있어
-- 고아 폴더가 남는다. 삭제 대신 status='cancelled' 로 표시하도록 바꿨으므로
-- (index.html) UPDATE 정책이 필요하다. DELETE 는 일부러 주지 않는다.
DROP POLICY IF EXISTS "update_folder_requests" ON folder_requests;
CREATE POLICY "update_folder_requests" ON folder_requests
  FOR UPDATE TO authenticated USING (app_is_staff()) WITH CHECK (app_is_staff());

-- ── 확인 ──────────────────────────────────────────────────────────
-- 적용 후 아래가 0행이어야 한다 (anon 에 열린 정책이 남아 있는지).
--   SELECT tablename, policyname, roles FROM pg_policies
--    WHERE schemaname = 'public' AND 'anon' = ANY(roles);
--
-- 그리고 익명 호출이 이제 빈 배열을 반환해야 한다.
--   curl -s ".../rest/v1/mail_log?select=id&limit=1" -H "apikey: <anon>"
--   → []
