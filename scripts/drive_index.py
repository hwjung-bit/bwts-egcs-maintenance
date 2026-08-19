"""
Drive Folder Indexer — Drive API → Supabase (drive_folders)

수리이력 행에서 Drive 폴더를 곧바로 열 수 있게, 서비스리포트 트리의
선박별 하위폴더를 (선박, 시스템, 날짜, 폴더명) → folder_id 로 색인한다.

트리 구조:
  공유드라이브 / 011  BWTS / 14. SERVICE REPORT / 11. KSZ / 2026-07-21 ...
  공유드라이브 / ...        / 13 메이커 서비스   / 11. KSZ / 2026-06-20 ...

GitHub Actions에서 실행. 환경변수:
  DRIVE_SA_JSON          — 서비스 계정 키 JSON. 있으면 이걸 쓴다.
                           SA 이메일이 리포트 트리에 뷰어로 공유돼
                           있어야 한다
  DRIVE_TOKEN_JSON       — (대안) OAuth token JSON (refresh_token,
                           drive.readonly 스코프). 없으면
                           GMAIL_TOKEN_JSON 사용
  GOOGLE_CLIENT_ID
  GOOGLE_CLIENT_SECRET
  SUPABASE_URL           — --dry-run 시 불필요
  SUPABASE_SERVICE_KEY   — --dry-run 시 불필요

로컬 점검: python scripts/drive_index.py --dry-run
"""

import json, os, re, sys, logging

from google.oauth2.credentials import Credentials
from google.oauth2 import service_account
from google.auth.transport.requests import Request
from googleapiclient.discovery import build
from supabase import create_client

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger(__name__)

SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/drive.readonly",
]

FOLDER_MIME = "application/vnd.google-apps.folder"

# Report trees: system → the folder holding "<no>. <SHIP>" children
ROOTS = {
    "BWTS": "1cVPkUgFH1W1zHVLb6SiShpvuDQ8S9RBE",  # 14. SERVICE REPORT
    "EGCS": "1GMA9uBDu6Oe7eo7Hnbq1SA4J9SpVIORq",  # 13 메이커 서비스
}

SHIP_CODES = {
    "KPS", "KUS", "KSH", "KKL", "KSG", "KJT", "KSL", "KQD",
    "KTJ", "KHM", "KNB", "KSZ", "KCN", "KJA", "KNH", "KMN",
    "KMB", "KDB", "KMU", "KCB", "KDE", "SDL", "SDY", "SAC",
}

# "11. KSZ", "02. KUS (수신)" → KSZ / KUS
SHIP_RE = re.compile(r"\b([A-Z]{3})\b")
# "2026-07-21 호 BWTS PRU ..." / "2026.07.21 ..." → date + title
DATE_RE = re.compile(r"^(\d{4})[-.](\d{2})[-.](\d{2})\s*(.*)$")


def get_creds():
    sa_json = os.environ.get("DRIVE_SA_JSON", "")
    if sa_json:
        return service_account.Credentials.from_service_account_info(
            json.loads(sa_json),
            scopes=["https://www.googleapis.com/auth/drive.readonly"],
        )

    token_json = (os.environ.get("DRIVE_TOKEN_JSON", "")
                  or os.environ.get("GMAIL_TOKEN_JSON", ""))
    if not token_json:
        log.error("DRIVE_SA_JSON / DRIVE_TOKEN_JSON not set")
        sys.exit(1)

    token_data = json.loads(token_json)
    creds = Credentials(
        token=(token_data.get("access_token")
               or token_data.get("token")),
        refresh_token=token_data.get("refresh_token"),
        token_uri="https://oauth2.googleapis.com/token",
        client_id=(token_data.get("client_id")
                   or os.environ.get("GOOGLE_CLIENT_ID", "")),
        client_secret=(token_data.get("client_secret")
                       or os.environ.get(
                           "GOOGLE_CLIENT_SECRET", "")),
        scopes=SCOPES,
    )
    if creds.expired or not creds.valid:
        creds.refresh(Request())
        log.info("Token refreshed")
    return creds


