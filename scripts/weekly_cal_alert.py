"""
Weekly Calibration Expiry Alert — Supabase → Gmail SMTP

GitHub Actions cron으로 매주 월요일 KST 08:00 실행.
BWTS/EGCS 검교정 만료·임박 항목을 집계하여 HTML 메일 발송.

환경변수:
  GMAIL_USER          — Gmail 계정 (기본: hwjung@ekmtc.com)
  GMAIL_APP_PASSWORD  — Google 앱 비밀번호 (16자리)
  SUPABASE_URL
  SUPABASE_SERVICE_KEY
  ALERT_TO            — 수신자 이메일 (기본: GMAIL_USER)
"""

import calendar
import logging
import os
import smtplib
import sys
from datetime import date, datetime, timedelta, timezone
from email.mime.text import MIMEText

from supabase import create_client

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger(__name__)

GMAIL_USER = os.environ.get("GMAIL_USER", "hwjung@ekmtc.com")
GMAIL_APP_PW = os.environ.get("GMAIL_APP_PASSWORD", "")
ALERT_TO = os.environ.get("ALERT_TO", "") or GMAIL_USER

# Thresholds — single source contracts/thresholds.json (shared with the web
# app and pipelines/bwts_log). Hardcoding them here again is how the screen
# and this alert drifted apart before.
import json
from pathlib import Path
_TH = json.load(open(Path(__file__).resolve().parents[1] / "contracts" / "thresholds.json",
                     encoding="utf-8"))
BWTS_INTERVAL = _TH["bwts_calibration"]["interval_months"]
BWTS_SOON_DAYS = _TH["bwts_calibration"]["soon_days"]
SENSOR_CYCLE = _TH["egcs_calibration"]["sensor_cycle_months"]   # {model: {cal, repl}}
EGCS_SOON_DAYS = _TH["egcs_calibration"]["soon_days"]

KST = timezone(timedelta(hours=9))


def get_supabase():
    url = os.environ.get("SUPABASE_URL", "")
    key = os.environ.get("SUPABASE_SERVICE_KEY", "")
    if not url or not key:
        log.error("SUPABASE_URL or SUPABASE_SERVICE_KEY not set")
        sys.exit(1)
    return create_client(url, key)


def add_months(d, months):
    """Add months to a date object."""
    month = d.month - 1 + months
    year = d.year + month // 12
    month = month % 12 + 1
    # Clamp to the target month's real last day — truncating to 28
    # would move a 29th–31st due date up to 3 days early.
    day = min(d.day, calendar.monthrange(year, month)[1])
    return date(year, month, day)


def get_ship_wms(ships_map, code):
    s = ships_map.get(code, {})
    w = (s.get("wms") or "").upper()
    if "TRI" in w:
        return "TRIOS"
    if "GI" in w or "GREEN" in w:
        return "GI"
    return ""


def sensor_model(ships_map, code, equip, model):
    maker = get_ship_wms(ships_map, code)
    equip_upper = (equip or "").upper()
    if "PAH" in equip_upper:
        kind = "PAH"
    elif "TURB" in equip_upper:
        kind = "TURB"
    else:
        kind = "PH"

    if maker == "TRIOS":
        return {
            "PAH": "enviroFlu",
            "TURB": "TTurb",
            "PH": "TpH-D",
        }[kind]
    if maker == "GI":
        if kind == "TURB":
            return "G6120"
        if kind == "PH":
            return "G6130"
        if model and model in SENSOR_CYCLE:
            return model
        return None
    return None


def collect_bwts_alerts(calibrations, today):
    """BWTS: 만료(<=0일) + 임박(<=60일)"""
    alerts = []
    for c in calibrations:
        if not c.get("last_date"):
            continue
        last = date.fromisoformat(str(c["last_date"]))
        due = add_months(last, BWTS_INTERVAL)
        days = (due - today).days
        if days <= BWTS_SOON_DAYS:
            alerts.append({
                "ship": c["ship_code"],
                "equip": "BWTS 연간",
                "kind": "검교정",
                "due": due.isoformat(),
                "days": days,
                "level": "expired" if days <= 0 else "soon",
            })
    alerts.sort(key=lambda a: a["days"])
    return alerts


