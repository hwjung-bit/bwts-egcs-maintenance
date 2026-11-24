"""BWTS daily watch (관제): analyse new logs, evaluate rules, store a snapshot.

  python watch.py --dry-run          # no publish, no snapshot write, print hits
  python watch.py                    # weekday job (BWTS_daily_watch.bat)
  python watch.py --no-analyze       # skip run.py (rules + snapshot only)

Steps
  1. run.py <year> 1 <last month> --diff   — cache re-parses only folders that
     changed, so late logs are graded the day they land instead of next month.
     Exit 2 (a reviewed row would change) stops the publish; we alarm and go on
     with the DB as it is.
  2. evaluate() — pure rules over DB grades, open BWTS tasks, PMS ECU cleanings
     and BWTS calibrations -> hits (level 긴급/주의).
  3. upsert watch_snapshot(date, 'BWTS') read by the 🛰 관제 tab and by the
     Monday weekly_check mail; alarm only for 긴급 hits new since yesterday.
Task candidates are followup.plan_all() inserts; they are only shown (the tab
has a register button) until bwts_followup.enabled is switched on.
"""
import argparse
import json
import subprocess
import sys
from datetime import date, datetime
from pathlib import Path

import followup as fu
from thresholds import TH

W = TH["watch"]
HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
LOG_ROOT = Path(r"G:\공유 드라이브\고려에스엠 0033 공무팀 환경기술파트\011  BWTS\4. BWTS LOG DATA")
ALARM = Path(r"C:\Users\user\.claude\claude_alarm.ps1")
URG, WARN = "긴급", "주의"


def last_period(today):
    d = fu.add_months(today.replace(day=1), -1)
    return f"{d.year}-{d.month:02d}"


# ── rules (pure) ────────────────────────────────────────────────────
def hit(ship, kind, level, msg, tab, key=None):
    return {"ship": ship, "kind": kind, "level": level, "msg": msg, "tab": tab,
            "key": key or f"{kind}:{ship}"}


def log_hits(grades, ships, today):
    lp = last_period(today)
    out = []
    for s in ships:
        bp = grades.get(s, {})
        g = bp.get(lp, ("",))[0]
        if g in ("", "미수신"):
            if today.day > W["missing_urgent_day"]:
                out.append(hit(s, "미수신", URG, f"{lp} 로그 미수신 ({today.day}일 경과)", "bwtsLog"))
            elif today.day > W["missing_after_day"]:
                out.append(hit(s, "미수신", WARN, f"{lp} 로그 미수신 ({today.day}일 경과)", "bwtsLog"))
            continue
        if g == fu.BAD:
            n = fu.streak(bp, lp)
            why = ", ".join(bp[lp][1]) or "사유 없음"
            lv = URG if n >= fu.FU["repeat_urgent_months"] else WARN
            out.append(hit(s, "점검필요", lv,
                           f"{lp} 점검필요" + (f" {n}개월 연속" if n > 1 else "") + f" — {why}",
                           "bwtsLog"))
        elif g in ("데이터불량", "판독실패"):
            out.append(hit(s, g, WARN, f"{lp} {g} — 재검토 필요", "bwtsLog"))
    return out


def ecu_state(cleanings, techcross, today):
    """{ship: {last, due, over, baseline}} for techcross ships with PMS data."""
    st = {}
    for s in sorted(techcross):
        chem = [c for c in (cleanings or {}).get(s, []) if c[1] in ("chem", "baseline")]
        if not chem:
            continue
        real = [c for c in chem if c[1] == "chem"]
        last = (real or chem)[-1][0]
        due = fu.add_months(last, fu.FU["ecu_cycle_months"])
        st[s] = {"last": last.isoformat(), "due": due.isoformat(),
                 "over": (today - due).days, "baseline": not real}
    return st


