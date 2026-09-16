"""
업무관리대장 → 수리이력 sync (Google Sheet → Supabase repairs)

환경기술파트 업무관리대장(GAS 웹앱, 진실원본 = 시트 '업무' 탭)에서
BWTS/EGCS 관련 업무만 골라 repairs 에 upsert 한다. id 는 'WL_<업무ID>'.

소유권 규칙:
  업무대장이 주인 → 제목·상세(symptom), 최근/다음조치(action), 상태(stage),
                    구분(equip), 등록일(date), 선박, 시스템. 실행마다 덮어쓴다.
  관리대장이 주인 → Drive 폴더, 첨부, 파일 링크. 여기서는 건드리지 않는다
                    (upsert 는 보낸 컬럼만 갱신한다).

대상 판정: 시스템 칸에 BWTS 또는 EGCS 가 있고 등록일이 SYNC_FROM 이후인 행만
(제목은 보지 않고, 과거 건은 옮기지 않는다 — 사용자 결정 2026-09-16).
시스템이 바뀌거나 업무가 지워져 대상에서 빠진 WL_ 행은 repairs 에서도 지운다.

GitHub Actions 에서 실행. 환경변수는 drive_index.py 와 같다:
  DRIVE_SA_JSON (권장, 시트를 서비스 계정에 뷰어로 공유) / DRIVE_TOKEN_JSON
  SUPABASE_URL, SUPABASE_SERVICE_KEY   — --dry-run 시 불필요

로컬 점검: python scripts/sync_work_ledger.py --dry-run
"""

import json, os, re, sys, logging, datetime as dt

from google.oauth2 import service_account
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from supabase import create_client

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

LEDGER_ID = "19GuSBHq_YhyRIkgcClXK0AWfjIlfZ2V1m22w-OWBjkU"   # 환경기술파트 업무 DB
TASK_RANGE = "업무!A1:R"
ORIGIN = "업무대장"
SYNC_FROM = "2026-09-16"   # 이 날 이후 등록된 업무만 (과거 건은 옮기지 않음)

# 시트 헤더 (work-ledger Schema.js TASK_COLS) → 키
HEADERS = {
    "ID": "id", "등록일": "createdAt", "출처": "source", "지시자": "requester",
    "선박": "vessel", "시스템": "system", "구분": "category", "제목": "title",
    "상세/지시내용": "detail", "기한": "dueDate", "상태": "status",
    "진행률": "progress", "최근조치": "lastAction", "다음조치": "nextAction",
    "완료일": "completedAt", "비고": "note", "updatedAt": "updatedAt",
}


# 업무대장 상태 → 수리이력 단계 (js/shared/constants.js STATUS_LIST)
STAGE = {"대기": "미확인", "진행": "확인", "보류": "확인", "완료": "완료"}

SHIP_CODES = {
    "KPS", "KUS", "KSH", "KKL", "KSG", "KJT", "KSL", "KQD",
    "KTJ", "KHM", "KNB", "KSZ", "KCN", "KJA", "KNH", "KMN",
    "KMB", "KDB", "KMU", "KCB", "KDE", "SDL", "SDY", "SAC",
}

DATE_RE = re.compile(r"(\d{4})[.\-/년\s]+(\d{1,2})[.\-/월\s]+(\d{1,2})")


def get_creds():
    sa_json = os.environ.get("DRIVE_SA_JSON", "")
    if sa_json:
        info = json.loads(sa_json)
        log.info("Service account: %s", info.get("client_email"))
        return service_account.Credentials.from_service_account_info(
            info, scopes=["https://www.googleapis.com/auth/spreadsheets.readonly"])
    token_json = (os.environ.get("DRIVE_TOKEN_JSON", "")
                  or os.environ.get("GMAIL_TOKEN_JSON", ""))
    if not token_json:
        log.error("DRIVE_SA_JSON / DRIVE_TOKEN_JSON not set")
        sys.exit(1)
    t = json.loads(token_json)
    creds = Credentials(
        token=t.get("access_token") or t.get("token"),
        refresh_token=t.get("refresh_token"),
        token_uri="https://oauth2.googleapis.com/token",
        client_id=t.get("client_id") or os.environ.get("GOOGLE_CLIENT_ID", ""),
        client_secret=t.get("client_secret") or os.environ.get("GOOGLE_CLIENT_SECRET", ""),
        scopes=t.get("scopes"),
    )
    if creds.expired or not creds.valid:
        creds.refresh(Request())
    return creds


