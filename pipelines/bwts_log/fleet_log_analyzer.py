# fleet_log_analyzer.py — DataLog/EventLog deep analysis
# Session-based TRO analysis, valve chattering, sensor correlation
import re
import csv
from datetime import datetime, timedelta
from pathlib import Path
from csv_parser import read_csv_rows, safe_float, avg, arr_max, arr_min


# ─── DataLog Row Parsing ───────────────────────────────────

from thresholds import BL

def _parse_datalog_rows(filepath):
    """Parse DataLog CSV into list of row dicts with timestamps."""
    rows = read_csv_rows(filepath)
    if len(rows) < 2:
        return []

    # Find header
    header_idx = 0
    for i in range(min(len(rows), 20)):
        upper = " ".join((c or "").upper() for c in rows[i])
        if ("INDEX" in upper and "TIME" in upper) or \
                ("OPERATION" in upper and "TRO" in upper):
            header_idx = i
            break

    header = [(h or "").upper().strip() for h in rows[header_idx]]

    def col(name):
        for i, h in enumerate(header):
            if name in h:
                return i
        return -1

    idx_time = col("TIME")
    idx_op = col("OPERATION")
    idx_volt = col("VOLTAGE")
    idx_cur = col("CURRENT")
    idx_fmu = -1
    for i, h in enumerate(header):
        if re.match(r"^FMU\d*$", h):
            idx_fmu = i
            break
    idx_csu = col("CSU")
    idx_fts = col("FTS")

    # TRO columns — Format A: TRO_B1/D1, Format B: TSU1_BP1/BP3
    tro_b_cols = [i for i, h in enumerate(header)
                  if re.search(r"TRO[_-]?B\d*", h)]
    tro_d_cols = [i for i, h in enumerate(header)
                  if re.search(r"TRO[_-]?[DS]\d*", h)]

    # Format B: TSU1_BP1 = Ballast TRO, TSU1_BP3 = Deballast TRO
    if not tro_b_cols and not tro_d_cols:
        for i, h in enumerate(header):
            if re.search(r"TSU\d*_BP1$", h):
                tro_b_cols.append(i)
            elif re.search(r"TSU\d*_BP3$", h):
                tro_d_cols.append(i)

    # Format C: NIU columns (KSZ)
    if not tro_b_cols and not tro_d_cols:
        for i, h in enumerate(header):
            if "NIU" in h and "QUANTITY" in h:
                tro_b_cols.append(i)

    # Fallback: single TRO column
    if not tro_b_cols and not tro_d_cols:
        for i, h in enumerate(header):
            if h in ("TRO", "T1"):
                tro_b_cols = [i]
            elif h in ("TRO2", "T2"):
                tro_d_cols = [i]

    # Detect Format B (TSU-based, shared sensor)
    is_format_b = any(
        re.search(r"TSU\d*_BP", h) for h in header)

    # BV (bypass valve)
    idx_bv = col("BV")
    if idx_bv < 0:
        idx_bv = col("TE02V")
    idx_pump1 = col("PUMP1")
    if idx_pump1 < 0:
        idx_pump1 = col("BP1")
    idx_pump2 = col("PUMP2")
    if idx_pump2 < 0:
        idx_pump2 = col("BP2")

    def get(row, idx):
        if idx < 0 or idx >= len(row):
            return None
        return row[idx]

    def parse_time(s):
        if not s:
            return None
        s = s.strip()
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M",
                     "%Y-%m-%d %H:%M:%S.%f"):
            try:
                return datetime.strptime(s, fmt)
            except ValueError:
                continue
        # Handle non-zero-padded: 2026-6-1 0:31:10
        m = re.match(
            r"(\d{4})-(\d{1,2})-(\d{1,2})\s+"
            r"(\d{1,2}):(\d{1,2}):?(\d{1,2})?", s)
        if m:
            parts = [int(x or 0) for x in m.groups()]
            try:
                return datetime(*parts)
            except ValueError:
                pass
        return None

    def normalize_mode(op_str):
        if not op_str:
            return None
        u = op_str.strip().upper()
        if u in ("BALLAST", "N-B") or re.match(r"^\d+-?B$", u):
            return "BALLAST"
        if u in ("DEBALLAST", "N-D") or re.match(r"^\d+-?D$", u):
            return "DEBALLAST"
        if u.startswith("STRIPP") or u == "N-S" \
                or re.match(r"^\d+-?S$", u):
            return "STRIPPING"
        return None

    # Space-separated CSV fix now handled by read_csv_rows

    parsed = []
    for i in range(header_idx + 1, len(rows)):
        row = rows[i]
        if len(row) < 4:
            continue
        # Skip repeated headers
        first = (row[0] or "").upper().strip()
        if first in ("INDEX", "OPERATION"):
            continue
        if re.match(r"^(ECS |SHIP |TOTAL TIME|MAKE DATE)", first):
            continue

        op_raw = get(row, idx_op)
        mode = normalize_mode(op_raw)
        if not mode:
            continue

        ts = parse_time(get(row, idx_time))

        # TRO values
        tro_b = max(
            (safe_float(get(row, c)) or 0.0 for c in tro_b_cols),
            default=0.0)
        tro_d = max(
            (safe_float(get(row, c)) or 0.0 for c in tro_d_cols),
            default=0.0)

        parsed.append({
            "time": ts,
            "date": ts.strftime("%Y-%m-%d") if ts else None,
            "mode": mode,
            "voltage": safe_float(get(row, idx_volt)),
            "current": safe_float(get(row, idx_cur)),
            "fmu": safe_float(get(row, idx_fmu)),
            "csu": safe_float(get(row, idx_csu)),
            "fts": safe_float(get(row, idx_fts)),
            "tro_b": tro_b,
            "tro_d": tro_d,
            "bv": safe_float(get(row, idx_bv)),
            "pump1": safe_float(get(row, idx_pump1)),
            "pump2": safe_float(get(row, idx_pump2)),
        })

    return parsed