def collect_egcs_alerts(calibrations, ships_map, today):
    """EGCS: 검교정/신환 만료(<=0일) + 임박(<=30일)"""
    alerts = []
    skipped = 0
    for c in calibrations:
        if not c.get("last_date"):
            continue
        last = date.fromisoformat(str(c["last_date"]))
        equip = (c.get("equip") or "").replace("-", "/")
        sm = sensor_model(
            ships_map, c["ship_code"], equip,
            c.get("model")
        )
        if not sm or sm not in SENSOR_CYCLE:
            # Blank or re-spelled ships.wms drops the whole ship
            # from the report — say so instead of going quiet.
            skipped += 1
            log.warning(
                "센서 주기 판별 실패 — 건너뜀: %s / %s "
                "(ships.wms=%r, model=%r)",
                c["ship_code"], equip,
                (ships_map.get(c["ship_code"]) or {}).get("wms"),
                c.get("model"),
            )
            continue
        cyc = SENSOR_CYCLE[sm]

        # Calibration check
        if cyc["cal"] is not None:
            cal_due = add_months(last, cyc["cal"])
            cal_days = (cal_due - today).days
            if cal_days <= EGCS_SOON_DAYS:
                wms_part = equip.split("/")[0] if "/" in equip \
                    else equip
                sensor_part = equip.split("/")[1] if "/" in equip \
                    else equip
                alerts.append({
                    "ship": c["ship_code"],
                    "wms": wms_part,
                    "sensor": sensor_part,
                    "kind": "검교정",
                    "due": cal_due.isoformat(),
                    "days": cal_days,
                    "level": (
                        "expired" if cal_days <= 0 else "soon"
                    ),
                })

        # Replacement check
        repl_due = add_months(last, cyc["repl"])
        repl_days = (repl_due - today).days
        if repl_days <= EGCS_SOON_DAYS:
            wms_part = equip.split("/")[0] if "/" in equip \
                else equip
            sensor_part = equip.split("/")[1] if "/" in equip \
                else equip
            alerts.append({
                "ship": c["ship_code"],
                "wms": wms_part,
                "sensor": sensor_part,
                "kind": "신환",
                "due": repl_due.isoformat(),
                "days": repl_days,
                "level": (
                    "expired" if repl_days <= 0 else "soon"
                ),
            })
    # Sort by ship, then WMS, then days (for rowspan grouping)
    alerts.sort(key=lambda a: (a["ship"], a.get("wms", ""), a["days"]))
    return alerts, skipped


def status_text(days):
    if days <= 0:
        return f"{abs(days)}일 경과(만료)"
    return f"D-{days} 임박"


def status_color(level):
    if level == "expired":
        return "#b91c1c"
    return "#b45309"


def row_bg(level):
    if level == "expired":
        return "#fef2f2"
    return "#fffbeb"


