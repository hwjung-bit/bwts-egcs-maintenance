"""
Weekly Calibration Expiry Alert — Supabase → Gmail

GitHub Actions cron으로 매주 월요일 KST 08:00 실행.
BWTS/EGCS 검교정 만료·임박 항목을 집계하여 HTML 메일 발송.

환경변수:
  GMAIL_TOKEN_JSON   — OAuth token JSON (refresh_token 포함)
  GOOGLE_CLIENT_ID
  GOOGLE_CLIENT_SECRET
  SUPABASE_URL
  SUPABASE_SERVICE_KEY
  ALERT_TO            — 수신자 이메일 (기본: hwjung@ekmtc.com)
"""

import base64
import json
import logging
import os
import sys
from datetime import date, timedelta
from email.mime.text import MIMEText

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from supabase import create_client

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger(__name__)

SCOPES = [
    "https://www.googleapis.com/auth/gmail.send",
]
ALERT_TO = os.environ.get("ALERT_TO", "hwjung@ekmtc.com")

# BWTS: 12개월 주기, 만료=0일 이내, 임박=60일 이내
BWTS_INTERVAL = 12
BWTS_SOON_DAYS = 60

# EGCS sensor cycle (months) — from WMS manual 2026.06.18
SENSOR_CYCLE = {
    "enviroFlu": {"cal": 48, "repl": 96},
    "TTurb":     {"cal": 48, "repl": 96},
    "TpH-D":    {"cal": 24, "repl": 24},
    "G6110":    {"cal": 24, "repl": 48},
    "G6111":    {"cal": 36, "repl": 36},
    "G6120":    {"cal": None, "repl": 60},
    "G6130":    {"cal": 12, "repl": 12},
}
EGCS_SOON_DAYS = 30


def get_creds():
    token_json = os.environ.get("GMAIL_TOKEN_JSON", "")
    client_id = os.environ.get("GOOGLE_CLIENT_ID", "")
    client_secret = os.environ.get("GOOGLE_CLIENT_SECRET", "")
    if not token_json:
        log.error("GMAIL_TOKEN_JSON not set")
        sys.exit(1)
    token_data = json.loads(token_json)
    creds = Credentials(
        token=token_data.get("access_token"),
        refresh_token=token_data.get("refresh_token"),
        token_uri="https://oauth2.googleapis.com/token",
        client_id=token_data.get("client_id") or client_id,
        client_secret=(
            token_data.get("client_secret") or client_secret
        ),
        scopes=SCOPES,
    )
    if creds.expired or not creds.valid:
        creds.refresh(Request())
        log.info("Token refreshed")
    return creds


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
    day = min(d.day, 28)
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
    return alerts


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


def build_html(bwts_alerts, egcs_alerts):
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

    html = f"""\
<div style="font-family:Malgun Gothic,sans-serif;\
font-size:13px;color:#1f2426">
<h2 style="color:#155060;margin:0 0 4px;font-size:17px">\
검교정 만료·임박 주간 리포트</h2>
<p style="color:#64748b;margin:0 0 16px;font-size:12.5px">\
총 <b>{total}건</b> (만료 {total_exp} · 임박 {total_soon}). \
기준: BWTS 2개월 이내 · EGCS 30일 이내. \
주기 출처: WMS 센서 매뉴얼(2026.06.18).</p>
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


def send_email(creds, to, subject, html_body):
    service = build("gmail", "v1", credentials=creds)
    msg = MIMEText(html_body, "html", "utf-8")
    msg["To"] = to
    msg["Subject"] = subject
    raw = base64.urlsafe_b64encode(
        msg.as_bytes()
    ).decode("ascii")
    result = service.users().messages().send(
        userId="me", body={"raw": raw}
    ).execute()
    log.info("Email sent: id=%s", result.get("id"))
    return result


def main():
    today = date.today()
    log.info("Weekly calibration alert — %s", today)

    sb = get_supabase()

    # Fetch data
    bwts_res = sb.table("calibrations").select("*").eq(
        "system", "BWTS"
    ).execute()
    egcs_res = sb.table("calibrations").select("*").eq(
        "system", "EGCS"
    ).execute()
    ships_res = sb.table("ships").select("*").execute()

    bwts_cal = bwts_res.data or []
    egcs_cal = egcs_res.data or []
    ships = ships_res.data or []
    ships_map = {s["code"]: s for s in ships}

    log.info(
        "Loaded: BWTS %d, EGCS %d, ships %d",
        len(bwts_cal), len(egcs_cal), len(ships),
    )

    # Collect alerts
    bwts_alerts = collect_bwts_alerts(bwts_cal, today)
    egcs_alerts = collect_egcs_alerts(
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
        bwts_alerts, egcs_alerts
    )
    subject = (
        f"[검교정] 주간 만료·임박 {total}건 "
        f"(BWTS {bwts_cnt} · EGCS {egcs_cnt})"
    )

    creds = get_creds()
    send_email(creds, ALERT_TO, subject, html)
    log.info("Done — %s", subject)


if __name__ == "__main__":
    main()
