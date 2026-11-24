"""Rules of watch.evaluate — pure, no DB."""
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import watch as w  # noqa: E402

BAD = ["TRO 저농도"]


def kinds(p, ship=None):
    return {(h["ship"], h["kind"], h["level"]) for h in p["hits"]
            if ship is None or h["ship"] == ship}


def ev(today, grades=None, ships=("KAA",), tasks=(), last=None, clean=None, tc=(),
       cal=(), ops=()):
    return w.evaluate(grades or {}, list(ships), list(tasks), last or {}, clean,
                      set(tc), list(cal), list(ops), today)


def test_missing_levels_by_day():
    assert not kinds(ev(date(2026, 11, 5)))
    assert kinds(ev(date(2026, 11, 12))) == {("KAA", "미수신", "주의")}
    assert kinds(ev(date(2026, 11, 24))) == {("KAA", "미수신", "긴급")}


def test_inspection_streak_urgent():
    g1 = {"KAA": {"2026-10": ("점검필요", BAD)}}
    g2 = {"KAA": {"2026-09": ("점검필요", BAD), "2026-10": ("점검필요", BAD)}}
    assert kinds(ev(date(2026, 11, 24), g1)) == {("KAA", "점검필요", "주의")}
    p = ev(date(2026, 11, 24), g2)
    assert kinds(p) == {("KAA", "점검필요", "긴급")}
    assert p["ships"]["KAA"]["log"]["streak"] == 2


def test_good_month_no_hit():
    g = {"KAA": {"2026-10": ("운전양호", [])}}
    assert not kinds(ev(date(2026, 11, 24), g))


def test_ecu_overdue_techcross_only():
    g = {s: {"2026-10": ("운전양호", [])} for s in ("KAA", "KBB")}
    clean = {s: [(date(2026, 9, 1), "chem", "ECU chemical cleaning", "M2", "", "1")]
             for s in ("KAA", "KBB")}
    p = ev(date(2026, 11, 24), g, ships=("KAA", "KBB"), clean=clean, tc=("KAA",))
    assert kinds(p) == {("KAA", "ECU", "긴급")}
    assert p["ships"]["KAA"]["ecu"]["over"] == 54
    assert p["ships"]["KBB"]["ecu"] is None


def test_stale_task():
    g = {"KAA": {"2026-10": ("운전양호", [])}}
    t = [{"id": "T1", "ship_code": "KAA", "title": "x", "status": "대기", "date": "2026-11-01"}]
    assert kinds(ev(date(2026, 11, 24), g, tasks=t)) == {("KAA", "정체", "주의")}
    assert not kinds(ev(date(2026, 11, 24), g, tasks=t, last={"T1": "2026-11-20"}))


def test_calibration_levels():
    g = {"KAA": {"2026-10": ("운전양호", [])}}
    cal = [{"ship": "KAA", "due": "2026-11-01", "days": -23, "level": "expired"}]
    assert kinds(ev(date(2026, 11, 24), g, cal=cal)) == {("KAA", "검교정", "긴급")}
    cal = [{"ship": "KAA", "due": "2025-01-01", "days": -700, "level": "stale"}]
    assert not kinds(ev(date(2026, 11, 24), g, cal=cal))


def test_candidates_from_ops():
    task = {"id": "BL_KAA_2026-10", "ship_code": "KAA"}
    act = {"id": "wa_BL_KAA_2026-10", "task_id": "BL_KAA_2026-10"}
    p = ev(date(2026, 11, 24), ops=[("insert_task", task), ("insert_action", act),
                                    ("patch_task", "BL_KAA_2026-10", {"x": 1})])
    assert p["candidates"] == [{"task": task, "action": act}]


def test_diff_new_and_resolved():
    a = [{"key": "미수신:KAA"}, {"key": "ECU:KBB"}]
    b = [{"key": "ECU:KBB"}, {"key": "점검필요:KCC"}]
    new, res = w.diff(a, b)
    assert [h["key"] for h in new] == ["미수신:KAA"]
    assert [h["key"] for h in res] == ["점검필요:KCC"]


def test_urgent_sorted_first():
    g = {"KAA": {"2026-10": ("점검필요", BAD)},
         "KBB": {"2026-09": ("점검필요", BAD), "2026-10": ("점검필요", BAD)}}
    p = ev(date(2026, 11, 24), g, ships=("KAA", "KBB"))
    assert p["hits"][0]["ship"] == "KBB"


def test_follow_states_and_resolve():
    hits = [{"key": "ECU:KAA"}, {"key": "ECU:KBB"}, {"key": "미수신:KCC"}]
    acts = [{"key": "ECU:KAA", "status": "요청함", "requested_at": "2026-11-10",
             "due_date": "2026-11-17", "round": 1},
            {"key": "ECU:KBB", "status": "요청함", "requested_at": "2026-11-20",
             "due_date": "2026-11-27", "round": 2},
            {"key": "ECU:KDD", "status": "요청함", "requested_at": "2026-11-20",
             "due_date": "2026-11-27"}]
    closed = w.follow(hits, acts, date(2026, 11, 24))
    f = {h["key"]: h["follow"] for h in hits}
    assert f["ECU:KAA"]["overdue"] is True
    assert f["ECU:KBB"]["overdue"] is False and f["ECU:KBB"]["round"] == 2
    assert f["미수신:KCC"] == {"status": "미조치"}
    assert [c["key"] for c in closed] == ["ECU:KDD"]
    assert closed[0]["status"] == "해소"
