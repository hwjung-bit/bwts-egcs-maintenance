"""Rules of followup.plan_all — pure, no DB."""
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import followup as fu  # noqa: E402

TODAY = date(2026, 11, 23)
START = fu.FU["start_period"]          # 2026-10


def g(*pairs):
    return {p: (gr, ["TRO 저농도"] if gr == "점검필요" else []) for p, gr in pairs}


def replay(ops, tasks, action_ids):
    """Apply ops to in-memory tables (what apply() does to the DB)."""
    tasks = {t["id"]: dict(t) for t in tasks}
    ids = set(action_ids)
    for op in ops:
        if op[0] == "insert_task":
            tasks[op[1]["id"]] = dict(op[1])
        elif op[0] == "insert_action":
            ids.add(op[1]["id"])
        else:
            tasks[op[1]].update(op[2])
    return list(tasks.values()), ids


def run(grades, tasks=(), ids=(), cleanings=None, tc=("KMU",), today=TODAY):
    ops = fu.plan_all(grades, list(tasks), list(ids), cleanings, set(tc), today)
    t, i = replay(ops, tasks, ids)
    return ops, {x["id"]: x for x in t}, i


def test_bad_creates_task_with_streak_urgency():
    _, tasks, _ = run({"KMU": g(("2026-08", "점검필요"), ("2026-09", "점검필요"),
                                ("2026-10", "점검필요"))})
    t = tasks["BL_KMU_2026-10"]
    assert t["urgency"] == "상" and "3개월 연속" in t["title"] and t["status"] == "대기"
    assert t["origin"] == "로그분석" and t["system"] == "BWTS"


def test_single_bad_is_medium_and_before_start_ignored():
    _, tasks, _ = run({"KNB": g(("2026-09", "점검필요"), ("2026-10", "점검필요"))})
    assert "BL_KNB_2026-09" not in tasks          # before start_period
    _, tasks, _ = run({"KNB": g(("2026-09", "운전양호"), ("2026-10", "점검필요"))})
    assert tasks["BL_KNB_2026-10"]["urgency"] == "중"


def test_recovery_auto_completes():
    grades = {"KMU": g(("2026-10", "점검필요"), ("2026-11", "운전양호"))}
    _, tasks, _ = run(grades)
    assert tasks["BL_KMU_2026-10"]["status"] == "완료"
    assert tasks["BL_KMU_2026-10"]["completed_at"] == TODAY.isoformat()


def test_still_bad_and_hold_keep_open():
    grades = {"KMU": g(("2026-10", "점검필요"), ("2026-11", "점검필요"), ("2026-12", "미운전"))}
    _, tasks, ids = run(grades)
    assert len([k for k in tasks if k.startswith("BL_")]) == 1
    assert tasks["BL_KMU_2026-10"]["status"] != "완료"
    assert {"wa_BL_KMU_2026-11", "wa_BL_KMU_2026-12"} <= ids
    assert tasks["BL_KMU_2026-10"]["urgency"] == "상"


def test_idempotent():
    grades = {"KMU": g(("2026-10", "점검필요"), ("2026-11", "점검필요"))}
    cl = {"KMU": [(date(2026, 9, 1), "chem", "ECU chemical cleaning", "M2", "done", "MC1")]}
    ops, tasks, ids = run(grades, cleanings=cl)
    assert ops
    ops2, _, _ = run(grades, tasks.values(), ids, cleanings=cl)
    assert ops2 == []


def test_manually_closed_then_bad_again_opens_new():
    closed = {"id": "BL_KMU_2026-10", "ship_code": "KMU", "origin": "로그분석",
              "status": "완료", "date": "2026-11-01"}
    _, tasks, _ = run({"KMU": g(("2026-10", "점검필요"), ("2026-11", "점검필요"))}, [closed])
    assert tasks["BL_KMU_2026-11"]["status"] == "대기"


def test_smart_platform_task_joins_loop_from_its_month():
    sp = {"id": "WK_x", "ship_code": "KJA", "origin": "스마트플랫폼", "status": "대기",
          "date": "2026-11-05", "title": "TRO 알람"}
    grades = {"KJA": g(("2026-10", "운전양호"), ("2026-11", "운전양호"))}
    _, tasks, ids = run(grades, [sp])
    assert "wa_BL_KJA_2026-10" not in ids            # before registration month
    assert tasks["WK_x"]["status"] == "완료"           # Nov log closes it
    assert not any(k.startswith("BL_KJA") for k in tasks)


def test_review_regrade_closes_untouched_task():
    t = {"id": "BL_KSZ_2026-10", "ship_code": "KSZ", "origin": "로그분석",
         "status": "대기", "date": "2026-11-01"}
    _, tasks, _ = run({"KSZ": g(("2026-10", "운전양호"))}, [t])
    assert tasks["BL_KSZ_2026-10"]["status"] == "완료"


def test_pms_cleaning_links_and_moves_to_progress():
    grades = {"KMU": g(("2026-10", "점검필요"))}
    cl = {"KMU": [(date(2026, 10, 30), "chem", "ECU chemical cleaning", "M2", "carried out", "MC9"),
                  (date(2026, 9, 1), "chem", "ECU chemical cleaning", "M2", "old", "MC9")]}
    _, tasks, ids = run(grades, cleanings=cl, today=date(2026, 11, 10))
    assert "wa_PMS_BL_KMU_2026-10_MC9_2026-10-30" in ids
    assert "wa_PMS_BL_KMU_2026-10_MC9_2026-09-01" not in ids
    assert tasks["BL_KMU_2026-10"]["status"] == "진행"


def test_ecu_overdue_opens_and_new_cleaning_closes():
    cl = {"KJA": [(date(2026, 8, 19), "chem", "ECU chemical cleaning", "M2", "x", "MC1")]}
    _, tasks, ids = run({}, cleanings=cl, tc=("KJA",))
    t = tasks["BE_KJA_2026-08-19"]
    assert t["urgency"] == "상" and t["due_date"] == "2026-09-19" and t["origin"] == "PMS"
    cl["KJA"].append((date(2026, 11, 25), "chem", "ECU chemical cleaning", "M2", "y", "MC1"))
    _, tasks, _ = run({}, tasks.values(), ids, cleanings=cl, tc=("KJA",), today=date(2026, 11, 26))
    assert tasks["BE_KJA_2026-08-19"]["status"] == "완료"
    assert "BE_KJA_2026-11-25" not in tasks        # not overdue yet


def test_ecu_not_due_and_alfa_skipped():
    cl = {"KCN": [(date(2026, 11, 1), "chem", "c", "M1", "x", "M")],
          "KDB": [(date(2026, 1, 1), "chem", "c", "M1", "x", "M")]}
    _, tasks, _ = run({}, cleanings=cl, tc=("KCN",))
    assert not tasks


def test_ecu_baseline_used_when_no_real_cleaning():
    cl = {"KDH": [(date(2026, 10, 26), "baseline", "ECU chemical cleaning", "M2", "Initial", "M")]}
    _, tasks, _ = run({}, cleanings=cl, tc=("KDH",), today=date(2026, 11, 27))
    assert "인도 후" in tasks["BE_KDH_2026-10-26"]["title"]


def test_add_months_clamps():
    assert fu.add_months(date(2026, 1, 31), 1) == date(2026, 2, 28)
    assert fu.prev_period("2026-01") == "2025-12"
