#!/usr/bin/env python3
"""
PDF → CSV converter for Techcross BWTS logs.
Extracts 3 sections from PDF:
  1. EventLog (DATE, DEVICE, LEVEL, DESCRIPTION, ...)
  2. OperationTimeLog (OPERATION, START TIME, END TIME, ...)
  3. DataLog (INDEX, TIME, OPERATION, TRO, ...)

Handles both individual PDFs and TOTALLOG (combined) PDFs.
"""
import sys
import re
import csv
from pathlib import Path
from datetime import datetime

if sys.stdout.encoding != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

import pdfplumber

from config import (
    VESSELS, BWTS_LOG_ROOT, find_month_dir,
    get_vessel_folder,
)


def detect_section(text):
    """Detect which section a page belongs to."""
    if not text:
        return None
    upper = text[:300].upper()
    if "OPERATION LOG" in upper or "EVENT LOG" in upper:
        return "event"
    if "OPERATION TIME" in upper:
        return "optime"
    if "DATA LOG" in upper or "DATA REPORT" in upper:
        return "data"
    if "REPORT LIST" in upper or "GENERAL INFORMATION" in upper:
        return "cover"
    return None


def find_sections(pdf):
    """Find page ranges for each section."""
    sections = {"event": None, "optime": None, "data": None}
    total = len(pdf.pages)

    # Check cover page for table of contents
    cover = pdf.pages[0].extract_text() or ""
    # Parse "Operation Event Log --- 1"
    toc = {}
    for m in re.finditer(
            r"(Event|Operation Time|Data)\s*(?:Log|Report)"
            r"\s*[-–—]+\s*(\d+)", cover, re.I):
        name = m.group(1).lower()
        page = int(m.group(2))
        if "event" in name:
            toc["event"] = page
        elif "time" in name:
            toc["optime"] = page
        elif "data" in name:
            toc["data"] = page

    # A TOC page number outside the document (KCN 2025-05 gave 6147 for a
    # 20-page PDF) means the regex caught a stray number — ignore the TOC.
    if toc and not all(1 <= pg <= total for pg in toc.values()):
        toc = {}
    if toc:
        # TOC numbers are often off by one (cover not counted). Nudge each
        # start to the nearest page whose text really is that section.
        def _fix(name, pg):
            for cand in (pg, pg + 1, pg - 1, pg + 2):
                if 1 <= cand <= total and detect_section(
                        pdf.pages[cand - 1].extract_text() or "") == name:
                    return cand
            return pg
        toc = {k: _fix(k, v) for k, v in toc.items()}
        # Convert page numbers from TOC
        if "event" in toc:
            end = toc.get("optime", toc.get("data", total))
            sections["event"] = (toc["event"], end - 1)
        if "optime" in toc:
            end = toc.get("data", total)
            sections["optime"] = (toc["optime"], end - 1)
        if "data" in toc:
            sections["data"] = (toc["data"], total)
        return sections

    # Fallback: scan first few pages
    for i in range(min(total, 20)):
        text = pdf.pages[i].extract_text() or ""
        sec = detect_section(text)
        if sec in sections and sections[sec] is None:
            sections[sec] = (i + 1, None)

    # Fill in end pages
    order = ["event", "optime", "data"]
    starts = [(s, sections[s][0]) for s in order
              if sections[s]]
    starts.sort(key=lambda x: x[1])
    for j, (name, start) in enumerate(starts):
        if j + 1 < len(starts):
            end = starts[j + 1][1] - 1
        else:
            end = total
        sections[name] = (start, end)

    return sections


def extract_table_text(pdf, start_page, end_page,
                       max_pages=500):
    """Extract text from page range, capped at max_pages."""
    lines = []
    end = min(end_page, start_page + max_pages - 1,
              len(pdf.pages))
    for i in range(start_page - 1, end):
        page = pdf.pages[i]
        text = page.extract_text()
        if text:
            for line in text.split("\n"):
                line = line.strip()
                if line:
                    lines.append(line)
    return lines


