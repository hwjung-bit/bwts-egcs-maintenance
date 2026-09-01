"""Upsert vessel-month summaries into Supabase bwts_log_analysis.

Env: SUPABASE_URL, SUPABASE_SERVICE_KEY (service_role — bypasses RLS).
The payload never includes review_* / final_grade, so a re-publish keeps
whatever the reviewer decided (PostgREST upsert only touches sent columns).
"""
import os
import sys
import json
from datetime import datetime, timezone

from thresholds import VERSION as TH_VERSION
from csv_parser import PARSER_VERSION

INTEGRITY_VERSION = "integ-2026-09"
ANALYZER_VERSION = f"th-{TH_VERSION}|{INTEGRITY_VERSION}|{PARSER_VERSION}"

_PAYLOAD_KEYS = (
    "grade", "grade_rule", "grade_reasons", "reception",
    "ballast_count", "deballast_count", "op_days",
    "tro_b_avg", "tro_b_min", "tro_d_max", "tro_b_in_range", "tro_d_compliant",
    "trip_count", "alarm_count", "chattering", "recovery_pattern", "integrity", "flags",
)


def _num(v):
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if f != f:   # NaN
        return None
    return round(f, 3)


def to_row(summary):
    period = f"{summary['year']}-{summary['month']:02d}"
    row = {"ship_code": summary["code"], "period": period}
    for k in _PAYLOAD_KEYS:
        row[k] = summary.get(k)
    for k in ("tro_b_avg", "tro_b_min", "tro_d_max"):
        row[k] = _num(row[k])
    for k in ("ballast_count", "deballast_count", "op_days", "trip_count", "alarm_count"):
        row[k] = int(row[k] or 0)
    row["grade_reasons"] = row["grade_reasons"] or []
    row["chattering"] = row["chattering"] or []
    row["recovery_pattern"] = row["recovery_pattern"] or {}
    row["integrity"] = row["integrity"] or {}
    row["flags"] = row["flags"] or []
    # Whole summary as JSON (cache-file content) for the detail view
    row["summary"] = json.loads(json.dumps(summary, ensure_ascii=False, default=str))
    row["analyzer_version"] = ANALYZER_VERSION
    row["analyzed_at"] = datetime.now(timezone.utc).isoformat()
    return row


def get_client():
    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_KEY", "").strip()
    if not url or not key:
        raise SystemExit(
            "SUPABASE_URL / SUPABASE_SERVICE_KEY 환경변수 없음.\n"
            "  Supabase 대시보드 → Project Settings → API → service_role 키를\n"
            "  Windows 사용자 환경변수 SUPABASE_SERVICE_KEY 로 등록 (anon 키 아님)."
        )
    from supabase import create_client
    return create_client(url, key)


def publish(summaries, batch=100, verbose=False):
    """summaries: iterable of vessel-month dicts. Returns rows upserted."""
    sb = get_client()
    rows = [to_row(s) for s in summaries if s and s.get("code")]
    done = 0
    for i in range(0, len(rows), batch):
        chunk = rows[i:i + batch]
        res = sb.table("bwts_log_analysis").upsert(
            chunk, on_conflict="ship_code,period").execute()
        if getattr(res, "error", None):
            raise RuntimeError(f"upsert 실패 @ {i}: {res.error}")
        done += len(chunk)
        if verbose:
            print(f"  upsert {done}/{len(rows)}")
    return done


if __name__ == "__main__":
    # Ad-hoc: publish everything in cache/ (integrity applied by run.py normally)
    from config import LOCAL_CACHE_DIR
    files = sorted(LOCAL_CACHE_DIR.glob("fleet_*.json"))
    data = [json.load(open(f, encoding="utf-8")) for f in files]
    print(f"{len(data)} cache rows → Supabase")
    n = publish(data, verbose=True)
    print(f"done: {n}")
    sys.exit(0)