# ─── Session Splitting ─────────────────────────────────────

def split_sessions(datalog_rows, gap_minutes=None):
    if gap_minutes is None:
        gap_minutes = BL["session_gap_minutes"]
    """Split DataLog rows into operation sessions."""
    if not datalog_rows:
        return []

    sessions = []
    current = None

    for row in datalog_rows:
        ts = row["time"]
        mode = row["mode"]

        start_new = False
        if current is None:
            start_new = True
        elif mode != current["mode"]:
            start_new = True
        elif ts and current["end_time"]:
            gap = (ts - current["end_time"]).total_seconds()
            if gap > gap_minutes * 60:
                start_new = True

        if start_new:
            if current and current["rows"]:
                sessions.append(current)
            current = {
                "session_id": len(sessions),
                "mode": mode,
                "date": row["date"],
                "start_time": ts,
                "end_time": ts,
                "rows": [],
            }

        current["rows"].append(row)
        if ts:
            current["end_time"] = ts

    if current and current["rows"]:
        sessions.append(current)

    # Compute duration
    for s in sessions:
        if s["start_time"] and s["end_time"]:
            s["duration_min"] = round(
                (s["end_time"] - s["start_time"])
                .total_seconds() / 60, 1)
        else:
            s["duration_min"] = len(s["rows"])  # ~1 row/min

    return sessions


# ─── TRO Session Analysis ──────────────────────────────────

