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


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    sb = get_client()
    n, m = sync_thresholds(sb)
    print(f"thresholds sync: {n} sections, {m} sensor models")
    out = export(sb, verbose=True)
    print(f"contract JSON → {out}")


if __name__ == "__main__":
    main()
