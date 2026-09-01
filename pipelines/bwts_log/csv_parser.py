# csv_parser.py — BWTS CSV 3-file parser
# Ported from csvService.js
import re
import csv
import math
from pathlib import Path
from dataclasses import dataclass, field
from alarm_info import ALARM_INFO

# Bump when parsing logic changes — run.py folds this into ANALYZER_VERSION so
# every cached month is re-parsed instead of silently keeping old results.
# 2026-09-01b: "<=7 columns => space-separated" guess replaced by a
#   "date time <token> inside one cell" test (335 comma OpTime/EventLog files
#   were being split on spaces → ops/alarms/chattering undercounted);
#   space-separated header keeps START/END/RUNNING TIME as one token.
# 2026-09-01c: vessel folder match code/name first (number prefix picked another
#   ship in 2024 folders); Alfa Laval reads every export in the folder with a
#   month filter, flow>0 rows = operating evidence, heartbeat rule; PDF-only
#   months converted in place; header-only OpTime/DataLog = idle, not a miss.
# 2026-09-01d: PDF TOC page offset verified against page text (OpTime rows were
#   lost), multi-section PDF treated as TotalLog regardless of file name,
#   quarantined *.bad.csv / _oldbug_*.bak never read as input.
# 2026-09-01e: DataLog rows sorted by time before session analysis —
#   Format-B files are exported newest-first (35 of 100 months in 2026).
# 2026-09-01f: session TRO judged on the steady-period AVERAGE after a 10-minute
#   time-based warm-up (operator rule), not on the minimum after 5 rows.
# 2026-09-01g: valve chattering no longer changes the grade — it is a flag
#   shown on the cell (thresholds.json chatter_affects_grade=false).
PARSER_VERSION = "parser-2026-09-01g"


# ─── Helpers ────────────────────────────────────────────────

def safe_float(val):
    """Parse float, return None for '-', empty, or invalid."""
    if val is None:
        return None
    s = str(val).strip()
    if s in ("", "-"):
        return None
    try:
        return float(s)
    except (ValueError, TypeError):
        return None


def avg(arr):
    return round(sum(arr) / len(arr), 2) if arr else None


def arr_max(arr):
    return round(max(arr), 2) if arr else None


def arr_min(arr):
    return round(min(arr), 2) if arr else None


def stats(arr):
    return {
        "avg": avg(arr), "max": arr_max(arr),
        "min": arr_min(arr), "count": len(arr),
    }


def parse_runtime(s):
    """Parse "H:MM" or "H:MM:SS" → decimal hours."""
    if not s:
        return None
    s = str(s).strip()
    m = re.match(r"^(\d+):(\d{1,2})(?::(\d{1,2}))?$", s)
    if m:
        h = int(m.group(1))
        mn = int(m.group(2))
        sec = int(m.group(3)) if m.group(3) else 0
        return round(h + mn / 60 + sec / 3600, 2)
    try:
        return round(float(s), 2)
    except ValueError:
        return None


def normalize_mode(raw):
    """Normalize operation mode string."""
    if not raw:
        return None
    u = raw.strip().upper()
    if re.match(r"^BALLAST(ING)?$", u) or u == "N-B" \
            or re.match(r"^\d+-?B$", u):
        return "BALLAST"
    if re.match(r"^DEBALLAST(ING)?$", u) or u == "N-D" \
            or re.match(r"^\d+-?D$", u):
        return "DEBALLAST"
    if u.startswith("STRIPP") or u == "N-S" \
            or re.match(r"^\d+-?S$", u):
        return "STRIPPING"
    if u == "STOP":
        return "STOP"
    return u or None


# ─── GPS Parsing ────────────────────────────────────────────

def parse_gps_coordinate(raw):
    """Parse "[deg, min, dir][deg, min, dir]" → (lat, lon)."""
    if not raw:
        return None
    blocks = re.findall(r"\[([^\]]+)\]", raw)
    if len(blocks) < 2:
        return None

    def _parse_block(block):
        parts = [p.strip() for p in block.split(",")]
        direction = parts[-1].upper()
        if direction not in ("N", "S", "E", "W"):
            return None
        nums = []
        for p in parts[:-1]:
            try:
                nums.append(float(p))
            except ValueError:
                return None
        if len(nums) == 2:
            dec = nums[0] + nums[1] / 60
        elif len(nums) == 3:
            dec = nums[0] + nums[1] / 60 + nums[2] / 3600
        else:
            return None
        if direction in ("S", "W"):
            dec = -dec
        return round(dec, 4)

    lat = _parse_block(blocks[0])
    lon = _parse_block(blocks[1])
    if lat is None or lon is None:
        return None
    return (lat, lon)


