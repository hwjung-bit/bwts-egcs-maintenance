# analysis.py — BWTS Analysis Pipeline
# Ported from analysisService.js + fallback.js
import re
from alarm_info import (
    ALARM_INFO, ALARM_CATEGORIES,
    VALVE_PATTERN, VALVE_CODES,
)


def _parse_repeat(a):
    """Extract repeat count from '×N회' in description."""
    m = re.search(r"×(\d+)회", a.get("description", ""))
    return int(m.group(1)) if m else (a.get("count") or 1)


# ─── Alarm Level Normalization ──────────────────────────────

def normalize_alarm_levels(alarms):
    level_map = {
        "trip": "Trip", "alarm": "Alarm",
        "warning": "Warning", "normal": "Normal",
    }
    for a in alarms:
        raw = (a.get("level") or "").lower()
        a["level"] = level_map.get(raw, a.get("level"))
    return alarms


# ─── Repeat Alarm Grouping ──────────────────────────────────

def group_repeat_alarms(alarms):
    groups = {}
    for a in alarms:
        base_desc = re.sub(
            r"\s*[\[\(]\d[\d.]*[\]\)]", "",
            a.get("description", "")).strip()
        if not a.get("code") and not base_desc:
            continue
        key = f"{a.get('code', '')}|{base_desc}"
        if key not in groups:
            groups[key] = {
                **a, "description": base_desc, "count": 1,
                "first_date": a.get("date"),
                "last_date": a.get("date"),
            }
        else:
            g = groups[key]
            g["count"] += 1
            if (a.get("level") or "").lower() == "trip":
                g["level"] = "Trip"
            d = a.get("date")
            if d:
                if not g["first_date"] or d < g["first_date"]:
                    g["first_date"] = d
                if not g["last_date"] or d > g["last_date"]:
                    g["last_date"] = d

    result = []
    for g in groups.values():
        if g["count"] > 1 and g["first_date"] and \
                g["last_date"] and g["first_date"] != g["last_date"]:
            date_range = f"{g['first_date']}~{g['last_date']}"
        else:
            date_range = g["first_date"]

        desc = (f"{g['description']} (×{g['count']}회)"
                if g["count"] > 1 else g["description"])

        result.append({
            "code": g.get("code"),
            "description": desc,
            "level": g["level"],
            "date": date_range,
            "time": g.get("time") if g["count"] == 1 else None,
            "sensor_at_event": (
                g.get("sensor_at_event")
                if g["count"] == 1 else None),
        })
    return result


# ─── Valve Warning ──────────────────────────────────────────

def append_valve_warning(data):
    alarms = data.get("error_alarms", [])
    valve_alarms = [
        a for a in alarms
        if (VALVE_PATTERN.search(a.get("description", ""))
            or VALVE_CODES.search(
                str(a.get("code", "")).replace("CODE", "")))
        and a.get("code") != "VRCS_ERR"
    ]
    if not valve_alarms:
        return

    total = sum(_parse_repeat(a) for a in valve_alarms)
    if total < 5:
        return

    codes = ", ".join(sorted(set(
        a["code"] for a in valve_alarms if a.get("code"))))
    is_critical = (
        data.get("overall_status") == "CRITICAL" or total >= 10)

    ko = (
        f"CODE({codes}) 밸브 비정상 동작 총 {total}회 감지 — "
        f"{'[긴급] 해당 밸브 즉각 점검 필요 (CRITICAL 수준).'}"
        if is_critical else
        f"CODE({codes}) 밸브 비정상 동작 총 {total}회 감지 — "
        f"해당 밸브 개도 설정 및 센서 점검 권장."
    )
    en = (
        f"CODE({codes}) Valve abnormal operation detected "
        f"{total} times — "
        f"{'[URGENT] immediate valve inspection required (CRITICAL level).'}"
        if is_critical else
        f"CODE({codes}) Valve abnormal operation detected "
        f"{total} times — recommend checking valve position "
        f"and feedback sensor."
    )

    remarks = data.setdefault("ai_remarks", [])
    if not any("밸브 비정상" in r for r in remarks):
        remarks.append(ko)
    remarks_en = data.setdefault("ai_remarks_en", [])
    if not any("Valve abnormal" in r for r in remarks_en):
        remarks_en.append(en)


