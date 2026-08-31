# config.py — BWTS Local Analyzer Configuration
import re
import zipfile
from pathlib import Path

# G drive root for BWTS LOG DATA
BWTS_LOG_ROOT = Path(
    r"G:\공유 드라이브\고려에스엠 0033 공무팀 환경기술파트"
    r"\011  BWTS\4. BWTS LOG DATA"
)

# Repo-relative paths (pipelines/bwts_log/ → repo root is two levels up)
PIPELINE_DIR = Path(__file__).resolve().parent
REPO_ROOT = PIPELINE_DIR.parents[1]

# Legacy HTML/mail output (fleet_dashboard.py). Gitignored.
OUTPUT_DIR = PIPELINE_DIR / "out"

# Local data cache (for multi-month analysis). Gitignored.
LOCAL_CACHE_DIR = PIPELINE_DIR / "cache"

# Vessel list — single source: contracts/ships.json
# (shared with the web app and the mail collector). "bwts" there maps to
# the "bwts_type" key the parsers already use; "folder_name" overrides the
# G-drive folder name when it differs from the display name.
import json as _json
with open(REPO_ROOT / "contracts" / "ships.json", encoding="utf-8") as _f:
    _SHIPS_JSON = _json.load(_f)["ships"]
VESSELS = []
for _s in _SHIPS_JSON:
    _v = {"number": _s["number"], "code": _s["code"],
          "name": _s.get("folder_name") or _s["name"],
          "display_name": _s["name"],
          "log_format": _s.get("log_format", "")}
    if _s.get("bwts") and _s["bwts"] != "techcross":
        _v["bwts_type"] = _s["bwts"]
    VESSELS.append(_v)

# Vessel lookup helpers
VESSEL_BY_CODE = {v["code"]: v for v in VESSELS}
VESSEL_BY_NUMBER = {v["number"]: v for v in VESSELS}
VESSEL_BY_NAME = {}
for v in VESSELS:
    VESSEL_BY_NAME[v["name"].upper()] = v
    # Short name variants (e.g. "KMTC PUSAN" → also "PUSAN")
    parts = v["name"].split()
    if len(parts) >= 2:
        VESSEL_BY_NAME[parts[-1].upper()] = v
        # Handle multi-word: "JEBEL ALI" → "JEBEL ALI"
        VESSEL_BY_NAME[" ".join(parts[1:]).upper()] = v

# Month folder patterns (G drive has multiple naming conventions)
MONTH_FOLDER_PATTERNS = {
    # 2026 style: "01월", "02월", ...
    "korean": lambda m: f"{m:02d}월",
    # 2025 old style: "25-01", "25-06", ...
    "dash": lambda y, m: f"{y % 100}-{m:02d}",
}


def find_month_dir(year: int, month: int) -> Path | None:
    """Find month directory (handles multiple naming conventions)."""
    year_dir = BWTS_LOG_ROOT / str(year)
    if not year_dir.exists():
        return None

    # Try multiple naming conventions
    candidates = [
        f"{month:02d}월",          # 2026: "01월"
        f"{month}월",              # 2024: "1월"
        f"{year % 100}-{month:02d}",  # 2025: "25-01"
    ]
    for name in candidates:
        path = year_dir / name
        if path.exists():
            return path

    return None


def get_vessel_folder(year: int, month: int,
                      code: str) -> Path | None:
    """Return vessel folder path, or None if not found."""
    v = VESSEL_BY_CODE.get(code)
    if not v:
        return None
    month_dir = find_month_dir(year, month)
    if not month_dir:
        return None

    # Folder numbering changed between years ("13. KHM" in 2024-03 vs
    # "13 KDB" today), so a number-prefix match can pick another ship's
    # folder — KDB 2024-03 was being parsed from KHM's data. Match code and
    # full name across every folder first; fall back to the number only
    # when nothing else matched.
    dirs = [d for d in month_dir.iterdir() if d.is_dir()]
    code_re = re.compile(r"(?<![A-Z])" + re.escape(code) + r"(?![A-Z])")
    for d in dirs:
        if code_re.search(d.name.upper()):
            return d
    for d in dirs:
        if v["name"].upper() in d.name.upper():
            return d
    for d in dirs:
        name_upper = d.name.upper()
        if name_upper.startswith(v["number"] + ".") or                 name_upper.startswith(v["number"] + " "):
            return d
    return None


def _check_if_totallog(filepath):
    """Check if a 'DATALOG' CSV is actually a TOTALLOG
    (starts with EventLog header DATE,DEVICE,LEVEL)."""
    try:
        with open(filepath, "r", encoding="utf-8-sig") as f:
            first = f.readline().upper()
        if "DATE" in first and "DEVICE" in first \
                and "LEVEL" in first:
            return True
    except Exception:
        pass
    return False


