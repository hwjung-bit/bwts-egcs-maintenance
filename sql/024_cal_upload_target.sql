-- 024: 업로드 큐를 BWTS 검교정 파일 저장에도 사용
--
-- BWTS 검교정 탭의 📥 파일 저장은 수리이력 없이 파일만 올린다.
-- target 이 있으면 GAS 가 repair 연동 대신 검교정 자료실로 보낸다:
--   bwts_cal_cert   → 011 BWTS › 11. CALIBRATION 연간 검교정 › 02. CERT
--   bwts_cal_report → 〃 › 03. SERVICE REPORT
--   bwts_cal_alarm  → 〃 › 04. SAFETY ALARM TEST
-- 각 폴더 아래 YYYY년 › 'YYYY-MM-DD SHIP' 이벤트 폴더에 저장 (기존 CERT 관행).
--
-- 재실행 가능. Run in Supabase SQL Editor.

ALTER TABLE upload_requests ALTER COLUMN repair_id DROP NOT NULL;
ALTER TABLE upload_requests ADD COLUMN IF NOT EXISTS target TEXT;
