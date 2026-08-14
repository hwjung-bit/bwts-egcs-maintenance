-- 006: purge rows unrelated to BWTS/EGCS
-- Mirrors the collector rule: vessel and maker mail is kept only
-- when the content is about BWTS/EGCS. 선급 is always kept.
-- Run once in Supabase SQL Editor, after 005.

-- lastech = Techcross AS agent → BWTS fallback
UPDATE mail_log SET system = 'BWTS'
 WHERE sender ~* '@lastech\.' AND system = '기타';

-- Preview before deleting:
--   SELECT source, system, count(*) FROM mail_log
--    WHERE source = '기타'
--       OR (source IN ('본선', '메이커') AND system = '기타')
--    GROUP BY source, system;

DELETE FROM mail_log
 WHERE source = '기타'
    OR (source IN ('본선', '메이커') AND system = '기타');