def build_html(bwts_alerts, egcs_alerts, egcs_skipped=0):
    """GAS 메일과 동일한 포맷의 HTML 생성."""
    bwts_exp = sum(1 for a in bwts_alerts if a["level"] == "expired")
    bwts_soon = sum(1 for a in bwts_alerts if a["level"] == "soon")
    egcs_exp = sum(1 for a in egcs_alerts if a["level"] == "expired")
    egcs_soon = sum(1 for a in egcs_alerts if a["level"] == "soon")
    total = len(bwts_alerts) + len(egcs_alerts)
    total_exp = bwts_exp + egcs_exp
    total_soon = bwts_soon + egcs_soon

    th = (
        "border:1px solid #e2e8f0;padding:7px 10px;"
        "text-align:left"
    )
    td = "border:1px solid #e2e8f0;padding:7px 10px"

    # BWTS table
    bwts_rows = ""
    for a in bwts_alerts:
        bg = row_bg(a["level"])
        sc = status_color(a["level"])
        bwts_rows += (
            f'<tr style="background:{bg}">'
            f'<td style="{td};font-weight:600">{a["ship"]}</td>'
            f'<td style="{td}">{a["equip"]}</td>'
            f'<td style="{td}">{a["kind"]}</td>'
            f'<td style="{td}">{a["due"]}</td>'
            f'<td style="{td}">'
            f'<span style="color:{sc};font-weight:600">'
            f'{status_text(a["days"])}</span></td>'
            f'</tr>'
        )

    bwts_html = ""
    if bwts_alerts:
        bwts_html = f"""
<div style="margin-bottom:20px">
<h3 style="color:#1e40af;margin:0 0 6px;font-size:15px">
⚓ BWTS <span style="font-weight:400;font-size:13px;\
color:#64748b">({len(bwts_alerts)}건 · \
만료 {bwts_exp} · 임박 {bwts_soon})</span></h3>
<table style="border-collapse:collapse;font-size:12.5px;\
width:100%">
<thead><tr style="background:#1e40af;color:#fff">
<th style="{th}">선박</th><th style="{th}">장비</th>
<th style="{th}">구분</th><th style="{th}">만료일</th>
<th style="{th}">상태</th>
</tr></thead><tbody>{bwts_rows}</tbody></table></div>"""

    # EGCS table — group by ship, merge rowspan
    egcs_rows = ""
    if egcs_alerts:
        # Group consecutive same-ship rows for rowspan
        i = 0
        while i < len(egcs_alerts):
            ship = egcs_alerts[i]["ship"]
            span = 0
            for j in range(i, len(egcs_alerts)):
                if egcs_alerts[j]["ship"] == ship:
                    span += 1
                else:
                    break
            for k in range(span):
                a = egcs_alerts[i + k]
                bg = row_bg(a["level"])
                sc = status_color(a["level"])
                ship_td = ""
                if k == 0:
                    ship_td = (
                        f'<td style="{td};font-weight:600;'
                        f'vertical-align:middle" '
                        f'rowspan="{span}">{a["ship"]}</td>'
                    )
                wms_td = (
                    f'<td style="{td};vertical-align:middle;'
                    f'text-align:center">{a.get("wms", "")}'
                    f'</td>'
                )
                egcs_rows += (
                    f'<tr style="background:{bg}">'
                    f'{ship_td}{wms_td}'
                    f'<td style="{td}">{a.get("sensor", "")}'
                    f'</td>'
                    f'<td style="{td}">{a["kind"]}</td>'
                    f'<td style="{td}">{a["due"]}</td>'
                    f'<td style="{td}">'
                    f'<span style="color:{sc};font-weight:600">'
                    f'{status_text(a["days"])}</span></td>'
                    f'</tr>'
                )
            i += span

    egcs_html = ""
    if egcs_alerts:
        egcs_html = f"""
<div style="margin-bottom:20px">
<h3 style="color:#065f46;margin:0 0 6px;font-size:15px">
🏭 EGCS <span style="font-weight:400;font-size:13px;\
color:#64748b">({len(egcs_alerts)}건 · \
만료 {egcs_exp} · 임박 {egcs_soon})</span></h3>
<table style="border-collapse:collapse;font-size:12.5px;\
width:100%">
<thead><tr style="background:#065f46;color:#fff">
<th style="{th}">선박</th><th style="{th}">WMS</th>
<th style="{th}">센서</th><th style="{th}">구분</th>
<th style="{th}">만료일</th><th style="{th}">상태</th>
</tr></thead><tbody>{egcs_rows}</tbody></table></div>"""

    skip_html = ""
    if egcs_skipped:
        skip_html = f"""
<p style="color:#b45309;font-size:12px;margin:0 0 12px">\
⚠ EGCS {egcs_skipped}건은 센서 주기를 판별하지 못해 제외됐습니다 \
(ships.wms 값 누락 또는 표기 변경). ships 테이블을 확인하세요.</p>"""

    html = f"""\
<div style="font-family:Malgun Gothic,sans-serif;\
font-size:13px;color:#1f2426">
<h2 style="color:#155060;margin:0 0 4px;font-size:17px">\
검교정 만료·임박 주간 리포트</h2>
<p style="color:#64748b;margin:0 0 16px;font-size:12.5px">\
총 <b>{total}건</b> (만료 {total_exp} · 임박 {total_soon}). \
기준: BWTS 2개월 이내 · EGCS 30일 이내. \
주기 출처: WMS 센서 매뉴얼(2026.06.18).</p>
{skip_html}
{bwts_html}
{egcs_html}
<p style="color:#94a3b8;font-size:11.5px;margin-top:10px;\
border-top:1px solid #e2e8f0;padding-top:10px">\
※ USCG/검교정 만료는 PSC 지적 사유입니다. \
<a href="https://hwjung-bit.github.io/bwts-egcs-maintenance/">\
앱 검교정 보드</a>에서 상세를 확인하세요.<br>\
이 메일은 매주 월요일 오전 8시 자동 발송됩니다 \
(GitHub Actions).</p></div>"""
    return html, total, len(bwts_alerts), len(egcs_alerts)