def list_child_folders(svc, parent_id):
    """Every non-trashed sub-folder of parent_id."""
    out, page = [], None
    q = (f"'{parent_id}' in parents "
         f"and mimeType = '{FOLDER_MIME}' and trashed = false")
    while True:
        res = svc.files().list(
            q=q,
            fields="nextPageToken,files(id,name,parents)",
            pageSize=1000,
            pageToken=page,
            supportsAllDrives=True,
            includeItemsFromAllDrives=True,
        ).execute()
        out.extend(res.get("files", []))
        page = res.get("nextPageToken")
        if not page:
            break
    return out


def ship_code_of(name):
    for m in SHIP_RE.finditer((name or "").upper()):
        if m.group(1) in SHIP_CODES:
            return m.group(1)
    return ""


def parse_folder(name):
    """→ (date | None, title)"""
    m = DATE_RE.match((name or "").strip())
    if not m:
        return None, (name or "").strip()
    y, mo, d, title = m.groups()
    return f"{y}-{mo}-{d}", title.strip()


def index_drive(dry_run=False):
    sb = None if dry_run else create_client(
        os.environ["SUPABASE_URL"],
        os.environ["SUPABASE_SERVICE_KEY"],
    )
    svc = build("drive", "v3", credentials=get_creds(),
                cache_discovery=False)

    rows, scanned_ships = [], []

    for system, root_id in ROOTS.items():
        ship_folders = list_child_folders(svc, root_id)
        log.info("%s root: %d ship folders",
                 system, len(ship_folders))

        for sf in ship_folders:
            code = ship_code_of(sf["name"])
            if not code:
                log.info("Skip (no ship code): %s", sf["name"])
                continue
            scanned_ships.append((code, system))

            children = list_child_folders(svc, sf["id"])
            for c in children:
                fdate, title = parse_folder(c["name"])
                rows.append({
                    "id": c["id"],
                    "ship_code": code,
                    "system": system,
                    "folder_date": fdate,
                    "title": title,
                    "name": c["name"],
                    "url": ("https://drive.google.com/drive/"
                            f"folders/{c['id']}"),
                    "parent_id": sf["id"],
                })
            log.info("  %s %s: %d folders",
                     code, system, len(children))

    if not rows:
        log.warning("Nothing indexed — aborting to keep the "
                    "existing index intact")
        return {"ships": 0, "folders": 0, "removed": 0}

    if dry_run:
        for r in rows[:10]:
            log.info("  sample: %s %s %s | %s",
                     r["ship_code"], r["system"],
                     r["folder_date"], r["name"][:60])
        no_date = sum(1 for r in rows if not r["folder_date"])
        log.info("No date prefix: %d / %d", no_date, len(rows))
        return {
            "ships": len(set(scanned_ships)),
            "folders": len(rows),
            "no_date": no_date,
            "dry_run": True,
        }

    for i in range(0, len(rows), 500):
        sb.table("drive_folders").upsert(
            rows[i:i + 500]).execute()
    log.info("Upserted %d folders", len(rows))

    # Drop rows for scanned ships whose folder is gone
    live = {r["id"] for r in rows}
    removed = 0
    for code, system in set(scanned_ships):
        old = sb.table("drive_folders").select("id").eq(
            "ship_code", code).eq("system", system).execute()
        stale = [r["id"] for r in (old.data or [])
                 if r["id"] not in live]
        for i in range(0, len(stale), 200):
            sb.table("drive_folders").delete().in_(
                "id", stale[i:i + 200]).execute()
        removed += len(stale)
    if removed:
        log.info("Removed %d stale rows", removed)

    return {
        "ships": len(set(scanned_ships)),
        "folders": len(rows),
        "removed": removed,
    }


if __name__ == "__main__":
    result = index_drive(dry_run="--dry-run" in sys.argv)
    print(json.dumps(result, ensure_ascii=False, indent=2))
