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

-- 지우기 전에 통째로 복사해 둔다. 이 DELETE 는 비가역인데, 나중에 누가
-- 수기로 '기타' 를 붙여둔 행까지 함께 사라진다. 복구는 아래에서:
--   INSERT INTO mail_log SELECT * FROM mail_log_bak_006
--    ON CONFLICT (id) DO NOTHING;
DROP TABLE IF EXISTS mail_log_bak_006;
CREATE TABLE mail_log_bak_006 AS
  SELECT * FROM mail_log WHERE system = '기타';

-- 백업본도 mail_log 와 같은 내용이다. RLS 를 켜지 않으면 014 로 닫아둔
-- 메일 본문이 다른 이름으로 공개된 anon 키에 다시 열린다.
-- 정책을 만들지 않으므로 service_role 외에는 아무도 못 읽는다.
ALTER TABLE mail_log_bak_006 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON mail_log_bak_006 FROM anon, authenticated;

DELETE FROM mail_log WHERE system = '기타';

SELECT count(*) AS backed_up FROM mail_log_bak_006;
