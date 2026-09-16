-- 026: repairs.urgency (긴급도)
--
-- 업무관리대장의 긴급도(상/중/하)를 동기화로 받는다. 메일·직접등록 건은
-- 수리이력 탭에서 🔥 토글로 '상'만 지정한다. 종합 탭이 '상'을 모아 보여준다.
--
-- Run once in Supabase SQL Editor, after 025. 재실행 가능.

ALTER TABLE repairs
  ADD COLUMN IF NOT EXISTS urgency TEXT DEFAULT '';
