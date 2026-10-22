"""
Service Report Importer — Gmail API → Supabase (service_reports, sql/035)

Gmail Auto Manager GAS(ServiceReportSave.gs)가 첨부를 Drive 에 저장하는
메일과 같은 조건으로 메일을 찾아 대장 행을 만든다. PDF 는 읽지 않는다 —
제목과 본문 상단(인용 전)만 보고 방선일·작업 구분을 추정한다.

  대상  : 벤더 도메인 발신 + 첨부 + 제목/본문 상단에 서비스 리포트 키워드
  선박  : 본문 상단 → 제목 순으로 처음 나오는 선명/코드
  장비  : EGCS 키워드 → BWTS 키워드 → 벤더 기본값
  방선일: 방선·작업 키워드가 있는 줄의 날짜 (메일일 -120일 ~ +3일)
  수리건: 같은 선박·장비에서 메일일을 덮는 repairs 가 하나뿐이면 연결

사람이 웹에서 고친 행(edited=true)은 메일 칸만 갱신하고 방선일·구분·
요약·수리건은 그대로 둔다.

GitHub Actions(sr-import.yml)에서 실행. 환경변수는 supabase_collector.py 와 같다.
  python scripts/sr_import.py                 최근 30일
  python scripts/sr_import.py --since 2023-01-01
  python scripts/sr_import.py --dry-run       Supabase 쓰기 없이 결과만 출력
"""

import argparse, os, re, sys, time, logging
from datetime import date, datetime, timedelta, timezone

from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

from supabase_collector import (
    SHIP_MAP, extract_body_text, fetch_messages, get_gmail_creds,
    get_header,
)

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

KST = timezone(timedelta(hours=9))

# Same table as ServiceReportSave.gs SR_VENDORS — keep the two in step.
# '' = no default equipment, decide by keywords only.
VENDORS = {
    "techcross.com": "BWTS",
    "lastech.kr": "BWTS",
    "alfalaval.com": "",
    "worldpanasia.com": "",
    "unionkr.com": "EGCS",
    "hd.com": "EGCS",
    "kongsberg.com": "EGCS",
    "hyundaimaterials.com": "EGCS",
    "itskr.co.kr": "EGCS",
}

KEYWORD_RE = re.compile(r"service\s*report|서비스\s*[레리]포트", re.I)
EGCS_RE = re.compile(r"EGCS|SCRUBBER|스크러버|CEMS|\bGMS\b|\bWMS\b|PureSOx|"
                     r"다공판|QUENCHING", re.I)
BWTS_RE = re.compile(r"BWTS|BWMS|평형수|\bTRO\b|PureBallast|\bDTS\b|\bECU\b|"
                     r"\bPB\b|\bCSP\b", re.I)
QUOTE_RE = re.compile(r"\n\s*(From:|보낸 사람:|-+\s*Original Message|"
                      r"On .{5,80}wrote:)", re.I)

# First match wins, so the more specific kinds come first.
WORK_TYPES = [
    ("개조·설치", re.compile(r"retrofit|개조|신규\s*설치|install", re.I)),
    ("검교정", re.compile(r"calibration|캘리브레이션|검교정|교정", re.I)),
    ("수리", re.compile(r"수리|repair|고장|불량|trouble|TS|fail|"
                        r"malfunction|error|alarm|이상|조치|교체|replace|"
                        r"작동\s*불가|용접", re.I)),
    ("정기점검", re.compile(r"정기|점검|annual|inspection|condition|"
                          r"pre-?check|survey", re.I)),
]

VISIT_LINE_RE = re.compile(r"방선|승선|작업\s*(일|기간|일정)|일정|기간|"
                           r"attend|visit|on\s*board|boarding|"
                           r"service\s*date|working\s*date", re.I)

MONTHS = {m: i + 1 for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun",
     "jul", "aug", "sep", "oct", "nov", "dec"])}

SIGNATURE_IMAGE_MAX = 100 * 1024
UPSERT_CHUNK = 100


# ── Detection ─────────────────────────────────────
def vendor_of(from_addr):
    """(domain, default equipment) or (None, None) when not a vendor."""
    addr = from_addr.lower()
    for dom, equip in VENDORS.items():
        if "@" + dom in addr or "." + dom in addr:
            return dom, equip
    return None, None


def top_body(body):
    m = QUOTE_RE.search(body)
    return (body[:m.start()] if m else body)[:3000]


def _ship_pattern(code, name):
    # Letters may be split by spaces ("NHAVA SHEVA", "JEBEL ALI")
    letters = r"\s*".join(re.escape(c) for c in name.replace(" ", ""))
    return re.compile(letters + r"|\b" + code + r"\b", re.I)


