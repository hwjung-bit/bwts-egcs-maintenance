-- 025: 선박별 WMS 특이사항 메모
--
-- 상태 메모(egcs_wms_memo)는 현황 탭에서 상태를 '정상'으로 되돌리면 지워진다 —
-- 장비 자체의 상시 특이사항을 담을 자리가 아니다. 그래서 별도 컬럼을 둔다.
-- 예) KDE: EGCS WMS 는 GI 인데 초기 제품이라 센서는 TRI-OS 가 물려 있음.
-- 선박관리 탭에서 셀 클릭으로 수정, EGCS 검교정 탭 선박 헤더에 📝 로 표시된다.
--
-- 재실행 가능. Run in Supabase SQL Editor.

ALTER TABLE ships ADD COLUMN IF NOT EXISTS wms_note TEXT;
