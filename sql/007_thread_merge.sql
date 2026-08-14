-- 007: one row per thread, with the whole conversation in it
-- thread_body holds [{d: date, f: sender, p: preview}, ...]
-- newest first. Run once in Supabase SQL Editor, after 006.

ALTER TABLE mail_log
  ADD COLUMN IF NOT EXISTS thread_body JSONB DEFAULT '[]'::jsonb;

-- ── 1. Seed every row with its own message ─────────────
UPDATE mail_log SET thread_body = jsonb_build_array(
  jsonb_build_object(
    'd', coalesce(date::text, ''),
    'f', coalesce(sender, ''),
    'p', coalesce(body_preview, '')))
 WHERE thread_body IS NULL
    OR jsonb_array_length(thread_body) = 0;

-- ── 2. Collapse split threads into the newest row ──────
WITH ranked AS (
  SELECT id, thread_id,
         row_number() OVER (PARTITION BY thread_id
                            ORDER BY date DESC, id DESC) AS rn
    FROM mail_log
), agg AS (
  SELECT thread_id,
         jsonb_agg(jsonb_build_object(
           'd', coalesce(date::text, ''),
           'f', coalesce(sender, ''),
           'p', coalesce(body_preview, ''))
           ORDER BY date DESC, id DESC)      AS body,
         count(*)                            AS rows_n,
         sum(coalesce(reply_count, 0))       AS replies_n,
         min(date)                           AS first_date
    FROM mail_log
   GROUP BY thread_id
  HAVING count(*) > 1
)
UPDATE mail_log t
   SET thread_body = a.body,
       reply_count = a.replies_n + a.rows_n - 1,
       last_reply  = t.date
  FROM agg a, ranked r
 WHERE t.id = r.id AND r.rn = 1 AND r.thread_id = a.thread_id;

-- ── 3. Drop the now-merged duplicates ──────────────────
DELETE FROM mail_log WHERE id IN (
  SELECT id FROM (
    SELECT id, row_number() OVER (PARTITION BY thread_id
                                  ORDER BY date DESC, id DESC) AS rn
      FROM mail_log
  ) x WHERE x.rn > 1
);
