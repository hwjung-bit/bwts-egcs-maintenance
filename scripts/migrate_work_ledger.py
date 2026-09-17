"""업무관리대장(구글 시트) → repairs/work_actions 일회성 이관.

sql/027_work_tasks.sql 이 먼저 적용돼 있어야 한다.

무엇을 하나
  업무 탭  → repairs 에 upsert. id 는 sync 와 같은 'WL_<업무ID>' 를 쓴다.
             이미 sync 로 들어와 있는 WL_ 행(BWTS/EGCS)은 새 업무 컬럼만 채우고
             stage·첨부·file_url·history·메일 링크는 건드리지 않는다.
  조치이력 → work_actions 에 upsert. 업무가 없는 고아 이력은 건너뛴다.

무엇을 안 하나
  삭제 없음. ML_·수동 등록 수리행 무수정. 시트 무수정.
  sync_work_ledger.py 의 SYNC_FROM 날짜 제한을 적용하지 않는다 (전체 이관).

실행
  python scripts/migrate_work_ledger.py --dry-run   # 쓰기 없이 건수만
  python scripts/migrate_work_ledger.py             # 실제 이관
  env: DRIVE_SA_JSON (또는 DRIVE_TOKEN_JSON/GMAIL_TOKEN_JSON), SUPABASE_URL, SUPABASE_SERVICE_KEY
"""
import logging
import os
import re
import sys

from googleapiclient.discovery import build
from supabase import create_client

# 시트 읽기·날짜 정규화·선박 코드는 sync 와 같은 규칙을 써야 같은 id 로 맞물린다.
from sync_work_ledger import (HEADERS, LEDGER_ID, ORIGIN, SHIP_CODES, TASK_RANGE,
                              get_creds, norm_date, read_tasks)

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger(__name__)

HIST_RANGE = "조치이력!A1:Z"
BATCH = 200

# 업무 4상태 + 수리 6단계 → 통일 7상태 (sql/027 app_unify_status 와 동일)
UNIFY = {
    "미확인": "대기", "확인": "확인", "수리준비중": "준비중", "자재준비중": "준비중",
    "방선예정": "방선예정", "대기": "대기", "준비중": "준비중", "진행": "진행",
    "보류": "보류", "완료": "완료",
}
# 새로 만드는 BWTS/EGCS 행의 옛 stage (앱 전환 전까지 수리이력 탭이 읽는다)
LEGACY_STAGE = {"대기": "미확인", "진행": "확인", "보류": "확인", "완료": "완료"}
REPAIR_SYSTEMS = {"BWTS", "EGCS"}


def to_int(v):
    d = re.sub(r"\D", "", str(v or ""))
    return int(d) if d else 0


def task_row(t, existing_ids):
    """시트 업무 1건 → repairs upsert 레코드. 기존 WL_ 행이면 업무 컬럼만."""
    rid = "WL_" + t["id"]
    ship = t.get("vessel", "").upper()
    system = t.get("system", "").strip()
    status = UNIFY.get(t.get("status", "").strip(), "대기")
    rec = {
        "id": rid,
        "ship_code": ship if ship in SHIP_CODES else None,
        "system": system,
        "date": norm_date(t.get("createdAt")),
        "title": t.get("title", ""),
        "detail": t.get("detail", ""),
        "source": t.get("source", ""),
        "category": t.get("category", ""),
        "requester": t.get("requester", ""),
        "due_date": norm_date(t.get("dueDate")),
        "status": status,
        "progress": to_int(t.get("progress")),
        "last_action": t.get("lastAction", ""),
        "next_action": t.get("nextAction", ""),
        "completed_at": norm_date(t.get("completedAt")),
        "note": t.get("note", ""),
        "urgency": t.get("urgency", ""),
        "origin": ORIGIN,
    }
    if rid not in existing_ids:
        # 신규 행: 수리이력 탭이 아직 stage 를 읽으므로 옛 단계도 채운다.
        rec["stage"] = (LEGACY_STAGE.get(status, "확인")
                        if system in REPAIR_SYSTEMS else "미확인")
        rec["symptom"] = t.get("title", "")
        rec["equip"] = t.get("category", "")
    return rec


