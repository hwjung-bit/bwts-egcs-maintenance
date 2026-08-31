-- 005: mail source classification (본선/선급/메이커/기타)
--      + re-detect system with content-first rules
-- Run once in Supabase SQL Editor.

ALTER TABLE mail_log ADD COLUMN IF NOT EXISTS source TEXT;
CREATE INDEX IF NOT EXISTS mail_log_source_idx
  ON mail_log (source);

-- 아래 두 UPDATE 는 WHERE 없이 전 행을 재분류한다. 최초 1회에는 그게 의도지만,
-- 이미 분류된 DB 에서 실수로 다시 돌리면 사람이 수기로 고친 분류가 전부
-- 날아간다. 이미 채워져 있으면 멈춘다.
DO $$
DECLARE classified int;
BEGIN
  SELECT count(*) INTO classified FROM mail_log WHERE source IS NOT NULL;
  IF classified > 0 THEN
    RAISE EXCEPTION
      'source 가 이미 % 건 채워져 있다. 005 는 최초 1회용이다. '
      '정말 전체 재분류가 필요하면 이 DO 블록을 지우고 실행할 것.', classified;
  END IF;
END $$;

-- ── 1. source: by sender address ──────────────────────
UPDATE mail_log SET source = CASE
  WHEN sender ~* 'kmtc[a-z]{2,3}@sea-one\.com'
    THEN '본선'
  WHEN sender ~* '@(krs\.co\.kr|classnk\.or\.jp|classnk\.com'
                 '|dnv\.com|lr\.org|eagle\.org'
                 '|bureauveritas\.com|rina\.org|ccs\.org\.cn)'
    THEN '선급'
  WHEN sender ~* '@(techcross|alfalaval|ermafirst|unionkr'
                 '|hyundaimaterials|hhi-power|worldpanasia'
                 '|greeninstruments|lastech|ms-sox|itskr'
                 '|kc-cottrell|panstar|gweng)\.'
    THEN '메이커'
  ELSE '기타'
END;

-- ── 2. system: content wins, sender domain as fallback ─
UPDATE mail_log m
SET system = CASE
  WHEN t.bw AND NOT t.eg THEN 'BWTS'
  WHEN t.eg AND NOT t.bw THEN 'EGCS'
  WHEN m.sender ~* '@(techcross|alfalaval|ermafirst|lastech)\.'
    THEN 'BWTS'
  WHEN m.sender ~* '@(unionkr|hyundaimaterials|hhi-power'
                   '|worldpanasia|greeninstruments|ms-sox'
                   '|itskr|kc-cottrell)\.'
    THEN 'EGCS'
  WHEN t.bw THEN 'BWTS'
  WHEN t.eg THEN 'EGCS'
  ELSE '기타'
END
FROM (
  SELECT id,
    (coalesce(subject, '') || ' ' || coalesce(body_preview, ''))
      ~* 'BWTS|BWMS|평형수|ballast\s*water|BWRB'
         '|\yTRO\y|\yECU\y|\yCPC\y'                    AS bw,
    (coalesce(subject, '') || ' ' || coalesce(body_preview, ''))
      ~* 'EGCS|스크러버|scrubber|\yWMS\y|\yCEMS\y'
         '|\yPAH\y|탈황|wash\s*water'                  AS eg
  FROM mail_log
) t
WHERE t.id = m.id;

-- ── 3. junk review ─────────────────────────────────────
-- 화이트리스트 밖 발신자 = 기타. 건수 먼저 확인:
--   SELECT count(*) FROM mail_log WHERE source = '기타';
-- 확인 후 삭제하려면 아래 주석 해제:
-- DELETE FROM mail_log WHERE source = '기타';
