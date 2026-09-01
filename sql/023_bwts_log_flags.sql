-- 023: bwts_log_analysis.flags — 등급에 반영되지 않는 참고 표시 (예: "밸브 채터링 3건")
-- 2026-09-01 사용자 결정: 밸브 채터링은 점검필요 사유에서 빼고 운전양호 셀에 표시만 한다.
-- 재실행 가능. Run in Supabase SQL Editor.
ALTER TABLE bwts_log_analysis ADD COLUMN IF NOT EXISTS flags JSONB NOT NULL DEFAULT '[]';