# ─── TRO Sanity Check ──────────────────────────────────────

def sanitize_tro_values(data):
    tro = data.get("tro_data")
    if not tro:
        return

    if tro.get("ballasting_avg") is not None \
            and tro["ballasting_avg"] > 100:
        val = tro["ballasting_avg"]
        tro["ballasting_avg"] = None
        note = (f"[TRO 이상] 주입 TRO {val}ppm — "
                f"비정상 수치(센서 오류 또는 단위 오류 의심). "
                f"Data Log 원본 재확인 필요.")
        remarks = data.setdefault("ai_remarks", [])
        if not any("비정상 수치" in r for r in remarks):
            remarks.append(note)

    if tro.get("deballasting_max") is not None \
            and tro["deballasting_max"] > 100:
        val = tro["deballasting_max"]
        tro["deballasting_max"] = None
        note = (f"[TRO 이상] 배출 TRO 최댓값 {val}ppm — "
                f"비정상 수치(센서 오류 또는 단위 오류 의심). "
                f"Data Log 원본 재확인 필요.")
        remarks = data.setdefault("ai_remarks", [])
        if not any("비정상 수치" in r for r in remarks):
            remarks.append(note)

    if tro.get("deballasting_max") is not None \
            and tro["deballasting_max"] > 1.0:
        tro["_deballasting_warning"] = (
            f"배출 TRO {tro['deballasting_max']}ppm — "
            f"IMO 기준(0.1ppm) 대폭 초과. TRO 센서 교차오염, "
            f"Ballast/Deballast 컬럼 혼동, 또는 중화 불량 가능성")


# ─── Overall Status Recalculation ───────────────────────────

def recalc_overall_status(data):
    all_alarms = data.get("error_alarms", [])
    tro = data.get("tro_data") or {}
    ops = data.get("operations", [])

    bwts_alarms = [a for a in all_alarms if a.get("code") != "VRCS_ERR"]

    trip_count = sum(
        _parse_repeat(a) for a in bwts_alarms
        if (a.get("level") or "").lower() == "trip")
    max_repeat = max(
        (_parse_repeat(a) for a in bwts_alarms), default=0)

    tro_safety = tro.get("ballasting_min") \
        if tro.get("ballasting_min") is not None \
        else tro.get("ballasting_avg")
    tro_ballast_bad = (
        tro_safety is not None and (tro_safety < 5 or tro_safety > 10))

    # Stable-ratio relaxation: if max is in normal range,
    # treat as normal when enough stable readings exist.
    # Short runs (<10 rows): 1+ reading in range → OK.
    # Long runs (>=10 rows): >=50% in range → OK.
    b_max = tro.get("ballasting_max")
    b_ratio = tro.get("ballasting_stable_ratio", 0)
    b_count = tro.get("ballasting_count", 0)
    if tro_ballast_bad and b_max is not None \
            and 5 <= b_max <= 12:
        if b_count >= 10 and b_ratio >= 0.5:
            tro_ballast_bad = False
        elif b_count < 10 and b_ratio > 0:
            tro_ballast_bad = False
    tro_deballast_bad = (
        tro.get("deballasting_max") is not None
        and tro["deballasting_max"] > 0.1)

    has_log_overflow = any(
        a.get("code") == "LOG_OVERFLOW" for a in bwts_alarms)

    had_ballast = any(
        re.search(r"BALLAST", o.get("operation_mode", ""), re.I)
        and not re.search(r"DE", o.get("operation_mode", ""), re.I)
        for o in ops)
    had_deballast = any(
        re.search(r"DEBALLAST", o.get("operation_mode", ""), re.I)
        for o in ops)
    tro_all_null = (
        (had_ballast and tro.get("ballasting_avg") is None
         and tro.get("ballasting_min") is None)
        or (had_deballast and tro.get("deballasting_max") is None)
    )

    # Judgment
    if trip_count >= 5 or max_repeat >= 15:
        status = "CRITICAL"
    elif (trip_count >= 1 or max_repeat >= 5
          or len(bwts_alarms) >= 5
          or tro_ballast_bad or tro_deballast_bad
          or tro_all_null or has_log_overflow):
        status = "WARNING"
    else:
        status = "NORMAL"

    # Recent window relaxation (7 days from last op)
    if status != "NORMAL":
        op_dates = sorted(
            o.get("date") for o in ops if o.get("date"))
        if op_dates:
            from datetime import datetime, timedelta
            last_op = op_dates[-1]
            try:
                cutoff = (
                    datetime.strptime(last_op, "%Y-%m-%d")
                    - timedelta(days=7)
                ).strftime("%Y-%m-%d")
                recent = [
                    a for a in bwts_alarms
                    if _get_alarm_last_date(a)
                    and _get_alarm_last_date(a) >= cutoff
                ]
                if not recent and not tro_ballast_bad \
                        and not tro_deballast_bad:
                    status = "NORMAL"
            except ValueError:
                pass

    data["overall_status"] = status

    # TRO null warning
    if tro_all_null:
        remarks = data.setdefault("ai_remarks", [])
        if not any(re.search(r"TRO", r, re.I) for r in remarks):
            remarks.append("TRO 미수신 — DataReport 확인 필요.")
        remarks_en = data.setdefault("ai_remarks_en", [])
        if not any("TRO data not received" in r for r in remarks_en):
            remarks_en.append(
                "TRO data not received — "
                "please verify DataReport.")


