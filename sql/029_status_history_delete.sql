-- 029: status_history 삭제 정책 — 현황 이력에서 잘못 기록한 항목을 지울 수 있게.
-- 023 은 read/insert/update 만 만들었다. 삭제는 직원(app_is_staff)만.
-- Run once in Supabase SQL Editor, after 023. 재실행 가능.

DROP POLICY IF EXISTS "delete_status_history" ON status_history;
CREATE POLICY "delete_status_history" ON status_history
  FOR DELETE TO authenticated USING (app_is_staff());