SHIP_PATTERNS = [(c, _ship_pattern(c, n)) for c, n in SHIP_MAP.items()]
# Vendor typos seen in real subjects
SHIP_PATTERNS.append(("KJA", re.compile(r"JEBLE\s*ALI", re.I)))


def first_ship(text):
    best, best_at = None, -1
    for code, pat in SHIP_PATTERNS:
        m = pat.search(text or "")
        if m and (best_at < 0 or m.start() < best_at):
            best, best_at = code, m.start()
    return best


def work_type_of(text):
    for name, pat in WORK_TYPES:
        if pat.search(text):
            return name
    return "기타"


def clean_subject(subject):
    s = re.sub(r"^\s*((re|fw|fwd|회신|전달)\s*:\s*)+", "", subject or "",
               flags=re.I)
    s = re.sub(r"\[(KMTC SM|ETP|EXTERNAL|외부메일|외부 메일)\]", "", s,
               flags=re.I)
    return re.sub(r"\s+", " ", s).strip()[:200]


# ── Visit dates ───────────────────────────────────
DATE_PATTERNS = [
    # 2026.10.15 / 2026-10-15 / 2026/10/15 (+ optional "~17" or "~10.17")
    re.compile(r"(?P<y>20\d{2})\s*[./-]\s*(?P<m>\d{1,2})\s*[./-]\s*(?P<d>\d{1,2})"
               r"(?:\s*[~\-–]\s*(?:(?P<m2>\d{1,2})\s*[./-]\s*)?(?P<d2>\d{1,2})\b)?"),
    # 2026년 10월 15일 / 10월 15일 (~17일)
    re.compile(r"(?:(?P<y>20\d{2})\s*년\s*)?(?P<m>\d{1,2})\s*월\s*(?P<d>\d{1,2})\s*일"
               r"(?:\s*[~\-–]\s*(?:(?P<m2>\d{1,2})\s*월\s*)?(?P<d2>\d{1,2})\s*일)?"),
    # 10/15 or 10.15 (~17) — no year
    re.compile(r"(?<![\d./-])(?P<m>\d{1,2})\s*[./]\s*(?P<d>\d{1,2})(?![\d./])"
               r"(?:\s*[~\-–]\s*(?:(?P<m2>\d{1,2})\s*[./]\s*)?(?P<d2>\d{1,2})(?![\d./]))?"),
    # 15 Oct 2026 / 15th October / 15~17 Oct
    re.compile(r"(?P<d>\d{1,2})(?:st|nd|rd|th)?(?:\s*[~\-–]\s*(?P<d2>\d{1,2})"
               r"(?:st|nd|rd|th)?)?\s+(?P<mon>[A-Za-z]{3})[a-z]*\.?,?"
               r"(?:\s+(?P<y>20\d{2}))?"),
    # Oct 15 (~17), 2026
    re.compile(r"(?P<mon>[A-Za-z]{3})[a-z]*\.?\s+(?P<d>\d{1,2})(?!\d)(?:st|nd|rd|th)?"
               r"(?:\s*[~\-–]\s*(?P<d2>\d{1,2}))?,?(?:\s+(?P<y>20\d{2}))?"),
]


def _mk(y, m, d):
    try:
        return date(y, m, d)
    except ValueError:
        return None


def dates_in(line, mail_day):
    out = []
    for pat in DATE_PATTERNS:
        for m in pat.finditer(line):
            g = m.groupdict()
            if g.get("mon"):
                mon = MONTHS.get(g["mon"][:3].lower())
                if not mon:
                    continue
            else:
                mon = int(g["m"])
            year = int(g["y"]) if g.get("y") else mail_day.year
            d1 = _mk(year, mon, int(g["d"]))
            if d1 and not g.get("y") and d1 > mail_day + timedelta(days=3):
                d1 = _mk(year - 1, mon, int(g["d"]))
            if not d1:
                continue
            out.append(d1)
            if g.get("d2"):
                mon2 = int(g["m2"]) if g.get("m2") else d1.month
                d2 = _mk(d1.year, mon2, int(g["d2"]))
                if d2 and d2 >= d1:
                    out.append(d2)
    return out


def visit_dates(subject, top, mail_day):
    """(start, end) from the subject ("… / 9.2", "(4/13)") and body lines that
    talk about the visit, else (None, None)."""
    lo, hi = mail_day - timedelta(days=120), mail_day + timedelta(days=3)
    lines = [subject] + [ln for ln in top.splitlines()
                         if VISIT_LINE_RE.search(ln)]
    found = []
    for line in lines:
        found += [d for d in dates_in(line, mail_day) if lo <= d <= hi]
    if not found:
        return None, None
    return min(found), max(found)


