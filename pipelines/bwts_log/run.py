"""BWTS log pipeline entry point: analyze → integrity → publish → export.

  python run.py                       # 2026-01 ~ 전월, 캐시 사용, publish
  python run.py --years 2024-2026     # 다년도 백필
  python run.py --dry-run             # Supabase 에 쓰지 않고 분포만 출력
  python run.py --clear               # 캐시 삭제 후 전체 재분석
  python run.py --html                # 레거시 HTML 도 out/ 에 생성

Replaces fleet_dashboard.py as the entry point; that file still works for
the desktop HTML but does not publish.

Cache invalidation: a cache file written by an older analyzer version is
re-parsed automatically (no more forgetting --clear after a rule change).
"""
import sys
import json
import shutil
import argparse
from datetime import datetime
from collections import Counter

from config import LOCAL_CACHE_DIR, OUTPUT_DIR, VESSELS
import fleet_summary
from fleet_summary import build_fleet_matrix
import integrity
from publish_supabase import publish, ANALYZER_VERSION


def _stamp_cache_version():
    """Wrap fleet_summary.needs_reparse so cache written by an older analyzer
    is treated as stale. Version is stored next to the cache as a marker."""
    marker = LOCAL_CACHE_DIR / ".analyzer_version"
    LOCAL_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    prev = marker.read_text(encoding="utf-8").strip() if marker.exists() else ""
    if prev != ANALYZER_VERSION:
        if prev:
            print(f"analyzer {prev} → {ANALYZER_VERSION}: 캐시 전체 재분석")
        for f in LOCAL_CACHE_DIR.glob("fleet_*.json"):
            f.unlink()
        marker.write_text(ANALYZER_VERSION, encoding="utf-8")


def clamp_to_last_month(start_year, start_month, end_year, end_month):
    """로그는 익월 초에 도착 — 당월/미래월은 미수신 오탐이므로 전월까지만."""
    now = datetime.now()
    ly, lm = now.year, now.month - 1
    if lm == 0:
        ly, lm = ly - 1, 12
    if (end_year, end_month) > (ly, lm):
        end_year, end_month = ly, lm
    if (start_year, start_month) > (end_year, end_month):
        start_year, start_month = end_year, end_month
    return start_year, start_month, end_year, end_month


def main():
    ap = argparse.ArgumentParser(description="BWTS log pipeline")
    ap.add_argument("year", nargs="?", type=int, default=2026)
    ap.add_argument("start_month", nargs="?", type=int, default=1)
    ap.add_argument("end_month", nargs="?", type=int, default=12)
    ap.add_argument("--years", type=str, help="다년도 예: 2024-2026")
    ap.add_argument("--clear", action="store_true", help="캐시 삭제 후 재분석")
    ap.add_argument("--dry-run", action="store_true", help="Supabase 쓰기 생략")
    ap.add_argument("--no-integrity", action="store_true", help="판독실패 검사 생략")
    ap.add_argument("--html", action="store_true", help="레거시 HTML 도 생성 (out/)")
    ap.add_argument("--no-export", action="store_true", help="공무팀 계약 JSON 내보내기 생략")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    if args.clear and LOCAL_CACHE_DIR.exists():
        shutil.rmtree(LOCAL_CACHE_DIR)
        print("캐시 삭제")
    _stamp_cache_version()

    if args.years:
        p = args.years.split("-")
        sy, sm, ey, em = int(p[0]), 1, int(p[-1]), 12
    else:
        sy, sm, ey, em = args.year, args.start_month, args.year, args.end_month
    sy, sm, ey, em = clamp_to_last_month(sy, sm, ey, em)

    print(f"BWTS log pipeline  {sy}-{sm:02d} ~ {ey}-{em:02d}  ({len(VESSELS)}척)  {ANALYZER_VERSION}")
    matrix = build_fleet_matrix(sy, sm, ey, em, verbose=args.verbose)
    rows = [s for key in sorted(matrix) for s in matrix[key]]
    # cached months already carry the integrity re-grade; report the rule grade
    before = Counter(s.get("grade_rule") or s["grade"] for s in rows)

    regraded = 0
    if not args.no_integrity:
        regraded = integrity.apply_matrix(matrix)
        # persist integrity result into cache so the web/skill see the same thing
        for s in rows:
            cp = fleet_summary._cache_path(s["code"], s["year"], s["month"])
            try:
                with open(cp, "w", encoding="utf-8") as f:
                    json.dump(s, f, ensure_ascii=False, indent=1, default=fleet_summary._json_serial)
            except OSError:
                pass
    after = Counter(s["grade"] for s in rows)

    print(f"\n{len(rows)} vessel-months")
    print("  룰 판정   :", dict(before))
    print("  integrity :", dict(after), f"(재판정 {regraded}건)")
    if regraded and args.verbose:
        for s in rows:
            if s["grade"] == integrity.GRADE_UNREADABLE:
                print(f"   - {s['code']} {s['year']}-{s['month']:02d} "
                      f"{s.get('grade_rule')}→판독실패 {s['integrity']['hits']}")

    if args.html:
        from fleet_html import generate_fleet_dashboard
        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        out = generate_fleet_dashboard(matrix, OUTPUT_DIR)
        print(f"  HTML: {out}")

    if args.dry_run:
        print("\n--dry-run: Supabase 쓰기 생략")
        return 0
    n = publish(rows, verbose=args.verbose)
    print(f"\nSupabase bwts_log_analysis upsert {n}건 완료")
    if not args.no_export:
        try:
            import export_contract
            sb = export_contract.get_client()
            export_contract.sync_thresholds(sb)
            out = export_contract.export(sb, verbose=args.verbose)
            print(f"공무팀 계약 JSON → {out}")
        except Exception as e:   # export is secondary — never fail the publish
            print(f"[경고] 계약 JSON 내보내기 실패: {e}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
