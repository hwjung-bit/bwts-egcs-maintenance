"""Vessel notice mail for one ship-month, built from the EventLog + alarm guide.

  python vessel_mail.py KTJ 2026-08                 # 한글, stdout
  python vessel_mail.py KTJ 2026-08 --lang ko_en    # 한글 + 영문 병기
  python vessel_mail.py KTJ 2026-08 --clip          # 클립보드 (제목 첫 줄 + 빈 줄 + 본문)
  python vessel_mail.py KTJ 2026-08 --out mail.txt

Reads the month's EVENTLOG.csv on G:, groups alarm codes, and writes the mail
the way the /mail skill does: 두괄식, [KMTC SM][ETP] 제목, 수신/발신 헤더,
■ 섹션, 1) 번호, 맺음말 없음. Guidance text and the 문제/특이 split come from
contracts/alarm_guide.json — nothing about a code is hardcoded here.

Env: SUPABASE_URL, SUPABASE_SERVICE_KEY (for the month's grade, chattering
and run counts). Without them the alarm section still works.
"""
import argparse
import json
import re
import sys
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

from config import VESSEL_BY_CODE, get_vessel_folder, get_csv_files
from csv_parser import parse_eventlog_csv

REPO = Path(__file__).resolve().parents[2]
GUIDE = json.loads((REPO / "contracts" / "alarm_guide.json").read_text(encoding="utf-8"))

SENDER = "KMTC SM ETP / 정현우 과장"
RECIPIENT_TITLES = "선장님, 기관장님"
REPLY_DAYS = 5
MAX_REQUEST_ITEMS = 3                      # 요청 사항에 코드로 적는 최대 건수
VALVE_CODES = {"CODE721", "CODE731"}       # 채터링과 같은 밸브 문제로 묶는 코드


def kind_count(g):
    """'트립 2회' 또는 '알람 4회' — 트립이 있으면 트립 수만 말한다."""
    return f"트립 {g['trips']}회" if g["trips"] else f"알람 {g['n']}회"


def kind_count_en(g):
    return f"trip {g['trips']}" if g["trips"] else f"alarm {g['n']}"


# ── data ────────────────────────────────────────────────────────────
def load_alarms(code, year, month):
    folder = get_vessel_folder(year, month, code)
    if not folder:
        return None, []
    files = get_csv_files(folder)
    ev = files.get("eventlog")
    if not ev:
        return folder, []
    return folder, parse_eventlog_csv(ev).get("alarms", [])


def load_row(code, period):
    try:
        from publish_supabase import get_client
        sb = get_client()
    except Exception:
        return None
    r = sb.table("bwts_log_analysis") \
        .select("grade,final_grade,grade_reasons,chattering,ballast_count,"
                "deballast_count,op_days,trip_count") \
        .eq("ship_code", code).eq("period", period).maybe_single().execute()
    return r.data if r else None


def guide_for(code, message):
    for e in GUIDE["codes"].get(code, []):
        if re.search(e["match"], message or "", re.I):
            return e
    return None


def category_of(code):
    return GUIDE["category"].get(code, {}).get("category", "특이")


def group_alarms(alarms):
    """code → {message, guide, n, trips, dates(set), devices(set), values}"""
    out = {}
    for a in alarms:
        code = a.get("code")
        if not code:
            continue
        desc = a.get("description") or ""
        g = guide_for(code, desc)
        # one bucket per guide entry (CODE100 has many), else per code
        key = (code, g["match"] if g else "")
        b = out.setdefault(key, {
            "code": code, "guide": g, "n": 0, "trips": 0,
            "dates": set(), "devices": set(), "tags": set(),
            "message": re.sub(r"\.?\s*\((?:T\d|LINE\d)\)", "",
                              re.sub(r"\s*\[.*$", "", desc)).rstrip(".").strip(),
        })
        b["n"] += 1
        if (a.get("level") or "").lower() == "trip":
            b["trips"] += 1
        if a.get("date"):
            b["dates"].add(str(a["date"])[:10].replace("-", "/")[5:])   # MM/DD
        if a.get("device"):
            b["devices"].add(a["device"])
        for m in re.findall(r"\[([^\]]+)\]", desc):
            if not m.upper().startswith("CODE") and not re.match(r"^[\d.]+$", m):
                b["tags"].add(m)           # valve numbers, PRU1 ...
    return list(out.values())


