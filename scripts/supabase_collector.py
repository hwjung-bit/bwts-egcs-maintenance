"""
BWTS/EGCS Mail Collector — Gmail API → Supabase

GitHub Actions에서 실행. 환경변수:
  GMAIL_TOKEN_JSON   — OAuth token JSON (refresh_token 포함)
  GOOGLE_CLIENT_ID
  GOOGLE_CLIENT_SECRET
  SUPABASE_URL
  SUPABASE_SERVICE_KEY
"""

import json, os, re, sys, logging
from datetime import datetime, timedelta

from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from googleapiclient.discovery import build
from supabase import create_client

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger(__name__)

# ── Config ─────────────────────────────────────
SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]
SCAN_DAYS = 90

DOMAIN_SYSTEM = {
    "techcross.com": "BWTS",
    "alfalaval.com": "BWTS",
    "ermafirst.com": "BWTS",
    "unionkr.com": "EGCS",
    "hyundaimaterials.com": "EGCS",
    "hhi-power.com": "EGCS",
    "worldpanasia.com": "EGCS",
    "greeninstruments.com": "EGCS",
    "lastech.kr": "EGCS",
    "ms-sox.com": "EGCS",
    "itskr.co.kr": "EGCS",
    "kc-cottrell.com": "EGCS",
    "sea-one.com": "BOTH",
    "hd.com": "BOTH",
    "panstar.kr": "BOTH",
    "gweng.co.kr": "BOTH",
}

SHIP_MAP = {
    "KPS": "KMTC PUSAN", "KUS": "KMTC ULSAN",
    "KSH": "KMTC SHANGHAI", "KKL": "KMTC KEELUNG",
    "KSG": "KMTC SINGAPORE", "KJT": "KMTC JAKARTA",
    "KSL": "KMTC SEOUL", "KQD": "KMTC QINGDAO",
    "KTJ": "KMTC TIANJIN", "KHM": "KMTC HOCHIMINH",
    "KNB": "KMTC NINGBO", "KSZ": "KMTC SHENZHEN",
    "KCN": "KMTC CHENNAI", "KJA": "KMTC JEBELALI",
    "KNH": "KMTC NHAVASHEVA", "KMN": "KMTC MANILA",
    "KMB": "KMTC MUMBAI", "KDB": "KMTC DUBAI",
    "KMU": "KMTC MUNDRA", "KCB": "KMTC COLOMBO",
    "KDE": "KMTC DELHI",
}

EXCLUDE_PATTERNS = [
    re.compile(r"Delivery Status Notification", re.I),
    re.compile(
        r"BWTS\s*(DATA\s*)?LOG|BWTS\s*LOG\s*DATA", re.I),
    re.compile(r"BWRB|BALLAST\s*WATER\s*RECORD", re.I),
    re.compile(r"OPERATING\s*RESULT\s*REPORT", re.I),
    re.compile(r"BSR_\d{8}", re.I),
    re.compile(r"PNC-\w+\s+HINAS", re.I),
    re.compile(r"BUNKER", re.I),
    re.compile(r"DAILY\s*REPORT|WEEKLY\s*REPORT", re.I),
    re.compile(r"DAILY\s*LOG", re.I),
    re.compile(r"TRO.*LOG|LOG.*TRO", re.I),
    re.compile(r"MONTHLY.*BWTS|BWTS.*MONTHLY", re.I),
    re.compile(
        r"본선보고서|교대보고서|세금계산서|거래명세서|청구서",
        re.I),
    re.compile(r"INTERNAL\s*AUDIT", re.I),
    re.compile(r"\bKPI\b", re.I),
    re.compile(r"TAX\s*INVOICE", re.I),
    re.compile(r"실태보고서|송품처\s*요청|계산서", re.I),
    re.compile(
        r"선적서류\s*전달|뉴스레터|newsletter", re.I),
    re.compile(r"개선제안서|부적합\s*보고서", re.I),
    re.compile(
        r"EEXI|연돌\s*연장|FUNNEL\s*EXTENSION", re.I),
    re.compile(r"BWTS\s*ECS\s*송부", re.I),
]

