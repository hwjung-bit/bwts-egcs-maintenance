-- 017: ships.sort_order / ships.hidden 성문화
--
-- 선박관리 탭(순서 설정·숨김)과 getShipOrder() 가 두 컬럼을 읽고 쓰지만
-- 001~016 어디에도 정의가 없다. 016 의 현황 컬럼과 같은 종류의 드리프트로,
-- 클린 DB 를 만들면 순서 저장이 400 으로 깨진다.
--
-- 재실행 가능. Run in Supabase SQL Editor. (017 → 018 → 019 → 020 → 021 순서)

ALTER TABLE ships
  ADD COLUMN IF NOT EXISTS sort_order INTEGER,
  ADD COLUMN IF NOT EXISTS hidden     BOOLEAN NOT NULL DEFAULT FALSE;

-- 순서가 비어 있는 선박은 코드 순으로 뒤에 붙인다 (프론트는 null 을 999 로 본다)
UPDATE ships s
SET sort_order = x.rn
FROM (
  SELECT code,
         (SELECT COALESCE(MAX(sort_order), 0) FROM ships) + ROW_NUMBER() OVER (ORDER BY code) AS rn
  FROM ships WHERE sort_order IS NULL
) x
WHERE s.code = x.code AND s.sort_order IS NULL;
