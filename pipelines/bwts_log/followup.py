"""BWTS log follow-up loop: grade -> task -> PMS ECU cleaning -> next-month check.

Turns monthly log grades into tasks in `repairs` (the work table, sql/027) and
records every automatic step in `work_actions`, so a 점검필요 month is tracked
until a later log shows the system healthy again.

  python followup.py --dry-run     # print planned changes only
  python followup.py               # apply (service key)

Rules (contracts/thresholds.json -> bwts_followup):
  log task  BL_<ship>_<YYYY-MM>   opened by 점검필요, closed by 운전양호/수리후정상
  ECU task  BE_<ship>_<last date>  opened when ECU chemical cleaning is older than
                                    ecu_cycle_months, closed by a newer cleaning
Smart Platform alarms are entered by hand in the 업무 tab (origin 스마트플랫폼)
and join the same loop. All ids are deterministic, so re-running is a no-op.
"""
import argparse
import importlib.util
import json
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

from thresholds import TH

FU = TH["bwts_followup"]
LOG_ORIGINS = ("로그분석", "스마트플랫폼")
ALL_ORIGINS = LOG_ORIGINS + ("PMS",)
BAD = "점검필요"
GOOD = ("운전양호", "수리후정상")


# ── helpers ─────────────────────────────────────────────────────────
def add_months(d, n):
    y, m = divmod(d.month - 1 + n, 12)
    y += d.year
    last = [31, 29 if y % 4 == 0 else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m]
    return date(y, m + 1, min(d.day, last))


def prev_period(p):
    d = add_months(date(int(p[:4]), int(p[5:7]), 1), -1)
    return f"{d.year}-{d.month:02d}"


def streak(by_period, p):
    """Consecutive 점검필요 months ending at period p."""
    n = 0
    while by_period.get(p, ("",))[0] == BAD:
        n += 1
        p = prev_period(p)
    return n


def task_start(t):
    """First log period that may update this task."""
    if t["id"].startswith("BL_"):
        return t["id"][-7:]                  # months after the trigger month
    return (t.get("date") or "")[:7]         # manual: registration month onward


class Plan:
    """Collects ops and keeps an in-memory view so later rules see earlier ones."""

    def __init__(self, tasks, action_ids, today):
        self.tasks = {t["id"]: dict(t) for t in tasks}
        self.action_ids = set(action_ids)
        self.today = today
        self.ops = []

    def open_log_task(self, ship):
        ts = [t for t in self.tasks.values() if t["ship_code"] == ship
              and t.get("origin") in LOG_ORIGINS and t.get("status") != "완료"]
        return max(ts, key=lambda t: t.get("date") or "") if ts else None

    def open_ecu_task(self, ship):
        ts = [t for t in self.tasks.values() if t["ship_code"] == ship
              and t["id"].startswith("BE_") and t.get("status") != "완료"]
        return ts[0] if ts else None

    def new_task(self, row):
        base = {"system": "BWTS", "date": self.today.isoformat(), "status": "대기",
                "progress": 0, "detail": "", "note": "", "source": "", "requester": ""}
        row = {**base, **row}
        row["symptom"] = row["title"]        # 이력 탭이 symptom 을 읽는다 (work.js 미러 규칙)
        self.tasks[row["id"]] = row
        self.ops.append(("insert_task", row))
        return row

    def act(self, aid, task, note, progress=None):
        if aid in self.action_ids:
            return False
        self.action_ids.add(aid)
        self.ops.append(("insert_action", {"id": aid, "task_id": task["id"],
                         "date": self.today.isoformat(), "progress": progress,
                         "note": note, "author": "followup"}))
        self.patch(task, {"last_action": note, "action": note})
        return True

    def patch(self, task, patch):
        patch = {k: v for k, v in patch.items() if task.get(k) != v}
        if patch:
            task.update(patch)
            self.ops.append(("patch_task", task["id"], patch))

    def close(self, task, aid, note):
        if self.act(aid, task, note, 100):
            self.patch(task, {"status": "완료", "progress": 100,
                              "completed_at": self.today.isoformat()})