KEYWORD_PATTERNS = [
    (re.compile(r"\bFMU\b", re.I), "FMU"),
    (re.compile(r"\bWMS\b", re.I), "WMS"),
    (re.compile(r"\bCEMS\b", re.I), "CEMS"),
    (re.compile(r"\bPAH\b", re.I), "PAH"),
    (re.compile(r"\bpH\b"), "pH"),
    (re.compile(r"\b(?:TURB|탁도)\b", re.I), "TURB"),
    (re.compile(r"검교정|[Cc]alibrat", re.I), "검교정"),
    (re.compile(
        r"[Ss]ervice\s*[Rr]eport|서비스\s*리포트",
        re.I), "SR"),
    (re.compile(
        r"\b(?:스크러버|[Ss]crubber)\b", re.I),
     "Scrubber"),
    (re.compile(r"\bBWT[SM]?\b", re.I), "BWTS"),
    (re.compile(r"인증서|[Cc]ertificat", re.I), "인증서"),
    (re.compile(r"견적|[Qq]uotat", re.I), "견적"),
    (re.compile(r"부품|[Ss]pare\s*[Pp]art", re.I), "부품"),
    (re.compile(r"방선|[Vv]isit", re.I), "방선"),
    (re.compile(
        r"[Ii]nvoice|인보이스|송장", re.I), "Invoice"),
]


# ── Helpers ────────────────────────────────────
def find_ship(text):
    text_up = text.upper()
    for code in SHIP_MAP:
        if code in text_up:
            return code
    for code, name in SHIP_MAP.items():
        city = name.replace("KMTC ", "")
        if len(city) >= 4 and city in text_up:
            return code
    return ""


def find_keywords(text):
    found = []
    for pat, kw in KEYWORD_PATTERNS:
        if pat.search(text):
            found.append(kw)
    return ", ".join(found)


def detect_system(from_addr, subject):
    m = re.search(r"@([\w.-]+)", from_addr or "")
    if m:
        domain = m.group(1).lower()
        sv = DOMAIN_SYSTEM.get(domain)
        if sv and sv != "BOTH":
            return sv
    if re.search(
            r"BWTS|BWT|평형수|techcross|alfalaval",
            subject, re.I):
        return "BWTS"
    if re.search(
            r"EGCS|스크러버|scrubber|WMS|CEMS",
            subject, re.I):
        return "EGCS"
    return "기타"


def is_excluded(subject):
    for pat in EXCLUDE_PATTERNS:
        if pat.search(subject):
            return True
    return False


def get_header(headers, name):
    for h in headers:
        if h["name"].lower() == name.lower():
            return h["value"]
    return ""


# ── Gmail Auth ─────────────────────────────────
def get_gmail_creds():
    token_json = os.environ.get("GMAIL_TOKEN_JSON", "")
    client_id = os.environ.get("GOOGLE_CLIENT_ID", "")
    client_secret = os.environ.get(
        "GOOGLE_CLIENT_SECRET", "")

    if not token_json:
        log.error("GMAIL_TOKEN_JSON not set")
        sys.exit(1)

    token_data = json.loads(token_json)
    creds = Credentials(
        token=token_data.get("access_token"),
        refresh_token=token_data.get("refresh_token"),
        token_uri="https://oauth2.googleapis.com/token",
        client_id=(token_data.get("client_id")
                   or client_id),
        client_secret=(token_data.get("client_secret")
                       or client_secret),
        scopes=SCOPES,
    )
    if creds.expired or not creds.valid:
        creds.refresh(Request())
        log.info("Token refreshed")
    return creds


# ── Gmail Fetch ────────────────────────────────
def build_query():
    domains = list(DOMAIN_SYSTEM.keys())
    domain_q = " OR ".join(f"from:{d}" for d in domains)
    kw_q = ("subject:BWTS OR subject:EGCS OR "
            "subject:scrubber OR subject:WMS "
            "OR subject:검교정")
    after = (datetime.now() - timedelta(days=SCAN_DAYS)
             ).strftime("%Y/%m/%d")
    return (f"({domain_q} OR {kw_q}) "
            f"after:{after} -from:ekmtc.com")


def fetch_messages(gmail, query, max_results=500):
    messages = []
    resp = gmail.users().messages().list(
        userId="me", q=query,
        maxResults=min(max_results, 500),
    ).execute()
    messages.extend(resp.get("messages", []))

    while ("nextPageToken" in resp
           and len(messages) < max_results):
        resp = gmail.users().messages().list(
            userId="me", q=query,
            pageToken=resp["nextPageToken"],
            maxResults=min(
                max_results - len(messages), 500),
        ).execute()
        messages.extend(resp.get("messages", []))

    return messages