def parse_event_lines(lines):
    """Parse EventLog text lines into CSV rows."""
    rows = []
    header = ["DATE", "DEVICE", "LEVEL", "DESCRIPTION",
              "Ack.Time", "Reset.Time", "Clear"]

    # Skip header lines
    skip_patterns = re.compile(
        r"^(ECS |SHIP NAME|LOG DATE|DATE\s+DEVICE|"
        r"Make Date|Page )", re.I)

    for line in lines:
        if skip_patterns.match(line):
            continue

        # Try to parse: datetime device level description ...
        m = re.match(
            r"(\d{4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{1,2}:\d{1,2})"
            r"\s+(\S+)\s+(Normal|Alarm|Trip|Warning|Fault)"
            r"\s+(.+)", line, re.I)
        if m:
            dt, device, level, rest = m.groups()
            # Try to split rest into desc, ack, reset, clear
            parts = rest.rsplit(" ", 2)
            desc = rest
            ack = "-"
            reset = "-"
            clear = "X"

            # Check for trailing X/O and times
            if len(parts) >= 2 and parts[-1] in ("X", "O"):
                clear = parts[-1]
                desc = " ".join(parts[:-1])

            rows.append([dt, device, level, desc,
                         ack, reset, clear])

    return header, rows


def parse_optime_lines(lines):
    """Parse OperationTimeLog text lines into CSV rows."""
    rows = []
    header = None

    skip = re.compile(
        r"^(ECS |SHIP NAME|OPERATION DATE|TOTAL TIME|"
        r"BALLAST TIME|DEBALLAST TIME|STRIPPING TIME|"
        r"Make Date|Page )", re.I)

    for line in lines:
        if skip.match(line):
            continue

        # Detect header line
        if "OPERATION" in line.upper() and \
                "START" in line.upper():
            # Parse header columns
            header = re.split(r"\s{2,}", line.strip())
            continue

        if not header:
            continue

        # Data line: starts with BALLAST/DEBALLAST/STRIPPING
        if re.match(r"^(BALLAST|DEBALLAST|STRIPPING)",
                    line, re.I):
            # Split by 2+ spaces
            cols = re.split(r"\s{2,}", line.strip())
            # Pad to header length
            while len(cols) < len(header):
                cols.append("")
            rows.append(cols[:len(header)])

    if not header:
        header = ["OPERATION", "START TIME", "END TIME",
                  "RUNNING TIME(HH:MM)", "POSITION(GPS)",
                  "VOLUME (m3)", "Line"]
    return header, rows


def parse_data_lines(lines):
    """Parse DataLog text lines into CSV rows."""
    rows = []
    header = None

    skip = re.compile(
        r"^(ECS |SHIP NAME|DATA |Make Date|Page )", re.I)

    for line in lines:
        if skip.match(line):
            continue

        upper = line.upper()
        # Detect header
        if "INDEX" in upper and "TIME" in upper and \
                ("OPERATION" in upper or "TRO" in upper):
            header = re.split(r"\s{2,}|\t", line.strip())
            continue

        if not header:
            continue

        # Data line: starts with number (INDEX)
        if re.match(r"^\d+\s", line):
            cols = re.split(r"\s{2,}|\t", line.strip())
            # Handle GPS with spaces
            if len(cols) > len(header):
                # Merge last columns (GPS)
                cols = cols[:len(header) - 1] + \
                    [" ".join(cols[len(header) - 1:])]
            while len(cols) < len(header):
                cols.append("")
            rows.append(cols[:len(header)])

    if not header:
        header = ["INDEX", "TIME", "OPERATION"]
    return header, rows


def write_csv(filepath, header, rows):
    """Write CSV file."""
    with open(filepath, "w", newline="", encoding="utf-8-sig") \
            as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)
    return len(rows)