# ── log rules ───────────────────────────────────────────────────────
def plan_log(plan, ship, by_period, start):
    """by_period: {period: (display_grade, reasons)}"""
    review_recheck(plan, ship, by_period)
    for p in sorted(x for x in by_period if x >= start):
        g, reasons = by_period[p]
        aid = f"wa_BL_{ship}_{p}"
        t = plan.open_log_task(ship)
        if t and p < task_start(t) or (t and t["id"] == f"BL_{ship}_{p}"):
            continue
        if g == BAD:
            n = streak(by_period, p)
            urg = "상" if n >= FU["repeat_urgent_months"] else "중"
            why = ", ".join(reasons) or "사유 없음"
            if t:
                plan.act(aid, t, f"로그 {p}: 여전히 점검필요 ({n}개월 연속) — {why}")
                if urg == "상":
                    plan.patch(t, {"urgency": "상"})
            elif f"BL_{ship}_{p}" not in plan.tasks:
                t = plan.new_task({
                    "id": f"BL_{ship}_{p}", "ship_code": ship, "origin": "로그분석",
                    "category": "점검", "equip": "BWTS", "urgency": urg,
                    "title": f"BWTS 로그 점검필요 {p}" + (f" ({n}개월 연속)" if n > 1 else ""),
                    "detail": why})
                plan.act(aid, t, f"로그 {p}: 점검필요 — {why}")
        elif t and g in GOOD:
            plan.close(t, aid, f"로그 {p}: {g} — 회복 확인, 자동 완료")
        elif t:
            plan.act(aid, t, f"로그 {p}: {g} — 판정 보류")


def review_recheck(plan, ship, by_period):
    """A BL_ task left untouched (대기) whose trigger month was re-graded healthy."""
    for t in list(plan.tasks.values()):
        if not t["id"].startswith(f"BL_{ship}_") or t.get("status") != "대기":
            continue
        p = t["id"][-7:]
        g = by_period.get(p, ("",))[0]
        if g in GOOD:
            plan.close(t, f"wa_BL_{ship}_{p}_rv", f"재검토 결과 {p} {g} — 자동 완료")


# ── PMS rules ───────────────────────────────────────────────────────
def load_judge(pms_path):
    """Reuse export_excel.judge() from the PMS collector (실시/점검만/미실시…)."""
    src = Path(pms_path).parent / "export_excel.py"
    spec = importlib.util.spec_from_file_location("pms_export_excel", src)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.judge


def ecu_cleanings(rows, judge):
    """{ship: [(date, kind, card, interval, remark, mcard)]} — 실시 rows only.
    kind: chem | strainer | baseline (new-building PMS start, used as last date
    only when no real cleaning exists)."""
    out = {}
    for r in rows:
        card, work = r.get("card") or "", r.get("work") or ""
        up = card.upper()
        if "ECU" not in up or "CLEAN" not in up or not work:
            continue
        j = judge(r.get("remark"))
        kind = "strainer" if "STRAINER" in up else "chem"
        if j == "설치/인도" or "BASELINE" in (r.get("remark") or "").upper():
            kind = "baseline"
        elif j != "실시":
            continue
        out.setdefault(r["vsl"], []).append(
            (date.fromisoformat(work), kind, card, r.get("interval") or "",
             " ".join((r.get("remark") or "").split())[:50], r.get("mcard_no") or ""))
    for v in out.values():
        v.sort()
    return out


def plan_pms_link(plan, ship, cleanings):
    """Record cleanings done while a log task is open; 대기/확인 → 진행."""
    for t in [t for t in plan.tasks.values() if t["ship_code"] == ship
              and t.get("origin") in LOG_ORIGINS]:
        if t["id"].startswith("BL_"):
            lo = date.fromisoformat(t["id"][-7:] + "-01")
        else:
            lo = date.fromisoformat(t["date"])
        hi = date.fromisoformat(t["completed_at"]) if t.get("completed_at") else plan.today
        for d, kind, card, _, remark, mc in cleanings:
            if kind == "baseline" or not lo <= d <= hi:
                continue
            note = f"PMS: {card} {d.isoformat()} — {remark}"
            if plan.act(f"wa_PMS_{t['id']}_{mc}_{d.isoformat()}", t, note) \
                    and t.get("status") in ("대기", "확인"):
                plan.patch(t, {"status": "진행"})


def plan_ecu_cycle(plan, ship, cleanings):
    chem = [c for c in cleanings if c[1] in ("chem", "baseline")]
    real = [c for c in chem if c[1] == "chem"]
    if not chem:
        return
    last = (real or chem)[-1][0]
    due = add_months(last, FU["ecu_cycle_months"])
    t = plan.open_ecu_task(ship)
    if t:
        prev = date.fromisoformat(t["id"][-10:])
        if last > prev:
            c = real[-1]
            plan.close(t, f"wa_BE_{ship}_{last.isoformat()}",
                       f"PMS: {c[2]} {last.isoformat()} 실시 — {c[4]} — 자동 완료")
            t = None
    if not t and plan.today > due and f"BE_{ship}_{last.isoformat()}" not in plan.tasks:
        what = "마지막" if real else "인도 후 실시 기록 없음, 기준"
        t = plan.new_task({
            "id": f"BE_{ship}_{last.isoformat()}", "ship_code": ship, "origin": "PMS",
            "category": "PMS", "equip": "ECU", "urgency": "상",
            "due_date": due.isoformat(),
            "title": f"ECU CHEMICAL CLEANING 미실시 — {what} {last.isoformat()}",
            "detail": f"주기 {FU['ecu_cycle_months']}개월, 기한 {due.isoformat()} 경과. "
                      "본선 즉시 실시 후 PMS 기록 요청"})
        plan.act(f"wa_BE_{ship}_{last.isoformat()}_open", t,
                 f"PMS {plan.today.isoformat()} 기준 기한 {due.isoformat()} 경과")


