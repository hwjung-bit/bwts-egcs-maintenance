-- 013: msg_id on folder_requests
--
-- 수리이력 등록 시 GAS 워커가 원본 Gmail 메일을 다시 열어 첨부파일을
-- 실제로 작업폴더에 저장할 수 있도록, 어느 메일인지 함께 넘긴다.
--
-- Run once in Supabase SQL Editor, after 012.

ALTER TABLE folder_requests
  ADD COLUMN IF NOT EXISTS msg_id TEXT;

-- 013 이전에 쌓인 pending 행은 msg_id 가 NULL 이라 워커가 첨부 저장을
-- 조용히 건너뛴다. repairs 에서 끌어와 채운다.
UPDATE folder_requests f
   SET msg_id = r.source_msg_id
  FROM repairs r
 WHERE r.id = f.repair_id
   AND f.msg_id IS NULL
   AND coalesce(r.source_msg_id, '') <> '';
