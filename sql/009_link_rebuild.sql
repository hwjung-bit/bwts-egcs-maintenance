-- 009: rebuild mail and Drive links
--
-- Links were built as ".../mail/u/0/#inbox/<threadId>", which only
-- opens while the thread still sits in the inbox — archived or
-- relabelled threads 404. "#all/<threadId>" opens either way
-- (verified against 2024 and 2026 threads).
--
-- Repairs also lost their mail link on the way in: 184 rows carry a
-- source_msg_id but no email_link, and 14 MIG_ rows carry their Drive
-- folder id inside the row id while file_url points at the shared ship
-- folder instead.
--
-- Run once in Supabase SQL Editor, after 008.

-- ── 0. file_url 컬럼 보장 ──────────────────────────────
-- 4단계가 repairs.file_url 을 쓰는데 001~008 어디에도 생성 구문이 없다.
-- 운영 DB 에는 어쩌다 존재하지만 클린 DB 에서는 여기서 죽는다.
ALTER TABLE repairs
  ADD COLUMN IF NOT EXISTS file_url TEXT DEFAULT '';

-- ── 1. mail_log: #inbox → #all ─────────────────────────
UPDATE mail_log
   SET mail_link = 'https://mail.google.com/mail/u/0/#all/'
                   || thread_id
 WHERE coalesce(thread_id, '') <> ''
   AND coalesce(mail_link, '') NOT LIKE '%#all/%';

-- ── 2. repairs: existing links to #all ─────────────────
UPDATE repairs
   SET email_link = replace(email_link, '#inbox/', '#all/')
 WHERE email_link LIKE '%#inbox/%';

-- ── 3. repairs: rebuild the missing links ──────────────
-- source_msg_id comes in three shapes:
--   "<msgId> @thread:<threadId>"  (GM_ rows)
--   "thread:<threadId>"          (ENRICH_ rows)
--   "<msgId>"                    (ML_ rows)
-- Prefer the thread id; fall back to the message id.
UPDATE repairs
   SET email_link = 'https://mail.google.com/mail/u/0/#all/'
       || coalesce(
            substring(source_msg_id from 'thread:([0-9a-f]+)'),
            substring(source_msg_id from '^([0-9a-f]{8,})'))
 WHERE coalesce(email_link, '') = ''
   AND source_msg_id ~ '[0-9a-f]{8,}';

-- MKR_ rows store it as "mkr:<id>" — same treatment, no anchor.
UPDATE repairs
   SET email_link = 'https://mail.google.com/mail/u/0/#all/'
                    || substring(source_msg_id from 'mkr:([0-9a-f]+)')
 WHERE coalesce(email_link, '') = ''
   AND source_msg_id ~ '^mkr:[0-9a-f]{8,}';

-- ── 4. repairs: MIG_ rows point at their own Drive folder ──
UPDATE repairs
   SET file_url = 'https://drive.google.com/drive/folders/'
                  || substring(id from '^MIG_(.+)$')
 WHERE id ~ '^MIG_[A-Za-z0-9_-]{20,}$';

-- ── 5. summary ─────────────────────────────────────────
SELECT
  (SELECT count(*) FROM mail_log
    WHERE mail_link LIKE '%#all/%')            AS mail_all,
  (SELECT count(*) FROM mail_log
    WHERE mail_link LIKE '%#inbox/%')          AS mail_inbox_left,
  (SELECT count(*) FROM repairs
    WHERE email_link LIKE '%#all/%')           AS repair_all,
  (SELECT count(*) FROM repairs
    WHERE coalesce(email_link, '') = '')       AS repair_no_link,
  (SELECT count(*) FROM repairs
    WHERE file_url LIKE '%/folders/%')         AS repair_folder;
