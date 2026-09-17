-- 028: 수리이력·계약 뷰를 통일 status 기준으로 전환 (업무관리대장 흡수 5단계)
--
-- 027 이후 앱은 status(대기·확인·준비중·방선예정·진행·보류·완료)만 읽고 쓴다.
-- 옛 stage 컬럼은 남겨 두되(되돌리기·수집기 호환) 어떤 뷰도 더는 읽지 않는다.
-- v_repairs_open 은 공무팀 Dash 계약(repairs_open.json, v_env_summary.repairs_open)
-- 이 읽으므로 컬럼 순서는 020 그대로 두고 status 를 뒤에 덧붙인다.
--
-- Run once in Supabase SQL Editor, after 027. 재실행 가능.

CREATE OR REPLACE VIEW v_repairs_open AS
SELECT id, ship_code, system, date, equip, stage, symptom, action, origin, email_link, file_url,
       status
FROM repairs
WHERE COALESCE(status, '') <> '완료'
  AND system IN ('BWTS', 'EGCS')
ORDER BY CASE status WHEN '대기' THEN 0 ELSE 1 END, date DESC;

-- 앱이 status 만 쓰게 된 뒤에는 stage 가 비어 들어온다. 트리거의 INSERT 분기가
-- status NULL 일 때만 stage 에서 파생하므로 그대로 두어도 무해하다.