def _get_alarm_last_date(a):
    d = a.get("date")
    if not d:
        return None
    m = re.search(r"~(\d{4}-\d{2}-\d{2})$", d)
    return m.group(1) if m else d


# ─── Operation Coverage Check ──────────────────────────────

def check_operation_coverage(data):
    ops = data.get("operations", [])
    if not ops:
        return
    dates = [o.get("date") for o in ops if o.get("date")]
    if not dates:
        return
    if len(set(dates)) == 1 and len(ops) >= 2:
        if data.get("overall_status") == "NORMAL":
            data["overall_status"] = "WARNING"


# ─── Operation Date Validation ──────────────────────────────

def validate_operation_dates(data):
    from datetime import datetime
    for op in data.get("operations", []):
        d = op.get("date")
        if not d:
            continue
        try:
            dt = datetime.strptime(d, "%Y-%m-%d")
            op["date"] = dt.strftime("%Y-%m-%d")
        except ValueError:
            op["date"] = None


# ─── Auto-fill Remarks ─────────────────────────────────────

def auto_fill_remarks(data):
    ops = data.get("operations", [])
    alarms = data.get("error_alarms", [])
    tro = data.get("tro_data") or {}
    efficiency = data.get("data_log_efficiency") \
        or tro.get("efficiency")
    op_stats = data.get("op_time_stats", {})
    op_anomalies = data.get("op_time_anomalies", [])
    gps_areas = data.get("gps_areas", [])
    ev_analysis = data.get("event_log_analysis") or {}

    ballast_count = sum(
        1 for o in ops
        if o.get("operation_mode", "").upper() == "BALLAST")
    deballast_count = sum(
        1 for o in ops
        if o.get("operation_mode", "").upper() == "DEBALLAST")

    b_min = tro.get("ballasting_min")
    b_avg = tro.get("ballasting_avg")
    d_max = tro.get("deballasting_max")
    b_safe = b_min if b_min is not None else b_avg
    b_ok = b_safe is not None and 5 <= b_safe <= 10

    # Stable-ratio relaxation (same as recalc_overall_status)
    b_max_val = tro.get("ballasting_max")
    b_ratio_val = tro.get("ballasting_stable_ratio", 0)
    b_count_val = tro.get("ballasting_count", 0)
    if not b_ok and b_max_val is not None \
            and 5 <= b_max_val <= 12:
        if b_count_val >= 10 and b_ratio_val >= 0.5:
            b_ok = True
        elif b_count_val < 10 and b_ratio_val > 0:
            b_ok = True
    d_ok = d_max is not None and d_max < 0.1

    ko = []
    en = []

    # Operation days
    ballast_dates = set(
        o["date"] for o in ops
        if o.get("operation_mode", "").upper() == "BALLAST"
        and o.get("date"))
    deballast_dates = set(
        o["date"] for o in ops
        if o.get("operation_mode", "").upper() == "DEBALLAST"
        and o.get("date"))
    all_dates = ballast_dates | deballast_dates
    op_days = len(all_dates)

    # Zero operations → early return
    if ballast_count == 0 and deballast_count == 0:
        data["no_operation"] = True
        ko.append("[운전 현황] 당월 운전 기록이 없습니다.")
        en.append("[Operations] No ballasting/deballasting "
                  "operations recorded this month.")
        if not alarms:
            ko.append("[알람없음] 이상 알람 없음.")
            en.append("[No Alarms] No abnormal alarms detected.")

        vrcs = sum(
            _parse_repeat(a) for a in alarms
            if a.get("code") == "VRCS_ERR")
        if vrcs > 0:
            ko.append(
                f"[VRCS] 밸브 제어 시스템 알람 {vrcs}건 — "
                f"BWTS 판정과 별개로 별도 조치 필요.")
            en.append(
                f"[VRCS] Valve control system alarms detected "
                f"{vrcs} time(s) — requires separate action, "
                f"excluded from BWTS judgment.")

        ko.append("[종합] 당월 BWTS 운전 이력 없음. 장비 이상 아님.")
        en.append("[Summary] No BWTS operations this month. "
                  "No equipment issues.")

        data["ai_remarks"] = ko
        data["ai_remarks_en"] = en
        data["alarm_summary"] = []
        return

    # TRO detail strings
    if b_min is not None and b_avg is not None:
        b_detail = f"최솟값 {b_min}ppm / 평균 {b_avg}ppm"
        b_detail_en = f"min {b_min}ppm / avg {b_avg}ppm"
    elif b_min is not None:
        b_detail = f"최솟값 {b_min}ppm"
        b_detail_en = f"min {b_min}ppm"
    elif b_avg is not None:
        b_detail = f"평균 {b_avg}ppm"
        b_detail_en = f"avg {b_avg}ppm"
    else:
        b_detail = None
        b_detail_en = None

    b_tro_ko = (
        f"{b_detail}(5~10ppm "
        f"{'충족' if b_ok else '미달' if b_safe < 5 else '초과'})"
        if b_detail else "미수신")
    d_tro_ko = (
        f"{d_max}ppm(IMO 기준 {'충족' if d_ok else '초과'})"
        if d_max is not None else "미수신")
    b_tro_en = (
        f"{b_detail_en}(5~10ppm: "
        f"{'OK' if b_ok else 'low' if b_safe < 5 else 'high'})"
        if b_detail_en else "N/A")
    d_tro_en = (
        f"{d_max}ppm(IMO: "
        f"{'compliant' if d_ok else 'exceeded'})"
        if d_max is not None else "N/A")

    # Volume detail
    vol_ko = ""
    vol_en = ""
    b_st = op_stats.get("BALLAST")
    d_st = op_stats.get("DEBALLAST")
    if b_st or d_st:
        parts_ko = []
        parts_en = []
        if b_st:
            parts_ko.append(
                f"주입 {b_st['total_volume']}m³/"
                f"{b_st['total_runtime']}h")
            parts_en.append(
                f"ballast {b_st['total_volume']}m³/"
                f"{b_st['total_runtime']}h")
        if d_st:
            parts_ko.append(
                f"배출 {d_st['total_volume']}m³/"
                f"{d_st['total_runtime']}h")
            parts_en.append(
                f"deballast {d_st['total_volume']}m³/"
                f"{d_st['total_runtime']}h")
        vol_ko = f" 총 처리량: {', '.join(parts_ko)}."
        vol_en = f" Total: {', '.join(parts_en)}."

    days_ko = (
        f"운용 {op_days}일(발라스팅 {len(ballast_dates)}일 / "
        f"디발라스팅 {len(deballast_dates)}일). "
        if op_days > 0 else "")
    days_en = (
        f"{op_days} day(s) operated (ballast "
        f"{len(ballast_dates)}d / deballast "
        f"{len(deballast_dates)}d). "
        if op_days > 0 else "")

    ko.append(
        f"[운전 현황] {days_ko}주입 {ballast_count}회 / "
        f"배출 {deballast_count}회. "
        f"주입 TRO {b_tro_ko}. 배출 TRO 최댓값 {d_tro_ko}."
        f"{vol_ko}")
    en.append(
        f"[Operations] {days_en}{ballast_count} ballasting / "
        f"{deballast_count} deballasting. "
        f"Ballasting TRO {b_tro_en}. "
        f"Deballasting TRO max {d_tro_en}.{vol_en}")

    # ECU/FMU
    ecu_avg = tro.get("ecu_current_avg")
    fmu_avg = tro.get("fmu_flow_avg")
    anu_st = tro.get("anu_status")
    if ecu_avg is not None or fmu_avg is not None or anu_st:
        parts = []
        if ecu_avg is not None:
            parts.append(f"전류 {ecu_avg}A")
        if fmu_avg is not None:
            parts.append(f"유량 {fmu_avg}m³/h")
        if anu_st:
            parts.append(f"ANU {anu_st}")

        corr = ""
        corr_en = ""
        if ecu_avg and fmu_avg and b_avg is not None:
            if ecu_avg > 500 and fmu_avg > 10 \
                    and (b_avg < 1 or b_avg == 0):
                corr = (" — ⚠️ 전류·유량 정상이나 TRO 미생성: "
                        "전극 열화 또는 TRO 센서 고장 의심")
                corr_en = (" — Warning: Current/flow normal but "
                           "TRO not generated: possible electrode "
                           "degradation or TRO sensor failure")
            elif ecu_avg > 500 and fmu_avg > 10 and b_ok:
                corr = " — 전류·유량·TRO 정상 상관관계 확인"
                corr_en = " — Current/flow/TRO correlation normal"

        eff_ko = ""
        eff_en = ""
        if efficiency:
            if efficiency.get("current_level") == "LOW":
                eff_ko += f" ⚠️ {efficiency['current_detail']}."
                eff_en += f" Warning: {efficiency['current_detail']}."
            sal = efficiency.get("salinity_impact")
            if sal in ("LOW", "ULTRA_LOW"):
                eff_ko += f" ⚠️ {efficiency['salinity_detail']}."
                eff_en += f" Warning: {efficiency['salinity_detail']}."

        ko.append(f"[ECU] {' / '.join(parts)}{corr}.{eff_ko}")
        en.append(f"[ECU] {' / '.join(parts)}{corr_en}.{eff_en}")

    # TRO warning
    if tro.get("_deballasting_warning"):
        ko.append(
            f"[TRO 경고] {tro['_deballasting_warning']}. "
            f"Data Log 원본 확인 권장.")
        en.append(
            f"[TRO Warning] Deballasting TRO {d_max}ppm — "
            f"significantly exceeds IMO limit (0.1ppm). "
            f"Possible sensor cross-contamination or column "
            f"mismatch. Verify raw Data Log.")

    # Alarm category grouping
    alarm_summary = []
    if not alarms:
        ko.append("[알람없음] 이상 알람 없음.")
        en.append("[No Alarms] No abnormal alarms detected.")
    else:
        code_map = {}
        for a in alarms:
            if a.get("code") == "VRCS_ERR":
                continue
            code = a.get("code") or "(코드없음)"
            if code not in code_map:
                code_map[code] = {"trips": 0, "alarms": 0,
                                  "total": 0}
            g = code_map[code]
            cnt = _parse_repeat(a)
            if (a.get("level") or "").lower() == "trip":
                g["trips"] += cnt
            else:
                g["alarms"] += cnt
            g["total"] += cnt

        cat_groups = {}
        for code, g in code_map.items():
            info = ALARM_INFO.get(code)
            cat = info["cat"] if info else "OTHER"
            if cat not in cat_groups:
                cat_groups[cat] = {
                    "trips": 0, "alarms": 0,
                    "codes": [], "actions": [],
                    "actions_en": []}
            cg = cat_groups[cat]
            cg["trips"] += g["trips"]
            cg["alarms"] += g["alarms"]
            label = (f"{info['title']}({code})"
                     if info else code)
            cnt_str = f" ×{g['total']}" if g["total"] > 1 else ""
            cg["codes"].append(f"{label}{cnt_str}")
            cg["actions"].append(
                info["action"] if info
                else "상세 원인 확인 후 제조사 기술지원 요청")
            cg["actions_en"].append(
                info["action_en"] if info
                else "Identify root cause and contact manufacturer")

        for cat, cg in cat_groups.items():
            cat_info = ALARM_CATEGORIES.get(
                cat, ALARM_CATEGORIES["OTHER"])
            parts = []
            parts_en = []
            if cg["trips"]:
                parts.append(f"Trip {cg['trips']}건")
                parts_en.append(f"Trip×{cg['trips']}")
            if cg["alarms"]:
                parts.append(f"Alarm {cg['alarms']}건")
                parts_en.append(f"Alarm×{cg['alarms']}")
            cnt_str = " / ".join(parts)
            cnt_str_en = "+".join(parts_en)

            unique_act = list(dict.fromkeys(cg["actions"]))[:2]
            unique_act_en = list(
                dict.fromkeys(cg["actions_en"]))[:2]

            alarm_summary.append({
                "cat": cat,
                "icon": cat_info["icon"],
                "label": cat_info["label"],
                "label_en": cat_info["label_en"],
                "trips": cg["trips"],
                "alarms": cg["alarms"],
                "codes": cg["codes"],
                "action": " / ".join(unique_act),
                "action_en": " / ".join(unique_act_en),
            })

            ko.append(
                f"{cat_info['icon']} {cat_info['label']} "
                f"({cnt_str}) — {unique_act[0]}")
            en.append(
                f"{cat_info['icon']} {cat_info['label_en']} "
                f"({cnt_str_en}) — {unique_act_en[0]}")

        # Repeated alarms
        repeated = ev_analysis.get("repeated_alarms", [])
        if repeated:
            rep_str = ", ".join(
                f"{r['code']}({r['total']}회)" for r in repeated)
            ko.append(
                f"⚠️ 반복 알람: {rep_str} — 근본 원인 분석(RCA) 필요")
            rep_str_en = ", ".join(
                f"{r['code']}({r['total']}x)" for r in repeated)
            en.append(f"⚠️ Repeated: {rep_str_en} — RCA required")

    data["alarm_summary"] = alarm_summary

    # OpTime anomalies
    if op_anomalies:
        flags = {}
        for a in op_anomalies:
            flags[a["flag"]] = flags.get(a["flag"], 0) + 1
        flag_str = ", ".join(
            f"{f} {c}건" for f, c in flags.items())
        ko.append(f"[운전 이상] {flag_str}.")
        flag_str_en = ", ".join(
            f"{f} {c} case(s)" for f, c in flags.items())
        en.append(f"[Operation Anomalies] {flag_str_en}.")

    # GPS areas
    if gps_areas:
        ko.append(f"[운항 해역] {', '.join(gps_areas)}.")
        en.append(f"[Operating Area] {', '.join(gps_areas)}.")

    # VRCS separate line
    vrcs = sum(
        _parse_repeat(a) for a in alarms
        if a.get("code") == "VRCS_ERR")
    if vrcs > 0:
        ko.append(
            f"[VRCS] 밸브 제어 시스템 알람 {vrcs}건 — "
            f"BWTS 판정과 별개로 별도 조치 필요.")
        en.append(
            f"[VRCS] Valve control system alarms detected "
            f"{vrcs} time(s) — requires separate action, "
            f"excluded from BWTS judgment.")

    # Summary line
    status = (data.get("overall_status") or "NORMAL").upper()
    bwts_alarms = [
        a for a in alarms if a.get("code") != "VRCS_ERR"]
    t_count = sum(
        _parse_repeat(a) for a in bwts_alarms
        if (a.get("level") or "").lower() == "trip")
    a_count = sum(
        _parse_repeat(a) for a in bwts_alarms) - t_count

    issues = []
    issues_en = []
    if t_count > 0:
        issues.append(f"Trip {t_count}건 발생")
        issues_en.append(f"{t_count} trip(s)")
    if not b_ok and b_safe is not None:
        issues.append(
            f"주입 TRO {'미달' if b_safe < 5 else '초과'}")
        issues_en.append(
            f"ballasting TRO {'low' if b_safe < 5 else 'high'}")
    if not d_ok and d_max is not None:
        issues.append("배출 TRO 기준 초과")
        issues_en.append("deballasting TRO exceeded")
    if tro.get("_deballasting_warning"):
        issues.append("배출 TRO 이상값 확인 필요")
        issues_en.append("deballasting TRO anomaly detected")

    if status == "CRITICAL":
        extra = ("알람 다발 — 정비 이력 확인 권장."
                 if a_count > 5 else "")
        ko.append(
            f"[종합] {', '.join(issues)}. "
            f"즉각적인 장비 점검 및 원인 분석이 필요합니다. {extra}")
        en.append(
            f"[Summary] {', '.join(issues_en)}. "
            f"Immediate equipment inspection and root cause "
            f"analysis required. "
            f"{'Multiple alarms — review maintenance history.' if a_count > 5 else ''}")
    elif status == "WARNING":
        prefix = (f"{', '.join(issues)}. " if issues else "")
        ko.append(
            f"[종합] {prefix}주의 필요 — "
            f"알람 내역 및 TRO 수치를 모니터링하시기 바랍니다.")
        prefix_en = (
            f"{', '.join(issues_en)}. " if issues_en else "")
        en.append(
            f"[Summary] {prefix_en}Attention required — "
            f"monitor alarm records and TRO values.")
    else:
        ko.append("[종합] 전반적으로 정상 운전 중. 특이사항 없음.")
        en.append(
            "[Summary] Overall normal operation. "
            "No significant issues detected.")

    data["ai_remarks"] = ko
    data["ai_remarks_en"] = en


