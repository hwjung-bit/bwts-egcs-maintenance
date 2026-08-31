"""
Backfill body_preview and category for existing mail_log rows.

Reads all mail_log rows missing body_preview,
fetches full message from Gmail, extracts body + category,
and updates Supabase.

Usage:
  Set env vars (same as collector), then:
  python backfill_category.py
"""

import json, os, re, sys, logging, time

from supabase_collector import (
    get_gmail_creds, extract_body_text, make_preview,
    detect_category, find_ship, find_keywords,
    SHIP_MAP,
)

from googleapiclient.discovery import build
from supabase import create_client

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger(__name__)


def backfill():
    supa_url = os.environ["SUPABASE_URL"]
    supa_key = os.environ["SUPABASE_SERVICE_KEY"]
    sb = create_client(supa_url, supa_key)

    creds = get_gmail_creds()
    gmail = build("gmail", "v1", credentials=creds)

    # Fetch rows missing body_preview
    log.info("Fetching rows to backfill...")
    rows = []
    offset = 0
    batch = 1000
    while True:
        resp = sb.table("mail_log").select(
            "id,subject"
        ).or_(
            "body_preview.is.null,"
            "body_preview.eq."
        ).order("id").range(
            offset, offset + batch - 1).execute()
        rows.extend(resp.data)
        if len(resp.data) < batch:
            break
        offset += batch

    log.info("Found %d rows to backfill", len(rows))
    if not rows:
        return

    updated = 0
    failed = 0
    for i, row in enumerate(rows):
        msg_id = row["id"]
        subject = row.get("subject", "")
        if i % 20 == 0:
            log.info("Progress: %d/%d (updated %d)",
                     i, len(rows), updated)
        try:
            msg = gmail.users().messages().get(
                userId="me", id=msg_id,
                format="full",
            ).execute()
        except Exception as e:
            # Message may have been deleted from Gmail
            log.warning("Gmail fetch failed %s: %s",
                        msg_id, str(e)[:80])
            failed += 1
            continue

        payload = msg.get("payload", {})
        body_text = extract_body_text(payload)
        body_preview = make_preview(body_text)
        combined = f"{subject} {body_text[:500]}"
        category = detect_category(combined)

        # Also re-detect ship from body if missing
        patch = {
            "body_preview": body_preview,
        }
        # An empty auto-detection must not wipe a hand-classified
        # category.
        if category:
            patch["category"] = category

        try:
            sb.table("mail_log").update(
                patch
            ).eq("id", msg_id).execute()
            updated += 1
        except Exception as e:
            log.warning("DB update failed %s: %s",
                        msg_id, e)
            failed += 1

        # Rate limit: ~5 req/sec to stay under Gmail quota
        if i % 5 == 4:
            time.sleep(1)

    log.info("=== Backfill done: %d updated, %d failed "
             "out of %d ===", updated, failed, len(rows))

    # A dead Gmail token used to look like a clean run — anything
    # over a fifth failing is a broken run, not stray deletions.
    if failed > len(rows) * 0.2:
        log.error("실패율 %.0f%% (%d/%d) — 실패로 종료",
                  failed * 100.0 / len(rows), failed, len(rows))
        sys.exit(1)


if __name__ == "__main__":
    backfill()