def convert_pdf(pdf_path, output_dir, code, year, month,
                verbose=True):
    """
    Convert a Techcross PDF to CSV files.
    Returns dict of created files.
    """
    pdf_path = Path(pdf_path)
    output_dir = Path(output_dir)
    created = {}

    if verbose:
        print(f"  [{code}] {pdf_path.name} "
              f"({pdf_path.stat().st_size // 1024}KB)...",
              end="", flush=True)

    try:
        with pdfplumber.open(pdf_path) as pdf:
            total = len(pdf.pages)
            if verbose:
                print(f" {total}p", end="", flush=True)

            sections = find_sections(pdf)

            # Determine PDF type from filename — but a PDF whose pages hold
            # two or more sections is a full report whatever it is called
            # ("[KQD] BWTS LOG DATA (2025-MAR).pdf" is a TotalLog, not a DataLog)
            name_upper = pdf_path.name.upper()
            found = sum(1 for v in sections.values() if v and v[0] is not None)
            is_total = "TOTAL" in name_upper or \
                "REPORT" in name_upper or found >= 2
            is_data = "DATA" in name_upper
            is_event = "EVENT" in name_upper
            is_optime = "OPERATION" in name_upper or \
                "OPTIME" in name_upper

            prefix = f"{code}_{year}_{month:02d}"

            if is_total or (not is_data and not is_event
                            and not is_optime):
                # TOTALLOG or unknown — try all sections
                for sec_name in ("event", "optime", "data"):
                    rng = sections.get(sec_name)
                    if not rng or rng[0] is None:
                        continue

                    max_p = (300 if sec_name == "event"
                            else 500 if sec_name == "data"
                            else 50)
                    lines = extract_table_text(
                        pdf, rng[0], rng[1],
                        max_pages=max_p)

                    if sec_name == "event":
                        h, r = parse_event_lines(lines)
                        fname = f"{prefix}_EVENTLOG.csv"
                    elif sec_name == "optime":
                        h, r = parse_optime_lines(lines)
                        fname = f"{prefix}_OPERATIONTIMELOG.csv"
                    else:
                        h, r = parse_data_lines(lines)
                        fname = f"{prefix}_DATALOG.csv"

                    # An OpTime/DataLog section that exists but holds no
                    # rows is real information (idle month): write the
                    # header-only CSV so reception becomes "full" and the
                    # month grades 미운전 instead of 판독실패.
                    if r or sec_name in ("optime", "data"):
                        out = output_dir / fname
                        cnt = write_csv(out, h, r)
                        created[sec_name] = (out, cnt)
                        if verbose:
                            print(f" {sec_name}={cnt}",
                                  end="")

            elif is_data:
                lines = extract_table_text(pdf, 1, total, 500)
                h, r = parse_data_lines(lines)
                if True:   # header-only is meaningful (idle month)
                    out = output_dir / \
                        f"{prefix}_DATALOG.csv"
                    cnt = write_csv(out, h, r)
                    created["data"] = (out, cnt)

            elif is_event:
                lines = extract_table_text(pdf, 1, total, 300)
                h, r = parse_event_lines(lines)
                if r:
                    out = output_dir / \
                        f"{prefix}_EVENTLOG.csv"
                    cnt = write_csv(out, h, r)
                    created["event"] = (out, cnt)

            elif is_optime:
                lines = extract_table_text(pdf, 1, total, 50)
                h, r = parse_optime_lines(lines)
                if True:   # header-only is meaningful (idle month)
                    out = output_dir / \
                        f"{prefix}_OPERATIONTIMELOG.csv"
                    cnt = write_csv(out, h, r)
                    created["optime"] = (out, cnt)

    except Exception as e:
        if verbose:
            print(f" ERROR: {e}")
        return created

    if verbose:
        if created:
            print(" OK")
        else:
            print(" (no data extracted)")

    return created


def _datalog_header_bad(path):
    """True when a *_DATALOG.csv carries an OpTime header (bad GAS conversion,
    KCN 2025-05): first header cell OPERATION and no DataLog column names."""
    try:
        with open(path, "r", encoding="utf-8-sig", errors="ignore") as f:
            head = (f.readline() + f.readline()).upper()
    except OSError:
        return False
    return head.startswith("OPERATION") and not any(
        k in head for k in ("TRO", "REC", "FMU", "TSU", "INDEX", "ANU"))