def interval_mismatch(cleanings):
    want = f"M{FU['ecu_cycle_months']}"
    return sorted({(s, c[3]) for s, cs in cleanings.items() for c in cs
                   if c[1] == "chem" and c[3] and c[3] != want})


# ── entry ───────────────────────────────────────────────────────────
def plan_all(grades, tasks, action_ids, cleanings, techcross, today):
    plan = Plan(tasks, action_ids, today)
    for ship in sorted(grades):
        plan_log(plan, ship, grades[ship], FU["start_period"])
    if cleanings is not None:
        for ship in sorted(set(grades) | set(cleanings)):
            cs = cleanings.get(ship, [])
            plan_pms_link(plan, ship, cs)
            if ship in techcross:
                plan_ecu_cycle(plan, ship, cs)
    return plan.ops


def fetch(sb):
    lo = prev_period(prev_period(FU["start_period"]))
    rows = []
    for yr in range(int(lo[:4]) - 1, date.today().year + 1):   # streak needs history
        rows += sb.table("bwts_log_analysis").select(
            "ship_code,period,grade,final_grade,grade_reasons").like(
            "period", f"{yr}-%").execute().data
    grades = {}
    for r in rows:
        grades.setdefault(r["ship_code"], {})[r["period"]] = (
            r["final_grade"] or r["grade"], r["grade_reasons"] or [])
    tasks = sb.table("repairs").select("*").in_("origin", list(ALL_ORIGINS)).execute().data
    ids = [t["id"] for t in tasks]
    acts = sb.table("work_actions").select("id").in_("task_id", ids).execute().data if ids else []
    ships = sb.table("ships").select("code,bwts_maker").execute().data
    tc = {s["code"] for s in ships if "테크로스" in (s.get("bwts_maker") or "")
          or "TECHCROSS" in (s.get("bwts_maker") or "").upper()}
    return grades, tasks, [a["id"] for a in acts], tc


def load_pms(today):
    p = Path(FU["pms_json_path"])
    if not p.exists():
        print(f"[경고] PMS 파일 없음: {p} — PMS 단계 생략")
        return None
    age = (today - datetime.fromtimestamp(p.stat().st_mtime).date()).days
    if age > FU["pms_max_age_days"]:
        print(f"[경고] PMS 파일 {age}일 지남 (> {FU['pms_max_age_days']}) — 오래된 자료로 판단 안 함. "
              f"'{p.parent / 'run.bat'}' 로 재수집 후 다시 실행")
        return None
    rows = json.load(open(p, encoding="utf-8"))["rows"]
    print(f"PMS {p.name}: {len(rows)}행, 수집 {age}일 전")
    return ecu_cleanings(rows, load_judge(p))


def apply(sb, ops):
    for op in ops:
        if op[0] == "insert_task":
            sb.table("repairs").insert(op[1]).execute()
        elif op[0] == "insert_action":
            sb.table("work_actions").insert(op[1]).execute()
        else:
            sb.table("repairs").update(op[2]).eq("id", op[1]).execute()


def print_ops(ops):
    for op in ops:
        if op[0] == "insert_task":
            r = op[1]
            print(f"  + 업무 {r['id']:<24} [{r['urgency']}] {r['title']}")
        elif op[0] == "insert_action":
            print(f"    · 조치 {op[1]['task_id']:<22} {op[1]['note'][:90]}")
        elif "status" in op[2]:
            print(f"    → 상태 {op[1]:<22} {op[2]['status']}")


def run(dry_run=False, today=None):
    from publish_supabase import get_client
    today = today or date.today()
    sb = get_client()
    grades, tasks, action_ids, tc = fetch(sb)
    cleanings = load_pms(today)
    ops = plan_all(grades, tasks, action_ids, cleanings, tc, today)
    print(f"\n후처리 계획 {len(ops)}건 (기준 {today}, 시작 {FU['start_period']})")
    print_ops(ops)
    if cleanings:
        mm = interval_mismatch(cleanings)
        if mm:
            print(f"\n[참고] PMS ECU chemical 카드 주기가 M{FU['ecu_cycle_months']} 아님: "
                  + ", ".join(f"{s}={iv}" for s, iv in mm))
    if dry_run:
        print("--dry-run: 쓰기 생략")
    elif ops:
        apply(sb, ops)
        print(f"적용 완료 {len(ops)}건")
    return ops


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="BWTS log follow-up")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    run(dry_run=a.dry_run)
    sys.exit(0)
