"""Trip 강등 반영 — 기존 점검필요 행에서 Trip 사유만 참고표시로 옮긴다.

원본 재파싱도, compute_grade 재실행도 하지 않는다 (compute_grade 만 돌리면
integrity.apply_matrix 의 판독실패 재분류가 사라지고 사유 문구가 통째로
바뀐다). 여기서는 grade_reasons 의 'Trip N건' 만 문자열로 걸러:
  - 남은 사유가 없으면      grade 점검필요 → 운전양호
  - TRO 등 다른 사유가 있으면 grade 유지, 사유에서 Trip 만 제거
어느 경우든 'Trip N건' 은 integrity.flags 로 옮긴다(⚙ 참고표시).
review_*·final_grade 는 건드리지 않는다.

  python scripts/regrade.py            # dry-run
  python scripts/regrade.py --write    # 실제 갱신
  env: SUPABASE_URL, SUPABASE_SERVICE_KEY
"""
import os
import re
import sys

from supabase import create_client

TRIP_RE = re.compile(r"^Trip \d+건$")
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
                .select("ship_code,period,grade,grade_reasons,integrity")
                .eq("grade", "점검필요")
                .range(start, start + PAGE - 1).execute().data or [])
        rows += page
        if len(page) < PAGE:
            break
        start += PAGE
    print(f"점검필요 {len(rows)}행 조회")

    changed, updates = [], []
    for r in rows:
        reasons = r.get("grade_reasons") or []
        trip = [x for x in reasons if TRIP_RE.match(x)]
        if not trip:
            continue
        rest = [x for x in reasons if not TRIP_RE.match(x)]
        new_grade = "점검필요" if rest else "운전양호"
        integ = dict(r.get("integrity") or {})
        flags = list(integ.get("flags") or [])
        for t in trip:
            if t not in flags:
                flags.append(t)
        integ["flags"] = flags
        changed.append((r["ship_code"], r["period"], r["grade"], new_grade,
                        "; ".join(rest) or "-", "; ".join(trip)))
        updates.append({"ship_code": r["ship_code"], "period": r["period"],
                        "grade": new_grade, "grade_reasons": rest, "integrity": integ})

    changed.sort()
    flips = sum(1 for c in changed if c[3] == "운전양호")
    print(f"\nTrip 사유 있는 행: {len(changed)} (→운전양호 {flips}, 점검필요 유지 {len(changed) - flips})\n")
    for c in changed:
        print(f"  {c[0]:4} {c[1]:7} {c[2]}->{c[3]:5} | 남은사유: {c[4][:45]:45} | ⚙ {c[5]}")

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