# ── Gmail ─────────────────────────────────────────
def build_query(since):
    froms = " OR ".join(VENDORS)
    return (f"from:({froms}) has:attachment -from:me "
            '{"service report" "서비스 레포트" "서비스레포트" '
            '"서비스 리포트" "서비스리포트"} '
            f"after:{since.strftime('%Y/%m/%d')}")


def attachments_of(payload):
    out = []

    def walk(part):
        name = part.get("filename") or ""
        body = part.get("body", {})
        if name and body.get("attachmentId"):
            heads = {h["name"].lower(): h["value"]
                     for h in part.get("headers", [])}
            inline = "inline" in heads.get("content-disposition", "").lower()
            size = body.get("size", 0)
            is_image = part.get("mimeType", "").startswith("image/")
            if not (is_image and (inline or size < SIGNATURE_IMAGE_MAX)):
                out.append({"name": name, "size": size})
        for p in part.get("parts", []) or []:
            walk(p)

    walk(payload)
    return out


def get_message(gmail, msg_id):
    # The OAuth client is shared with other tools, so the per-user rate
    # limit is hit on a full backfill — back off and retry.
    for attempt in range(6):
        try:
            return gmail.users().messages().get(
                userId="me", id=msg_id, format="full").execute()
        except HttpError as e:
            if e.resp.status not in (403, 429) or attempt == 5:
                raise
            wait = 15 * (attempt + 1)
            log.warning("rate limit — %ds 대기", wait)
            time.sleep(wait)


def parse(gmail, stub):
    msg = get_message(gmail, stub["id"])
    payload = msg.get("payload", {})
    heads = payload.get("headers", [])
    subject = get_header(heads, "Subject") or ""
    sender = get_header(heads, "From") or ""
    dom, default_equip = vendor_of(sender)
    if dom is None:
        return None, "벤더 아님"
    top = top_body(extract_body_text(payload))
    if not (KEYWORD_RE.search(subject) or KEYWORD_RE.search(top)):
        return None, "키워드 없음"
    atts = attachments_of(payload)
    if not atts:
        return None, "첨부 없음"
    # Body first: multi-ship threads keep one subject
    ship = first_ship(top) or first_ship(subject)
    if not ship:
        return None, "선박 미식별"
    text = subject + "\n" + top
    system = ("EGCS" if EGCS_RE.search(text) else
              "BWTS" if BWTS_RE.search(text) else default_equip)
    if not system:
        return None, "장비 미판정"
    mail_at = datetime.fromtimestamp(int(msg["internalDate"]) / 1000, KST)
    start, end = visit_dates(subject, top, mail_at.date())
    return {
        "msg_id": msg["id"],
        "thread_id": msg.get("threadId", ""),
        "ship_code": ship,
        "system": system,
        "vendor": dom,
        "sender": sender[:200],
        "mail_at": mail_at.isoformat(),
        "subject": subject[:500],
        "body": top,
        "attachments": atts,
        "visit_start": start.isoformat() if start else None,
        "visit_end": end.isoformat() if end else None,
        "work_type": work_type_of(text),
        "summary": clean_subject(subject),
    }, None


# ── Repairs link ──────────────────────────────────
def link_repair(row, repairs):
    """repairs.id when exactly one repair of the ship/system covers the mail."""
    day = row["mail_at"][:10]
    lo = (date.fromisoformat(day) - timedelta(days=180)).isoformat()
    cands = []
    for r in repairs:
        if r["ship_code"] != row["ship_code"] or r["system"] != row["system"]:
            continue
        start = r.get("date") or ""
        done = (r.get("completed_at") or "")[:10]
        if not start or start > day or start < lo:
            continue
        if done and done < (date.fromisoformat(day)
                            - timedelta(days=14)).isoformat():
            continue
        cands.append(r["id"])
    return cands[0] if len(cands) == 1 else None


# ── Grouping ──────────────────────────────────────
# One row per (thread, ship): re-sends, invoices and settlement mails in the
# same thread fold into the first report mail.
MAIL_FIELDS = ["id", "thread_id", "msg_ids", "mail_count", "ship_code",
               "system", "vendor", "sender", "mail_at", "last_mail_at",
               "subject", "body", "attachments"]
GUESS_FIELDS = ["visit_start", "visit_end", "work_type", "summary"]