def classify_sea_area(lat, lon):
    if 25 <= lat <= 45 and 115 <= lon <= 145:
        return "동아시아"
    if -10 <= lat <= 25 and 95 <= lon <= 140:
        return "동남아시아"
    if -40 <= lat <= 25 and 30 <= lon <= 100:
        return "인도양/중동"
    if lon < -100 or lon > 140 or abs(lon) > 140:
        return "태평양"
    return "기타"


# ─── CSV Reader ─────────────────────────────────────────────

def _fix_space_separated_rows(rows):
    """Fix space-separated CSV with GPS commas mangling columns.

    When a CSV uses spaces (not commas/tabs) as delimiters but GPS
    fields contain commas like [29, 51.05, N],[122, 49.49, E],
    csv.reader splits on those commas → column misalignment.
    Detect and re-split by spaces, merging date+time and GPS parts.
    """
    if not rows or len(rows) < 2:
        return rows
    sample = [len(r) for r in rows[:3]]
    if not all(c <= 7 for c in sample):
        return rows
    # Column count alone is not enough: a well-formed OpTime CSV whose GPS
    # cell is quoted has exactly 7 columns too (KPS 2024-05..10 were split
    # on spaces here and parsed to zero operations). A space-separated file
    # shows "date time <more tokens>" inside one cell; a comma CSV never does.
    _dt_run = re.compile(
        r"\d{4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{1,2}(?::\d{1,2})?\s+\S")
    def _looks_space_separated(r):
        for c in r:
            c2 = re.sub(r"\[[^\]]*\]", "", str(c))
            if _dt_run.search(c2):
                return True
        return False
    if not any(_looks_space_separated(r) for r in rows[1:6]):
        return rows

    fixed = []
    for r in rows:
        # Rejoin comma-mangled rows
        if len(r) > 1:
            joined = ",".join(r)
            r = [joined]

        if len(r) == 1:
            line = r[0]
            # Replace commas inside [...] with pipe
            line = re.sub(
                r'\[([^\]]*)\]',
                lambda m: "[" + m.group(1).replace(
                    ",", "|") + "]",
                line)
            # Header: keep two-word column names as one token so
            # detect_columns can still see "START TIME" / "END TIME".
            # Without this the space-split header had 12 tokens for 7
            # fields and start/end times mapped to nothing.
            if "OPERATION" in line.upper() and "TIME" in line.upper()                     and not re.search(r"\d{4}-\d{1,2}-\d{1,2}", line):
                line = re.sub(r"(?i)(START|END|RUNNING)\s+TIME",
                              lambda m: m.group(1) + "\x00TIME", line)
            parts = [p.replace("\x00", " ") for p in line.split()]
            merged = []
            i_p = 0
            while i_p < len(parts):
                p = parts[i_p]
                # Merge date + time
                if re.match(r"\d{4}-\d{1,2}-\d{1,2}$", p) \
                        and i_p + 1 < len(parts) \
                        and re.match(r"\d{1,2}:\d{1,2}",
                                     parts[i_p + 1]):
                    merged.append(f"{p} {parts[i_p + 1]}")
                    i_p += 2
                # Merge adjacent bracket parts into GPS
                elif p.startswith("[") and not p.endswith("]"):
                    gps_parts = [p]
                    i_p += 1
                    while i_p < len(parts):
                        gps_parts.append(parts[i_p])
                        if parts[i_p].endswith("]"):
                            i_p += 1
                            break
                        i_p += 1
                    merged.append(" ".join(gps_parts))
                else:
                    merged.append(p)
                    i_p += 1
            # Restore pipes to commas in GPS cells
            merged = [
                c.replace("|", ",")
                if "[" in c else c
                for c in merged]
            fixed.append(merged)
        else:
            fixed.append(r)
    return fixed


def read_csv_rows(filepath):
    """Read CSV file → list of lists."""
    path = Path(filepath)
    if not path.exists():
        return []
    # Try UTF-8 first, fallback to cp949 (Korean)
    for enc in ("utf-8-sig", "utf-8", "cp949", "euc-kr"):
        try:
            with open(path, "r", encoding=enc) as f:
                rows = list(csv.reader(f))
            return _fix_space_separated_rows(rows)
        except (UnicodeDecodeError, UnicodeError):
            continue
    return []


def detect_columns(header_row, col_patterns):
    """Find column indices by keyword patterns."""
    upper = [(h or "").upper().strip() for h in header_row]
    result = {}
    for field_name, patterns in col_patterns.items():
        idx = None
        if callable(patterns):
            for i, h in enumerate(upper):
                if patterns(h):
                    idx = i
                    break
        elif isinstance(patterns, re.Pattern):
            for i, h in enumerate(upper):
                if patterns.search(h):
                    idx = i
                    break
        else:  # list of keywords
            for i, h in enumerate(upper):
                if any(kw.upper() in h for kw in patterns):
                    idx = i
                    break
        result[field_name] = idx
    return result