def ecu_hits(ecu):
    return [hit(s, "ECU", URG, f"ECU chemical cleaning 미실시 — 마지막 {e['last']}"
                + (" (인도 기준)" if e["baseline"] else "") + f", 기한 {e['due']} +{e['over']}일",
                "bwtsLog") for s, e in ecu.items() if e["over"] > 0]


def task_hits(tasks, last_act, today):
    out = []
    for t in tasks:
        if t.get("status") == "보류":        # parked on purpose
            continue
        d = max(filter(None, [last_act.get(t["id"]), (t.get("date") or "")[:10]]), default="")
        if not d:
            continue
        idle = (today - date.fromisoformat(d)).days
        if idle >= W["stale_task_days"]:
            out.append(hit(t.get("ship_code") or "공통", "정체", WARN,
                           f"업무 '{t.get('title') or t['id']}' {idle}일째 조치 없음 ({t.get('status')})",
                           "work", key=f"정체:{t['id']}"))
    return out


def cal_hits(alerts):
    return [hit(a["ship"], "검교정", URG if a["level"] != "soon" else WARN,
                f"BWTS 검교정 {'만료' if a['days'] <= 0 else '임박'} — 기한 {a['due']} ({a['days']}일)",
                "bwtsCal") for a in alerts if a["level"] != "stale"]


def candidates(ops):
    """followup insert_task ops + their first action, ready for the tab button."""
    acts = {}
    for op in ops:
        if op[0] == "insert_action":
            acts.setdefault(op[1]["task_id"], op[1])
    return [{"task": op[1], "action": acts.get(op[1]["id"])}
            for op in ops if op[0] == "insert_task"]


def evaluate(grades, ships, tasks, last_act, cleanings, techcross, cal_alerts, ops, today):
    ecu = ecu_state(cleanings, techcross, today)
    hits = (log_hits(grades, ships, today) + ecu_hits(ecu)
            + task_hits(tasks, last_act, today) + cal_hits(cal_alerts))
    hits.sort(key=lambda h: (h["level"] != URG, h["ship"], h["kind"]))
    lp = last_period(today)
    by_ship = {}
    for s in ships:
        bp = grades.get(s, {})
        g = bp.get(lp, ("",))[0] or "미수신"
        by_ship[s] = {
            "log": {"period": lp, "grade": g,
                    "streak": fu.streak(bp, lp) if g == fu.BAD else 0},
            "ecu": ecu.get(s),
            "tasks": sum(1 for t in tasks if t["ship_code"] == s),
            "cal": next(({"due": a["due"], "days": a["days"]} for a in cal_alerts
                         if a["ship"] == s), None),
            "level": next((h["level"] for h in hits if h["ship"] == s), ""),
        }
    return {"ships": by_ship, "hits": hits, "candidates": candidates(ops)}


def diff(now_hits, old_hits):
    """(new, resolved) by key."""
    nk = {h["key"] for h in now_hits}
    ok = {h["key"] for h in old_hits}
    return ([h for h in now_hits if h["key"] not in ok],
            [h for h in old_hits if h["key"] not in nk])


# ── IO ──────────────────────────────────────────────────────────────
def analyze(today, dry_run):
    if not LOG_ROOT.exists():
        return "G: 드라이브 미연결 — 분석 생략"
    lp = last_period(today)
    cmd = [sys.executable, "-X", "utf8", "run.py", lp[:4], "1", lp[5:], "--diff"]
    if dry_run:
        cmd.append("--dry-run")
    r = subprocess.run(cmd, cwd=HERE, capture_output=True, text=True, encoding="utf-8",
                       errors="replace")
    tail = "\n".join((r.stdout or "").strip().splitlines()[-12:])
    print(tail)
    if r.returncode == 2:
        return "검토완료 행 등급 변경 감지 — publish 중단 (/bwts-review 확인)"
    if r.returncode != 0:
        return f"run.py 실패 rc={r.returncode}: {(r.stderr or '')[-300:]}"
    return ""


