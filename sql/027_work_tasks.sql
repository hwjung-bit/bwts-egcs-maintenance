-- 027: repairs 를 업무 테이블로 확장 + 조치이력(work_actions) + 통일 상태
--
-- 업무관리대장(GAS+시트)을 이 앱으로 흡수한다. 테이블을 새로 만들지 않고
-- repairs 를 넓히는 이유: GAS 폴더/업로드 연동·스토리지·수집기가 전부
-- 테이블명 repairs 와 repair_id 에 묶여 있어 그대로 두는 게 가장 안전하다.
--   📋 업무 탭   = repairs 전체
--   🔧 수리이력  = repairs WHERE system IN ('BWTS','EGCS')  (복사본 아님, 같은 행)
--
-- 상태는 하나로 통일한다 (업무 4상태 + 수리 6단계 → 7개):
--   대기 · 확인 · 준비중 · 방선예정 · 진행 · 보류 · 완료
-- 옛 stage 는 앱이 전환될 때까지 그대로 두고(020 뷰·수집기·계약 내보내기가
-- 아직 읽는다), 트리거로 status 를 stage 에서 파생시켜 둘이 어긋나지 않게 한다.
-- 앱 전환(4~5단계) 후 stage 를 내린다.
--
-- Run once in Supabase SQL Editor, after 026. 재실행 가능.

-- ── 1. 업무 컬럼 ────────────────────────────────────────────────
ALTER TABLE repairs
  ADD COLUMN IF NOT EXISTS title        TEXT    DEFAULT '',
  ADD COLUMN IF NOT EXISTS detail       TEXT    DEFAULT '',
  ADD COLUMN IF NOT EXISTS source       TEXT    DEFAULT '',   -- 출처 (주간회의/상무/…)
  ADD COLUMN IF NOT EXISTS category     TEXT    DEFAULT '',   -- 구분 (검교정/수리/발주/…)
  ADD COLUMN IF NOT EXISTS requester    TEXT    DEFAULT '',   -- 지시자
  ADD COLUMN IF NOT EXISTS due_date     DATE,
  ADD COLUMN IF NOT EXISTS status       TEXT,                 -- 통일 상태 (아래 CHECK)
  ADD COLUMN IF NOT EXISTS progress     INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_action  TEXT    DEFAULT '',
  ADD COLUMN IF NOT EXISTS next_action  TEXT    DEFAULT '',
  ADD COLUMN IF NOT EXISTS completed_at DATE,
  ADD COLUMN IF NOT EXISTS note         TEXT    DEFAULT '';

-- 일반 업무는 시스템이 비어 있을 수 있다 (NOT NULL 은 유지, 빈 문자열 허용)
ALTER TABLE repairs ALTER COLUMN system SET DEFAULT '';

-- ── 2. 옛 stage → 통일 status 백필 ─────────────────────────────
CREATE OR REPLACE FUNCTION app_unify_status(p_stage TEXT) RETURNS TEXT
  LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE p_stage
    WHEN '미확인'     THEN '대기'
    WHEN '확인'       THEN '확인'
    WHEN '수리준비중' THEN '준비중'
    WHEN '자재준비중' THEN '준비중'
    WHEN '방선예정'   THEN '방선예정'
    WHEN '대기'       THEN '대기'
    WHEN '준비중'     THEN '준비중'
    WHEN '진행'       THEN '진행'
    WHEN '보류'       THEN '보류'
    WHEN '완료'       THEN '완료'
    ELSE '대기'
  END
$$;

UPDATE repairs SET status = app_unify_status(stage) WHERE status IS NULL;

ALTER TABLE repairs ALTER COLUMN status SET DEFAULT '대기';
ALTER TABLE repairs DROP CONSTRAINT IF EXISTS repairs_status_chk;
ALTER TABLE repairs ADD CONSTRAINT repairs_status_chk
  CHECK (status IN ('대기','확인','준비중','방선예정','진행','보류','완료'));
CREATE INDEX IF NOT EXISTS idx_repairs_status ON repairs(status);

-- ── 3. 전환기 정합성 트리거 ─────────────────────────────────────
-- 아직 stage 를 쓰는 경로(수리이력 탭·메일 전환·수집기)가 행을 넣거나
-- stage 를 바꾸면 status 를 따라 맞춘다. status 만 바꾼 경우는 건드리지 않는다.
-- 완료로 바뀌면 완료일을 채운다 (업무대장 onEdit 규칙과 동일).
CREATE OR REPLACE FUNCTION repairs_status_sync() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS NULL THEN
      NEW.status := app_unify_status(NEW.stage);
    END IF;
  ELSIF NEW.stage IS DISTINCT FROM OLD.stage
        AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    NEW.status := app_unify_status(NEW.stage);
  END IF;
  IF NEW.status = '완료' AND NEW.completed_at IS NULL THEN
    NEW.completed_at := CURRENT_DATE;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_repairs_status_sync ON repairs;
CREATE TRIGGER trg_repairs_status_sync
  BEFORE INSERT OR UPDATE ON repairs
  FOR EACH ROW EXECUTE FUNCTION repairs_status_sync();

-- ── 4. 조치이력 ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS work_actions (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES repairs(id) ON DELETE CASCADE,
  date       DATE,
  progress   INTEGER,
  note       TEXT DEFAULT '',
  author     TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_work_actions_task ON work_actions(task_id, date DESC);

ALTER TABLE work_actions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read_work_actions"   ON work_actions;
DROP POLICY IF EXISTS "insert_work_actions" ON work_actions;
DROP POLICY IF EXISTS "update_work_actions" ON work_actions;
DROP POLICY IF EXISTS "delete_work_actions" ON work_actions;
CREATE POLICY "read_work_actions" ON work_actions
  FOR SELECT TO authenticated USING (app_is_staff());
CREATE POLICY "insert_work_actions" ON work_actions
  FOR INSERT TO authenticated WITH CHECK (app_is_staff());
CREATE POLICY "update_work_actions" ON work_actions
  FOR UPDATE TO authenticated USING (app_is_staff()) WITH CHECK (app_is_staff());
CREATE POLICY "delete_work_actions" ON work_actions
  FOR DELETE TO authenticated USING (app_is_staff());

-- ── 5. 읽기용 별칭 ──────────────────────────────────────────────
-- 코드에서 "업무"를 다룰 때 repairs 라는 이름을 안 보이게 한다. 같은 행.
CREATE OR REPLACE VIEW work_tasks AS SELECT * FROM repairs;

-- ── 6. 계약 뷰 가드 ─────────────────────────────────────────────
-- 020 의 v_repairs_open 은 repairs 전체를 읽는다. 일반 업무가 들어오면
-- 공무팀 Dash 의 repairs_open.json 과 v_env_summary.repairs_open 에 새어
-- 나가므로 BWTS/EGCS 로 한정한다. 컬럼 목록은 020 과 동일하게 유지
-- (v_env_summary 가 이 뷰를 COUNT 로 참조).
CREATE OR REPLACE VIEW v_repairs_open AS
SELECT id, ship_code, system, date, equip, stage, symptom, action, origin, email_link, file_url
FROM repairs
WHERE COALESCE(stage,'') <> '완료'
  AND system IN ('BWTS', 'EGCS')
ORDER BY CASE stage WHEN '미확인' THEN 0 ELSE 1 END, date DESC;