def norm_date(v):
    m = DATE_RE.search(str(v or ""))
    if not m:
        return None
    y, mo, d = (int(x) for x in m.groups())
    try:
        return dt.date(y, mo, d).isoformat()
    except ValueError:
        return None


def read_tasks(creds):
    svc = build("sheets", "v4", credentials=creds, cache_discovery=False)
    try:
        res = svc.spreadsheets().values().get(
            spreadsheetId=LEDGER_ID, range=TASK_RANGE,
            valueRenderOption="FORMATTED_VALUE").execute()
    except HttpError as e:
        if e.resp.status in (403, 404) and os.environ.get("DRIVE_SA_JSON"):
            email = json.loads(os.environ["DRIVE_SA_JSON"]).get("client_email")
            log.error("시트 접근 불가 (%s) — 업무 DB 시트를 %s 에 뷰어로 공유하세요",
                      e.resp.status, email)
        raise
    rows = res.get("values", [])
    if not rows:
        return []
    keys = [HEADERS.get(h.strip(), None) for h in rows[0]]
    out = []
    for r in rows[1:]:
        t = {}
        for i, k in enumerate(keys):
            if k:
                t[k] = str(r[i]).strip() if i < len(r) and r[i] is not None else ""
        if t.get("id") and t.get("title"):
            out.append(t)
    return out


def to_repair(t):
    sysv = t.get("system", "").upper()
    if "BWTS" in sysv:
        system = "BWTS"
    elif "EGCS" in sysv:
        system = "EGCS"
    else:
        return None
    created = norm_date(t.get("createdAt"))
    if not created or created < SYNC_FROM:
        return None
    # ships FK: unknown/ALL/blank must be NULL, '' is rejected
    ship = t.get("vessel", "").upper()
    ship = ship if ship in SHIP_CODES else None
    symptom = t["title"] + (" — " + t["detail"] if t.get("detail") else "")
    action = t.get("lastAction", "")
    if t.get("nextAction"):
        action += (" → 다음: " if action else "다음: ") + t["nextAction"]
    return {
        "id": "WL_" + t["id"],
        "ship_code": ship,
        "system": system,
        "date": created,
        "equip": t.get("category", ""),
        "stage": STAGE.get(t.get("status", ""), "미확인"),
        "symptom": symptom,
        "action": action,
        "email_subject": t["title"],
        "origin": ORIGIN,
    }


def sync(dry_run=False):
    tasks = read_tasks(get_creds())
    rows = [r for r in (to_repair(t) for t in tasks) if r]
    log.info("업무 %d건 중 BWTS/EGCS %d건", len(tasks), len(rows))
    if dry_run:
        for r in rows[:10]:
            log.info("  %s %s %s %s | %s", r["id"], r["ship_code"] or "—",
                     r["system"], r["stage"], r["symptom"][:50])
        return {"tasks": len(tasks), "matched": len(rows), "dry_run": True}
    sb = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_KEY"])
    for i in range(0, len(rows), 200):
        sb.table("repairs").upsert(rows[i:i + 200], on_conflict="id").execute()
    log.info("upsert %d건", len(rows))
    # 대상에서 빠진 거울 행 정리 — 시트를 읽지 못했으면 여기까지 오지 않으므로 안전
    live = {r["id"] for r in rows}
    old = sb.table("repairs").select("id").like("id", "WL_%").execute()
    stale = [r["id"] for r in (old.data or []) if r["id"] not in live]
    for i in range(0, len(stale), 200):
        sb.table("repairs").delete().in_("id", stale[i:i + 200]).execute()
    if stale:
        log.info("대상 아님 → 삭제 %d건", len(stale))
    by = {}
    for r in rows:
        by[r["system"] + "/" + r["stage"]] = by.get(r["system"] + "/" + r["stage"], 0) + 1
    return {"tasks": len(tasks), "matched": len(rows), "removed": len(stale), "by": by}


if __name__ == "__main__":
    print(json.dumps(sync(dry_run="--dry-run" in sys.argv), ensure_ascii=False, indent=2))
