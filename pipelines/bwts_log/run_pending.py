"""Analyze only the cells that were not fully received last time.

Web button 「📥 수신분 분석」 → kmtcfolder:bwts-run → this script (no Claude).

A cell is a candidate when it was never analyzed, or its reception was not
"full" (미수신·부분수신·null·zip·pdf 등) AND a file newer than the last
analysis has arrived in the vessel folder. Those caches are dropped and
run.py re-parses just those ships; every other month comes straight from
cache, so nothing else is redone.

  python run_pending.py            # 올해 1월 ~ 전월
  python run_pending.py --dry-run  # 대상만 출력
"""
import sys
import json
import argparse
import subprocess
from pathlib import Path

from config import VESSELS, in_service, get_vessel_folder
from fleet_summary import _cache_path
from run import clamp_to_last_month


def newest_file(folder):
    """Arrival time of the newest file in folder, 0 if none.

    Drive keeps the sender's mtime (can predate our last run); ctime is when
    the file landed on the drive, so take the later of the two."""
    if not folder or not folder.exists():
        return 0
    return max((max(st.st_mtime, st.st_ctime)
                for p in folder.rglob("*") if p.is_file()
                for st in [p.stat()]), default=0)


def find_pending(year, last_month):
    pending = {}            # code -> [month, ...]
    for month in range(1, last_month + 1):
        for v in VESSELS:
            code = v["code"]
            if not in_service(v, year, month):
                continue
            cp = _cache_path(code, year, month)
            if not cp.exists():
                # never analyzed: last month goes in even if still 미수신
                if month == last_month or newest_file(
                        get_vessel_folder(year, month, code)):
                    pending.setdefault(code, []).append(month)
                continue
            try:
                rec = json.loads(cp.read_text(encoding="utf-8"))
                if rec.get("reception") == "full":
                    continue
            except (json.JSONDecodeError, OSError):
                pass
            # 부분·미수신 칸: 지난 분석 뒤에 파일이 새로 들어왔을 때만
            if newest_file(get_vessel_folder(year, month, code)) > cp.stat().st_mtime:
                pending.setdefault(code, []).append(month)
    return pending


def main():
    ap = argparse.ArgumentParser(description="미분석 수신분만 분석")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    from datetime import datetime
    y = datetime.now().year
    y, _, ey, em = clamp_to_last_month(y, 1, y, 12)
    print(f"수신분 확인: {ey}-01 ~ {ey}-{em:02d}")
    pending = find_pending(ey, em)
    if not pending:
        print("\n새로 들어온 로그 없음 — 분석할 것 없음")
        return 0
    for code, months in sorted(pending.items()):
        print(f"  {code}: {', '.join(f'{m}월' for m in months)}")
    if args.dry_run:
        return 0

    for code, months in pending.items():
        for m in months:
            _cache_path(code, ey, m).unlink(missing_ok=True)
    # 1월부터 돌려야 integrity 이력 검사가 앞 달을 본다 (앞 달은 캐시라 빠름)
    cmd = [sys.executable, str(Path(__file__).with_name("run.py")),
           str(ey), "1", str(em), "--ships", ",".join(sorted(pending))]
    print("\n" + " ".join(cmd[1:]))
    return subprocess.call(cmd, cwd=Path(__file__).parent)


if __name__ == "__main__":
    sys.exit(main())
