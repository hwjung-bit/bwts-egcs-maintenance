"""watch_rules — EGCS · 수신 · 연료/CII columns, pure."""
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import watch_rules as wr  # noqa: E402


def lv(hs):
    return {(h["ship"], h["kind"], h["level"], h["col"]) for h in hs}


def test_egcs_status_levels():
    rows = [{"code": "KAA", "egcs_wms_status": "정상", "egcs_cems_status": "문제", "egcs_cems_memo": "O2 0"},
            {"code": "KBB", "egcs_body_status": "운용가능"},
            {"code": "KCC"}]
    assert lv(wr.egcs_status_hits(rows)) == {("KAA", "EGCS상태", "긴급", "EGCS 상태"),
                                             ("KBB", "EGCS상태", "주의", "EGCS 상태")}


def test_egcs_cal_one_per_ship_stale_skipped():
    al = [{"ship": "KAA", "sensor": "pH", "kind": "검교정", "days": -3, "level": "expired"},
          {"ship": "KAA", "sensor": "PAH", "kind": "검교정", "days": 10, "level": "soon"},
          {"ship": "KBB", "sensor": "pH", "kind": "검교정", "days": 20, "level": "soon"},
          {"ship": "KCC", "sensor": "pH", "kind": "검교정", "days": -900, "level": "stale"}]
    assert lv(wr.egcs_cal_hits(al)) == {("KAA", "EGCS검교정", "긴급", "EGCS 검교정"),
                                        ("KBB", "EGCS검교정", "주의", "EGCS 검교정")}


def test_bunker_two_weeks_urgent_and_start():
    weeks = [("2026-11-20", {"KAA": False, "KBB": False, "KCC": True, "KDH": False}),
             ("2026-11-13", {"KAA": False, "KBB": True, "KCC": True})]
    hs = wr.bunker_hits(weeks, {"KDH": "2026-11-27"})
    assert lv(hs) == {("KAA", "벙커미수신", "긴급", "수신"), ("KBB", "벙커미수신", "주의", "수신")}


def test_bsr_missing_days():
    t = date(2026, 11, 27)
    hs = wr.bsr_hits({"KAA": date(2026, 10, 20), "KBB": date(2026, 11, 20), "KCC": None}, t)
    assert {h["ship"] for h in hs} == {"KAA", "KCC"}


def test_egcs_daily_gap():
    t = date(2026, 11, 27)
    full = {f"2026-11-{d:02d}" for d in range(20, 27)}
    gap = full - {"2026-11-21", "2026-11-22", "2026-11-23"}
    assert {h["ship"] for h in wr.egcs_log_hits({"KLB": full, "KDH": gap}, t)} == {"KDH"}


def test_fuel_lines_and_extra():
    lines = ["=== CII 오류 ===", "[해결 2026-11-26] SDY M.G.O WRONG → GOOD",
             "[SHAFT 정지] KTJ 주간 값 그대로", "[SHAFT 정지] KCN 11/13 입거(DOCK), 이상 아님",
             "[SHAFT 오기] KCB 11/15", "[SHAFT 오기] KCB 11/16"]
    extra = {"at": "2026-11-23T08:00", "bcm": {"KAA": 3}, "xpert": {"KBB": {"worst": 70, "bad": 1, "total": 4},
                                                                   "KCC": {"worst": 50, "bad": 1, "total": 3}}}
    hs = wr.fuel_hits(lines, "x.txt", extra)
    assert lv(hs) == {("KTJ", "CII오류", "주의", "연료·CII"), ("KCB", "CII오류", "주의", "연료·CII"),
                      ("KAA", "BCM", "주의", "연료·CII"), ("KBB", "XPERT", "긴급", "연료·CII"),
                      ("KCC", "XPERT", "주의", "연료·CII")}
    assert "2건" in next(h["msg"] for h in hs if h["ship"] == "KCB")