def chatter_lines(row):
    if not row or not row.get("chattering"):
        return []
    bl = json.loads((REPO / "contracts" / "thresholds.json").read_text(encoding="utf-8"))["bwts_log"]
    worth = [c for c in row["chattering"]
             if c.get("chatter_events", 0) >= bl["chatter_report_min_events"]]
    worth.sort(key=lambda c: -c["chatter_events"])
    return [f"{c['valve']} {c['chatter_events']:,}회" for c in worth]


# ── text ────────────────────────────────────────────────────────────
def fmt_dates(dates):
    ds = sorted(dates)
    return ", ".join(ds[:4]) + (f" 외 {len(ds) - 4}일" if len(ds) > 4 else "")


def build(code, period, lang="ko"):
    year, month = int(period[:4]), int(period[5:7])
    v = VESSEL_BY_CODE.get(code) or {"name": code}
    ship = v.get("name", code)
    ko_month = f"{year}년 {month}월"
    folder, alarms = load_alarms(code, year, month)
    row = load_row(code, period)
    groups = group_alarms(alarms)
    chat = chatter_lines(row)
    problems = sorted([g for g in groups if category_of(g["code"]) == "문제"],
                      key=lambda g: (-g["trips"], -g["n"]))
    unusual = sorted([g for g in groups if category_of(g["code"]) == "특이"],
                     key=lambda g: -g["n"])
    # 채터링이 있으면 밸브 코드(721/731)는 같은 문제라 밸브 블록에 합친다 —
    # 본선이 한 가지 밸브 문제를 세 항목으로 읽지 않게.
    valve_codes = []
    if chat:
        valve_codes = [g for g in problems if g["code"] in VALVE_CODES]
        problems = [g for g in problems if g["code"] not in VALVE_CODES]
    # 요청 사항은 상위 3건만 코드로 적고 나머지는 "그 외"로 — 두괄식 유지
    top = [g for g in problems if not (g["guide"] and g["guide"].get("notice"))]
    top, rest = top[:MAX_REQUEST_ITEMS], top[MAX_REQUEST_ITEMS:]
    reasons = (row or {}).get("grade_reasons") or []
    grade = (row or {}).get("final_grade") or (row or {}).get("grade") or ""
    reply_by = date.today() + timedelta(days=REPLY_DAYS)

    L = []
    L.append(f"수신 : {ship} / {RECIPIENT_TITLES}")
    L.append(f"발신 : {SENDER}")
    L.append("")
    L.append(f"업무에 수고가 많으십니다. {ko_month} BWTS 로그 확인 결과 하기 사항이 확인되어 "
             "점검과 조치를 요청드립니다.")
    L.append("")

    # ■ 요청 사항 — 문제점이 바로 보이게
    L.append("■ 요청 사항")
    n = 0
    if chat:
        n += 1
        valves = ", ".join(c.split()[0] for c in chat)
        stops = sum(g["n"] for g in valve_codes if g["code"] == "CODE731")
        extra = f" (밸브 원인 비정상 정지 {stops}회 포함)" if stops else ""
        L.append(f"{n}) 밸브 {valves} 개폐 신호 반복 원인 확인 및 수정{extra}")
    for g in top:
        n += 1
        tag = f" ({', '.join(sorted(g['tags']))})" if g["tags"] else ""
        L.append(f"{n}) [{g['code']}] {g['message']}{tag} {kind_count(g)} 점검 결과 회신")
    if rest:
        n += 1
        codes = "·".join(f"[{g['code']}]" for g in rest)
        L.append(f"{n}) 그 외 {codes} 알람 {len(rest)}종 점검 결과 회신 (하기 현상 참조)")
    if n == 0:
        L.append("1) 하기 특이 알람 발생 상황 확인 후 회신")
        n = 1
    L.append(f"{n + 1}) 회신 희망일 : {reply_by.year}년 {reply_by.month}월 {reply_by.day}일")
    L.append("")

    # ■ 확인된 현상
    L.append(f"■ {month}월 로그에서 확인된 현상")
    i = 0
    if chat:
        i += 1
        L.append(f"{i}) 밸브 개폐 신호 반복 : " + " / ".join(chat))
        for g in valve_codes:
            i += 1
            tag = f" [{', '.join(sorted(g['tags']))}]" if g["tags"] else ""
            L.append(f"{i}) [{g['code']}] {g['message']}{tag} : {kind_count(g)}, {fmt_dates(g['dates'])}")
    for g in problems:
        i += 1
        d = fmt_dates(g["dates"])
        tag = f" [{', '.join(sorted(g['tags']))}]" if g["tags"] else ""
        kind = f"트립 {g['trips']}회" if g["trips"] else f"알람 {g['n']}회"
        if g["trips"] and g["n"] > g["trips"]:
            kind += f" (알람 포함 {g['n']}회)"
        L.append(f"{i}) [{g['code']}] {g['message']}{tag} : {kind}, {d}")
    if reasons:
        for r_ in reasons:
            i += 1
            L.append(f"{i}) 분석 판정 사유 : {r_}")
    L.append("")

    # ■ 추정 원인 및 점검 방법 — 문제 코드만, 매뉴얼 참조 포함
    guided = [g for g in problems if g["guide"] and not g["guide"].get("notice")]
    if chat or guided:
        L.append("■ 추정 원인 및 점검 방법")
        k = 0
        if chat:
            k += 1
            L.append(f"{k}) 밸브 개폐 신호 반복")
            L.append("   현상 : 같은 밸브의 열림·닫힘 신호가 짧은 간격으로 반복됩니다.")
            L.append("   추정 : 밸브가 완전히 열리거나 닫힌 위치를 유지하지 못하고 있는 것으로 보입니다.")
            if valve_codes:
                ev = ", ".join(f"[{g['code']}] {g['message']} {g['n']}회" for g in valve_codes)
                L.append(f"   근거 : {ev} — 같은 밸브에서 발생, 한 가지 문제로 봅니다.")
            L.append("   점검 : 리미트 스위치 접점과 배선, 액추에이터 작동, 밸브 시트 이물질 고착 여부. "
                     "수동으로 완전 개폐 후 STATUS 신호가 안정되는지 확인")
            L.append("   참조 : ECS MANUAL p.39 STATUS 화면에서 해당 밸브 디지털 신호 확인")
        for g in guided:
            e = g["guide"]
            k += 1
            L.append(f"{k}) [{g['code']}] {g['message']}")
            L.append(f"   추정 : {e['cause']}")
            for j, c in enumerate(e.get("check", []), 1):
                L.append(f"   점검{j} : {c}")
            if e.get("ref") and e["ref"] != "—":
                L.append(f"   참조 : {e['ref']}")
        L.append("")

    # ■ 특이 알람 — 한 줄씩
    notices = unusual + [g for g in problems if g["guide"] and g["guide"].get("notice")]
    if notices:
        L.append("■ 특이 알람 (참고)")
        for j, g in enumerate(notices, 1):
            why = GUIDE["category"].get(g["code"], {}).get("why", "")
            L.append(f"{j}) [{g['code']}] {g['message']} {g['n']}회, {fmt_dates(g['dates'])} — {why}")
        L.append("")

    # ■ 점검 후에도 해결되지 않을 때
    L.append("■ 점검 후에도 해결되지 않을 때")
    for j, s in enumerate(GUIDE["common"]["when_unresolved"], 1):
        L.append(f"{j}) {s}")
    L.append(f"{len(GUIDE['common']['when_unresolved']) + 1}) 위 자료 확인 후 메이커 서비스 필요 여부를 판단하여 안내드리겠습니다.")
    L.append("")

    # ■ 참고 사항
    L.append("■ 참고 사항")
    p = 0
    if row:
        p += 1
        L.append(f"{p}) {month}월 운전 실적 : 밸러스트 {row.get('ballast_count', 0)}회, "
                 f"디밸러스트 {row.get('deballast_count', 0)}회, 운전일 {row.get('op_days', 0)}일"
                 + (f", 판정 {grade}" if grade else ""))
    if chat:
        p += 1
        L.append(f"{p}) 밸브 개폐 신호 반복은 BWTS 운전 등급과 별개의 점검 항목입니다.")
    if not folder:
        p += 1
        L.append(f"{p}) {month}월 로그 폴더가 확인되지 않아 EventLog 기반 항목은 비어 있습니다.")

    subject_core = []
    if chat:
        subject_core.append("밸브")
    if problems:
        subject_core.append(problems[0]["code"].replace("CODE", "코드"))
    subject = f"[KMTC SM][ETP] {ship} BWTS {month}월 로그 확인 및 조치 요청"
    body = "\n".join(L).rstrip() + "\n"

    if lang == "ko_en":
        body += "\n" + english_section(ship, period, chat, valve_codes, top, rest,
                                       problems, notices, reply_by)
    return subject, body


