"""Parse-miss detection — turns "미운전/데이터불량" into "판독실패(검토필요)"
when the raw files say otherwise.

This is the automated form of the check the operator used to do by eye:
the matrix says a vessel did not operate, but the folder has alarms, a
DataLog, or big CSVs — so the parser missed it, the vessel did not idle.

Checks (any hit ⇒ grade "판독실패"):
  I1  EventLog has alarms/trips but OpTime·DataLog yield 0 sessions and 0 ops
  I2  DataLog present (_has_datalog) but 0 sessions
  I3  A CSV is larger than csv_min_bytes_for_content yet nothing was parsed
  I4  EventLog raw text contains BALLAST|DEBALLAST|START|STOP but 0 ops
  I5  DataLog/OpTime header matches none of the known formats (A/B/KSZ)
  I6  Vessel operated ≥N of the previous M months, this month "미운전"
  I7  PDF only / ZIP not extracted — pipeline issue (kept as 데이터불량,
      recorded in checks so it is visible, not re-graded)

Only grades "미운전" and "데이터불량" are ever re-graded. An operating grade
is never touched here. Cutoffs live in contracts/thresholds.json → integrity.
"""
import re
from pathlib import Path

from config import get_vessel_folder, get_csv_files
from thresholds import INTEG

GRADE_UNREADABLE = "판독실패"
OPERATING_GRADES = ("운전양호", "점검필요", "수리후정상")
CANDIDATE_GRADES = ("미운전", "데이터불량")

# Header signatures of formats the parser knows
KNOWN_HEADER_MARKERS = (
    "TRO_B1", "TRO_D1",          # Format A
    "TSU1_BP1", "TSU1_BP3",      # Format B (shared sensor)
    "TSU2",                      # KSZ (2 units)
    "OPERATION", "MODE", "BALLAST",  # OpTime / generic Techcross
)

_EVENT_RE = re.compile(INTEG["eventlog_grep_pattern"], re.I)


def _head_text(path, max_bytes=64 * 1024):
    try:
        with open(path, "rb") as f:
            raw = f.read(max_bytes)
        return raw.decode("utf-8", errors="ignore")
    except OSError:
        return ""


def _files_for(summary, allow_side_effects=False):
    """Locate the vessel-month folder and its CSVs without extracting ZIPs."""
    folder = get_vessel_folder(summary["year"], summary["month"], summary["code"])
    if not folder:
        return None, {}
    files = get_csv_files(folder, auto_extract_zip=allow_side_effects)
    return folder, files


def check_history(summary, history_grades):
    """I6: history_grades = grades of the previous months (oldest→newest)."""
    n = INTEG["history_months"]
    need = INTEG["history_min_operating_months"]
    recent = [g for g in history_grades[-n:] if g]
    if len(recent) < need:
        return False
    operating = sum(1 for g in recent if g in OPERATING_GRADES)
    return operating >= need


