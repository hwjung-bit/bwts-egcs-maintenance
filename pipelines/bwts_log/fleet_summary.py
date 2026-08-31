# fleet_summary.py — VesselMonthSummary computation and grading
import sys
import json
import os
from datetime import datetime
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')

from config import (
    VESSELS, VESSEL_BY_CODE, LOCAL_CACHE_DIR,
    get_vessel_folder, get_csv_files, scan_reception_matrix,
)
from csv_parser import combine_csv_results
from analysis import validate_and_normalize
from fleet_log_analyzer import analyze_datalog_deep
from thresholds import BL


def _json_serial(obj):
    """Convert non-serializable objects for JSON."""
    if isinstance(obj, datetime):
        return obj.isoformat()
    if isinstance(obj, Path):
        return str(obj)
    raise TypeError(f"Type {type(obj)} not serializable")


def _cache_path(code, year, month):
    return LOCAL_CACHE_DIR / f"fleet_{year}_{month:02d}_{code}.json"


def needs_reparse(code, year, month):
    """Check if cached result is stale based on folder mtime."""
    cp = _cache_path(code, year, month)
    if not cp.exists():
        return True

    folder = get_vessel_folder(year, month, code)
    if not folder or not folder.exists():
        return False

    folder_mtime = folder.stat().st_mtime
    cache_mtime = cp.stat().st_mtime
    return folder_mtime > cache_mtime


def _classify_reception(folder, csv_files):
    """Determine reception status string from folder/files."""
    if not folder:
        return "missing", "폴더 없음"

    has = {k: csv_files[k] is not None
           for k in ("optime", "datalog", "eventlog")}
    count = sum(has.values())
    nulls = csv_files.get("_null_files", [])
    pdfs = csv_files.get("_pdf_only", [])
    zips = list(folder.glob("*.zip")) + list(folder.glob("*.ZIP"))

    if count == 3:
        return "full", "CSV 3종 완비"
    if count > 0:
        missing = [k for k in ("optime", "datalog", "eventlog")
                   if not has[k]]
        return "partial", f"누락: {', '.join(missing)}"
    if nulls:
        return "null", f"null 파일 {len(nulls)}개"
    if zips:
        return "zip", f"ZIP {len(zips)}개 (미해제)"
    if pdfs:
        return "pdf_only", f"PDF {len(pdfs)}개만"
    return "folder_only", "폴더만 존재 (파일 없음)"


def compute_grade(summary):
    """
    Returns (grade_label, [reasons]).
    Grades:
      운전양호 / 점검필요 / 수리후정상 / 미운전 / 미수신 / 데이터불량
    """
    reception = summary.get("reception", "missing")
    reasons = []

    if reception == "missing":
        return "미수신", ["폴더 없음"]

    if reception in ("null", "zip", "pdf_only", "folder_only"):
        detail = summary.get("reception_detail", reception)
        # "폴더만 존재" or "PDF만" with only BWRB → treat as 미수신
        if reception == "folder_only":
            return "미수신", ["폴더만 존재 (파일 없음)"]
        return "데이터불량", [detail]

    b_count = summary.get("ballast_count", 0)
    d_count = summary.get("deballast_count", 0)

    if b_count == 0 and d_count == 0:
        # Check if DataLog CSV exists but parsing failed
        sess = summary.get("session_count", 0)
        if summary.get("_has_datalog") and sess == 0:
            return "데이터불량", ["DataLog 파싱 실패"]
        return "미운전", ["당월 운전 기록 없음"]

    # Check recovery pattern
    rp = summary.get("recovery_pattern") or {}
    if rp.get("pattern") == "recovery":
        return "수리후정상", [rp.get("detail", "회복 패턴 감지")]

    # Check for issues -> 점검필요
    no_tro = summary.get("no_tro_sensor", False)
    tro_b_ok = summary.get("tro_b_in_range")
    tro_d_ok = summary.get("tro_d_compliant")
    trip_count = summary.get("trip_count", 0)
    chattering = summary.get("chattering", [])

    if not no_tro:
        if tro_b_ok is False:
            reasons.append("주입 TRO 범위 이탈")
        if tro_d_ok is False:
            reasons.append("배출 TRO 기준 초과")
    if trip_count >= BL["trip_check_needed"]:
        reasons.append(f"Trip {trip_count}건")
    if chattering:
        reasons.append("밸브 채터링 감지")

    if reasons:
        return "점검필요", reasons

    return "운전양호", []