def read_history(creds):
    svc = build("sheets", "v4", credentials=creds, cache_discovery=False)
    res = svc.spreadsheets().values().get(
        spreadsheetId=LEDGER_ID, range=HIST_RANGE,
        valueRenderOption="FORMATTED_VALUE").execute()
    rows = res.get("values", [])
    if not rows:
        return []
    keys = [h.strip() for h in rows[0]]   # 조치이력 헤더는 키와 동일 (Schema.js HISTORY_COLS)
    out = []
    for r in rows[1:]:
        h = {k: (str(r[i]).strip() if i < len(r) and r[i] is not None else "")
             for i, k in enumerate(keys) if k}
        if h.get("id") and h.get("taskId"):
            out.append(h)
    return out


def chunks(seq):
    for i in range(0, len(seq), BATCH):
        yield seq[i:i + BATCH]


def main():
    dry = "--dry-run" in sys.argv
    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_KEY", "").strip()
    if not url or not key:
        log.error("SUPABASE_URL / SUPABASE_SERVICE_KEY 없음")
        return 1
    sb = create_client(url, key)

    # 027 적용 확인: title 컬럼이 없으면 여기서 멈춘다
    try:
        sb.table("repairs").select("id,title").limit(1).execute()
    except Exception as e:  # noqa: BLE001
        log.error("repairs.title 조회 실패 — sql/027_work_tasks.sql 먼저 실행: %s", e)
        return 1

    creds = get_creds()
    tasks = read_tasks(creds)
    hist = read_history(creds)
    log.info("시트: 업무 %d건, 조치이력 %d건", len(tasks), len(hist))

    existing = set()
    start = 0
    while True:
        page = (sb.table("repairs").select("id").like("id", "WL_%")
                .range(start, start + 999).execute().data or [])
        existing.update(r["id"] for r in page)
        if len(page) < 1000:
            break
        start += 1000

    recs = [task_row(t, existing) for t in tasks]
    n_new = sum(1 for r in recs if r["id"] not in existing)
    n_upd = len(recs) - n_new
    by_sys = {}
    for r in recs:
        by_sys[r["system"] or "(없음)"] = by_sys.get(r["system"] or "(없음)", 0) + 1
    log.info("업무 → repairs: 신규 %d, 기존 WL_ 갱신 %d", n_new, n_upd)
    log.info("시스템별: %s", ", ".join(f"{k} {v}" for k, v in sorted(by_sys.items(), key=lambda x: -x[1])))

    task_ids = {r["id"] for r in recs}
    acts, orphan = [], 0
    for h in hist:
        tid = "WL_" + h["taskId"]
        if tid not in task_ids:
            orphan += 1
            continue
        acts.append({
            "id": h["id"], "task_id": tid, "date": norm_date(h.get("date")),
            "progress": to_int(h.get("progress")) if h.get("progress") else None,
            "note": h.get("note", ""), "author": h.get("author", ""),
        })
    log.info("조치이력 → work_actions: %d건 (고아 %d건 건너뜀)", len(acts), orphan)

    if dry:
        log.info("--dry-run: 쓰기 없음")
        return 0

    for part in chunks(recs):
        sb.table("repairs").upsert(part, on_conflict="id").execute()
    log.info("repairs upsert 완료 (%d)", len(recs))
    for part in chunks(acts):
        sb.table("work_actions").upsert(part, on_conflict="id").execute()
    log.info("work_actions upsert 완료 (%d)", len(acts))

    got = sb.table("repairs").select("id", count="exact").like("id", "WL_%").execute()
    log.info("검증: repairs 의 WL_ 행 = %s (기대 ≥ %d)", got.count, len(recs))
    return 0


if __name__ == "__main__":
    sys.exit(main())
