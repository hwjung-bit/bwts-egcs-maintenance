-- 038: lock down work_tasks view (2026-11-12)
-- Found: anon key could read work_tasks (SELECT * FROM repairs) — the view was
-- created in 027 without REVOKE/GRANT and without security_invoker, so it ran as
-- owner and bypassed repairs RLS. No code reads this view.
-- Rollback: ALTER VIEW public.work_tasks SET (security_invoker = off);
--           GRANT SELECT ON public.work_tasks TO anon;

REVOKE ALL ON public.work_tasks FROM anon, public;
ALTER VIEW public.work_tasks SET (security_invoker = on);

-- Verify: every public view, its options, and whether anon can SELECT it
SELECT json_agg(t)::text FROM (
  SELECT c.relname AS view,
         c.reloptions AS opts,
         has_table_privilege('anon', c.oid, 'SELECT') AS anon_select
  FROM pg_class c
  WHERE c.relkind = 'v' AND c.relnamespace = 'public'::regnamespace
  ORDER BY 1
) t;