def run_checks(summary, history_grades=(), allow_side_effects=False):
    """Return {"hits": [...ids], "detail": [...], "regrade": bool}.

    Does not mutate summary. history_grades: previous months' grades for the
    same vessel, oldest first (may be empty when unknown).
    """
    hits, detail = [], []
    # A cached month may already carry the re-grade; judge on the rule grade
    # so re-running keeps the hits instead of blanking them.
    grade = summary.get("grade_rule") or summary.get("grade", "")
    if grade not in CANDIDATE_GRADES:
        return {"hits": hits, "detail": detail, "regrade": False}

    # Alfa Laval (UV) months have no OpTime/DataLog/EventLog trio — the parser
    # already grades an incomplete export as 데이터불량 with its own evidence
    # (flow rows, event count). Only the history check applies to them.
    is_alfa = "alfa_event_count" in summary
    ops = (summary.get("ballast_count") or 0) + (summary.get("deballast_count") or 0)
    sessions = summary.get("session_count") or 0
    alarms = (summary.get("alarm_count") or 0) + (summary.get("trip_count") or 0)
    reception = summary.get("reception", "")

    # I7 — pipeline issue, informational (grade stays 데이터불량)
    if reception in ("pdf_only", "zip"):
        hits.append("I7")
        detail.append(f"I7 {reception}: CSV 변환/해제 안 됨 — 파이프라인 문제")

    # I1 — alarms exist, nothing operational parsed, and there is NO OpTime
    # evidence at all. A parsed OpTime table with zero rows (_optime_rows == 0)
    # is positive evidence of an idle month — comm-failure trips or a drain
    # tank alarm can fire while the plant is not ballasting.
    if not is_alfa and alarms > 0 and sessions == 0 and ops == 0 and summary.get("_optime_rows") is None:
        hits.append("I1")
        detail.append(f"I1 알람/트립 {alarms}건 있는데 OpTime·DataLog 세션 0")

    # I2 — DataLog present but no sessions (a header-only DataLog is not a miss)
    if not is_alfa and summary.get("_has_datalog") and sessions == 0 and (summary.get("_datalog_rows") or 0) > 0:
        hits.append("I2")
        detail.append("I2 DataLog 있음(_has_datalog) 인데 세션 0 — 헤더/구분자 변형 의심")

    # File-level checks need the G: folder
    folder, files = _files_for(summary, allow_side_effects) if not is_alfa else (None, {})
    if folder:
        min_bytes = INTEG["csv_min_bytes_for_content"]
        for key in ("optime", "datalog", "eventlog"):
            p = files.get(key)
            if not p:
                continue
            try:
                size = Path(p).stat().st_size
            except OSError:
                continue
            # I3 — content-sized file, nothing parsed
            if size >= min_bytes and ops == 0 and sessions == 0 and key != "eventlog":
                hits.append("I3")
                detail.append(f"I3 {key} {size // 1024}KB 인데 파싱 결과 0")
            # I5 — unknown header
            if key in ("optime", "datalog"):
                head = _head_text(p, 8 * 1024).upper()
                if head and not any(m in head for m in KNOWN_HEADER_MARKERS):
                    hits.append("I5")
                    detail.append(f"I5 {key} 헤더가 알려진 형식(A/B/KSZ) 아님 — 신규 형식")
        # I4 — raw EventLog text says it operated. Skipped when an OpTime table
        # was parsed with zero rows: that is direct evidence of an idle month and
        # the keyword grep (START|STOP) also matches "Restart"/"Start-up".
        ev = files.get("eventlog")
        if ev and ops == 0 and summary.get("_optime_rows") is None:
            txt = _head_text(ev)
            n = len(_EVENT_RE.findall(txt))
            if n > 0:
                hits.append("I4")
                detail.append(f"I4 EventLog 원문에 운전 키워드 {n}회 (첫 64KB) 인데 운전 0")

    # I6 — history says this vessel usually operates
    if grade == "미운전" and check_history(summary, history_grades):
        hits.append("I6")
        detail.append(f"I6 직전 {INTEG['history_months']}개월 중 "
                      f"{INTEG['history_min_operating_months']}개월+ 운전 → 이번 달 미운전 이상")

    # I7 alone is informational; anything else re-grades
    regrade = any(h != "I7" for h in hits)
    return {"hits": sorted(set(hits)), "detail": detail, "regrade": regrade}


def apply(summary, history_grades=(), allow_side_effects=False):
    """Mutating form: sets summary["integrity"], keeps the rule grade in
    summary["grade_rule"], and re-grades to 판독실패 when warranted.
    Returns the (possibly new) grade."""
    summary["grade_rule"] = summary.get("grade_rule") or summary.get("grade")
    res = run_checks(summary, history_grades, allow_side_effects)
    summary["integrity"] = res
    if not res["regrade"] and summary.get("grade") == GRADE_UNREADABLE:
        summary["grade"] = summary["grade_rule"]      # checks no longer fire → back to rule grade
    if res["regrade"]:
        summary["grade"] = GRADE_UNREADABLE
        summary["grade_reasons"] = [f"파서 판독 실패 의심 ({', '.join(res['hits'])})"] + res["detail"]
    return summary["grade"]


def apply_matrix(matrix):
    """matrix: {(year, month): [summary, ...]} → applies checks with history.
    Returns count of re-graded cells."""
    by_code = {}
    for key in sorted(matrix):
        for s in matrix[key]:
            by_code.setdefault(s["code"], []).append(s)
    n = 0
    for code, rows in by_code.items():
        rows.sort(key=lambda s: (s["year"], s["month"]))
        for i, s in enumerate(rows):
            hist = [r.get("grade_rule") or r.get("grade") for r in rows[:i]]
            before = s.get("grade")
            after = apply(s, hist)
            if before != after:
                n += 1
    return n
