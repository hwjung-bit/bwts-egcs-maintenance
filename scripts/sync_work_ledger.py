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
TASK_RANGE = "업무!A1:Z"
ORIGIN = "업무대장"
SYNC_FROM = "2026-09-16"   # 이 날 이후 등록된 업무만 (과거 건은 옮기지 않음)

# 시트 헤더 (work-ledger Schema.js TASK_COLS) → 키
HEADERS = {
    "ID": "id", "등록일": "createdAt", "출처": "source", "지시자": "requester",
    "선박": "vessel", "시스템": "system", "구분": "category", "제목": "title",
    "상세/지시내용": "detail", "기한": "dueDate", "상태": "status",
    "진행률": "progress", "최근조치": "lastAction", "다음조치": "nextAction",
    "완료일": "completedAt", "비고": "note", "updatedAt": "updatedAt",
    "긴급도": "urgency",
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
    # 진행률은 repairs 에 칸이 없다 — 0/100 이 아닌 값만 조치 앞에 붙여 보여준다
    prog = re.sub(r"\D", "", t.get("progress", ""))
    if prog and prog not in ("0", "100"):
        action = f"[{prog}%] " + action if action else f"[{prog}%]"
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
        "urgency": t.get("urgency", ""),
    }


# ── 메일 건 ↔ 업무대장 건 병합 ─────────────────────────────────────────
# 메일대장에서 옮긴 수리이력(ML_)과 업무대장에서 온 건(WL_)이 같은 일이면
# WL_ 을 주인으로 두고 메일 링크·첨부·Drive 폴더를 넘긴 뒤 ML_ 을 지운다.
# 짝 판정: 같은 선박·시스템, 날짜 ±MERGE_DAYS, 제목 공통 단어 ≥2 & 겹침 ≥ MERGE_MIN.
MERGE_DAYS = 30
MERGE_MIN = 0.5
MERGE_MIN_HITS = 2
STOP = {"및", "관련", "내용", "건", "요청", "확인", "작성", "검토", "정리", "전달", "본선",
        "진행", "대기", "완료", "보류", "PO", "RST", "ALL", "RE", "FW", "FWD", "KMTC", "SM", "ETP",
        "BWTS", "EGCS", "호선", "호", "의"}


def tokens(s):
    s = re.sub(r"\[[^\]]*\]", " ", str(s or "")).upper()
    out = set()
    for p in re.split(r"[^0-9A-Z가-힣]+", s):
        if len(p) >= 2 and p not in STOP:
            out.add(p)
    return out


def overlap(a, b):
    hit = len(a & b)
    if hit < MERGE_MIN_HITS:
        return 0.0, hit
    return hit / max(4, min(len(a), len(b))), hit


def day_diff(a, b):
    try:
        return abs((dt.date.fromisoformat(str(a)[:10]) - dt.date.fromisoformat(str(b)[:10])).days)
    except ValueError:
        return 999


def parse_list(v):
    if not v:
        return []
    if isinstance(v, str):
        try:
            v = json.loads(v)
        except ValueError:
            return []
    return v if isinstance(v, list) else []


def merge_duplicates(sb):
    cols = "id,ship_code,system,date,symptom,email_subject,email_link,source_msg_id,attachments,file_url,history"
    rows = sb.table("repairs").select(cols).execute().data or []
    wl = [r for r in rows if str(r["id"]).startswith("WL_")]
    ml = [r for r in rows if str(r["id"]).startswith("ML_")]
    merged = 0
    for m in ml:
        if not m.get("ship_code"):
            continue
        mt = tokens(m.get("email_subject") or m.get("symptom"))
        best, best_score = None, 0.0
        for w in wl:
            if w.get("ship_code") != m["ship_code"] or w.get("system") != m.get("system"):
                continue
            if day_diff(w.get("date"), m.get("date")) > MERGE_DAYS:
                continue
            score, _ = overlap(mt, tokens(w.get("symptom")))
            if score > best_score:
                best, best_score = w, score
        if not best or best_score < MERGE_MIN:
            continue
        merge_into(sb, best, m)
        merged += 1
        log.info("병합 %.2f  %s ← %s | %s", best_score, best["id"], m["id"],
                 (m.get("email_subject") or m.get("symptom") or "")[:50])
    return merged


def merge_into(sb, w, m):
    patch = {}
    if not w.get("email_link") and m.get("email_link"):
        patch["email_link"] = m["email_link"]
    if not w.get("source_msg_id") and m.get("source_msg_id"):
        patch["source_msg_id"] = m["source_msg_id"]
    atts = parse_list(w.get("attachments"))
    names = {a.get("name") for a in atts if isinstance(a, dict)}
    added = [a for a in parse_list(m.get("attachments")) if isinstance(a, dict) and a.get("name") not in names]
    if added:
        patch["attachments"] = json.dumps(atts + added, ensure_ascii=False)
    folder_id = None
    fm = re.search(r"/folders/([A-Za-z0-9_-]+)", m.get("file_url") or "")
    if fm:
        folder_id = fm.group(1)
    else:
        fr = sb.table("folder_requests").select("folder_id").eq("repair_id", m["id"]).execute().data or []
        if fr and fr[0].get("folder_id"):
            folder_id = fr[0]["folder_id"]
    if folder_id and not w.get("file_url"):
        patch["file_url"] = f"https://drive.google.com/drive/folders/{folder_id}"
    hist = parse_list(w.get("history"))
    hist.append({"date": dt.date.today().isoformat(), "by": "sync",
                 "note": f"메일 건 병합: {m['id']} — {(m.get('email_subject') or m.get('symptom') or '')[:80]}"})
    patch["history"] = json.dumps(hist, ensure_ascii=False)
    sb.table("repairs").update(patch).eq("id", w["id"]).execute()
    if folder_id:
        # 이 WL 건의 작업폴더는 이미 있다 — 워커가 새로 만들지 않도록 linked 로 남긴다
        sb.table("folder_requests").upsert({
            "repair_id": w["id"], "ship_code": w["ship_code"], "system": w["system"],
            "req_date": w.get("date"), "title": w.get("symptom") or "",
            "status": "linked", "folder_id": folder_id, "msg_id": m.get("source_msg_id"),
        }, on_conflict="repair_id").execute()
    sb.table("folder_requests").update({"status": "merged"}).eq("repair_id", m["id"]).execute()
    sb.table("repairs").delete().eq("id", m["id"]).execute()


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
    merged = merge_duplicates(sb)
    if merged:
        log.info("메일 건 병합 %d건", merged)
    by = {}
    for r in rows:
        by[r["system"] + "/" + r["stage"]] = by.get(r["system"] + "/" + r["stage"], 0) + 1
    return {"tasks": len(tasks), "matched": len(rows), "removed": len(stale), "merged": merged, "by": by}


if __name__ == "__main__":
    print(json.dumps(sync(dry_run="--dry-run" in sys.argv), ensure_ascii=False, indent=2))
