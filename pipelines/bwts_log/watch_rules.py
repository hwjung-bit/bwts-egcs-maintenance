"""Fleet watch rules beyond BWTS (EGCS · 수신 · 연료/CII) + their G:/file readers.

Pure *_hits functions take already-read data so they test without G: or the DB.
Readers mirror the Gmail Auto Manager WeeklyReport.gs folder rules but read the
G: mount directly (listdir / names only, no file content except the AI txt).
Every hit gets the same shape as watch.hit(); COL maps kind -> matrix column.
"""
import json
import re
from datetime import date, timedelta
from pathlib import Path

from thresholds import TH

W = TH["watch"]
URG, WARN = "긴급", "주의"
ENV = Path(r"G:\공유 드라이브\고려에스엠 0033 공무팀 환경기술파트")
BUNKER_ROOT = ENV / "006  CII RATING" / "01.  주간 CII RATING (매주 작성)"
BSR_ROOT = ENV / "006  CII RATING" / "12. BUNKER SOUNDING REPORT" / "원본"
EGCS_LOG_ROOT = ENV / "025  SCRUBBER 업무" / "04  스크러버 로그 데이터"
WEEKLY_EXTRA = Path(r"D:\CLAUDE CODE\(활성) 주간 점검 보고\weekly_extra.json")
CODE_RE = re.compile(r"\b([A-Z]{3})\b")

# matrix columns (order = screen order)
COLS = ["BWTS 로그", "ECU", "BWTS 검교정", "EGCS 상태", "EGCS 검교정", "수신", "연료·CII", "업무"]
COL = {"미수신": "BWTS 로그", "점검필요": "BWTS 로그", "데이터불량": "BWTS 로그", "판독실패": "BWTS 로그",
       "ECU": "ECU", "검교정": "BWTS 검교정", "EGCS상태": "EGCS 상태", "EGCS검교정": "EGCS 검교정",
       "벙커미수신": "수신", "BSR미수신": "수신", "EGCS로그": "수신",
       "CII오류": "연료·CII", "BCM": "연료·CII", "XPERT": "연료·CII", "정체": "업무"}


def hit(ship, kind, level, msg, tab, key=None):
    return {"ship": ship, "kind": kind, "level": level, "msg": msg, "tab": tab,
            "key": key or f"{kind}:{ship}", "col": COL[kind]}


# ── EGCS ────────────────────────────────────────────────────────────
EGCS_PARTS = (("wms", "WMS"), ("cems", "CEMS"), ("body", "BODY"), ("etc", "기타"))


def egcs_status_hits(ships):
    """ships rows with egcs_*_status/memo. 문제 = 운전 불가 (긴급), 운용가능/수리중 = 주의."""
    out = []
    for s in ships:
        bad = []
        for col, name in EGCS_PARTS:
            st = (s.get(f"egcs_{col}_status") or "정상").strip()
            if st in ("", "정상", "-"):
                continue
            memo = (s.get(f"egcs_{col}_memo") or "").strip()
            bad.append((st, f"{name} {st}" + (f" ({memo[:40]})" if memo else "")))
        if bad:
            lv = URG if any(st == "문제" for st, _ in bad) else WARN
            out.append(hit(s["code"], "EGCS상태", lv, "EGCS " + " · ".join(t for _, t in bad), "status"))
    return out


def egcs_cal_hits(alerts):
    """weekly_cal_alert.collect_egcs_alerts rows -> one hit per ship (stale skipped)."""
    by = {}
    for a in alerts:
        if a["level"] != "stale":
            by.setdefault(a["ship"], []).append(a)
    out = []
    for s, al in sorted(by.items()):
        exp = [a for a in al if a["level"] == "expired"]
        parts = ", ".join(f"{a['sensor']} {a['kind']} {'만료' if a['days'] <= 0 else 'D-' + str(a['days'])}"
                          for a in sorted(al, key=lambda a: a["days"]))
        out.append(hit(s, "EGCS검교정", URG if exp else WARN, f"EGCS {parts}", "egcsCal"))
    return out


# ── 수신 ────────────────────────────────────────────────────────────
def bunker_hits(weeks, starts):
    """weeks: [(friday 'YYYY-MM-DD', {code: received bool})] newest first.
    Missing the newest week -> 주의, also the one before -> 긴급."""
    if not weeks:
        return []
    out = []
    f0, w0 = weeks[0]
    for code, ok in sorted(w0.items()):
        if ok or f0 < starts.get(code, ""):
            continue
        prev = weeks[1][1].get(code, True) if len(weeks) > 1 else True
        lv = URG if prev is False else WARN
        out.append(hit(code, "벙커미수신", lv,
                       f"BUNKER CONDITION REPORT 미수신 (~{f0})" + (" 2주 연속" if lv == URG else ""),
                       "links"))
    return out


def bsr_hits(last, today):
    """last: {code: latest BSR date or None}."""
    lim = W["bsr_missing_days"]
    out = []
    for code, d in sorted(last.items()):
        gap = (today - d).days if d else None
        if gap is None or gap > lim:
            out.append(hit(code, "BSR미수신", WARN,
                           f"BSR {lim}일 넘게 미수신 (마지막 {d.isoformat() if d else '없음'})", "bsr"))
    return out