def fetch_rest(sb, today):
    tasks = sb.table("repairs").select("id,ship_code,title,status,date,origin,urgency") \
        .eq("system", "BWTS").neq("status", "완료").execute().data
    ids = [t["id"] for t in tasks]
    last = {}
    if ids:
        for a in sb.table("work_actions").select("task_id,date").in_("task_id", ids).execute().data:
            d = (a.get("date") or "")[:10]
            if d > last.get(a["task_id"], ""):
                last[a["task_id"]] = d
    ships = [s["code"] for s in sb.table("ships").select("code,bwts_maker,hidden").execute().data
             if s.get("bwts_maker") and not s.get("hidden")]
    sys.path.insert(0, str(REPO / "scripts"))
    import logging
    import weekly_cal_alert as wc
    logging.getLogger("httpx").setLevel(logging.WARNING)
    cal = wc.collect_bwts_alerts(wc.fetch_all(sb, "calibrations", ("system", "BWTS")), today)
    return tasks, last, sorted(ships), cal


def snapshot_on(sb, d):
    try:
        r = sb.table("watch_snapshot").select("payload").eq("system", "BWTS") \
            .lte("date", d.isoformat()).order("date", desc=True).limit(1).execute().data
    except Exception as e:          # table not created yet (sql/041)
        print(f"[경고] watch_snapshot 읽기 실패: {e}")
        return None
    return r[0]["payload"] if r else None


def alarm(msg):
    if ALARM.exists():
        subprocess.Popen(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                          str(ALARM), msg, "BWTS 관제"])


def run(dry_run=False, no_analyze=False, today=None):
    from publish_supabase import get_client
    today = today or date.today()
    note = "" if no_analyze else analyze(today, dry_run)
    sb = get_client()
    grades, ftasks, action_ids, tc = fu.fetch(sb)
    cleanings = fu.load_pms(today)
    tasks, last_act, ships, cal = fetch_rest(sb, today)
    ops = fu.plan_all(grades, ftasks, action_ids, cleanings, tc, today)
    if fu.FU.get("enabled") and not dry_run:
        fu.apply(sb, ops)          # auto mode: register instead of suggesting
        ops = []
    payload = evaluate(grades, ships, tasks, last_act, cleanings, tc, cal, ops, today)
    pms = Path(fu.FU["pms_json_path"])
    payload["meta"] = {
        "at": datetime.now().isoformat(timespec="minutes"), "note": note,
        "pms_at": datetime.fromtimestamp(pms.stat().st_mtime).isoformat(timespec="minutes")
        if pms.exists() else None,
        "pms_ok": cleanings is not None, "auto_register": bool(fu.FU.get("enabled")),
    }
    prev = snapshot_on(sb, today) or {"hits": []}     # last stored run (same-day reruns stay quiet)
    new, resolved = diff(payload["hits"], prev["hits"])
    print(f"\n관제 {today}: 긴급 {sum(h['level'] == URG for h in payload['hits'])} · "
          f"주의 {sum(h['level'] == WARN for h in payload['hits'])} · "
          f"후보 {len(payload['candidates'])} · 직전 대비 신규 {len(new)} 해결 {len(resolved)}")
    for h in payload["hits"]:
        print(f"  [{h['level']}] {h['ship']} {h['kind']:<5} {h['msg']}")
    if note:
        print(f"[참고] {note}")
    if dry_run:
        print("--dry-run: snapshot 저장 생략")
        return payload
    sb.table("watch_snapshot").upsert({"date": today.isoformat(), "system": "BWTS",
                                       "payload": payload}).execute()
    urgent_new = [h for h in new if h["level"] == URG]
    if urgent_new or note:
        alarm("BWTS 관제 — " + (note + " / " if note else "")
              + ", ".join(f"{h['ship']} {h['kind']}" for h in urgent_new[:6]))
    return payload


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="BWTS daily watch")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--no-analyze", action="store_true")
    a = ap.parse_args()
    run(dry_run=a.dry_run, no_analyze=a.no_analyze)
    sys.exit(0)