def find_header_row(rows, test_fn, max_scan=20):
    """Find header row index using test function."""
    for i in range(min(len(rows), max_scan)):
        if test_fn(rows[i]):
            return i
    return 0


# ─── OpTime CSV Parser ──────────────────────────────────────

def parse_optime_csv(filepath):
    """Parse OPERATIONTIMELOG.CSV → list of operation dicts."""
    rows = read_csv_rows(filepath)
    if len(rows) < 2:
        return []

    def is_header(row):
        upper = " ".join((c or "").upper() for c in row)
        return "OPERATION" in upper and "TIME" in upper

    h_idx = find_header_row(rows, is_header)
    header = rows[h_idx]

    cols = detect_columns(header, {
        "mode": ["OPERATION", "OP MODE", "OP_MODE", "MODE"],
        "date": ["DATE", "DAY"],
        "start": ["START TIME"],
        "end": ["END TIME"],
        "runtime": ["RUNNING", "RUNTIME", "RUN_TIME",
                     "RUN TIME", "DURATION"],
        "position": ["POSITION", "GPS", "LOC"],
        "volume": ["VOLUME", "VOL", "TON"],
    })

    def is_header_or_meta(row):
        first = (row[0] or "").upper().strip()
        if first == "OPERATION" and any(
                "TIME" in (c or "").upper() for c in row):
            return True
        if re.match(
            r"^(ECS |SHIP |OPERATION DATE|TOTAL TIME|"
            r"BALLAST TIME|DEBALLAST TIME|STRIPPING TIME|"
            r"MAKE DATE|- \d)", first, re.IGNORECASE
        ):
            return True
        return False

    def get(row, field):
        i = cols.get(field)
        if i is not None and i < len(row):
            return (row[i] or "").strip()
        return None

    operations = []
    for i in range(h_idx + 1, len(rows)):
        row = rows[i]
        if len(row) < 2:
            continue
        if is_header_or_meta(row):
            continue

        mode = normalize_mode(get(row, "mode"))
        if not mode or mode == "STOP":
            continue

        vol_str = get(row, "volume") or ""
        vol = safe_float(vol_str)

        date_val = get(row, "date")
        if not date_val:
            start_raw = get(row, "start") or ""
            dm = re.search(r"(\d{4}-\d{1,2}-\d{1,2})", start_raw)
            if dm:
                date_val = dm.group(1)

        gps_raw = get(row, "position")
        gps = parse_gps_coordinate(gps_raw)
        area = classify_sea_area(*gps) if gps else None

        start_time = get(row, "start")
        end_time = get(row, "end")
        run_time = parse_runtime(get(row, "runtime"))

        if not start_time and not run_time and vol is None:
            continue

        operations.append({
            "operation_mode": mode,
            "date": date_val,
            "start_time": start_time,
            "end_time": end_time,
            "run_time": run_time,
            "location_gps": gps_raw,
            "parsed_gps": {"lat": gps[0], "lon": gps[1],
                           "area": area} if gps else None,
            "ballast_volume": vol if mode == "BALLAST" else None,
            "deballast_volume": vol if mode == "DEBALLAST" else None,
        })

    return operations


# ─── DataLog CSV Parser ─────────────────────────────────────

def parse_datalog_csv(filepath):
    """Parse DATALOG.CSV → tro_data dict."""
    rows = read_csv_rows(filepath)
    if len(rows) < 2:
        return None

    # Find header
    def is_datalog_header(row):
        upper = " ".join((c or "").upper() for c in row)
        return ("INDEX" in upper and "TIME" in upper) or \
               ("OPERATION" in upper and
                ("TRO" in upper or "REC" in upper or "FMU" in upper))

    h_idx = find_header_row(rows, is_datalog_header)
    actual_rows = rows[h_idx:]
    if len(actual_rows) < 2:
        return None

    header = actual_rows[0]
    upper = [(h or "").upper().strip() for h in header]

    # Detect format B (TECHCROSS/KHM)
    format_b_count = sum(
        1 for h in upper
        if re.search(r"REC\d*_STATE_", h) or h in (
            "GDS1", "BP1", "BP2", "TE02V")
    )
    is_format_b = format_b_count >= 2

    # Find OPERATION column
    op_idx = None
    for i, h in enumerate(upper):
        if h in ("OPERATION", "OP"):
            op_idx = i
            break

    if op_idx is not None:
        return _parse_datalog_timeseries(
            actual_rows, upper, op_idx, is_format_b)

    # Summary format fallback
    return _parse_datalog_summary(actual_rows, upper)


def _find_col(upper, pattern):
    """Find column index by regex pattern."""
    for i, h in enumerate(upper):
        if re.search(pattern, h):
            return i
    return -1