def analyze_tro_session(session, has_tro_sensor_global=True):
    """
    Analyze TRO within a session, accounting for warm-up.
    has_tro_sensor_global: determined from entire DataLog,
    not per-session.
    """
    mode = session["mode"]
    rows = session["rows"]

    if mode == "BALLAST":
        all_tro = [r["tro_b"] for r in rows]
    elif mode in ("DEBALLAST", "STRIPPING"):
        all_tro = [r["tro_d"] for r in rows]
        # Format B: tro_d (TSU_BP3) is always 0,
        # actual D-TRO is in tro_b (TSU_BP1)
        if not any(v > 0 for v in all_tro):
            fallback = [r["tro_b"] for r in rows]
            if any(v > 0 for v in fallback):
                all_tro = fallback
    else:
        return None

    has_tro_this_session = any(v > 0 for v in all_tro)

    if not has_tro_sensor_global:
        # No TRO sensor — judge by current/flow instead
        currents = [r["current"] for r in rows
                    if r["current"] and r["current"] > 0]
        flows = [r["fmu"] for r in rows
                 if r["fmu"] and r["fmu"] > 0]
        cur_avg = avg(currents) if currents else None
        flow_avg = avg(flows) if flows else None
        return {
            "mode": mode,
            "total_rows": len(rows),
            "tro_appeared": False,
            "no_tro_sensor": True,
            "warmup_rows": 0,
            "stable_rows": 0,
            "warmup_tro": [],
            "stable_tro": [],
            "stable_avg": None,
            "stable_min": None,
            "stable_max": None,
            "in_range": None,
            "tro_appeared_at_min": None,
            "current_avg": cur_avg,
            "flow_avg": flow_avg,
            "issue": None,
        }

    # Find when TRO first appears (> 0.1 for ballast)
    threshold = BL["tro_appear_threshold_ppm"] if mode == "BALLAST" else 0.0
    first_appear_idx = None
    for i, v in enumerate(all_tro):
        if v > threshold:
            first_appear_idx = i
            break

    if first_appear_idx is None:
        # TRO sensor exists globally but didn't produce
        # reading in this session (short run or warm-up only)
        return {
            "mode": mode,
            "total_rows": len(rows),
            "tro_appeared": False,
            "no_tro_sensor": not has_tro_sensor_global,
            "warmup_rows": len(all_tro),
            "stable_rows": 0,
            "warmup_tro": all_tro[:10],
            "stable_tro": [],
            "stable_avg": None,
            "stable_min": None,
            "stable_max": None,
            "in_range": None,
            "tro_appeared_at_min": None,
            "issue": "TRO 미생성" if mode == "BALLAST"
                     else None,
        }

    # Warm-up = first 5 rows after TRO appears
    warmup_end = min(first_appear_idx + BL["warmup_rows"], len(all_tro))
    warmup = all_tro[first_appear_idx:warmup_end]
    stable = all_tro[warmup_end:]

    # Deballast: also skip first 5 rows as warm-up
    if mode in ("DEBALLAST", "STRIPPING"):
        warmup = all_tro[:BL["warmup_rows"]]
        stable = all_tro[5:]

    # Filter out zeros in stable (sensor noise)
    stable_nonzero = [v for v in stable if v > 0] \
        if mode == "BALLAST" else stable

    s_avg = avg(stable_nonzero) if stable_nonzero else None
    s_min = arr_min(stable_nonzero) if stable_nonzero else None
    s_max = arr_max(stable_nonzero) if stable_nonzero else None

    if mode == "BALLAST":
        in_range = (s_min is not None and BL["tro_ballast_min_ppm"] <= s_min <= BL["tro_ballast_max_ppm"]) \
            if s_min is not None else None
        # Stable-ratio relaxation: if max in 5~12 and
        # >=50% of stable readings in 5~10, treat as OK.
        # Short sessions (<10 rows): 1+ in range → OK.
        if not in_range and s_max is not None \
                and BL["tro_ballast_min_ppm"] <= s_max <= BL["tro_ballast_relaxed_max_ppm"] and stable_nonzero:
            in_range_count = sum(
                1 for v in stable_nonzero if BL["tro_ballast_min_ppm"] <= v <= BL["tro_ballast_max_ppm"])
            ratio = in_range_count / len(stable_nonzero)
            if len(stable_nonzero) >= BL["tro_ballast_relaxed_min_rows"] and ratio >= BL["tro_ballast_relaxed_ratio"]:
                in_range = True
            elif len(stable_nonzero) < 10 and in_range_count > 0:
                in_range = True
    else:
        in_range = (s_max is not None and s_max < BL["tro_deballast_max_ppm"]) \
            if s_max is not None else None

    # Detect issue
    issue = None
    if mode == "BALLAST" and s_min is not None:
        if s_min < BL["tro_ballast_min_ppm"] and not in_range:
            issue = f"TRO 최솟값 {s_min}ppm ({BL['tro_ballast_min_ppm']}ppm 미달)"
        elif s_min > BL["tro_ballast_max_ppm"]:
            issue = f"TRO 최솟값 {s_min}ppm ({BL['tro_ballast_max_ppm']}ppm 초과)"
    elif mode == "DEBALLAST" and s_max is not None:
        if s_max > BL["tro_deballast_max_ppm"]:
            issue = f"D-TRO 최댓값 {s_max}ppm ({BL['tro_deballast_max_ppm']}ppm 초과)"

    return {
        "mode": mode,
        "total_rows": len(rows),
        "tro_appeared": True,
        "warmup_rows": len(warmup),
        "stable_rows": len(stable_nonzero),
        "warmup_tro": warmup,
        "stable_tro": stable_nonzero[:20],  # sample
        "stable_avg": s_avg,
        "stable_min": s_min,
        "stable_max": s_max,
        "in_range": in_range,
        "tro_appeared_at_min": first_appear_idx,
        "issue": issue,
    }


