"""Judgment thresholds — single source is contracts/thresholds.json.

The web app (js/shared/thresholds.js) and the weekly alert read the same
file, so a change here is a change everywhere. Never hardcode a cutoff in
the analyzers; add a key to the JSON and reference it via BL / INTEG.
"""
import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
TH_PATH = REPO_ROOT / "contracts" / "thresholds.json"

with open(TH_PATH, encoding="utf-8") as _f:
    TH = json.load(_f)

VERSION = TH.get("version", "unknown")
BL = TH["bwts_log"]          # log analysis cutoffs (TRO, warm-up, chattering, ...)
INTEG = TH["integrity"]      # parse-miss detection (판독실패)
BWTS_CAL = TH["bwts_calibration"]
EGCS_CAL = TH["egcs_calibration"]