def _parse_datalog_timeseries(rows, upper, op_idx, is_format_b):
    """Parse time-series DataLog CSV (row-by-row)."""
    # TRO column detection
    # Format A: TRO_B1/D1, Format B: TSU1_BP1/BP3
    tro_cols = []
    for i, h in enumerate(upper):
        if re.search(r"TRO[_-]?B\d*", h):
            tro_cols.append((i, "ballast"))
        elif re.search(r"TRO[_-]?[DS]\d*", h):
            tro_cols.append((i, "deballast"))
        elif h in ("TRO", "T1"):
            tro_cols.append((i, "auto"))
        elif h in ("TRO2", "T2"):
            tro_cols.append((i, "deballast"))
        elif re.search(r"TSU\d*_BP1$", h):
            tro_cols.append((i, "ballast"))
        elif re.search(r"TSU\d*_BP3$", h):
            tro_cols.append((i, "deballast"))
        elif "NIU" in h and "QUANTITY" in h:
            tro_cols.append((i, "auto"))

    # Sensor columns
    if is_format_b:
        ecu_idx = _find_col(upper, r"REC1_STATE_CURRENT")
        volt_idx = _find_col(upper, r"REC1_STATE_VOLTAGE")
    else:
        ecu_idx = _find_col(
            upper,
            r"REC\d*_?(STATE_)?CURRENT(?!.*VOLTAGE)")
        volt_idx = _find_col(upper, r"REC\d*_?(STATE_)?VOLTAGE")

    fmu_idx = _find_col(upper, r"^FMU\d*$")
    anu_d_idx = _find_col(upper, r"^ANU[_-]?D\d*")
    csu_idx = _find_col(upper, r"^CSU\d*$")
    fts_idx = _find_col(upper, r"^FTS\d*$")
    gas_idx = _find_col(upper, r"^(GAS|GDS)\d*$")
    bypass_idx = _find_col(upper, r"^(BV\d*|TE02V)$")
    pump1_idx = _find_col(upper, r"^(PUMP1|BP1)$")
    pump2_idx = _find_col(upper, r"^(PUMP2|BP2)$")

    # Collection arrays
    ballast_tros = []
    deballast_tros = []
    ecu_values = []
    fmu_values = []
    csu_values = []
    fts_values = []
    fmu_sum = 0.0

    mode_data = {
        "BALLAST": {"volt": [], "cur": [], "csu": [],
                     "fmu": [], "fts": [], "anu_d": []},
        "DEBALLAST": {"volt": [], "cur": [], "csu": [],
                       "fmu": [], "fts": [], "anu_d": []},
    }

    anu_op = 0
    anu_all = 0
    gas_detected = 0
    bypass_count = 0
    zero_voltage = 0
    zero_current = 0
    ultra_low_salinity = 0
    fmu_zero_pump = 0
    pump_not_running = 0
    operating_rows = 0
    dash_cols = set()

    def _get(row, idx):
        if idx < 0 or idx >= len(row):
            return None
        return row[idx]

    for i in range(1, len(rows)):
        row = rows[i]
        op_val = _get(row, op_idx)
        if not op_val:
            continue

        # Skip repeated headers
        first = (row[0] or "").upper().strip()
        if first in ("INDEX", "OPERATION") and any(
                "TIME" in (c or "").upper() for c in row):
            continue
        if re.match(
            r"^(ECS |SHIP |TOTAL TIME|MAKE DATE|- \d)",
            first, re.I
        ):
            continue

        op = op_val.strip().upper()
        is_ballast = op in ("BALLAST", "N-B") or \
            bool(re.match(r"^\d+-?B$", op, re.I))
        is_deballast = op in ("DEBALLAST", "N-D") or \
            bool(re.match(r"^\d+-?D$", op, re.I))
        is_stripping = op.startswith("STRIPP") or op == "N-S" or \
            bool(re.match(r"^\d+-?S$", op, re.I))

        if not is_ballast and not is_deballast and not is_stripping:
            continue
        operating_rows += 1
        mode_key = "BALLAST" if is_ballast else "DEBALLAST"
        md = mode_data[mode_key]

        # TRO
        for col_idx, col_type in tro_cols:
            v = safe_float(_get(row, col_idx))
            if v is None or v < 0 or v > 15:
                if _get(row, col_idx) == "-":
                    dash_cols.add(upper[col_idx])
                continue
            eff_type = col_type
            if col_type == "auto":
                eff_type = "ballast" if is_ballast else "deballast"
            if eff_type == "ballast" and is_ballast and v >= 0.1:
                ballast_tros.append(v)
            if eff_type == "deballast" and \
                    (is_deballast or is_stripping):
                deballast_tros.append(v)

        # Voltage
        if volt_idx >= 0:
            v = safe_float(_get(row, volt_idx))
            if v is not None:
                if v == 0:
                    zero_voltage += 1
                md["volt"].append(v)
            elif _get(row, volt_idx) == "-":
                dash_cols.add(upper[volt_idx])

        # Current
        if ecu_idx >= 0:
            v = safe_float(_get(row, ecu_idx))
            if v is not None:
                if v > 50:
                    ecu_values.append(v)
                if v == 0:
                    zero_current += 1
                md["cur"].append(v)
            elif _get(row, ecu_idx) == "-":
                dash_cols.add(upper[ecu_idx])

        # FMU
        if fmu_idx >= 0:
            v = safe_float(_get(row, fmu_idx))
            if v is not None:
                if v > 0:
                    fmu_values.append(v)
                    fmu_sum += v
                md["fmu"].append(v)
                if v == 0:
                    p1 = safe_float(_get(row, pump1_idx)) \
                        if pump1_idx >= 0 else None
                    p2 = safe_float(_get(row, pump2_idx)) \
                        if pump2_idx >= 0 else None
                    if p1 == 1 or p2 == 1:
                        fmu_zero_pump += 1

        # ANU
        if anu_d_idx >= 0:
            v = safe_float(_get(row, anu_d_idx))
            if v is not None:
                anu_all += 1
                if v > 0:
                    anu_op += 1
                md["anu_d"].append(v)

        # CSU (salinity)
        if csu_idx >= 0:
            v = safe_float(_get(row, csu_idx))
            if v is not None and v > 0:
                csu_values.append(v)
                md["csu"].append(v)
                if v < 5:
                    ultra_low_salinity += 1
            elif _get(row, csu_idx) == "-":
                dash_cols.add(upper[csu_idx])

        # FTS (temperature)
        if fts_idx >= 0:
            v = safe_float(_get(row, fts_idx))
            if v is not None and v > 0:
                fts_values.append(v)
                md["fts"].append(v)

        # Gas
        if gas_idx >= 0:
            v = safe_float(_get(row, gas_idx))
            if v is not None and v > 0:
                gas_detected += 1

        # Bypass
        if bypass_idx >= 0:
            v = safe_float(_get(row, bypass_idx))
            if v is not None and v == 1:
                bypass_count += 1

        # Pump
        if pump1_idx >= 0 or pump2_idx >= 0:
            p1 = safe_float(_get(row, pump1_idx)) \
                if pump1_idx >= 0 else None
            p2 = safe_float(_get(row, pump2_idx)) \
                if pump2_idx >= 0 else None
            if (p1 is None or p1 == 0) and \
                    (p2 is None or p2 == 0):
                pump_not_running += 1

    # Format B fallback: if D-TRO is empty but B-TRO columns
    # had values during deballast, it means TSU_BP1 is shared
    # sensor. Re-scan deballast rows using ballast TRO columns.
    if not deballast_tros and tro_cols:
        b_type_cols = [c for c in tro_cols if c[1] == "ballast"]
        if b_type_cols:
            for i in range(1, len(rows)):
                row = rows[i]
                op_val = _get(row, op_idx)
                if not op_val:
                    continue
                op = op_val.strip().upper()
                is_d = op in ("DEBALLAST", "N-D") or \
                    bool(re.match(r"^\d+-?D$", op, re.I))
                is_s = op.startswith("STRIPP") or op == "N-S" \
                    or bool(re.match(r"^\d+-?S$", op, re.I))
                if not is_d and not is_s:
                    continue
                for col_idx, _ in b_type_cols:
                    v = safe_float(_get(row, col_idx))
                    if v is not None and 0 <= v <= 15:
                        deballast_tros.append(v)

    # Warm-up skip: first 5 rows
    stable = ballast_tros[5:]

    # Stable region analysis (5~10 ppm = normal range)
    b_in_range = [v for v in ballast_tros if 5 <= v <= 10]
    b_stable_ratio = (
        round(len(b_in_range) / len(ballast_tros), 2)
        if ballast_tros else 0)
    b_max = arr_max(ballast_tros)

    # Performance stats by mode
    performance = {}
    for mode, d in mode_data.items():
        if not d["volt"] and not d["cur"]:
            continue
        performance[mode] = {
            "voltage": stats(d["volt"]),
            "current": stats(d["cur"]),
            "salinity": stats(d["csu"]),
            "flow": stats(d["fmu"]),
            "temperature": stats(d["fts"]),
            "anu_d1": stats(d["anu_d"]),
        }

    # Efficiency evaluation
    ecu_avg_val = avg(ecu_values)
    csu_avg_val = avg(csu_values)
    efficiency = _evaluate_efficiency(
        ecu_avg_val, csu_avg_val,
        gas_detected, bypass_count,
        zero_voltage, zero_current)

    # Anomalies
    data_anomalies = []
    if fmu_zero_pump > 0:
        data_anomalies.append(
            {"flag": "[유량 없음 주의]", "count": fmu_zero_pump})
    if pump_not_running > 0:
        data_anomalies.append(
            {"flag": "[펌프 미작동]", "count": pump_not_running})

    return {
        "ballasting_avg": avg(ballast_tros),
        "ballasting_min": arr_min(
            stable if stable else ballast_tros),
        "ballasting_max": b_max,
        "ballasting_stable_ratio": b_stable_ratio,
        "ballasting_count": len(ballast_tros),
        "deballasting_max": arr_max(deballast_tros),
        "ecu_current_avg": ecu_avg_val,
        "fmu_flow_avg": avg(fmu_values),
        "anu_status": (
            "Operating" if anu_all > 0 and anu_op / anu_all > 0.3
            else "Standby" if anu_all > 0
            else None
        ),
        "csu_avg": csu_avg_val,
        "fts_avg": avg(fts_values),
        "gasDetectedCount": gas_detected,
        "bypassCount": bypass_count,
        "zeroVoltageCount": zero_voltage,
        "zeroCurrentCount": zero_current,
        "ultraLowSalinityCount": ultra_low_salinity,
        "performance": performance,
        "efficiency": efficiency,
        "monthly_total_flow_m3": (
            round(fmu_sum / 60, 2) if fmu_values else None),
        "data_anomalies": data_anomalies,
        "sensors_not_installed": list(dash_cols),
        "format_detected": "B" if _find_col(
            [(h or "").upper() for h in rows[0]],
            r"REC\d*_STATE_") >= 0 else "A",
        "operating_row_count": operating_rows,
    }