def compute_vessel_summary(code, year, month, verbose=False):
    """Analyze single vessel-month. Returns VesselMonthSummary dict."""
    v = VESSEL_BY_CODE.get(code)
    if not v:
        return None

    summary = {
        "code": code,
        "name": v["name"],
        "year": year,
        "month": month,
        "reception": "missing",
        "reception_detail": "",
        "ballast_count": 0,
        "deballast_count": 0,
        "op_days": 0,
        "ballast_volume": 0.0,
        "deballast_volume": 0.0,
        "ballast_runtime": 0.0,
        "deballast_runtime": 0.0,
        "tro_b_avg": None,
        "tro_b_min": None,
        "tro_d_max": None,
        "tro_b_in_range": None,
        "tro_d_compliant": None,
        "session_count": 0,
        "session_summaries": [],
        "recovery_pattern": {},
        "chattering": [],
        "sensor_issues": [],
        "alarm_count": 0,
        "trip_count": 0,
        "grade": "",
        "grade_reasons": [],
        "gps_areas": [],
    }

    # 0. Check BWTS type first — non-Techcross skip TRO
    bwts_type = v.get("bwts_type", "techcross")

    if bwts_type != "techcross":
        folder = get_vessel_folder(year, month, code)
        type_label = bwts_type.replace("_", " ").upper()

        if not folder:
            summary["reception"] = "missing"
            summary["reception_detail"] = "폴더 없음"
            summary["grade"] = "미수신"
            summary["grade_reasons"] = [
                f"{type_label} — 데이터 미수신"]
            if verbose:
                print(f"[{code}] -> 미수신 ({type_label})")
            return summary

        # Try Alfa Laval parser
        from alfa_laval_parser import analyze_alfa_laval
        al = analyze_alfa_laval(folder)

        if not al:
            has_any = any(
                f for f in folder.iterdir()
                if f.suffix.upper() in (
                    ".CSV", ".XLSX", ".PDF", ".ZIP"))
            if not has_any:
                summary["reception"] = "missing"
                summary["grade"] = "미수신"
                summary["grade_reasons"] = [
                    f"{type_label} — 폴더만 존재"]
            else:
                summary["reception"] = "full"
                summary["reception_detail"] = (
                    f"{type_label} — 파싱 실패")
                summary["grade"] = "데이터불량"
                summary["grade_reasons"] = [
                    f"{type_label} — 형식 미지원"]
            if verbose:
                print(f"[{code}] -> {summary['grade']} "
                      f"({type_label})")
            return summary

        # Alfa Laval parsed successfully
        summary["reception"] = "full"
        summary["reception_detail"] = (
            f"{type_label} — {al.get('source', '')}")
        summary["ballast_count"] = al["ballast_count"]
        summary["deballast_count"] = al["deballast_count"]
        summary["op_days"] = al["op_days"]
        summary["alarm_count"] = al["alarm_count"]
        summary["no_tro_sensor"] = True  # UV type

        # Grade
        issues = al.get("issues", [])
        if al["ballast_count"] == 0 \
                and al["deballast_count"] == 0:
            summary["grade"] = "미운전"
            summary["grade_reasons"] = [
                f"{type_label} — 운전 기록 없음"]
        elif issues:
            summary["grade"] = "점검필요"
            summary["grade_reasons"] = [
                f"{type_label}"] + issues
        else:
            summary["grade"] = "운전양호"
            summary["grade_reasons"] = [
                f"{type_label} — 정상 운전"]

        if verbose:
            print(f"[{code}] -> {summary['grade']} "
                  f"B={al['ballast_count']} D={al['deballast_count']} "
                  f"({type_label})")
        return summary

    # 1. Check reception (Techcross only from here)
    folder = get_vessel_folder(year, month, code)
    csv_files = get_csv_files(folder) if folder else {
        "optime": None, "datalog": None, "eventlog": None,
        "_null_files": [], "_pdf_only": [], "_issues": [],
    }
    reception, detail = _classify_reception(folder, csv_files)
    summary["reception"] = reception
    summary["reception_detail"] = detail

    if reception in ("missing", "null", "zip",
                     "pdf_only", "folder_only"):
        grade, reasons = compute_grade(summary)
        summary["grade"] = grade
        summary["grade_reasons"] = reasons
        if verbose:
            print(f"[{code}] -> {grade}")
        return summary

    # Track which CSVs exist
    summary["_has_datalog"] = csv_files["datalog"] is not None

    # 2. Parse CSVs (Techcross only)
    combined = combine_csv_results(
        csv_files["optime"],
        csv_files["datalog"],
        csv_files["eventlog"],
        vessel={"name": v["name"], "year": year, "month": month},
    )

    # 3. Run validate_and_normalize (for alarm counts)
    analyzed = validate_and_normalize(combined)

    # Extract operation stats
    ops = analyzed.get("operations", [])
    op_stats = analyzed.get("op_time_stats", {})
    b_stat = op_stats.get("BALLAST", {})
    d_stat = op_stats.get("DEBALLAST", {})

    summary["ballast_count"] = b_stat.get("count", 0)
    summary["deballast_count"] = d_stat.get("count", 0)
    summary["ballast_volume"] = b_stat.get("total_volume", 0.0)
    summary["deballast_volume"] = d_stat.get("total_volume", 0.0)
    summary["ballast_runtime"] = b_stat.get("total_runtime", 0.0)
    summary["deballast_runtime"] = d_stat.get("total_runtime", 0.0)

    # Op days
    all_dates = set()
    for o in ops:
        if o.get("date"):
            all_dates.add(o["date"])
    summary["op_days"] = len(all_dates)

    # 4. Run deep analysis (before grade, so we can use sessions)
    deep = analyze_datalog_deep(
        csv_files["datalog"],
        csv_files["eventlog"],
    )

    # Fallback: if OpTime gives 0 counts but DataLog has sessions,
    # use session counts (OpTime CSV may be missing/broken)
    if summary["ballast_count"] == 0 \
            and summary["deballast_count"] == 0:
        sess_list = deep.get("session_summaries", [])
        b_sess = [s for s in sess_list if s["mode"] == "BALLAST"]
        d_sess = [s for s in sess_list
                  if s["mode"] in ("DEBALLAST", "STRIPPING")]
        if b_sess or d_sess:
            summary["ballast_count"] = len(b_sess)
            summary["deballast_count"] = len(d_sess)
            sess_dates = set(
                s["date"] for s in sess_list if s.get("date"))
            summary["op_days"] = len(sess_dates)

    # GPS areas
    summary["gps_areas"] = analyzed.get("gps_areas", [])

    # Alarm/trip counts from error_alarms
    alarms = analyzed.get("error_alarms", [])
    for a in alarms:
        if a.get("code") == "VRCS_ERR":
            continue
        lvl = (a.get("level") or "").lower()
        if lvl == "trip":
            summary["trip_count"] += 1
        else:
            summary["alarm_count"] += 1

    summary["session_count"] = len(deep.get("sessions", []))
    summary["session_summaries"] = deep.get(
        "session_summaries", [])
    summary["recovery_pattern"] = deep.get(
        "recovery_pattern", {})
    summary["chattering"] = deep.get("chattering", [])
    summary["sensor_issues"] = deep.get("sensor_issues", [])

    # TRO from deep analysis (warm-up excluded)
    otb = deep.get("overall_tro_b", {})
    otd = deep.get("overall_tro_d", {})
    summary["tro_b_avg"] = otb.get("stable_avg")
    summary["tro_b_min"] = otb.get("stable_min")
    summary["tro_d_max"] = otd.get("stable_max")
    summary["tro_d_avg"] = otd.get("stable_avg")

    # Check if vessel has TRO sensor (from deep analysis)
    no_tro_sensor = not deep.get("has_tro_sensor", True)
    summary["no_tro_sensor"] = no_tro_sensor

    # Format B detection (TSU shared sensor)
    is_format_b = deep.get("is_format_b", False)
    summary["is_format_b"] = is_format_b

    # TRO range checks (only if sensor exists)
    # Use avg for judgment (min can be warm-up artifact)
    if not no_tro_sensor:
        b_check = summary["tro_b_avg"]
        if b_check is not None:
            summary["tro_b_in_range"] = BL["tro_ballast_min_ppm"] <= b_check <= BL["tro_ballast_max_ppm"]
            # Stable-ratio relaxation: check session-level
            # in_range results — if majority of sessions OK,
            # override overall judgment
            if not summary["tro_b_in_range"]:
                b_sessions = [
                    s for s in summary.get(
                        "session_summaries", [])
                    if s["mode"] == "BALLAST"
                    and s.get("in_range") is not None]
                if b_sessions:
                    ok_count = sum(
                        1 for s in b_sessions if s["in_range"])
                    if ok_count >= len(b_sessions) * BL["tro_ballast_relaxed_ratio"]:
                        summary["tro_b_in_range"] = True
        # Format B: D-TRO is shared sensor residual, skip judgment
        if not is_format_b:
            d_avg = summary.get("tro_d_avg")
            if d_avg is not None:
                summary["tro_d_compliant"] = d_avg < BL["tro_deballast_month_avg_max_ppm"]
            elif summary["tro_d_max"] is not None:
                summary["tro_d_compliant"] = \
                    summary["tro_d_max"] < BL["tro_deballast_month_avg_max_ppm"]
        else:
            summary["tro_d_compliant"] = True  # Skip for Format B

    # 5. Compute grade
    grade, reasons = compute_grade(summary)
    summary["grade"] = grade
    summary["grade_reasons"] = reasons

    if verbose:
        print(f"[{code}] -> {grade}")

    return summary