# ─── Recovery Pattern Detection ────────────────────────────

def detect_recovery_pattern(sessions):
    """
    Detect mid-month recovery pattern.
    Returns: "stable_ok", "stable_bad", "recovery",
             "degradation", "insufficient"
    """
    ballast_sessions = [
        s for s in sessions
        if s["mode"] == "BALLAST" and s.get("tro_analysis")
        and s["tro_analysis"]["tro_appeared"]
    ]

    if len(ballast_sessions) < 2:
        return {
            "pattern": "insufficient",
            "detail": "Ballast 세션 부족 (2회 미만)",
        }

    # Split by date (first half vs second half of month)
    dates = sorted(set(s["date"] for s in ballast_sessions))
    if not dates:
        return {"pattern": "insufficient", "detail": "날짜 없음"}

    mid_day = BL["recovery_split_day"]
    early = [s for s in ballast_sessions
             if s["date"] and int(s["date"].split("-")[2]) <= mid_day]
    late = [s for s in ballast_sessions
            if s["date"] and int(s["date"].split("-")[2]) > mid_day]

    def sessions_ok(sess_list):
        if not sess_list:
            return None
        return all(
            s["tro_analysis"]["in_range"]
            for s in sess_list
            if s["tro_analysis"]["in_range"] is not None
        )

    early_ok = sessions_ok(early)
    late_ok = sessions_ok(late)

    if early_ok is None and late_ok is None:
        return {"pattern": "insufficient", "detail": "TRO 데이터 없음"}

    if early_ok is None:
        return {
            "pattern": "late_only",
            "detail": f"후반만 운전 — "
                      f"{'정상' if late_ok else '이상'}",
        }
    if late_ok is None:
        return {
            "pattern": "early_only",
            "detail": f"전반만 운전 — "
                      f"{'정상' if early_ok else '이상'}",
        }

    if not early_ok and late_ok:
        recovery_date = late[0]["date"] if late else "불명"
        return {
            "pattern": "recovery",
            "detail": f"월 전반 TRO 이상 -> "
                      f"{recovery_date} 이후 정상화",
            "recovery_date": recovery_date,
        }
    if early_ok and not late_ok:
        degrade_date = late[0]["date"] if late else "불명"
        return {
            "pattern": "degradation",
            "detail": f"월 전반 정상 -> "
                      f"{degrade_date} 이후 악화",
            "degrade_date": degrade_date,
        }
    if early_ok and late_ok:
        return {"pattern": "stable_ok", "detail": "월 전체 정상"}
    return {"pattern": "stable_bad", "detail": "월 전체 이상"}


# ─── Valve Chattering Detection ────────────────────────────

