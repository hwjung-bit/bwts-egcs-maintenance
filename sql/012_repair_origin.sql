-- 012: repair origin (접수 경로)
--
-- 메일로 들어오지 않은 건 — 카톡·전화·구두·방선 중 정리된 추가 작업 —
-- 도 수리이력에 남길 수 있어야 한다. 대시보드의 "직접 등록" 버튼이
-- 이 컬럼을 채우고, 메일에서 옮겨온 기존 건은 전부 '메일'로 둔다.
--
-- Run once in Supabase SQL Editor, after 011.

ALTER TABLE repairs
  ADD COLUMN IF NOT EXISTS origin TEXT DEFAULT '메일';

UPDATE repairs SET origin = '메일' WHERE origin IS NULL;

CREATE INDEX IF NOT EXISTS idx_repairs_origin ON repairs(origin);