def english_section(ship, period, chat, valve_codes, top, rest, problems, notices, reply_by):
    E = ["----------------------------------------", "",
         f"TO : {ship} / Master, Chief Engineer",
         f"FR : KMTC SM ETP / Hyunwoo Jung", "",
         "Dear Master and Chief Engineer,", "",
         f"Our review of the BWTS log for {period} found the items below. "
         "Please check and reply with the result.", "",
         "■ Request"]
    n = 0
    if chat:
        n += 1
        stops = sum(g["n"] for g in valve_codes if g["code"] == "CODE731")
        extra = f" (caused {stops} abnormal stop(s))" if stops else ""
        E.append(f"{n}) Valve {', '.join(c.split()[0] for c in chat)}: find and fix the cause of the "
                 f"repeating open/close signal{extra}")
    for g in top:
        n += 1
        tag = f" ({', '.join(sorted(g['tags']))})" if g["tags"] else ""
        E.append(f"{n}) [{g['code']}] {g['message']}{tag}: {kind_count_en(g)} - check and report")
    if rest:
        n += 1
        E.append(f"{n}) Also check {', '.join('[' + g['code'] + ']' for g in rest)} "
                 f"({len(rest)} more alarm types, listed below)")
    E.append(f"{n + 1}) Reply requested by {reply_by.isoformat()}")
    E.append("")
    E.append("■ What the log shows")
    i = 0
    if chat:
        i += 1
        E.append(f"{i}) Repeating valve open/close signal: " + " / ".join(
            c.replace("회", " times") for c in chat))
    for g in valve_codes + problems:
        i += 1
        E.append(f"{i}) [{g['code']}] {g['message']}: {kind_count_en(g)}, {fmt_dates(g['dates'])}")
    E.append("")
    if chat:
        E.append("■ Valve signal")
        E.append("   The valve does not seem to hold a fully open or closed position, so the limit-switch "
                 "signal keeps repeating. Please check the limit switch contacts and wiring, the actuator "
                 "(control air if pneumatic) and any foreign matter on the seat. "
                 "See ECS MANUAL p.39, STATUS screen.")
        E.append("")
    if notices:
        E.append("■ Other alarms (for information)")
        for j, g in enumerate(notices, 1):
            E.append(f"{j}) [{g['code']}] {g['message']} {g['n']} time(s)")
        E.append("")
    E.append("■ If the problem remains after checking")
    E.append("1) Photo of the alarm list on the HMI ABNORMAL screen")
    E.append("2) Event log PDF for the period from the HMI LOG button (Troubleshooting Book 5.1 p.44)")
    E.append("")
    E.append("Best regards,")
    return "\n".join(E) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ship_code")
    ap.add_argument("period", help="YYYY-MM")
    ap.add_argument("--lang", choices=["ko", "ko_en"], default="ko")
    ap.add_argument("--clip", action="store_true", help="클립보드로 (제목 + 빈 줄 + 본문)")
    ap.add_argument("--out", help="파일로 저장")
    a = ap.parse_args()

    subject, body = build(a.ship_code.upper(), a.period, a.lang)
    text = subject + "\n\n" + body
    if a.out:
        Path(a.out).write_text(text, encoding="utf-8")
        print(f"saved: {a.out}")
    if a.clip:
        import subprocess
        subprocess.run(["powershell", "-NoProfile", "-Command", "Set-Clipboard -Value $input"],
                       input=text, text=True, encoding="utf-8")
        print("clipboard OK")
    if not a.out and not a.clip:
        sys.stdout.reconfigure(encoding="utf-8")
        print(text)


if __name__ == "__main__":
    main()