def send_email(to, subject, html_body):
    if not GMAIL_APP_PW:
        log.error("GMAIL_APP_PASSWORD not set")
        sys.exit(1)
    msg = MIMEText(html_body, "html", "utf-8")
    msg["From"] = GMAIL_USER
    msg["To"] = to
    msg["Subject"] = subject
    # A hung SMTP socket used to stall the job forever — bound it
    # and give the send one retry.
    for attempt in (1, 2):
        try:
            with smtplib.SMTP_SSL(
                "smtp.gmail.com", 465, timeout=30
            ) as srv:
                srv.login(GMAIL_USER, GMAIL_APP_PW)
                srv.send_message(msg)
            break
        except Exception as e:
            if attempt == 2:
                log.error("SMTP send failed: %s", e)
                sys.exit(1)
            log.warning("SMTP send failed (retrying): %s", e)
    log.info("Email sent via SMTP to %s", to)


# Primary key per table — the paging ORDER BY must use a column that exists
# (ships has no id; its key is code). 2026-09-01: ordering by "id" made the
# weekly alert fail with 42703 on ships.
_PK = {"ships": "code"}


def fetch_all(sb, table, eq=None):
    """Page through a table — a single read caps at 1000 rows."""
    rows = []
    page_size = 1000
    offset = 0
    while True:
        # ORDER BY 없는 range 는 페이지 경계에서 행이 중복·누락될 수 있다.
        q = sb.table(table).select("*").order(_PK.get(table, "id"))
        if eq:
            q = q.eq(eq[0], eq[1])
        res = q.range(offset, offset + page_size - 1).execute()
        page = res.data or []
        rows.extend(page)
        if len(page) < page_size:
            break
        offset += page_size
    return rows


def main():
    # Runner clock is UTC — the Monday 08:00 KST run would otherwise
    # compute against Sunday.
    today = datetime.now(KST).date()
    log.info("Weekly calibration alert — %s", today)

    sb = get_supabase()

    # Fetch data
    bwts_cal = fetch_all(sb, "calibrations", ("system", "BWTS"))
    egcs_cal = fetch_all(sb, "calibrations", ("system", "EGCS"))
    ships = fetch_all(sb, "ships")
    ships_map = {s["code"]: s for s in ships}

    log.info(
        "Loaded: BWTS %d, EGCS %d, ships %d",
        len(bwts_cal), len(egcs_cal), len(ships),
    )

    # An empty read means an expired key / RLS / table error, not
    # "nothing due" — fail loudly instead of reporting success.
    if not bwts_cal and not egcs_cal:
        log.error("calibrations 조회 결과 0건 — 키 만료·RLS·테이블 "
                  "오류 의심")
        sys.exit(1)

    # Collect alerts
    bwts_alerts = collect_bwts_alerts(bwts_cal, today)
    egcs_alerts, egcs_skipped = collect_egcs_alerts(
        egcs_cal, ships_map, today
    )

    total = len(bwts_alerts) + len(egcs_alerts)
    if total == 0:
        log.info("No expiring calibrations — skip email")
        return

    log.info(
        "Alerts: BWTS %d, EGCS %d",
        len(bwts_alerts), len(egcs_alerts),
    )

    html, total, bwts_cnt, egcs_cnt = build_html(
        bwts_alerts, egcs_alerts, egcs_skipped
    )
    subject = (
        f"[검교정] 주간 만료·임박 {total}건 "
        f"(BWTS {bwts_cnt} · EGCS {egcs_cnt})"
    )

    send_email(ALERT_TO, subject, html)
    log.info("Done — %s", subject)


if __name__ == "__main__":
    main()