def _write_section(rows, output_dir, filename):
    """Write CSV rows to file."""
    import csv as _csv
    path = output_dir / filename
    if path.exists():
        return
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = _csv.writer(f)
        for r in rows:
            w.writerow(r)


def get_csv_files(folder: Path,
                  auto_extract_zip=True) -> dict:
    """
    Find CSV files in vessel folder.
    Handles: normal CSV, null-named CSV, ZIP extraction.
    Returns dict with keys: optime, datalog, eventlog
    and metadata: _zip_extracted, _null_files, _pdf_only
    """
    result = {
        "optime": None, "datalog": None, "eventlog": None,
        "_zip_extracted": False,
        "_null_files": [],
        "_pdf_only": [],
        "_issues": [],
    }
    if not folder or not folder.exists():
        return result

    # Auto-extract ZIPs if no CSV files exist
    csvs = list(folder.glob("*.csv")) + list(folder.glob("*.CSV"))
    zips = list(folder.glob("*.zip")) + list(folder.glob("*.ZIP"))

    if not csvs and zips and auto_extract_zip:
        for zf in zips:
            try:
                with zipfile.ZipFile(zf, "r") as z:
                    z.extractall(folder)
                result["_zip_extracted"] = True
                result["_issues"].append(
                    f"ZIP 자동 해제: {zf.name}")
            except (zipfile.BadZipFile, Exception) as e:
                result["_issues"].append(
                    f"ZIP 해제 실패: {zf.name} ({e})")
        # Re-scan after extraction
        csvs = list(folder.glob("*.csv")) + \
            list(folder.glob("*.CSV"))

    # Classify CSV files
    for f in folder.iterdir():
        if f.suffix.upper() != ".CSV":
            continue
        # quarantined by ensure_csv_from_pdf (wrong header) or renamed
        # old-bug output (_oldbug_*.bak) — never treat as input
        if f.name.lower().endswith(".bad.csv") or f.name.startswith("_oldbug_"):
            continue
        upper = f.name.upper()

        # Handle null-named files by checking content
        if "NULL" in upper:
            result["_null_files"].append(f)
            file_type = _detect_csv_type_by_content(f)
            if file_type:
                result["_issues"].append(
                    f"null 파일 내용 판별: {f.name} -> {file_type}")
                if file_type == "optime" and not result["optime"]:
                    result["optime"] = f
                elif file_type == "datalog" \
                        and not result["datalog"]:
                    result["datalog"] = f
                elif file_type == "eventlog" \
                        and not result["eventlog"]:
                    result["eventlog"] = f
            continue

        # Normal file name matching
        if "OPERATIONTIME" in upper:
            result["optime"] = f
        elif "DATALOG" in upper or "DATAREPORT" in upper:
            if "TOTALLOG" not in upper:
                # Check if "DATALOG" is actually a TOTALLOG
                # (GAS sometimes mislabels combined files)
                _is_total = _check_if_totallog(f)
                if _is_total:
                    result["_totallog"] = f
                    result["_issues"].append(
                        f"DATALOG가 실제 TOTALLOG: {f.name}")
                else:
                    result["datalog"] = f
        elif "EVENTLOG" in upper:
            result["eventlog"] = f
        elif "TOTALLOG" in upper:
            result["_totallog"] = f

    # Split TOTALLOG CSV if individual files are missing
    totallog = result.get("_totallog")
    if totallog and not all(
            result[k] for k in ("optime", "datalog", "eventlog")):
        try:
            from csv_parser import read_csv_rows
            total_rows = read_csv_rows(totallog)
            if total_rows:
                # Detect sections by content
                text = total_rows[0][0] if total_rows[0] else ""
                upper_first = " ".join(
                    (c or "").upper() for c in total_rows[0])
                # EventLog starts with DATE,DEVICE,LEVEL
                if "DATE" in upper_first and "LEVEL" in upper_first:
                    if not result["eventlog"]:
                        result["eventlog"] = totallog
                        result["_issues"].append(
                            "TOTALLOG → EventLog으로 사용")
                # Find OpTime/DataLog sections within
                base = totallog.stem
                for old in ("TOTALLOG", "DATALOG",
                            "EVENTLOG"):
                    base = base.replace(old, "")
                    base = base.replace(old.lower(), "")
                base = base.rstrip("_")

                for ri, row in enumerate(total_rows):
                    line = " ".join(
                        (c or "").upper() for c in row)
                    if "OPERATION" in line and "START" in line \
                            and not result["optime"]:
                        op_name = f"{base}_OPERATIONTIMELOG.csv"
                        _write_section(
                            total_rows[ri:], totallog.parent,
                            op_name)
                        opf = totallog.parent / op_name
                        if opf.exists():
                            result["optime"] = opf
                    if not result["datalog"] and (
                        ("INDEX" in line and "TIME" in line
                         and ("TRO" in line or "REC" in line))
                        or ("TIME" in line and "OPERATION" in line
                            and ("TSU" in line or "FMU" in line
                                 or "REC" in line)
                            and "START" not in line)):
                        dl_name = f"{base}_DATALOG_split.csv"
                        _write_section(
                            total_rows[ri:], totallog.parent,
                            dl_name)
                        dlf = totallog.parent / dl_name
                        if dlf.exists():
                            result["datalog"] = dlf
        except Exception as e:
            result["_issues"].append(f"TOTALLOG 분리 실패: {e}")

    # Check PDF-only situation
    if not any(result[k] for k in ("optime", "datalog", "eventlog")):
        pdfs = list(folder.glob("*.pdf")) + \
            list(folder.glob("*.PDF"))
        if pdfs:
            result["_pdf_only"] = pdfs
            result["_issues"].append(
                f"CSV 없음, PDF {len(pdfs)}개만 존재")

    return result