def _parse_datalog_summary(rows, upper):
    """Parse summary-format DataLog (single stats row)."""
    def find(keywords, exclude=None):
        for i, h in enumerate(upper):
            if exclude and exclude.upper() in h:
                continue
            if all(kw.upper() in h for kw in keywords):
                return i
        return -1

    cols = {
        "ballasting_avg": find(["BALLAST", "AVG"], "DEBALLAST"),
        "ballasting_min": find(["BALLAST", "MIN"], "DEBALLAST"),
        "deballasting_max": find(["DEBALLAST", "MAX"]),
        "ecu_current_avg": find(["CURRENT"]),
        "fmu_flow_avg": find(["FMU"]),
    }

    if len(rows) < 2:
        return None
    row = rows[1]
    result = {}
    for key, idx in cols.items():
        if idx >= 0 and idx < len(row):
            result[key] = safe_float(row[idx])
        else:
            result[key] = None

    result["anu_status"] = None
    return result


def _evaluate_efficiency(ecu_avg, csu_avg,
                         gas_count, bypass_count,
                         zero_volt, zero_cur):
    """Evaluate treatment efficiency."""
    result = {
        "current_level": None, "current_detail": None,
        "salinity_impact": None, "salinity_detail": None,
        "anomalies": [],
    }

    if ecu_avg is not None:
        if 1500 <= ecu_avg <= 3000:
            result["current_level"] = "NORMAL"
            result["current_detail"] = \
                f"평균 {ecu_avg}A (정상 범위 1500~3000A)"
        elif ecu_avg < 1000:
            result["current_level"] = "LOW"
            result["current_detail"] = \
                f"평균 {ecu_avg}A (저전류 — 처리 성능 저하 가능)"
            result["anomalies"].append("[저전류 주의]")
        elif ecu_avg == 0:
            result["current_level"] = "ZERO"
            result["current_detail"] = "전류 미공급 — Bypass 의심"
            result["anomalies"].append("[전류 미공급 의심]")
        else:
            result["current_level"] = "NORMAL"
            result["current_detail"] = f"평균 {ecu_avg}A"

    if csu_avg is not None:
        if csu_avg >= 35:
            result["salinity_impact"] = "NORMAL"
            result["salinity_detail"] = \
                f"평균 {csu_avg}ppt (고염분 정상)"
        elif csu_avg >= 10:
            result["salinity_impact"] = "NORMAL"
            result["salinity_detail"] = f"평균 {csu_avg}ppt"
        elif csu_avg >= 5:
            result["salinity_impact"] = "LOW"
            result["salinity_detail"] = \
                f"평균 {csu_avg}ppt (저염분 — 처리 효율 저하 가능)"
            result["anomalies"].append("[저염분 해역]")
        else:
            result["salinity_impact"] = "ULTRA_LOW"
            result["salinity_detail"] = \
                f"평균 {csu_avg}ppt (초저염분 — 처리 불가 수준)"
            result["anomalies"].append("[초저염분 해역]")

    if gas_count > 0:
        result["anomalies"].append(f"[가스 감지] {gas_count}건")
    if bypass_count > 0:
        result["anomalies"].append(
            f"[Bypass 운전] {bypass_count}건")

    return result


