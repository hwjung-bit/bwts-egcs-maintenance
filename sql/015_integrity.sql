-- 015: 스키마 무결성 + 큐 재시도
--
-- 세 가지를 정리한다.
--   1. thread_id UNIQUE — 007 이 "스레드당 1행"으로 병합해 놓고도 제약이
--      없어서, 같은 스레드의 새 메시지가 다른 id 로 들어오면 중복이 재발한다.
--   2. 외래키 — 모든 ship_code 에 FK 가 없어 오탈자 선박코드가 그대로
--      적재되고 필터에 유령 선박이 생긴다.
--   3. 큐 재시도 — folder_requests / folder_trash_requests 의 'error' 가
--      종착역이라 실패 건을 영원히 아무도 모른다.
--
-- 1·2 는 기존 데이터가 깨끗해야 걸린다. 반쯤 적용되는 것보다 멈추는 게
-- 낫기 때문에, 위반이 있으면 무엇을 고쳐야 하는지 알리고 중단한다.
-- 재실행 가능. Run in Supabase SQL Editor, after 014.

-- ── 1. mail_log.thread_id UNIQUE ──────────────────────────────────
DO $$
DECLARE dup_count int;
BEGIN
  SELECT count(*) INTO dup_count FROM (
    SELECT thread_id FROM mail_log
     WHERE coalesce(thread_id, '') <> ''
     GROUP BY thread_id HAVING count(*) > 1
  ) d;

  IF dup_count > 0 THEN
    RAISE EXCEPTION
      'thread_id 중복 % 건. 007_thread_merge.sql 을 먼저 실행하고 다시 시도할 것. '
      '확인: SELECT thread_id, count(*) FROM mail_log GROUP BY 1 HAVING count(*) > 1;',
      dup_count;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS mail_log_thread_uniq
  ON mail_log (thread_id)
  WHERE coalesce(thread_id, '') <> '';

-- ── 2. 외래키 ─────────────────────────────────────────────────────
-- 선박을 못 찾은 메일은 ship_code 에 빈 문자열이 들어가 있다 (2026-08-31
-- 기준 mail_log 402건 중 112건). FK 는 '' 를 NULL 로 보지 않으므로
-- ships.code 에 없다며 거부한다. "미상"은 NULL 이 맞는 표현이기도 하다.
-- 수집기도 이제 None 을 쓴다 (supabase_collector.py).
UPDATE mail_log     SET ship_code = NULL WHERE ship_code = '';
UPDATE repairs      SET ship_code = NULL WHERE ship_code = '';
UPDATE calibrations SET ship_code = NULL WHERE ship_code = '';

-- 그래도 ships 에 없는 코드가 남아 있으면 FK 생성이 실패한다.
-- 반쯤 적용되는 것보다 무엇이 문제인지 알리고 멈추는 게 낫다.
DO $$
DECLARE orphans text;
BEGIN
  SELECT string_agg(DISTINCT t.ship_code, ', ') INTO orphans
    FROM (
      SELECT ship_code FROM mail_log
      UNION SELECT ship_code FROM repairs
      UNION SELECT ship_code FROM calibrations
    ) t
   WHERE t.ship_code IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM ships s WHERE s.code = t.ship_code);

  IF orphans IS NOT NULL THEN
    RAISE EXCEPTION
      'ships 에 없는 ship_code: %. 선박 마스터에 추가하거나 해당 행을 고친 뒤 다시 실행할 것.',
      orphans;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mail_log_ship_fk') THEN
    ALTER TABLE mail_log ADD CONSTRAINT mail_log_ship_fk
      FOREIGN KEY (ship_code) REFERENCES ships(code) ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'repairs_ship_fk') THEN
    ALTER TABLE repairs ADD CONSTRAINT repairs_ship_fk
      FOREIGN KEY (ship_code) REFERENCES ships(code) ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calibrations_ship_fk') THEN
    ALTER TABLE calibrations ADD CONSTRAINT calibrations_ship_fk
      FOREIGN KEY (ship_code) REFERENCES ships(code) ON UPDATE CASCADE;
  END IF;
END $$;

-- ON UPDATE CASCADE 를 준 이유: 선박 코드 변경 시 이력이 고아가 되는 문제가
-- 있었다. 프론트에서는 코드 편집을 막았지만, DB 수준에서 고치는 경우에도
-- 자동으로 따라가도록 둔다.

-- folder_requests 에는 일부러 FK 를 걸지 않는다.
--
-- ON DELETE CASCADE 를 걸면 프론트가 수리이력을 지우기 직전에 남긴
-- status='cancelled' 표시가 곧바로 함께 삭제된다. 그러면 GAS 가 그 요청을
-- 선점해 폴더를 만드는 중이었을 때, 큐 행이 사라지고 결과 PATCH 는 0행이라
-- 아무 기록도 없이 고아 폴더만 남는다 — cancelled 설계가 막으려던 바로 그
-- 상황이다. 큐의 수명은 repairs 가 아니라 워커가 관리한다.
--
-- 이미 쌓인 고아 요청만 1회 정리한다.
DELETE FROM folder_requests f
 WHERE f.status IN ('pending', 'processing')
   AND NOT EXISTS (SELECT 1 FROM repairs r WHERE r.id = f.repair_id);

-- ── 3. 큐 재시도 ──────────────────────────────────────────────────
-- attempts: 워커가 시도할 때마다 증가. MAX_ATTEMPTS 도달 전까지는
--           'error' 대신 'pending' 으로 되돌려 다음 회차가 다시 집는다.
-- locked_at: 선점(claim) 시각. 오래 잡혀 있으면 죽은 실행으로 보고 회수한다.
ALTER TABLE folder_requests
  ADD COLUMN IF NOT EXISTS attempts  INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ;

ALTER TABLE folder_trash_requests
  ADD COLUMN IF NOT EXISTS attempts  INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ;

-- 상태값 확장: pending | processing | linked | created | trashed
--            | cancelled (프론트 취소) | error (재시도 소진)
COMMENT ON COLUMN folder_requests.status IS
  'pending | processing | linked | created | cancelled | error';
COMMENT ON COLUMN folder_trash_requests.status IS
  'pending | processing | trashed | error';

CREATE INDEX IF NOT EXISTS folder_requests_pending_idx
  ON folder_requests (status, locked_at);
CREATE INDEX IF NOT EXISTS folder_trash_pending_idx
  ON folder_trash_requests (status, locked_at);

-- ── 4. 확인 ───────────────────────────────────────────────────────
SELECT
  (SELECT count(*) FROM folder_requests WHERE status = 'error')   AS req_error,
  (SELECT count(*) FROM folder_requests WHERE status = 'pending') AS req_pending,
  (SELECT count(*) FROM folder_trash_requests WHERE status = 'error') AS trash_error,
  (SELECT count(*) FROM pg_policies
    WHERE schemaname = 'public' AND 'anon' = ANY(roles))          AS anon_policies_left;
