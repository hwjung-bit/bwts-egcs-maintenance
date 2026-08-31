-- 016: ships 현황 컬럼 성문화
--
-- 현황 탭이 쓰는 8개 컬럼이 001~015 어디에도 없다. Supabase 대시보드에서
-- 수동으로 추가된 것이라 클린 DB 를 만들면 현황 탭이 통째로 깨진다.
-- 2026-08-31 운영 DB 조회로 실재를 확인하고 여기에 성문화한다.
--
--   curl ".../rest/v1/ships?select=code,bwts_status,bwts_memo,..." → 200
--
-- 같은 조회에서 index.html 이 쓰기 대상으로 삼던 bwts_status_memo 는
-- 존재하지 않는 것으로 확인됐다 (42703). 현황 탭 메모 저장이 조용히
-- 실패하던 원인이며, 프론트를 실제 컬럼명(*_memo)에 맞췄다.
--
-- 재실행 가능. Run in Supabase SQL Editor.

ALTER TABLE ships
  ADD COLUMN IF NOT EXISTS bwts_status      TEXT DEFAULT '정상',
  ADD COLUMN IF NOT EXISTS bwts_memo        TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS egcs_wms_status  TEXT DEFAULT '정상',
  ADD COLUMN IF NOT EXISTS egcs_wms_memo    TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS egcs_cems_status TEXT DEFAULT '정상',
  ADD COLUMN IF NOT EXISTS egcs_cems_memo   TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS egcs_body_status TEXT DEFAULT '정상',
  ADD COLUMN IF NOT EXISTS egcs_body_memo   TEXT DEFAULT '';

-- 현황 탭 컬럼 명명 규칙 (프론트 stCell 이 이 규칙으로 짝을 만든다):
--   <계통>_status  ↔  <계통>_memo
-- '_status_memo' 같은 이름은 없다. 새 계통을 추가할 때도 이 규칙을 지킬 것.
