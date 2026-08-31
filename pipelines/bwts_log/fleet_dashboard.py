#!/usr/bin/env python3
"""
BWTS Fleet Dashboard — 선대 관리 대시보드

Usage:
  python fleet_dashboard.py              # 2026년 1월 ~ 현재
  python fleet_dashboard.py 2026 3 7     # 2026년 3~7월
  python fleet_dashboard.py --clear      # 캐시 삭제 후 재분석
"""
import sys
import os
import argparse
import subprocess
import shutil
from datetime import datetime
from pathlib import Path

if sys.stdout.encoding != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

from config import OUTPUT_DIR, LOCAL_CACHE_DIR, VESSELS
from fleet_summary import build_fleet_matrix
from fleet_html import generate_fleet_dashboard
from fleet_mail import generate_mail_drafts


def main():
    parser = argparse.ArgumentParser(
        description="BWTS Fleet Dashboard")
    parser.add_argument("year", nargs="?", type=int, default=2026)
    parser.add_argument("start_month", nargs="?", type=int,
                        default=1)
    parser.add_argument("end_month", nargs="?", type=int,
                        default=12)
    parser.add_argument("--years", type=str, default=None,
                        help="다년도 (예: 2024-2026)")
    parser.add_argument("-v", "--verbose", action="store_true")
    parser.add_argument("-o", "--output", type=str, default=None)
    parser.add_argument("--clear", action="store_true",
                        help="캐시 삭제 후 재분석")
    args = parser.parse_args()

    now = datetime.now()
    output_dir = Path(args.output) if args.output else OUTPUT_DIR

    if args.clear and LOCAL_CACHE_DIR.exists():
        shutil.rmtree(LOCAL_CACHE_DIR)
        print("캐시 삭제 완료\n")

    # Multi-year support
    if args.years:
        parts = args.years.split("-")
        start_year = int(parts[0])
        end_year = int(parts[-1])
        start_month = 1
        end_month = 12
    else:
        start_year = args.year
        end_year = args.year
        start_month = args.start_month
        end_month = args.end_month

    # 로그는 항상 익월 초에 도착하므로, 아직 오지 않은 당월/미래월까지
    # "미수신"으로 잡아 재전송 메일 대상에 넣는 걸 막는다.
    last_valid_year, last_valid_month = now.year, now.month - 1
    if last_valid_month == 0:
        last_valid_year -= 1
        last_valid_month = 12
    if (end_year, end_month) > (last_valid_year, last_valid_month):
        end_year, end_month = last_valid_year, last_valid_month
    if (start_year, start_month) > (end_year, end_month):
        start_year, start_month = end_year, end_month

    print(f"\n{'='*50}")
    print(f"  BWTS Fleet Dashboard")
    if start_year == end_year:
        print(f"  {start_year}년 {start_month}월 ~ "
              f"{end_month}월 ({len(VESSELS)}척)")
    else:
        print(f"  {start_year}년 ~ {end_year}년 "
              f"({len(VESSELS)}척)")
    print(f"{'='*50}\n")

    # Build fleet matrix
    print("분석 중...")
    matrix = build_fleet_matrix(
        start_year, start_month,
        end_year, end_month,
        verbose=args.verbose)

    # Stats
    all_summaries = [
        s for month_data in matrix.values()
        for s in month_data]

    latest_key = max(matrix.keys())
    latest = matrix[latest_key]
    grade_counts = {}
    for s in latest:
        g = s["grade"]
        grade_counts[g] = grade_counts.get(g, 0) + 1

    print(f"\n-- {latest_key[0]}년 {latest_key[1]}월 현황 --")
    for grade in ["운전양호", "점검필요", "수리후정상",
                   "미운전", "미수신", "데이터불량"]:
        cnt = grade_counts.get(grade, 0)
        if cnt > 0:
            print(f"  {grade}: {cnt}")

    # Generate mail drafts
    drafts = generate_mail_drafts(all_summaries)

    # Generate HTML
    html_path = output_dir / "BWTS_Fleet_Dashboard.html"
    generate_fleet_dashboard(matrix, drafts, html_path)

    print(f"\n  Dashboard: {html_path}")
    print(f"  분석: {len(all_summaries)} vessel-months")
    if drafts:
        print(f"  미수신 메일 초안: {len(drafts)}건")

    # Open in browser
    try:
        subprocess.Popen(
            ["powershell", "-Command",
             f'Start-Process "{html_path}"'])
    except Exception:
        pass

    print(f"\n완료.\n")


if __name__ == "__main__":
    main()