def ensure_csv_from_pdf(folder, code, year, month, verbose=False):
    """Fill in missing OpTime/DataLog/EventLog CSVs from the PDFs in the
    vessel folder. Called by fleet_summary before parsing so a month that
    arrived as PDF only is judged on its content, not on the file type.
    Returns a list of (section, path, rows) created. Never touches a CSV
    that already exists, except a DataLog with an OpTime header, which is
    renamed *.bad.csv and regenerated from the PDF."""
    folder = Path(folder)
    if not folder or not folder.exists():
        return []
    csvs = [f for f in folder.iterdir()
            if f.suffix.upper() == ".CSV" and "null" not in f.name.lower()
            and not f.name.lower().endswith(".bad.csv")]

    def has(rx):
        return any(re.search(rx, f.name, re.I) for f in csvs)

    bad_dl = [f for f in csvs if re.search(r"DATALOG|DATAREPORT", f.name, re.I)
              and _datalog_header_bad(f)]
    for f in bad_dl:
        f.rename(f.with_name(f.stem + ".bad.csv"))
        if verbose:
            print(f"  [{code}] {f.name}: OpTime header on a DataLog -> .bad.csv, regenerating")
    need = {
        "optime": not has(r"OPERATIONTIME|OPTIME"),
        "data": bool(bad_dl) or not has(r"DATALOG|DATAREPORT"),
        "event": not has(r"EVENTLOG"),
    }
    if not any(need.values()):
        return []
    pdfs = [f for f in folder.iterdir() if f.suffix.upper() == ".PDF"
            and "BWRB" not in f.name.upper() and "스쯔" not in f.name]
    if not pdfs:
        return []
    # TotalLog / Report PDFs first -- they carry every section
    pdfs.sort(key=lambda f: 0 if re.search(r"TOTAL|REPORT", f.name, re.I) else 1)
    created = []
    for pdf in pdfs:
        made = convert_pdf(pdf, folder, code, year, month, verbose=verbose)
        for sec, (path, cnt) in made.items():
            if need.get(sec):
                created.append((sec, path, cnt))
                need[sec] = False
        if not any(need.values()):
            break
    return created


def convert_all_pdf_only(dry_run=False, verbose=True):
    """
    Find all Techcross PDF-only cases and convert to CSV.
    """
    results = []

    for year in [2024, 2025, 2026]:
        for month in range(1, 13):
            mdir = find_month_dir(year, month)
            if not mdir:
                continue

            for v in VESSELS:
                if v.get("bwts_type", "techcross") \
                        != "techcross":
                    continue
                code = v["code"]
                folder = get_vessel_folder(year, month, code)
                if not folder:
                    continue

                # Check which CSVs are missing
                csvs = [f for f in folder.iterdir()
                        if f.suffix.upper() == ".CSV"
                        and "null" not in f.name.lower()]
                has_op = any(re.search(r"OPERATIONTIME",
                    f.name, re.I) for f in csvs)
                has_dl = any(re.search(r"DATALOG|DATAREPORT",
                    f.name, re.I) for f in csvs)
                has_ev = any(re.search(r"EVENTLOG",
                    f.name, re.I) for f in csvs)

                if has_op and has_dl and has_ev:
                    continue  # all 3 present

                # Find PDFs
                pdfs = [f for f in folder.iterdir()
                        if f.suffix.upper() == ".PDF"]
                if not pdfs:
                    continue

                if dry_run:
                    if verbose:
                        print(f"  {year}/{month:02d} [{code}] "
                              f"{len(pdfs)} PDFs")
                    results.append(
                        (year, month, code, len(pdfs)))
                    continue

                # Convert — use largest PDF first (likely TOTAL)
                pdfs.sort(key=lambda f: f.stat().st_size,
                          reverse=True)

                # Only convert sections that are missing
                needed = set()
                if not has_ev:
                    needed.add("event")
                if not has_op:
                    needed.add("optime")
                if not has_dl:
                    needed.add("data")

                all_created = {}
                for pdf in pdfs:
                    created = convert_pdf(
                        pdf, folder, code, year, month,
                        verbose=verbose)
                    for k, v_val in created.items():
                        if k in needed and k not in all_created:
                            all_created[k] = v_val

                results.append(
                    (year, month, code,
                     {k: v[1] for k, v in all_created.items()}))

    return results


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(
        description="PDF → CSV converter")
    parser.add_argument("--dry-run", action="store_true",
                        help="목록만 출력")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    print("\n=== Techcross PDF → CSV 변환 ===\n")
    results = convert_all_pdf_only(
        dry_run=args.dry_run, verbose=True)

    if args.dry_run:
        print(f"\n총 {len(results)}건 변환 대상")
    else:
        ok = sum(1 for r in results if len(r) > 3
                 and isinstance(r[3], dict) and r[3])
        print(f"\n완료: {ok}/{len(results)}건 변환 성공")
