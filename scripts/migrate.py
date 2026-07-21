"""
BWTS/EGCS Data Migration — JSON files → Supabase

Usage:
  pip install supabase
  python migrate.py

Reads:
  - BWTS_EGCS_data.json     (1,434 mail_log records)
  - env_data.js              (ships, repairs, calibrations)

Requires env vars:
  SUPABASE_URL=https://xxx.supabase.co
  SUPABASE_SERVICE_KEY=eyJ...  (service_role key, NOT anon)
"""

import json, re, os, sys
from pathlib import Path

# ── Paths ──
DESKTOP = Path("D:/DATA/Desktop")
DASHBOARD_DIR = Path(
    "G:/공유 드라이브/고려에스엠 0033 공무팀 환경기술파트"
    "/_dashboard"
)
MAIL_JSON = DESKTOP / "BWTS_EGCS_data.json"
ENV_JS = DESKTOP / "env_data.js"
if not ENV_JS.exists():
    ENV_JS = DASHBOARD_DIR / "env_data.js"

# ── Supabase ──
SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("Set SUPABASE_URL and SUPABASE_SERVICE_KEY env vars")
    sys.exit(1)

from supabase import create_client
sb = create_client(SUPABASE_URL, SUPABASE_KEY)


def parse_env_data(path):
    """Parse env_data.js → dict with ships, repairs, bwtsCal, egcsCal"""
    text = path.read_text(encoding="utf-8")
    # Extract ENV_DATA = {...};
    m = re.search(r"var ENV_DATA\s*=\s*(\{[\s\S]*?\});\s*\n", text)
    if not m:
        print("ENV_DATA not found in", path)
        sys.exit(1)
    return json.loads(m.group(1))


def parse_status(raw):
    """Split 'status | [date] memo' → (status, note_addition)"""
    if not raw:
        return "미확인", ""
    parts = raw.split(" | ", 1)
    status = parts[0].strip()
    note_add = parts[1].strip() if len(parts) > 1 else ""
    # Some entries have only '[date] name' without status prefix
    if status.startswith("[") and re.match(r"\[\d{4}-", status):
        note_add = status
        status = "확인"
    if not status:
        status = "미확인"
    return status, note_add


def migrate_ships(env):
    """Insert ships master data"""
    ships = env.get("ships", [])
    rows = []
    for s in ships:
        rows.append({
            "code": s["code"],
            "name": s.get("name", ""),
            "teu": str(s.get("teu", "")),
            "bwts_maker": s.get("bwts_maker", ""),
            "egcs_maker": s.get("egcs_maker", ""),
            "wms": s.get("wms", ""),
            "cems": s.get("cems", ""),
        })
    if rows:
        sb.table("ships").upsert(rows).execute()
    print(f"ships: {len(rows)} upserted")


def migrate_mail_log(path):
    """Insert mail_log from JSON"""
    data = json.loads(path.read_text(encoding="utf-8"))
    rows = []
    for d in data:
        status, note_add = parse_status(d.get("status", ""))
        note = d.get("note", "")
        if note_add:
            note = (note_add + "\n" + note).strip() if note else note_add
        rows.append({
            "id": d["id"],
            "thread_id": d.get("threadId", d["id"]),
            "date": d["date"],
            "system": d.get("system", "기타"),
            "ship_code": d.get("shipCode", ""),
            "ship_name": d.get("shipName", ""),
            "keyword": d.get("keyword", ""),
            "subject": d["subject"],
            "sender": d.get("from", ""),
            "mail_link": d.get("mailLink", ""),
            "attachments": d.get("attachments", ""),
            "drive_links": d.get("driveLinks", ""),
            "note": note,
            "status": status,
            "reply_count": d.get("replyCount", 0) or 0,
            "last_reply": d.get("lastReply") or None,
        })
    # Batch insert (Supabase handles up to 1000 per call)
    batch_size = 500
    for i in range(0, len(rows), batch_size):
        batch = rows[i:i + batch_size]
        sb.table("mail_log").upsert(batch).execute()
        print(f"mail_log: {i + len(batch)} / {len(rows)}")
    print(f"mail_log: {len(rows)} total upserted")


# V1 stage → V2 stage mapping
STAGE_MAP = {
    "reported": "미확인",
    "diagnosed": "진행중",
    "parts": "부품발주중",
    "in_progress": "진행중",
    "done": "완료",
    "hold": "방선대기",
}


def migrate_repairs(env):
    """Insert repairs from env_data"""
    repairs = env.get("repairs", [])
    rows = []
    for r in repairs:
        atts = r.get("attachments", [])
        if isinstance(atts, str):
            try:
                atts = json.loads(atts)
            except Exception:
                atts = []
        hist = r.get("history", [])
        if isinstance(hist, str):
            try:
                hist = json.loads(hist)
            except Exception:
                hist = []
        rows.append({
            "id": r["id"],
            "ship_code": r.get("shipCode", ""),
            "system": r.get("system", "BWTS"),
            "date": r.get("date") or None,
            "equip": r.get("equip", ""),
            "stage": STAGE_MAP.get(r.get("stage", ""), "미확인"),
            "symptom": r.get("symptom", ""),
            "action": r.get("action", ""),
            "parts": r.get("parts", ""),
            "cost": r.get("cost", ""),
            "attachments": json.dumps(atts, ensure_ascii=False),
            "history": json.dumps(hist, ensure_ascii=False),
            "email_subject": r.get("emailSubject", ""),
            "email_link": r.get("emailLink", ""),
            "needs_review": bool(r.get("needsReview")),
            "source_msg_id": r.get("sourceMsgId", ""),
        })
    if rows:
        batch_size = 200
        for i in range(0, len(rows), batch_size):
            batch = rows[i:i + batch_size]
            sb.table("repairs").upsert(batch).execute()
        print(f"repairs: {len(rows)} upserted")


def migrate_calibrations(env):
    """Insert calibrations (BWTS + EGCS) from env_data"""
    rows = []
    # BWTS calibrations
    for c in env.get("bwtsCal", []):
        rows.append({
            "id": c["id"],
            "ship_code": c.get("shipCode", ""),
            "system": "BWTS",
            "equip": c.get("equip", "연간검교정"),
            "last_date": c.get("lastCalibration") or None,
            "interval_months": c.get("intervalMonths", 12),
            "note": c.get("note", ""),
            "serial": c.get("serial", ""),
            "model": c.get("model", ""),
            "cert_url": c.get("certUrl", ""),
        })
    # EGCS calibrations
    for c in env.get("egcsCal", []):
        rows.append({
            "id": c["id"],
            "ship_code": c.get("shipCode", ""),
            "system": "EGCS",
            "equip": c.get("equip", ""),
            "last_date": c.get("date") or None,
            "interval_months": 0,
            "note": c.get("text", ""),
            "serial": c.get("serial", ""),
            "model": c.get("model", ""),
            "cert_url": "",
        })
    if rows:
        sb.table("calibrations").upsert(rows).execute()
    print(f"calibrations: {len(rows)} upserted")


if __name__ == "__main__":
    print("=== BWTS/EGCS Migration ===")
    print(f"Supabase: {SUPABASE_URL}")

    env = parse_env_data(ENV_JS)
    print(f"Loaded env_data: {len(env.get('ships',[]))} ships, "
          f"{len(env.get('repairs',[]))} repairs, "
          f"{len(env.get('bwtsCal',[]))} bwtsCal, "
          f"{len(env.get('egcsCal',[]))} egcsCal")

    migrate_ships(env)
    migrate_mail_log(MAIL_JSON)
    migrate_repairs(env)
    migrate_calibrations(env)

    print("\n=== Done ===")