def _merge_atts(a, b):
    seen = {(x["name"], x["size"]) for x in a}
    return a + [x for x in b if (x["name"], x["size"]) not in seen]


def group(mails, existing):
    """mails: parsed messages. existing: id → current DB row (may hold mails
    older than this scan window). Returns rows keyed by thread:ship."""
    rows = {}
    for m in sorted(mails, key=lambda x: x["mail_at"]):
        gid = m["thread_id"] + ":" + m["ship_code"]
        r = rows.get(gid)
        if r is None:
            r = rows[gid] = dict(m, id=gid, msg_ids=[], attachments=[],
                                 last_mail_at=m["mail_at"])
            r.pop("msg_id")
            ex = existing.get(gid)
            if ex and (datetime.fromisoformat(ex["mail_at"])
                       < datetime.fromisoformat(m["mail_at"])):
                # Keep the first report mail from the earlier scan
                for k in ["mail_at", "subject", "body", "sender", "vendor",
                          "system"] + GUESS_FIELDS:
                    r[k] = ex[k]
                r["msg_ids"] = list(ex.get("msg_ids") or [])
                r["attachments"] = list(ex.get("attachments") or [])
        if m["msg_id"] not in r["msg_ids"]:
            r["msg_ids"].append(m["msg_id"])
        r["attachments"] = _merge_atts(r["attachments"], m["attachments"])
        r["last_mail_at"] = max(r["last_mail_at"], m["mail_at"])
        # Fill a missing visit range from a later mail in the thread
        if not r.get("visit_start") and m.get("visit_start"):
            r["visit_start"], r["visit_end"] = m["visit_start"], m["visit_end"]
    for r in rows.values():
        r["mail_count"] = len(r["msg_ids"])
    return list(rows.values())


# ── Main ──────────────────────────────────────────

def run(since, dry_run):
    gmail = build("gmail", "v1", credentials=get_gmail_creds(),
                  cache_discovery=False)
    query = build_query(since)
    log.info("query: %s", query)
    stubs = fetch_messages(gmail, query)
    log.info("검색 %d통", len(stubs))

    mails, skipped = [], {}
    for stub in stubs:
        time.sleep(0.15)
        m, why = parse(gmail, stub)
        if m:
            mails.append(m)
        else:
            skipped[why] = skipped.get(why, 0) + 1
    log.info("대상 %d통, 제외 %s", len(mails), skipped)

    if dry_run:
        rows = group(mails, {})
        log.info("묶음 %d건", len(rows))
        for r in sorted(rows, key=lambda x: x["mail_at"]):
            log.info("%s %s %-4s %-6s %s~%s x%d | %s", r["mail_at"][:10],
                     r["ship_code"], r["system"], r["work_type"],
                     r["visit_start"] or "", r["visit_end"] or "",
                     r["mail_count"], r["summary"][:70])
        return

    from supabase import create_client
    db = create_client(os.environ["SUPABASE_URL"],
                       os.environ["SUPABASE_SERVICE_KEY"])
    repairs = (db.table("repairs")
               .select("id,ship_code,system,date,completed_at")
               .in_("system", ["BWTS", "EGCS"]).execute().data or [])
    existing = {}
    gids = sorted({m["thread_id"] + ":" + m["ship_code"] for m in mails})
    for i in range(0, len(gids), UPSERT_CHUNK):
        got = (db.table("service_reports").select("*")
               .in_("id", gids[i:i + UPSERT_CHUNK]).execute().data or [])
        existing.update({g["id"]: g for g in got})
    rows = group(mails, existing)

    full, mail_only = [], []
    for r in rows:
        ex = existing.get(r["id"])
        if ex and ex["edited"]:
            mail_only.append({k: r[k] for k in MAIL_FIELDS})
            continue
        r["repair_id"] = (ex or {}).get("repair_id") or link_repair(r, repairs)
        full.append(r)
    for batch in (full, mail_only):
        for i in range(0, len(batch), UPSERT_CHUNK):
            db.table("service_reports").upsert(
                batch[i:i + UPSERT_CHUNK]).execute()
    linked = sum(1 for r in full if r.get("repair_id"))
    log.info("저장 %d행 (신규 %d, 편집행 메일칸만 %d, 수리건 연결 %d)",
             len(rows), sum(1 for r in rows if r["id"] not in existing),
             len(mail_only), linked)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", help="YYYY-MM-DD (기본: 30일 전)")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    since = (date.fromisoformat(a.since) if a.since
             else date.today() - timedelta(days=30))
    run(since, a.dry_run)


if __name__ == "__main__":
    main()
