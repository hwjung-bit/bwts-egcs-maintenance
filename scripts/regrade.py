"""저장된 summary 로 등급만 다시 매긴다 (원본 CSV 재파싱 없음).

Trip 강등(2026-09-21)처럼 판정 룰만 바뀌었을 때, 원본을 다시 안 읽고
bwts_log_analysis.summary 로 compute_grade 를 재실행해 grade/grade_reasons/
integrity.flags 를 갱신한다. review_*·final_grade 는 절대 건드리지 않는다
(disp = final_grade ?? grade 라 검토로 덮은 건 그대로 보인다).

  python scripts/regrade.py            # dry-run: 바뀔 행만 출력
  python scripts/regrade.py --write    # 실제 갱신
  env: SUPABASE_URL, SUPABASE_SERVICE_KEY
"""
import copy
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                "pipelines", "bwts_log"))
from fleet_summary import compute_grade  # noqa: E402
from supabase import create_client  # noqa: E402

PAGE = 1000


def main():
    write = "--write" in sys.argv
    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_KEY", "").strip()
    if not url or not key:
        print("SUPABASE_URL / SUPABASE_SERVICE_KEY 없음")
        return 1
    sb = create_client(url, key)

    rows, start = [], 0
    while True:
        page = (sb.table("bwts_log_analysis")
                .select("ship_code,period,grade,grade_reasons,summary,integrity")
                .range(start, start + PAGE - 1).execute().data or [])
        rows += page
        if len(page) < PAGE:
            break
        start += PAGE
    print(f"행 {len(rows)}개 조회")

    changed, updates = [], []
    for r in rows:
        sm = r.get("summary")
        if not sm:
            continue
        sm2 = copy.deepcopy(sm)
        try:
            grade, reasons = compute_grade(sm2)
        except Exception as e:  # noqa: BLE001
            print("skip", r["ship_code"], r["period"], "compute 실패:", e)
            continue
        flags = sm2.get("flags") or []
        old_grade = r.get("grade")
        old_reasons = r.get("grade_reasons") or []
        if grade == old_grade and reasons == old_reasons:
            continue
        changed.append((r["ship_code"], r["period"], old_grade, grade,
                        "; ".join(reasons) or "-"))
        integ = dict(r.get("integrity") or {})
        integ["flags"] = flags
        updates.append({"ship_code": r["ship_code"], "period": r["period"],
                        "grade": grade, "grade_reasons": reasons, "integrity": integ})

    changed.sort()
    print(f"\n바뀌는 행: {len(changed)}")
    for c in changed:
        print(f"  {c[0]:4} {c[1]:7} {c[2]:6} -> {c[3]:6}  {c[4][:60]}")

    if not write:
        print("\n--dry-run: 쓰기 없음 (--write 로 실제 갱신)")
        return 0

    for u in updates:
        sb.table("bwts_log_analysis").update(
            {"grade": u["grade"], "grade_reasons": u["grade_reasons"], "integrity": u["integrity"]}
        ).eq("ship_code", u["ship_code"]).eq("period", u["period"]).execute()
    print(f"\n{len(updates)}개 행 갱신 완료")
    return 0


if __name__ == "__main__":
    sys.exit(main())
