"""BWTS log pipeline entry point: analyze → integrity → publish → export.

  python run.py                       # 2026-01 ~ 전월, 캐시 사용, publish
  python run.py --years 2024-2026     # 다년도 백필
  python run.py --dry-run             # Supabase 에 쓰지 않고 분포만 출력
  python run.py --clear               # 캐시 삭제 후 전체 재분석
  python run.py --html                # 레거시 HTML 도 out/ 에 생성
  python run.py 2026 1 8 --ships KCB  # 한 척만 (이력 유지 위해 1월부터)

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


def diff_against_db(rows):
    """publish 하면 등급이 바뀌는 셀을 (자동분, 검토완료분) 으로 나눠 돌려준다.

    검토완료분이 하나라도 있으면 위험 신호다 — 사람이나 이전 재검토가 이미
    판단을 내린 셀의 근거가 파서 변경으로 소리 없이 뒤집힌다는 뜻이므로."""
    from publish_supabase import get_client
    sb = get_client()
    periods = sorted({f"{s['year']}-{s['month']:02d}" for s in rows})
    if not periods:
        return [], []
    cur = {}
    got = sb.table("bwts_log_analysis") \
        .select("ship_code,period,grade,final_grade,review_status") \
        .gte("period", periods[0]).lte("period", periods[-1]) \
        .execute().data or []
    for r in got:
        cur[(r["ship_code"], r["period"])] = r
    auto_changed, reviewed_changed = [], []
    for s in rows:
        old = cur.get((s["code"], f"{s['year']}-{s['month']:02d}"))
        if not old or old["grade"] == s["grade"]:
            continue
        rec = (s["code"], f"{s['year']}-{s['month']:02d}",
               old["grade"], s["grade"], old["review_status"])
        if old["review_status"] == "auto":
            auto_changed.append(rec)
        elif old.get("final_grade") == s["grade"]:
            # 자동 판정이 검토자의 결론을 뒤늦게 따라잡은 경우 — 뒤집는 게
            # 아니라 수렴이므로 막지 않는다. 화면은 final_grade 를 쓰므로
            # 보이는 등급도 그대로다.
            auto_changed.append(rec)
        else:
            reviewed_changed.append(rec)
    return auto_changed, reviewed_changed


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
    ap.add_argument("--diff", action="store_true",
                    help="publish 전 DB 대비 등급 변동 출력. 검토완료 행이 바뀌면 종료코드 2")
    ap.add_argument("--ships", type=str,
                    help="선박 코드 일부만 예: KCB,KSG (미지정=전체). "
                         "이력 판정 때문에 시작월은 1월로 두는 것이 안전")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    ship_codes = None
    if args.ships:
        known = {v["code"] for v in VESSELS}
        ship_codes = [c.strip().upper() for c in args.ships.split(",") if c.strip()]
        unknown = [c for c in ship_codes if c not in known]
        if unknown:
            print(f"알 수 없는 선박 코드: {', '.join(unknown)}")
            return 2
        # 부분 실행마다 전체 테이블을 다시 읽어 계약 JSON 을 쓰는 것은 낭비
        args.no_export = True

    if args.clear and LOCAL_CACHE_DIR.exists():
        if ship_codes:          # 부분 실행이 나머지 선박 캐시까지 날리면 안 된다
            for c in ship_codes:
                for f in LOCAL_CACHE_DIR.glob(f"fleet_*_{c}.json"):
                    f.unlink()
            print(f"캐시 삭제: {','.join(ship_codes)}")
        else:
            shutil.rmtree(LOCAL_CACHE_DIR)
            print("캐시 삭제")
    _stamp_cache_version()

    if args.years:
        p = args.years.split("-")
        sy, sm, ey, em = int(p[0]), 1, int(p[-1]), 12
    else:
        sy, sm, ey, em = args.year, args.start_month, args.year, args.end_month
    sy, sm, ey, em = clamp_to_last_month(sy, sm, ey, em)

    if ship_codes and sm != 1 and not args.no_integrity:
        print(f"[주의] {sm}월부터 시작 — integrity 이력 검사가 이전 달을 못 본다. "
              f"부분 재분석은 '{sy} 1 {em} --ships …' 로 돌릴 것")
    scope = f"{len(ship_codes)}척 {','.join(ship_codes)}" if ship_codes else f"{len(VESSELS)}척"
    print(f"BWTS log pipeline  {sy}-{sm:02d} ~ {ey}-{em:02d}  ({scope})  {ANALYZER_VERSION}")
    matrix = build_fleet_matrix(sy, sm, ey, em, verbose=args.verbose,
                                ship_codes=ship_codes)
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

    if args.diff:
        auto_changed, reviewed_changed = diff_against_db(rows)
        print(f"\n등급 변동 (DB 대비): 자동 {len(auto_changed)}건 · "
              f"검토완료 {len(reviewed_changed)}건")
        for c, p, a, b, _ in auto_changed:
            print(f"   {c} {p}: {a} → {b}")
        for c, p, a, b, st in reviewed_changed:
            print(f"   [검토완료:{st}] {c} {p}: {a} → {b}")
        if reviewed_changed:
            print("[중단] 검토완료 행의 등급이 바뀐다 — 파서 수정을 되돌리고 재검토")
            return 2

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
            export_contract.export_legacy_snapshot(sb, verbose=args.verbose)
        except Exception as e:   # export is secondary — never fail the publish
            print(f"[경고] 계약 JSON 내보내기 실패: {e}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