# ─── EventLog CSV Parser ────────────────────────────────────

def parse_eventlog_csv(filepath):
    """Parse EVENTLOG.CSV → dict with alarms and stats."""
    rows = read_csv_rows(filepath)

    # Check for overflow / conversion error
    if len(rows) <= 2 and rows:
        first = (rows[0][0] if rows[0] else "").strip()
        if "페이지 과도" in first:
            pm = re.search(r"(\d+)\s*페이지", first)
            return {
                "alarms": [], "wrongTerminationCount": 0,
                "gpsTimeSetCount": 0,
                "_overflow": True,
                "_overflowPages": int(pm.group(1)) if pm else None,
            }
        if any(kw in first for kw in
               ("변환 실패", "점검 필요", "서버 오류")):
            return {
                "alarms": [], "wrongTerminationCount": 0,
                "gpsTimeSetCount": 0,
                "_overflow": True,
                "_overflowReason": first,
            }

    if len(rows) < 2:
        return {
            "alarms": [], "wrongTerminationCount": 0,
            "gpsTimeSetCount": 0,
        }

    def is_ev_header(row):
        upper = " ".join((c or "").upper() for c in row)
        return "DATE" in upper and \
            ("LEVEL" in upper or "DESCRIPTION" in upper)

    h_idx = find_header_row(rows, is_ev_header)
    header = rows[h_idx]
    cols = detect_columns(header, {
        "date": ["DATE"],
        "level": ["LEVEL", "TYPE"],
        "description": ["DESCRIPTION", "DESC", "DETAIL"],
        "device": ["DEVICE", "MODULE"],
        "ack": lambda h: "ACK" in h,
        "reset": lambda h: "RESET" in h,
        "clear": lambda h: h == "CLEAR",
    })

    alarms = []
    wrong_term = 0
    gps_time_set = 0
    normal_count = 0
    alarm_count = 0
    trip_count = 0
    total_count = 0
    power_on = 0
    proper_term = 0
    valve_counts = {}

    def get(row, f):
        i = cols.get(f)
        if i is not None and i < len(row):
            return (row[i] or "").strip()
        return ""

    for i in range(h_idx + 1, len(rows)):
        row = rows[i]
        if len(row) < 2:
            continue

        raw_level = get(row, "level").upper()
        desc = get(row, "description")
        total_count += 1

        if raw_level == "NORMAL":
            normal_count += 1
            if "terminated in the wrong way" in desc:
                wrong_term += 1
            if "GPS Time Set" in desc:
                gps_time_set += 1
            if "HMI Power On" in desc:
                power_on += 1
            if "terminated" in desc and "wrong way" not in desc:
                proper_term += 1
            vm = re.search(
                r"Valve\s+(?:Opened|Closed)\.\[([^\],]+)", desc, re.I)
            if vm:
                valve = vm.group(1).strip()
                valve_counts[valve] = valve_counts.get(valve, 0) + 1
            continue

        if re.search(r"TRIP|FAULT", raw_level):
            level = "Trip"
            trip_count += 1
        elif re.search(r"ALARM", raw_level):
            level = "Alarm"
            alarm_count += 1
        elif re.search(r"WARN", raw_level):
            level = "Warning"
            alarm_count += 1
        else:
            continue

        code_m = re.search(r"\[CODE\s*(\d+)\]", desc, re.I)
        code = f"CODE{code_m.group(1)}" if code_m else None
        clean_desc = re.sub(r"\[CODE\s*\d+\]", "", desc,
                            flags=re.I).strip().lstrip("-– ").strip()

        ack_val = get(row, "ack")
        reset_val = get(row, "reset")
        clear_val = get(row, "clear")

        if not code and not clean_desc:
            continue

        alarms.append({
            "date": get(row, "date") or None,
            "level": level,
            "code": code,
            "description": clean_desc or desc,
            "device": get(row, "device") or None,
            "acked": ack_val not in ("-", ""),
            "reset": reset_val not in ("-", ""),
            "cleared": clear_val == "X",
            "count": 1,
        })

    # Level counts
    level_counts = {
        "normal": normal_count, "alarm": alarm_count,
        "trip": trip_count, "total": total_count,
        "alarm_trip_ratio": round(
            (alarm_count + trip_count) / total_count * 100, 1
        ) if total_count > 0 else 0,
    }

    # Code frequency
    code_freq = {}
    for a in alarms:
        c = a["code"] or "(코드없음)"
        if c not in code_freq:
            code_freq[c] = {"code": c, "total": 0,
                            "Trip": 0, "Alarm": 0, "Warning": 0}
        code_freq[c]["total"] += 1
        code_freq[c][a["level"]] += 1
    code_frequency = sorted(
        code_freq.values(), key=lambda x: x["total"], reverse=True)
    repeated_alarms = [c for c in code_frequency if c["total"] >= 5]

    # VRCS chattering
    vrcs_data = [
        {"valve": v, "count": c}
        for v, c in sorted(
            valve_counts.items(), key=lambda x: x[1], reverse=True)
        if c >= 10
    ]

    return {
        "alarms": alarms,
        "wrongTerminationCount": wrong_term,
        "gpsTimeSetCount": gps_time_set,
        "level_counts": level_counts,
        "code_frequency": code_frequency,
        "repeated_alarms": repeated_alarms,
        "vrcs_data": vrcs_data,
        "_overflow": False,
    }