def egcs_log_hits(have, today):
    """have: {code: set of 'YYYY-MM-DD'} for daily-report ships; last 7 days up to yesterday."""
    days = [(today - timedelta(days=i)).isoformat() for i in range(7, 0, -1)]
    out = []
    for code, got in sorted(have.items()):
        miss = [d[5:] for d in days if d not in got]
        if len(miss) >= W["egcs_daily_gap_days"]:
            out.append(hit(code, "EGCS로그", WARN,
                           f"EGCS 일일 로그 최근 7일 중 {len(miss)}일 없음 ({', '.join(miss)})", "links"))
    return out


# ── 연료 · CII ──────────────────────────────────────────────────────
AI_LINE = re.compile(r"^\[(?!해결)([^\]]+)\]\s+([A-Z]{3})\b")


def fuel_hits(ai_lines, ai_name, extra):
    """ai_lines: weekly bunker AI 오류 txt lines. extra: weekly_extra.json (xpert/bcm)."""
    by = {}
    for ln in ai_lines:
        m = AI_LINE.match(ln.strip())
        if m and "이상 아님" not in ln:
            by.setdefault(m.group(2), []).append(m.group(1))
    out = [hit(c, "CII오류", WARN, f"주간 벙커 AI 오류 {len(t)}건 ({', '.join(sorted(set(t)))}) — {ai_name}",
               "links") for c, t in sorted(by.items())]
    at = (extra or {}).get("at", "")[:10]
    for c, n in sorted((extra or {}).get("bcm", {}).items()):
        out.append(hit(c, "BCM", WARN, f"BCM CII 빨간 행 {n}건 ({at} 수집)", "links"))
    for c, x in sorted((extra or {}).get("xpert", {}).items()):
        worst = x.get("worst")
        lv = URG if worst is None or worst > 60 else WARN
        out.append(hit(c, "XPERT", lv, f"X-PERT 계측 지연 {x.get('bad')}/{x.get('total')}대, 최장 "
                       + (f"{worst}일" if worst is not None else "기록없음") + f" ({at} 수집)", "links"))
    return out


# ── readers (G: / local files) ──────────────────────────────────────
def _code(name):
    m = CODE_RE.search(name)
    return m.group(1) if m else None


def read_bunker(today):
    """Newest two '~YYYY-MM-DD' week folders up to today."""
    weeks = []
    for back in (0, 1):
        m = (today.replace(day=1) - timedelta(days=back * 28)).replace(day=1)
        mdir = BUNKER_ROOT / f"{m.year}년" / f"{m.month:02d}월"
        if not mdir.exists():
            continue
        for w in mdir.iterdir():
            if w.name.startswith("~") and w.name[1:] <= today.isoformat():
                weeks.append(w)
    out = []
    for w in sorted(set(weeks), key=lambda p: p.name, reverse=True)[:2]:
        cat = w / "1. 전 선박 BUNKER CONDITION REPORT"
        if not cat.exists():
            continue
        rec = {}
        for f in cat.iterdir():
            c = _code(f.name)
            if c:
                rec[c] = "(수신)" in f.name
        out.append((w.name[1:], rec))
    return out


BSR_FILE = re.compile(r"_BSR_(\d{8})")


def read_bsr():
    last = {}
    if not BSR_ROOT.exists():
        return last
    for d in BSR_ROOT.iterdir():
        c = _code(d.name)
        if not c or not d.is_dir():
            continue
        ds = [BSR_FILE.search(f.name).group(1) for f in d.iterdir() if BSR_FILE.search(f.name)]
        last[c] = date(int(max(ds)[:4]), int(max(ds)[4:6]), int(max(ds)[6:])) if ds else None
    return last


LOG_FILE = re.compile(r"DataLog_(\d{4})-?(\d{2})-?(\d{2})", re.I)


def read_egcs_logs(today, codes):
    """Daily-report ships only: CODE/YYYY/(MM월/)*DataLog_YYYY-MM-DD.csv|YYYYMMDD.pdf"""
    have = {}
    for c in codes:
        got = set()
        for y in {today.year, (today - timedelta(days=8)).year}:
            ydir = EGCS_LOG_ROOT / c / str(y)
            if ydir.exists():
                for f in ydir.rglob("*DataLog*"):
                    x = LOG_FILE.search(f.name)
                    if x:
                        got.add("-".join(x.groups()))
        have[c] = got
    return have


def read_ai_txt():
    txts = sorted(BUNKER_ROOT.glob("*년/*월/*/*AI 오류.txt"),
                  key=lambda p: (re.search(r"\((\d{4}-\d{2}-\d{2})\)", p.name) or [None, ""])[1])
    if not txts:
        return [], ""
    t = txts[-1]
    return t.read_bytes().decode("utf-8", "replace").splitlines(), t.name


def read_extra():
    try:
        return json.loads(WEEKLY_EXTRA.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
