"""Regression fixtures for parser variants found by /bwts-review.

Each fixture is the head of a real CSV that the parser once mis-read.
Add a case per fix: (fixture file, expected sessions/ops) — the test is
what stops the same format from being lost again after the next change.

Run: pytest pipelines/bwts_log/tests
"""
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from thresholds import BL, INTEG  # noqa: E402
import integrity  # noqa: E402


def test_thresholds_loaded():
    assert BL["tro_ballast_min_ppm"] == 5.0
    assert BL["tro_ballast_max_ppm"] == 10.0
    assert INTEG["csv_min_bytes_for_content"] > 0


def test_integrity_i1_regrades_idle_with_alarms():
    s = {"code": "KPS", "year": 2024, "month": 5, "grade": "데이터불량",
         "ballast_count": 0, "deballast_count": 0, "session_count": 0,
         "alarm_count": 42, "trip_count": 0, "_has_datalog": True, "reception": "full"}
    res = integrity.run_checks(s, history_grades=[])
    assert "I1" in res["hits"] and "I2" in res["hits"]
    assert res["regrade"] is True


def test_integrity_never_touches_operating_grade():
    s = {"code": "KPS", "year": 2024, "month": 5, "grade": "운전양호",
         "ballast_count": 3, "deballast_count": 2, "session_count": 5,
         "alarm_count": 0, "trip_count": 0}
    res = integrity.run_checks(s)
    assert res["hits"] == [] and res["regrade"] is False


def test_integrity_i6_history():
    s = {"code": "KSL", "year": 2025, "month": 5, "grade": "미운전",
         "ballast_count": 0, "deballast_count": 0, "session_count": 0,
         "alarm_count": 0, "trip_count": 0}
    hist = ["운전양호", "점검필요", "운전양호", "운전양호", "수리후정상", "운전양호"]
    assert integrity.check_history(s, hist) is True
    assert integrity.check_history(s, ["미수신", "미운전", "운전양호"]) is False


# ── parser fixtures (append one per fix) ─────────────────────────────
# KPS_2024-05_OPTIME.csv          comma CSV, GPS quoted → exactly 7 columns; the old
#                                  "≤7 cols ⇒ space-separated" guess split it on spaces
#                                  and 72 operations parsed as 0 (2026-09-01)
# KQD_2024-02_OPTIME_spacesep.csv true space-separated file (GAS-converted) — must
#                                  still take the space path after the fix
FIXTURES = sorted((HERE / "fixtures").glob("*.csv"))


@pytest.mark.parametrize("path", FIXTURES, ids=lambda p: p.name)
def test_fixture_parses(path):
    """A fixture must parse to at least one row of its type."""
    from csv_parser import parse_optime_csv, parse_datalog_csv, parse_eventlog_csv
    name = path.name.upper()
    if "OPTIME" in name or "OPERATION" in name:
        r = parse_optime_csv(path)          # list of operation dicts
        assert isinstance(r, list) and len(r) > 0, f"{path.name}: OpTime 파싱 0행"
        assert r[0].get("operation_mode") and r[0].get("start_time"), f"{path.name}: 컬럼 매핑 실패"
    elif "DATALOG" in name or "DATAREPORT" in name:
        r = parse_datalog_csv(path)
        assert r, f"{path.name}: DataLog 파싱 실패"
    elif "EVENTLOG" in name:
        r = parse_eventlog_csv(path)
        assert r, f"{path.name}: EventLog 파싱 실패"
    else:
        pytest.skip("파일명에 로그 종류 없음")
