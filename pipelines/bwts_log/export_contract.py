"""Export the 환경파트 data contract for the 공무팀 dashboard (Dash).

1. Mirror contracts/thresholds.json into app_thresholds / sensor_cycles so the
   SQL views judge with the same cutoffs as the web app.
2. Read the contract views (sql/020) and write JSON snapshots to the G-drive
   folder the Dash server already reads from.

Files (see contracts/env_summary.schema.md):
  env_summary.json, bwts_calibration.json, egcs_calibration.json,
  repairs_open.json, bwts_log_latest.json

Env: SUPABASE_URL, SUPABASE_SERVICE_KEY. Override output dir with ENV_CONTRACT_DIR.
"""
import os
import sys
import json
from pathlib import Path
from datetime import datetime, timezone

from thresholds import TH, EGCS_CAL
from publish_supabase import get_client

DEFAULT_DIR = Path(r"G:\공유 드라이브\고려에스엠 0030 공무팀\공무팀 AI\AI 대쉬보드 (공무팀)\환경\data")
OUT_DIR = Path(os.environ.get("ENV_CONTRACT_DIR", str(DEFAULT_DIR)))
CONTRACT_VERSION = "env-contract-1"


def sync_thresholds(sb):
    now = datetime.now(timezone.utc).isoformat()
    rows = [{"key": k, "value": v, "synced_at": now} for k, v in TH.items() if isinstance(v, dict)]
    sb.table("app_thresholds").upsert(rows, on_conflict="key").execute()
    cyc = [{"model": m, "cal_months": c.get("cal"), "repl_months": c["repl"]}
           for m, c in EGCS_CAL["sensor_cycle_months"].items()]
    sb.table("sensor_cycles").upsert(cyc, on_conflict="model").execute()
    return len(rows), len(cyc)


def _write(name, payload):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    tmp = OUT_DIR / (name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1, default=str)
    tmp.replace(OUT_DIR / name)   # atomic swap — Dash never reads a half file


def export(sb, verbose=False):
    meta = {"contract": CONTRACT_VERSION, "generated_at": datetime.now(timezone.utc).isoformat(),
            "source": "supabase ivsjskywdtsnoxhnozcd", "thresholds_version": TH.get("version")}

    summ = sb.table("v_env_summary").select("*").execute().data
    _write("env_summary.json", {**meta, **(summ[0] if summ else {})})

    cal = sb.table("v_calibration_status").select("*").order("days_left").execute().data or []
    _write("bwts_calibration.json", {**meta, "rows": [r for r in cal if r["system"] == "BWTS"]})
    _write("egcs_calibration.json", {**meta, "rows": [r for r in cal if r["system"] == "EGCS"]})

    rep = sb.table("v_repairs_open").select("*").execute().data or []
    _write("repairs_open.json", {**meta, "rows": rep})

    lg = sb.table("v_bwts_log_latest").select("*").execute().data or []
    _write("bwts_log_latest.json", {**meta, "rows": lg})

    if verbose:
        print(f"  env_summary: {json.dumps(summ[0] if summ else {}, ensure_ascii=False, default=str)[:300]}")
        print(f"  calibration {len(cal)} · repairs_open {len(rep)} · bwts_log_latest {len(lg)}")
    return OUT_DIR


# ── 구 GAS 스냅샷 호환 (env_snapshot.json / env_data.js) ────────────────────
# 공무팀 Dash 는 2026-09 시점에 구 GAS 웹앱이 Drive `_dashboard/` 에 내보내던
# env_snapshot.json 을 읽는다. 구 시트 DB 가 멈추면서 그 파일은 7월 이후 굳었다.
# 옛 트리거를 끄는 대신 여기서 Supabase 기준으로 같은 모양을 써 준다 —
# Dash 코드를 건드리지 않고 최신 데이터가 흐르게. 새 계약(env_summary.json)이
# 자리잡으면 이 블록은 지운다.
LEGACY_SNAPSHOT_DIRS = [
    Path(r"G:\공유 드라이브\고려에스엠 0033 공무팀 환경기술파트\_dashboard"),
    Path("G:/공유 드라이브/고려에스엠 0033 공무팀 환경기술파트/025  SCRUBBER 업무/13 메이커 서비스/_dashboard"),
]
_STAGE_LEGACY = {"미확인": "received", "확인": "diagnosing", "수리준비중": "repairing",
                 "자재준비중": "repairing", "방선예정": "repairing", "완료": "done"}


def _kst_now():
    from datetime import timedelta
    return (datetime.now(timezone.utc) + timedelta(hours=9)).strftime("%Y-%m-%d %H:%M")


def _atts(v):
    if not v:
        return []
    if isinstance(v, str):
        try:
            v = json.loads(v)
        except ValueError:
            return []
    return v if isinstance(v, list) else []


