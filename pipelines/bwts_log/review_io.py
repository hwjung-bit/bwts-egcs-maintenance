"""Review-loop I/O for the /bwts-review skill.

  python review_io.py list                       # pending requests + this month's 판독실패/점검필요/데이터불량
  python review_io.py show KPS 2026-05           # everything Claude needs to re-judge one cell
  python review_io.py answer KPS 2026-05 --grade 운전양호 --note "..." [--answer "..."] [--request-id N]
  python review_io.py label KPS 2026-05 --rule 미운전 --final 운전양호 --source claude --note "..."

`show` prints the cached summary, the G: folder, file sizes, the CSV
headers and the first EventLog lines so the reviewer can read the raw
data instead of trusting the parser. `answer` writes final_grade /
review_note / review_status='reviewed' and closes the matching
bwts_reviews row. Nothing here changes the automatic grade.

Env: SUPABASE_URL, SUPABASE_SERVICE_KEY.
"""
import sys
import csv
import json
import argparse
from pathlib import Path
from datetime import datetime, timezone

from config import LOCAL_CACHE_DIR, get_vessel_folder, get_csv_files
from publish_supabase import get_client

LABELS = Path(__file__).resolve().parent / "labels" / "labels.csv"
LABEL_COLS = ["date", "ship_code", "period", "grade_rule", "grade_auto",
              "final_grade", "source", "note"]


def _period(p):
    y, m = p.split("-")
    return int(y), int(m)


def cmd_list(args):
    sb = get_client()
    pend = sb.table("bwts_reviews").select("*").eq("status", "pending") \
        .order("created_at").execute().data or []
    latest = sb.table("bwts_log_analysis").select("period") \
        .order("period", desc=True).limit(1).execute().data
    latest = latest[0]["period"] if latest else None
    flagged = []
    if latest:
        flagged = sb.table("bwts_log_analysis") \
            .select("ship_code,period,grade,grade_rule,grade_reasons,review_status,integrity") \
            .eq("period", latest).eq("review_status", "auto") \
            .in_("grade", ["판독실패", "점검필요", "데이터불량"]) \
            .order("grade").execute().data or []
    out = {"pending_requests": pend, "latest_period": latest, "flagged_auto": flagged}
    print(json.dumps(out, ensure_ascii=False, indent=1, default=str))


def _head(path, n=12):
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            return [next(f).rstrip("\n") for _ in range(n)]
    except (StopIteration, OSError):
        return []


def cmd_show(args):
    code, period = args.ship_code.upper(), args.period
    y, m = _period(period)
    cp = LOCAL_CACHE_DIR / f"fleet_{y}_{m:02d}_{code}.json"
    summary = json.load(open(cp, encoding="utf-8")) if cp.exists() else None
    folder = get_vessel_folder(y, m, code)
    files = get_csv_files(folder, auto_extract_zip=False) if folder else {}
    info = {"ship_code": code, "period": period, "cache_file": str(cp) if cp.exists() else None,
            "folder": str(folder) if folder else None, "files": {}}
    if folder:
        for f in sorted(folder.iterdir()):
            try:
                info["files"][f.name] = f.stat().st_size
            except OSError:
                pass
        for key in ("optime", "datalog", "eventlog"):
            p = files.get(key)
            if p:
                info[f"{key}_head"] = _head(p, 8 if key != "eventlog" else 30)
    if summary:
        slim = {k: v for k, v in summary.items() if k != "session_summaries"}
        slim["session_summaries_count"] = len(summary.get("session_summaries") or [])
        slim["session_summaries_first10"] = (summary.get("session_summaries") or [])[:10]
        info["summary"] = slim
    try:
        sb = get_client()
        row = sb.table("bwts_log_analysis").select(
            "grade,grade_rule,final_grade,review_status,review_note,reviewed_at,integrity") \
            .eq("ship_code", code).eq("period", period).maybe_single().execute()
        info["db_row"] = row.data if row else None
        q = sb.table("bwts_reviews").select("*").eq("ship_code", code).eq("period", period) \
            .order("created_at").execute()
        info["reviews"] = q.data or []
    except SystemExit:
        info["db_row"] = "SUPABASE env 없음 — DB 조회 생략"
    print(json.dumps(info, ensure_ascii=False, indent=1, default=str))


def cmd_answer(args):
    sb = get_client()
    code, period = args.ship_code.upper(), args.period
    now = datetime.now(timezone.utc).isoformat()
    patch = {"review_status": "reviewed", "reviewed_by": "claude", "reviewed_at": now,
             "review_note": args.note}
    if args.grade:
        patch["final_grade"] = args.grade
    res = sb.table("bwts_log_analysis").update(patch).eq("ship_code", code).eq("period", period).execute()
    if not res.data:
        raise SystemExit(f"행 없음: {code} {period} — run.py 로 먼저 publish")
    q = sb.table("bwts_reviews").select("id").eq("ship_code", code).eq("period", period).eq("status", "pending")
    if args.request_id:
        q = q.eq("id", args.request_id)
    pend = q.execute().data or []
    for r in pend:
        sb.table("bwts_reviews").update({
            "status": "answered", "answer": args.answer or args.note,
            "answered_by": "claude", "answered_at": now}).eq("id", r["id"]).execute()
    print(f"OK {code} {period}: final_grade={args.grade or '(유지)'} · 요청 {len(pend)}건 답변")


def cmd_label(args):
    LABELS.parent.mkdir(parents=True, exist_ok=True)
    new = not LABELS.exists()
    with open(LABELS, "a", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=LABEL_COLS)
        if new:
            w.writeheader()
        w.writerow({"date": datetime.now().strftime("%Y-%m-%d"), "ship_code": args.ship_code.upper(),
                    "period": args.period, "grade_rule": args.rule, "grade_auto": args.auto or args.rule,
                    "final_grade": args.final, "source": args.source, "note": args.note})
    print(f"label appended → {LABELS}")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list").set_defaults(fn=cmd_list)
    p = sub.add_parser("show"); p.add_argument("ship_code"); p.add_argument("period"); p.set_defaults(fn=cmd_show)
    p = sub.add_parser("answer"); p.add_argument("ship_code"); p.add_argument("period")
    p.add_argument("--grade", help="확정 등급 (생략 시 자동 판정 유지)")
    p.add_argument("--note", required=True, help="근거 3줄 이내")
    p.add_argument("--answer", help="요청자에게 보이는 답변 (기본 = note)")
    p.add_argument("--request-id", type=int)
    p.set_defaults(fn=cmd_answer)
    p = sub.add_parser("label"); p.add_argument("ship_code"); p.add_argument("period")
    p.add_argument("--rule", required=True); p.add_argument("--auto"); p.add_argument("--final", required=True)
    p.add_argument("--source", default="claude", choices=["claude", "user"]); p.add_argument("--note", default="")
    p.set_defaults(fn=cmd_label)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
