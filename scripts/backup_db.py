"""Supabase 전 테이블을 JSON 으로 떠서 공유드라이브에 보관 (주간, 최근 12회 유지).

업무관리대장 흡수(2026-09-18) 이후 Supabase 가 업무·조치이력·BWTS 판정의 유일한
원본이다. 무료 플랜이라 대시보드 복원 백업이 없으므로 여기서 직접 뜬다.
전체 ~7MB, 몇 초.

  python scripts/backup_db.py                 # 기본 위치
  python scripts/backup_db.py D:\\임의경로     # 다른 위치
  env: SUPABASE_URL, SUPABASE_SERVICE_KEY (사용자 환경변수)

복원: 각 <table>.json 을 SQL Editor 나 supabase 클라이언트 upsert 로 되넣는다.
"""
import datetime as dt
import json
import os
import shutil
import sys
from pathlib import Path

from supabase import create_client

DEFAULT_DIR = Path(r"G:\공유 드라이브\고려에스엠 0033 공무팀 환경기술파트\관리대장_백업")
KEEP = 12
PAGE = 1000
TABLES = [
    "repairs", "work_actions", "ships", "calibrations", "status_history",
    "bwts_log_analysis", "bwts_reviews", "mail_log", "drive_folders",
    "folder_requests", "folder_trash_requests", "upload_requests",
    "app_thresholds", "sensor_cycles", "config",
]


def dump(sb, table):
    rows, start = [], 0
    while True:
        page = sb.table(table).select("*").range(start, start + PAGE - 1).execute().data or []
        rows += page
        if len(page) < PAGE:
            return rows
        start += PAGE


def main():
    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_KEY", "").strip()
    if not url or not key:
        print("SUPABASE_URL / SUPABASE_SERVICE_KEY 없음")
        return 1
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_DIR
    out = root / dt.date.today().isoformat()
    out.mkdir(parents=True, exist_ok=True)
    sb = create_client(url, key)

    total = 0
    for t in TABLES:
        rows = dump(sb, t)
        (out / f"{t}.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1, default=str),
                                       encoding="utf-8")
        total += len(rows)
        print(f"{t:22} {len(rows):5}")
    print(f"합계 {total}행 -> {out}")

    # 날짜 폴더만 남기고 오래된 것부터 정리
    olds = sorted(p for p in root.iterdir() if p.is_dir() and len(p.name) == 10 and p.name[4] == "-")
    for p in olds[:-KEEP]:
        shutil.rmtree(p, ignore_errors=True)
        print("삭제(오래됨):", p.name)
    return 0


if __name__ == "__main__":
    sys.exit(main())