def parse_message(gmail, msg_stub):
    msg = gmail.users().messages().get(
        userId="me", id=msg_stub["id"],
        format="metadata",
        metadataHeaders=["Subject", "From", "Date"],
    ).execute()

    headers = msg.get("payload", {}).get("headers", [])
    subject = get_header(headers, "Subject") or ""
    from_addr = get_header(headers, "From") or ""
    thread_id = msg.get("threadId", "")
    msg_id = msg["id"]

    # Parse date
    date_fmt = ""
    try:
        ts = int(msg.get("internalDate", 0)) / 1000
        date_fmt = datetime.fromtimestamp(ts).strftime(
            "%Y-%m-%d")
    except Exception:
        pass

    system = detect_system(from_addr, subject)
    ship = find_ship(subject)
    keywords = find_keywords(subject)
    link = (
        f"https://mail.google.com/mail/u/0/"
        f"#inbox/{thread_id}")

    # Attachments
    att_names = []
    parts = msg.get("payload", {}).get("parts", [])
    for p in parts:
        fn = p.get("filename", "")
        if fn:
            att_names.append(fn)

    return {
        "id": msg_id,
        "thread_id": thread_id,
        "date": date_fmt,
        "system": system,
        "ship_code": ship,
        "ship_name": SHIP_MAP.get(ship, ""),
        "keyword": keywords,
        "subject": subject,
        "sender": from_addr,
        "mail_link": link,
        "attachments": ", ".join(att_names),
        "note": "",
        "status": "미확인",
        "reply_count": 0,
        "last_reply": None,
    }


# ── Main ───────────────────────────────────────
def collect():
    log.info("=== Collect start ===")

    supa_url = os.environ.get("SUPABASE_URL", "")
    supa_key = os.environ.get(
        "SUPABASE_SERVICE_KEY", "")
    if not supa_url or not supa_key:
        log.error("SUPABASE_URL/SERVICE_KEY not set")
        sys.exit(1)

    sb = create_client(supa_url, supa_key)

    # Get existing IDs from Supabase
    existing = sb.table("mail_log").select(
        "id,thread_id").execute()
    saved_ids = set()
    thread_map = {}  # thread_id → first row id
    for row in existing.data:
        saved_ids.add(row["id"])
        tid = row.get("thread_id", "")
        if tid and tid not in thread_map:
            thread_map[tid] = row["id"]

    log.info("Existing: %d mails, %d threads",
             len(saved_ids), len(thread_map))

    # Fetch Gmail
    creds = get_gmail_creds()
    gmail = build("gmail", "v1", credentials=creds)
    query = build_query()
    log.info("Query: %s", query[:80])
    msg_stubs = fetch_messages(gmail, query)
    log.info("Found: %d messages", len(msg_stubs))

    new_rows = []
    reply_updates = []

    for i, stub in enumerate(msg_stubs):
        if i % 50 == 0 and i > 0:
            log.info("Progress: %d/%d (new %d, reply %d)",
                     i, len(msg_stubs),
                     len(new_rows), len(reply_updates))
        msg_id = stub["id"]
        if msg_id in saved_ids:
            continue

        try:
            parsed = parse_message(gmail, stub)
        except Exception as e:
            log.warning("Parse failed %s: %s", msg_id, e)
            continue

        if is_excluded(parsed["subject"]):
            continue

        th_id = parsed["thread_id"]

        if th_id in thread_map:
            # Reply to existing thread
            reply_updates.append({
                "orig_id": thread_map[th_id],
                "date": parsed["date"],
                "sender": parsed["sender"],
            })
        else:
            new_rows.append(parsed)
            thread_map[th_id] = msg_id

        saved_ids.add(msg_id)

    # Insert new rows
    if new_rows:
        batch_size = 500
        for i in range(0, len(new_rows), batch_size):
            batch = new_rows[i:i + batch_size]
            sb.table("mail_log").upsert(batch).execute()
        log.info("Inserted %d new mails", len(new_rows))

    # Update reply counts
    for u in reply_updates:
        try:
            row = sb.table("mail_log").select(
                "reply_count,note,status"
            ).eq("id", u["orig_id"]).single().execute()
            d = row.data
            cur_count = int(d.get("reply_count") or 0)
            cur_note = d.get("note") or ""
            cur_status = d.get("status") or ""

            from_short = re.sub(
                r"<[^>]+>", "", u["sender"]).strip()
            note_add = f"[{u['date']}] {from_short}"
            new_note = cur_note
            if note_add not in cur_note:
                new_note = (
                    f"{cur_note} | {note_add}"
                    if cur_note else note_add)

            new_status = (cur_status if cur_status == "완료"
                          else "진행중")

            sb.table("mail_log").update({
                "reply_count": cur_count + 1,
                "last_reply": u["date"],
                "note": new_note,
                "status": new_status,
            }).eq("id", u["orig_id"]).execute()
        except Exception as e:
            log.warning("Reply update failed: %s", e)

    log.info("=== Done: new %d, replies %d ===",
             len(new_rows), len(reply_updates))

    return {
        "new": len(new_rows),
        "replies": len(reply_updates),
        "total": len(saved_ids),
    }


if __name__ == "__main__":
    result = collect()
    print(json.dumps(result, ensure_ascii=False, indent=2))