def build_fleet_matrix(start_year, start_month,
                       end_year, end_month, verbose=False):
    """
    Build {(year, month): [VesselMonthSummary, ...]}
    for all vessels across the date range.
    Uses cache: only re-parses if source folder is newer.
    """
    LOCAL_CACHE_DIR.mkdir(parents=True, exist_ok=True)

    matrix = {}

    for year in range(start_year, end_year + 1):
        m_start = start_month if year == start_year else 1
        m_end = end_month if year == end_year else 12
        for month in range(m_start, m_end + 1):
            key = (year, month)
            matrix[key] = []

            for v in VESSELS:
                code = v["code"]
                cp = _cache_path(code, year, month)

                if not needs_reparse(code, year, month):
                    try:
                        with open(cp, "r", encoding="utf-8") as f:
                            cached = json.load(f)
                        matrix[key].append(cached)
                        if verbose:
                            print(f"[{code}] {year}-{month:02d}"
                                  f" (cached) -> {cached['grade']}")
                        continue
                    except (json.JSONDecodeError, KeyError):
                        pass

                summary = compute_vessel_summary(
                    code, year, month, verbose=verbose)
                if summary is None:
                    continue

                matrix[key].append(summary)

                # Write cache
                try:
                    with open(cp, "w", encoding="utf-8") as f:
                        json.dump(summary, f,
                                  ensure_ascii=False, indent=1,
                                  default=_json_serial)
                except Exception:
                    pass

    return matrix
