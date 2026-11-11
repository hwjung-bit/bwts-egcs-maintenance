-- 037: 선박별 BWTS A/S 담당자
--
-- 테크로스는 선박마다 A/S 담당이 나뉜다(라스텍 정원비·김소연 주임, 본사 이대형 과장 등).
-- 선박관리 탭 'BWTS A/S' 칸에서 셀 클릭으로 수정, BWTS 검교정 탭 'A/S 담당' 열에 표시된다.
-- 초기값 = 사용자 보관 담당자 분류표(2026-11-11) + KLB·KDH·KDE(서비스 리포트·메일 기준).
--
-- 재실행 가능. Run in Supabase SQL Editor.

ALTER TABLE ships ADD COLUMN IF NOT EXISTS bwts_as TEXT;