def detect_valve_chattering(eventlog_path):
    """
    Detect valve chattering from EventLog CSV.

    Chattering = same valve rapidly toggling Open/Close
    in very short intervals (< 30 seconds between events).

    Normal operation: valve opens, stays open minutes~hours,
    then closes. This is NOT chattering even if many events.

    Real chattering: Open-Close-Open-Close every 2-5 seconds.
    We detect "rapid bursts" — sequences where consecutive
    events on the same valve are < 30 sec apart, and the
    burst has >= 6 events (3 open-close cycles).
    """
    rows = read_csv_rows(eventlog_path)
    if len(rows) < 2:
        return []

    # Find header
    header_idx = 0
    for i in range(min(len(rows), 20)):
        upper = " ".join((c or "").upper() for c in rows[i])
        if "DATE" in upper and ("LEVEL" in upper
                                 or "DESCRIPTION" in upper):
            header_idx = i
            break

    header = [(h or "").upper().strip() for h in rows[header_idx]]
    date_idx = next(
        (i for i, h in enumerate(header) if "DATE" in h), 0)
    desc_idx = next(
        (i for i, h in enumerate(header)
         if "DESC" in h or "DETAIL" in h), 3)

    def parse_ev_time(s):
        if not s:
            return None
        s = s.strip()
        m = re.match(
            r"(\d{4})-(\d{1,2})-(\d{1,2})\s+"
            r"(\d{1,2}):(\d{1,2}):?(\d{1,2})?", s)
        if m:
            parts = [int(x or 0) for x in m.groups()]
            try:
                return datetime(*parts)
            except ValueError:
                pass
        return None

    # Collect valve events
    valve_events = {}
    for i in range(header_idx + 1, len(rows)):
        row = rows[i]
        if len(row) <= desc_idx:
            continue
        if (row[0] or "").upper().strip() == "DATE":
            continue

        desc = row[desc_idx] if desc_idx < len(row) else ""
        match = re.search(
            r"Valve\s+(Opened|Closed)\.\[([^\],]+)",
            desc, re.I)
        if not match:
            continue

        action = match.group(1)
        valve = match.group(2).strip()
        ts = parse_ev_time(row[date_idx] if date_idx < len(row)
                           else None)
        if ts:
            valve_events.setdefault(valve, []).append(
                {"time": ts, "action": action})

    # Detect rapid bursts per valve
    RAPID_GAP_SEC = BL["chatter_interval_sec"]
    MIN_BURST_EVENTS = BL["chatter_min_burst_events"]

    chattering = []
    for valve, events in valve_events.items():
        events.sort(key=lambda e: e["time"])
        total = len(events)

        # Find rapid bursts: consecutive events < RAPID_GAP_SEC
        bursts = []
        current_burst = [events[0]] if events else []

        for j in range(1, len(events)):
            gap = (events[j]["time"]
                   - events[j - 1]["time"]).total_seconds()
            if 0 <= gap <= RAPID_GAP_SEC:
                current_burst.append(events[j])
            else:
                if len(current_burst) >= MIN_BURST_EVENTS:
                    bursts.append(current_burst)
                current_burst = [events[j]]

        if len(current_burst) >= MIN_BURST_EVENTS:
            bursts.append(current_burst)

        if not bursts:
            continue

        # Summarize chattering for this valve
        total_chatter_events = sum(len(b) for b in bursts)
        worst_burst = max(bursts, key=len)
        worst_start = worst_burst[0]["time"]
        worst_end = worst_burst[-1]["time"]
        worst_dur = (worst_end - worst_start).total_seconds()

        chattering.append({
            "valve": valve,
            "total_events": total,
            "chatter_events": total_chatter_events,
            "burst_count": len(bursts),
            "worst_burst_size": len(worst_burst),
            "worst_burst_start": worst_start.strftime(
                "%m/%d %H:%M:%S"),
            "worst_burst_end": worst_end.strftime("%H:%M:%S"),
            "worst_burst_duration_sec": round(worst_dur),
            "avg_interval_sec": round(
                worst_dur / max(len(worst_burst) - 1, 1), 1),
            "severity": (
                "심각" if total_chatter_events >= 100
                else "주의" if total_chatter_events >= 20
                else "경미"),
        })

    chattering.sort(key=lambda c: c["chatter_events"],
                    reverse=True)
    return chattering


# ─── Sensor Correlation Analysis ───────────────────────────

def analyze_sensor_correlation(session):
    """
    Check if current flows but TRO doesn't appear.
    Only for BALLAST sessions.
    """
    if session["mode"] != "BALLAST":
        return None

    rows = session["rows"]
    high_current = [r for r in rows
                    if r["current"] and r["current"] > 500]
    if len(high_current) < 5:
        return None

    zero_tro = [r for r in high_current if r["tro_b"] < 0.1]
    ratio = len(zero_tro) / len(high_current)

    if ratio > 0.7:
        return {
            "issue": "전극 열화 의심",
            "detail": (f"전류 정상({len(high_current)}행) 중 "
                       f"TRO 미생성 {len(zero_tro)}행 "
                       f"({ratio:.0%})"),
        }
    elif ratio > 0.3:
        return {
            "issue": "TRO 생성 불안정",
            "detail": (f"전류 정상 중 TRO 미생성 "
                       f"{ratio:.0%}"),
        }
    return None