def _detect_csv_type_by_content(filepath: Path) -> str | None:
    """Detect CSV type by reading first few lines."""
    try:
        for enc in ("utf-8-sig", "utf-8", "cp949"):
            try:
                with open(filepath, "r", encoding=enc) as f:
                    head = f.read(2000).upper()
                break
            except UnicodeDecodeError:
                continue
        else:
            return None

        if "OPERATION" in head and "START" in head \
                and "RUNNING" in head:
            return "optime"
        if "INDEX" in head and "TRO" in head:
            return "datalog"
        if "LEVEL" in head and "DESCRIPTION" in head:
            return "eventlog"
        if "ALARM" in head or "TRIP" in head:
            return "eventlog"
    except Exception:
        pass
    return None


def scan_all_months(start_year=2026, start_month=1,
                    end_year=None, end_month=None):
    """
    Scan all available year/month directories.
    Returns list of (year, month, month_dir_path).
    """
    from datetime import datetime
    if end_year is None:
        end_year = datetime.now().year
    if end_month is None:
        end_month = datetime.now().month

    results = []
    for year in range(start_year, end_year + 1):
        year_dir = BWTS_LOG_ROOT / str(year)
        if not year_dir.exists():
            continue
        m_start = start_month if year == start_year else 1
        m_end = end_month if year == end_year else 12
        for month in range(m_start, m_end + 1):
            month_dir = find_month_dir(year, month)
            if month_dir:
                results.append((year, month, month_dir))
    return results


def scan_reception_matrix(start_year=2026, start_month=1,
                          end_year=None, end_month=None):
    """
    Build reception matrix: vessel × month → status.
    Status: "full" (3 CSV), "partial" (some CSV),
            "pdf_only", "null", "zip", "folder_only",
            "missing" (no folder)
    """
    months = scan_all_months(
        start_year, start_month, end_year, end_month)

    matrix = {}  # {(year, month): {code: status_dict}}
    for year, month, month_dir in months:
        key = (year, month)
        matrix[key] = {}
        for v in VESSELS:
            code = v["code"]
            folder = get_vessel_folder(year, month, code)
            if not folder:
                matrix[key][code] = {
                    "status": "missing", "detail": "폴더 없음"}
                continue

            files = get_csv_files(folder, auto_extract_zip=False)
            has_csv = sum(1 for k in ("optime", "datalog",
                                       "eventlog")
                          if files[k])
            has_null = len(files["_null_files"])
            has_pdf = len(files["_pdf_only"])

            zips = list(folder.glob("*.zip")) + \
                list(folder.glob("*.ZIP"))

            if has_csv == 3:
                matrix[key][code] = {
                    "status": "full", "detail": "CSV 3종 완비"}
            elif has_csv > 0:
                missing = [k for k in ("optime", "datalog",
                                        "eventlog")
                           if not files[k]]
                matrix[key][code] = {
                    "status": "partial",
                    "detail": f"누락: {', '.join(missing)}",
                    "csv_count": has_csv,
                }
            elif has_null > 0:
                matrix[key][code] = {
                    "status": "null",
                    "detail": f"null 파일 {has_null}개"}
            elif zips:
                matrix[key][code] = {
                    "status": "zip",
                    "detail": f"ZIP {len(zips)}개 (미해제)"}
            elif has_pdf > 0:
                matrix[key][code] = {
                    "status": "pdf_only",
                    "detail": f"PDF {has_pdf}개만"}
            else:
                matrix[key][code] = {
                    "status": "folder_only",
                    "detail": "폴더만 존재 (파일 없음)"}

    return matrix