# ─── Zero Operations Override ──────────────────────────────

def check_zero_operations(data):
    ops = data.get("operations", [])
    alarms = data.get("error_alarms", [])
    if ops:
        return

    note = "[운전 현황] 당월 운전 기록이 없습니다."
    note_en = ("[Operations] No ballasting/deballasting "
               "operations recorded this month.")

    if alarms:
        existing = data.get("ai_remarks", [])
        alarm_lines = [
            r for r in existing
            if re.match(
                r"^\[CODE|^\[VRCS|^\[LOG_OVERFLOW|^\[알람",
                r, re.I)]
        fallback_lines = [
            r for r in existing
            if re.search(r"알람|alarm|Trip|trip", r, re.I)
            and not re.search(
                r"TRO 미수신|TRO.*미수신|not received", r, re.I)]
        data["ai_remarks"] = [
            note] + (alarm_lines or fallback_lines)

        existing_en = data.get("ai_remarks_en", [])
        alarm_en = [
            r for r in existing_en
            if re.match(
                r"^\[CODE|^\[VRCS|^\[LOG_OVERFLOW|"
                r"^\[No Alarm|^\[Alarm", r, re.I)]
        fallback_en = [
            r for r in existing_en
            if re.search(r"alarm|Trip", r, re.I)
            and not re.search(
                r"TRO.*not received|not received.*TRO", r, re.I)]
        data["ai_remarks_en"] = [
            note_en] + (alarm_en or fallback_en)
    else:
        data["ai_remarks"] = [
            note, "[알람없음] 이상 알람 없음."]
        data["ai_remarks_en"] = [
            note_en,
            "[No Alarms] No abnormal alarms detected."]


# ─── Main Pipeline ──────────────────────────────────────────

def validate_and_normalize(data):
    """Run full analysis pipeline on parsed CSV data."""
    if not data or not isinstance(data, dict):
        return {}

    s = (data.get("overall_status") or "").upper()
    if s not in ("NORMAL", "WARNING", "CRITICAL"):
        data["overall_status"] = None

    data.setdefault("error_alarms", [])
    data.setdefault("operations", [])
    data.setdefault("ai_remarks", [])
    data.setdefault("ai_remarks_en", [])

    # Pipeline steps (same order as JS)
    validate_operation_dates(data)
    sanitize_tro_values(data)
    data["error_alarms"] = normalize_alarm_levels(
        data["error_alarms"])
    data["error_alarms"] = group_repeat_alarms(
        data["error_alarms"])
    append_valve_warning(data)
    recalc_overall_status(data)
    check_operation_coverage(data)
    auto_fill_remarks(data)
    check_zero_operations(data)

    return data