# ─── Main Analysis Entry Point ─────────────────────────────

def analyze_datalog_deep(datalog_path, eventlog_path=None):
    """
    Deep analysis of DataLog + EventLog.
    Returns comprehensive analysis dict.
    """
    result = {
        "sessions": [],
        "session_summaries": [],
        "recovery_pattern": None,
        "chattering": [],
        "sensor_issues": [],
        "overall_tro_b": {
            "stable_avg": None, "stable_min": None,
        },
        "overall_tro_d": {"stable_max": None},
    }

    if not datalog_path or not Path(datalog_path).exists():
        return result

    # Parse and split into sessions
    dl_rows = _parse_datalog_rows(datalog_path)
    result["row_count"] = len(dl_rows)     # 0 = header-only file (idle month, not a parse failure)
    sessions = split_sessions(dl_rows)

    # Determine TRO sensor presence from ALL rows (not per-session)
    all_tro_b = [r["tro_b"] for r in dl_rows]
    all_tro_d = [r["tro_d"] for r in dl_rows]
    has_tro_sensor = any(v > 0 for v in all_tro_b) or \
        any(v > 0 for v in all_tro_d)
    result["has_tro_sensor"] = has_tro_sensor

    # Detect Format B from raw CSV header (TSU columns = shared sensor)
    raw_rows = read_csv_rows(datalog_path)
    is_format_b = False
    for r in raw_rows[:20]:
        line = " ".join(r).upper()
        if "TSU" in line and "BP" in line:
            is_format_b = True
            break
    result["is_format_b"] = is_format_b
    result["overall_tro_d"] = {"stable_max": None, "stable_avg": None}

    # Analyze each session
    all_b_stable = []
    all_d_values = []

    for s in sessions:
        tro = analyze_tro_session(s, has_tro_sensor)
        s["tro_analysis"] = tro

        sensor = analyze_sensor_correlation(s)
        if sensor:
            result["sensor_issues"].append({
                **sensor,
                "session_id": s["session_id"],
                "date": s["date"],
            })

        # Collect for overall stats
        if tro and tro["tro_appeared"]:
            if s["mode"] == "BALLAST" and tro["stable_tro"]:
                all_b_stable.extend(tro["stable_tro"])
            elif s["mode"] in ("DEBALLAST", "STRIPPING") \
                    and tro["stable_tro"]:
                all_d_values.extend(tro["stable_tro"])

        # Session summary (for dashboard display)
        result["session_summaries"].append({
            "id": s["session_id"],
            "date": s["date"],
            "mode": s["mode"],
            "duration_min": s["duration_min"],
            "rows": len(s["rows"]),
            "tro_appeared": tro["tro_appeared"] if tro else False,
            "no_tro_sensor": tro.get("no_tro_sensor", False)
                if tro else False,
            "warmup_min": tro["tro_appeared_at_min"] if tro else None,
            "stable_avg": tro["stable_avg"] if tro else None,
            "stable_min": tro["stable_min"] if tro else None,
            "stable_max": tro["stable_max"] if tro else None,
            "in_range": tro["in_range"] if tro else None,
            "current_avg": tro.get("current_avg") if tro else None,
            "flow_avg": tro.get("flow_avg") if tro else None,
            "issue": tro["issue"] if tro else None,
        })

    result["sessions"] = sessions

    # Overall TRO stats (stable only)
    if all_b_stable:
        result["overall_tro_b"]["stable_avg"] = avg(all_b_stable)
        result["overall_tro_b"]["stable_min"] = arr_min(
            all_b_stable)
    if all_d_values:
        result["overall_tro_d"]["stable_max"] = arr_max(
            all_d_values)
        result["overall_tro_d"]["stable_avg"] = avg(
            all_d_values)

    # Recovery pattern
    result["recovery_pattern"] = detect_recovery_pattern(sessions)

    # Valve chattering
    if eventlog_path and Path(eventlog_path).exists():
        result["chattering"] = detect_valve_chattering(
            eventlog_path)

    return result
