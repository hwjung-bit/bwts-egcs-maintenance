-- 006: purge rows unrelated to BWTS/EGCS
-- Mirrors the collector rule: an allowlisted sender is not
-- enough — the content must classify as BWTS or EGCS.
-- Run once in Supabase SQL Editor, after 005.

-- lastech = Techcross AS agent → BWTS fallback
UPDATE mail_log SET system = 'BWTS'
 WHERE sender ~* '@lastech\.' AND system = '기타';

-- Preview before deleting:
--   SELECT source, count(*) FROM mail_log
--    WHERE system = '기타' GROUP BY source;

DELETE FROM mail_log WHERE system = '기타';
