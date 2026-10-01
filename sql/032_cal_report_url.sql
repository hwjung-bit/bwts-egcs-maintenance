-- 032: BWTS 검교정 대장에 SERVICE REPORT 링크 칸.
-- cert_url 과 같은 방식 — 웹 📥 파일 저장(target=bwts_cal_report) 처리 후
-- GAS syncCalRecord_ 가 채운다. 기존 행은 GAS 1회 백필(backfillCalReportUrls_).
-- 재실행 가능.
ALTER TABLE calibrations ADD COLUMN IF NOT EXISTS report_url TEXT DEFAULT '';