# ─── OpTime Aggregation & Anomalies ─────────────────────────

def aggregate_by_mode(operations):
    """Aggregate count/volume/runtime by mode."""
    result = {}
    for op in operations:
        mode = op["operation_mode"]
        if not mode or mode == "STOP":
            continue
        if mode not in result:
            result[mode] = {
                "count": 0, "total_volume": 0.0,
                "total_runtime": 0.0}
        g = result[mode]
        g["count"] += 1
        vol = op.get("ballast_volume") or \
            op.get("deballast_volume") or 0
        if vol > 0:
            g["total_volume"] += vol
        if op.get("run_time") and op["run_time"] > 0:
            g["total_runtime"] += op["run_time"]
    for g in result.values():
        g["total_volume"] = round(g["total_volume"], 2)
        g["total_runtime"] = round(g["total_runtime"], 2)
    return result


def detect_optime_anomalies(operations):
    """Detect anomalies in operation data."""
    anomalies = []
    start_times = []

    for i, op in enumerate(operations):
        vol = op.get("ballast_volume") or \
            op.get("deballast_volume")
        rt = op.get("run_time")

        if (vol is None or vol == 0) and rt and rt > 0:
            anomalies.append({
                "index": i, "mode": op["operation_mode"],
                "flag": "[볼륨 미기록 의심]",
                "detail": f"runtime={rt}h, volume={vol}",
            })
        if not op.get("end_time") or op["end_time"] == "-":
            anomalies.append({
                "index": i, "mode": op["operation_mode"],
                "flag": "[종료시간 누락]",
                "detail": f"start={op.get('start_time')}",
            })
        if (rt is None or rt == 0) and vol and vol > 0:
            anomalies.append({
                "index": i, "mode": op["operation_mode"],
                "flag": "[운전시간 오류]",
                "detail": f"runtime={rt}, volume={vol}",
            })

    return anomalies