def build_legacy_snapshot(sb):
    ships = sb.table("ships").select("*").execute().data or []
    repairs = sb.table("repairs").select("*").order("date", desc=True).execute().data or []
    cals = sb.table("calibrations").select("*").execute().data or []
    mails = sb.table("mail_log").select(
        "id,date,system,ship_code,subject,sender,status,note,category,source,mail_link") \
        .order("date", desc=True).limit(300).execute().data or []
    now = _kst_now()
    snap = {
        "email": "hwjung@ekmtc.com", "role": "admin", "dbUrl": "",
        "ships": [{"code": s["code"], "name": s.get("name") or "", "teu": s.get("teu") or "",
                   "bwts_maker": s.get("bwts_maker") or "", "egcs_maker": s.get("egcs_maker") or "",
                   "wms": s.get("wms") or "", "cems": s.get("cems") or "", "scrubber_folder": "",
                   "hidden": bool(s.get("hidden")), "updatedAt": s.get("updated_at") or ""}
                  for s in sorted(ships, key=lambda x: (x.get("sort_order") or 999))],
        "repairs": [{"id": r["id"], "shipCode": r.get("ship_code") or "", "system": r.get("system") or "",
                     "date": r.get("date") or "", "equip": r.get("equip") or "",
                     "stage": _STAGE_LEGACY.get(r.get("stage"), "received"), "stageKo": r.get("stage") or "",
                     "symptom": r.get("symptom") or "", "action": r.get("action") or "",
                     "parts": r.get("parts") or "", "cost": r.get("cost") or "",
                     "attachments": _atts(r.get("attachments")), "createdAt": "", "updatedAt": "",
                     "history": _atts(r.get("history")), "sourceFolderId": "",
                     "sourceMsgId": r.get("source_msg_id") or "", "needsReview": bool(r.get("needs_review")),
                     "emailSubject": r.get("email_subject") or "", "emailLink": r.get("email_link") or "",
                     "fileUrl": r.get("file_url") or "", "origin": r.get("origin") or ""}
                    for r in repairs],
        "bwtsCal": [{"id": c.get("id"), "shipCode": c["ship_code"], "equip": "연간검교정",
                     "lastCalibration": c.get("last_date") or "", "intervalMonths": c.get("interval_months") or 12,
                     "note": c.get("note") or "", "updatedAt": "", "system": "BWTS",
                     "serial": c.get("serial") or "", "model": c.get("model") or "", "certUrl": c.get("cert_url") or ""}
                    for c in cals if c.get("system") == "BWTS"],
        "egcsCal": [{"id": c.get("id"), "shipCode": c["ship_code"], "equip": (c.get("equip") or "").replace("-", "/"),
                     "date": c.get("last_date") or "", "text": "" if c.get("last_date") else (c.get("note") or ""),
                     "serial": c.get("serial") or "", "model": c.get("model") or ""}
                    for c in cals if c.get("system") == "EGCS"],
        "syncStatus": {"at": now, "source": "supabase bwts-egcs-maintenance"},
        "snapStatus": {"at": now, "ok": True, "source": "export_contract.py"},
        "collectLog": [],
    }
    mail_init = [{"id": m["id"], "date": m.get("date") or "", "system": m.get("system") or "",
                  "shipCode": m.get("ship_code") or "", "subject": m.get("subject") or "",
                  "from": m.get("sender") or "", "status": m.get("status") or "",
                  "note": m.get("note") or "", "category": m.get("category") or "",
                  "source": m.get("source") or "", "link": m.get("mail_link") or ""} for m in mails]
    return snap, mail_init


def export_legacy_snapshot(sb, verbose=False):
    snap, mail_init = build_legacy_snapshot(sb)
    js = json.dumps(snap, ensure_ascii=False)
    js_file = ("// Auto-generated " + _kst_now() + " by bwts-egcs-maintenance export_contract.py\n"
               "var ENV_DATA = " + js + ";\n"
               "var MAIL_DATA_INIT = " + json.dumps(mail_init, ensure_ascii=False) + ";\n")
    written = []
    for d in LEGACY_SNAPSHOT_DIRS:
        if not d.parent.exists():
            continue
        d.mkdir(parents=True, exist_ok=True)
        for name, content in (("env_snapshot.json", js), ("env_data.js", js_file)):
            tmp = d / (name + ".tmp")
            tmp.write_text(content, encoding="utf-8")
            tmp.replace(d / name)
        written.append(str(d))
    if verbose:
        print(f"  legacy snapshot: ships {len(snap['ships'])} · repairs {len(snap['repairs'])} · "
              f"bwtsCal {len(snap['bwtsCal'])} · egcsCal {len(snap['egcsCal'])} → {len(written)} dirs")
    return written


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    sb = get_client()
    n, m = sync_thresholds(sb)
    print(f"thresholds sync: {n} sections, {m} sensor models")
    out = export(sb, verbose=True)
    print(f"contract JSON → {out}")
    export_legacy_snapshot(sb, verbose=True)


if __name__ == "__main__":
    main()