# ─── Combine 3 CSVs ─────────────────────────────────────────

def combine_csv_results(optime_path, datalog_path,
                        eventlog_path, vessel=None):
    """Parse all 3 CSV files and combine into analysis input."""
    vessel = vessel or {}
    operations = parse_optime_csv(optime_path) \
        if optime_path else []
    tro_data = parse_datalog_csv(datalog_path) \
        if datalog_path else None

    ev_result = parse_eventlog_csv(eventlog_path) \
        if eventlog_path else None
    error_alarms = list(ev_result["alarms"]) if ev_result else []

    # Event Log overflow → LOG_OVERFLOW alarm
    if ev_result and ev_result.get("_overflow"):
        reason = ev_result.get("_overflowReason", "")
        pages = ev_result.get("_overflowPages")
        desc = (
            f"Event Log {reason}" if reason
            else f"Event Log {pages}페이지 페이지 과도 — "
                 f"밸브 오작동 또는 반복 알람 지속 가능성. "
                 f"전체 로그 상세 검토 필요."
            if pages
            else "Event Log 페이지 과도"
        )
        error_alarms.append({
            "code": "LOG_OVERFLOW",
            "description": desc,
            "level": "Warning",
            "date": None, "time": None,
        })

    # VRCS chattering injection
    if ev_result:
        for vd in ev_result.get("vrcs_data", []):
            error_alarms.append({
                "code": "VRCS_ERR",
                "description": (
                    f"Valve Opened/Closed 반복 오작동 감지 "
                    f"[{vd['valve']}] ×{vd['count']}회"),
                "level": "Alarm" if vd["count"] >= 100
                    else "Warning",
                "date": None, "time": None,
                "count": vd["count"],
            })

    # Aggregation
    op_time_stats = aggregate_by_mode(operations)
    op_time_anomalies = detect_optime_anomalies(operations)
    gps_areas = list(set(
        op["parsed_gps"]["area"]
        for op in operations
        if op.get("parsed_gps") and op["parsed_gps"].get("area")
    ))

    year = vessel.get("year")
    month = vessel.get("month")
    period = (f"{year}-{str(month).zfill(2)}"
              if year and month else None)

    return {
        "vessel_name": vessel.get("name"),
        "period": period,
        "operations": operations,
        "tro_data": tro_data,
        "error_alarms": error_alarms,
        "_event_log_missing": eventlog_path is None,
        "op_time_stats": op_time_stats,
        "op_time_anomalies": op_time_anomalies,
        "gps_areas": gps_areas,
        "data_log_efficiency": (
            tro_data.get("efficiency") if tro_data else None),
        "event_log_analysis": (
            {
                "level_counts": ev_result.get("level_counts"),
                "code_frequency": ev_result.get("code_frequency"),
                "repeated_alarms": ev_result.get("repeated_alarms"),
            } if ev_result else None
        ),
    }
