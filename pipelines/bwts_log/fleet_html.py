# fleet_html.py — Fleet Dashboard HTML generation
# Single self-contained HTML with Chart.js CDN
import json
from datetime import datetime
from pathlib import Path
from config import VESSELS

GRADE_STYLES = {
    "운전양호":   {"bg": "#E8F5E9", "fg": "#2E7D32", "dot": "#4CAF50"},
    "점검필요":   {"bg": "#FFF3E0", "fg": "#E65100", "dot": "#FF9800"},
    "수리후정상": {"bg": "#E3F2FD", "fg": "#1565C0", "dot": "#42A5F5"},
    "미운전":     {"bg": "#F5F5F5", "fg": "#757575", "dot": "#9E9E9E"},
    "미수신":     {"bg": "#FFEBEE", "fg": "#C62828", "dot": "#F44336"},
    "데이터불량": {"bg": "#F3E5F5", "fg": "#6A1B9A", "dot": "#9C27B0"},
}


def _cell_label(s):
    """Short label for matrix cell — B/D colored."""
    g = s["grade"]
    if g in ("미수신", "데이터불량"):
        return g[:3]
    if g == "미운전":
        return "—"
    b = s.get("ballast_count", 0)
    d = s.get("deballast_count", 0)
    warn = ""
    if s.get("tro_b_in_range") is False:
        warn = " ⚠"
    if s.get("chattering"):
        warn = " ⚠"
    return (f'<span class="b-count">{b}</span>'
            f'/<span class="d-count">{d}</span>{warn}')


def _detail_html(s):
    """Generate detail panel HTML for a vessel-month."""
    g = s["grade"]
    style = GRADE_STYLES.get(g, GRADE_STYLES["미수신"])

    if g in ("미수신", "데이터불량"):
        return (f'<div class="detail-empty">'
                f'{s["reception_detail"]}</div>')

    lines = []

    # Operations
    lines.append(f'<div class="detail-section">')
    lines.append(f'<h4>운전 현황</h4>')
    lines.append(
        f'<p>Ballast {s["ballast_count"]}회 / '
        f'Deballast {s["deballast_count"]}회 / '
        f'{s["op_days"]}일 운용</p>')
    if s.get("ballast_volume") or s.get("deballast_volume"):
        lines.append(
            f'<p>처리량: 주입 {s["ballast_volume"]:.0f}m³ / '
            f'배출 {s["deballast_volume"]:.0f}m³</p>')
    if s.get("gps_areas"):
        lines.append(
            f'<p>해역: {", ".join(s["gps_areas"])}</p>')
    lines.append('</div>')

    # TRO
    lines.append(f'<div class="detail-section">')
    lines.append(f'<h4>TRO (warm-up 제외)</h4>')
    b_avg = s.get("tro_b_avg")
    b_min = s.get("tro_b_min")
    d_max = s.get("tro_d_max")
    b_ok = s.get("tro_b_in_range")
    d_ok = s.get("tro_d_compliant")

    # Check if this vessel has TRO sensor
    sessions = s.get("session_summaries", [])
    no_tro_sensor = any(
        ss.get("no_tro_sensor") for ss in sessions
        if isinstance(ss, dict))

    if no_tro_sensor:
        lines.append(
            '<p>ℹ️ TRO 센서 미장착 (전류/유량 기반 판정)</p>')
    else:
        if b_avg is not None:
            icon = "✅" if b_ok else "⚠️"
            lines.append(
                f'<p>{icon} B-TRO: 평균 {b_avg}ppm, '
                f'최솟값 {b_min}ppm '
                f'({"정상" if b_ok else "범위 이탈"})</p>')
        if d_max is not None:
            icon = "✅" if d_ok else "⚠️"
            d_avg = s.get("tro_d_avg")
            d_avg_str = f', 평균 {d_avg}ppm' if d_avg is not None else ''
            lines.append(
                f'<p>{icon} D-TRO: 최댓값 {d_max}ppm{d_avg_str} '
                f'({"IMO 충족" if d_ok else "기준 초과"})</p>')
    lines.append('</div>')

    # Recovery pattern
    rp = s.get("recovery_pattern") or {}
    if rp.get("pattern") and rp["pattern"] != "insufficient":
        pat = rp["pattern"]
        detail = rp.get("detail", "")
        icon = {"recovery": "🔧", "degradation": "📉",
                "stable_ok": "✅", "stable_bad": "❌"
                }.get(pat, "ℹ️")
        lines.append(
            f'<div class="detail-section">'
            f'<h4>월중 패턴</h4>'
            f'<p>{icon} {detail}</p></div>')

    # Chattering
    ch = s.get("chattering", [])
    if ch:
        lines.append(f'<div class="detail-section">')
        lines.append(f'<h4>밸브 채터링</h4>')
        for c in ch:
            sev_class = {"심각": "sev-critical",
                         "주의": "sev-warning"
                         }.get(c["severity"], "sev-minor")
            lines.append(
                f'<p class="{sev_class}">'
                f'🔧 {c["valve"]}: '
                f'채터링 {c["chatter_events"]}회 '
                f'(최악 {c["worst_burst_size"]}회/'
                f'{c["worst_burst_duration_sec"]}초, '
                f'평균간격 {c["avg_interval_sec"]}초) '
                f'[{c["severity"]}]</p>')
        lines.append('</div>')

    # Sensor issues
    si = s.get("sensor_issues", [])
    if si:
        lines.append(f'<div class="detail-section">')
        lines.append(f'<h4>센서 이상</h4>')
        for issue in si:
            lines.append(
                f'<p>⚡ {issue["date"]} — '
                f'{issue["issue"]}: {issue["detail"]}</p>')
        lines.append('</div>')

    # Session summaries
    sessions = s.get("session_summaries", [])
    if sessions:
        lines.append(f'<div class="detail-section">')
        lines.append(f'<h4>세션별 상세</h4>')
        lines.append('<table class="session-table">')
        lines.append(
            '<tr><th>#</th><th>날짜</th><th>모드</th>'
            '<th>시간</th><th>TRO avg</th><th>TRO min/max</th>'
            '<th>상태</th></tr>')
        for sess in sessions:
            ok = sess.get("in_range")
            cls = ("ok" if ok else "bad" if ok is False
                   else "na")
            issue = sess.get("issue") or ""
            mode_short = ("B" if sess["mode"] == "BALLAST"
                          else "D")
            tro_val = ""
            if sess.get("stable_avg") is not None:
                tro_val = f'{sess["stable_avg"]}'
            mm = ""
            if sess["mode"] == "BALLAST" \
                    and sess.get("stable_min") is not None:
                mm = f'{sess["stable_min"]}'
            elif sess.get("stable_max") is not None:
                mm = f'{sess["stable_max"]}'

            dur = sess.get("duration_min")
            dur_str = f'{dur}분' if dur and dur > 0 else ""
            lines.append(
                f'<tr class="sess-{cls}">'
                f'<td>{sess["id"] + 1}</td>'
                f'<td>{sess.get("date", "")}</td>'
                f'<td>{mode_short}</td>'
                f'<td>{dur_str}</td>'
                f'<td>{tro_val}</td>'
                f'<td>{mm}</td>'
                f'<td>{issue}</td></tr>')
        lines.append('</table></div>')

    # Grade reasons
    reasons = s.get("grade_reasons", [])
    if reasons:
        lines.append(
            f'<div class="grade-reasons">'
            f'판정 사유: {", ".join(reasons)}</div>')

    return "\n".join(lines)


def generate_fleet_dashboard(matrix, mail_drafts, output_path):
    """Generate single HTML dashboard file."""
    now_dt = datetime.now()
    now = now_dt.strftime("%Y-%m-%d %H:%M")
    current_year = now_dt.year
    current_month = now_dt.month
    periods = sorted(matrix.keys())
    if not periods:
        return

    codes = [v["code"] for v in VESSELS]

    # Group periods by year
    years = sorted(set(y for y, m in periods))
    latest_year = years[-1]

    # Lookup
    lookup = {}
    for key, summaries in matrix.items():
        for s in summaries:
            lookup[(key[0], key[1], s["code"])] = s

    # Detail data as JSON
    detail_json = {}
    for key, val in lookup.items():
        k = f"{key[0]}_{key[1]:02d}_{key[2]}"
        detail_json[k] = _detail_html(val)

    # Chart data per vessel (all periods)
    chart_data = {}
    for code in codes:
        periods_list = []
        tro_b_list = []
        tro_d_list = []
        b_counts = []
        d_counts = []
        for y, m in periods:
            s = lookup.get((y, m, code))
            periods_list.append(f"{y % 100}/{m}")
            if s:
                tro_b_list.append(s.get("tro_b_avg"))
                tro_d_list.append(s.get("tro_d_avg"))
                b_counts.append(s.get("ballast_count", 0))
                d_counts.append(s.get("deballast_count", 0))
            else:
                tro_b_list.append(None)
                tro_d_list.append(None)
                b_counts.append(0)
                d_counts.append(0)
        # Check if this vessel is UV type (no TRO)
        v_info = next(
            (v for v in VESSELS if v["code"] == code), {})
        is_uv = v_info.get("bwts_type", "techcross") \
            != "techcross"

        chart_data[code] = {
            "periods": periods_list,
            "tro_b": tro_b_list,
            "tro_d": tro_d_list,
            "b_counts": b_counts,
            "d_counts": d_counts,
            "no_tro": is_uv,
        }

    # Build per-year matrix tables + year summary chart data
    year_tables = ""
    year_chart_data = {}
    for yr in years:
        yr_months = [(y, m) for y, m in periods if y == yr]

        # Year summary: per-month donut charts
        yr_chart = {"months": []}
        for y, m in yr_months:
            if (y, m) > (current_year, current_month):
                continue
            data = matrix.get((y, m), [])
            ok = sum(1 for s in data
                     if s["grade"] in ("운전양호", "수리후정상"))
            check = sum(1 for s in data
                        if s["grade"] == "점검필요")
            noop = sum(1 for s in data
                       if s["grade"] == "미운전")
            nodata = sum(1 for s in data
                         if s["grade"] in (
                             "미수신", "데이터불량"))
            total = ok + check + noop + nodata
            yr_chart["months"].append({
                "label": f"{m}월",
                "values": [ok, check, noop, nodata],
                "pcts": [
                    ok * 100 // max(total, 1),
                    check * 100 // max(total, 1),
                    noop * 100 // max(total, 1),
                    nodata * 100 // max(total, 1),
                ],
            })
        year_chart_data[yr] = yr_chart

        # Header row
        headers = "".join(
            f'<th>{m}월</th>' for _, m in yr_months)

        # Data rows
        rows = ""
        for code in codes:
            cells = ""
            for y, m in yr_months:
                if (y, m) > (current_year, current_month):
                    cells += '<td class="cell future"></td>'
                    continue
                s = lookup.get((y, m, code))
                if s:
                    g = s["grade"]
                    st = GRADE_STYLES.get(
                        g, GRADE_STYLES["미수신"])
                    label = _cell_label(s)
                    k = f"{y}_{m:02d}_{code}"
                    cells += (
                        f'<td class="cell" '
                        f'style="background:{st["bg"]};'
                        f'color:{st["fg"]};cursor:pointer" '
                        f'onclick="showDetail(\'{k}\','
                        f'\'{code}\')">{label}</td>')
                else:
                    cells += '<td class="cell na">-</td>'
            rows += (
                f'<tr><td class="vessel-code" '
                f'onclick="showVessel(\'{code}\')">'
                f'{code}</td>{cells}</tr>\n')

        display = "block" if yr == latest_year else "none"
        # Generate canvas elements for each month
        month_canvases = ""
        for mi, (y, m) in enumerate(yr_months):
            if (y, m) > (current_year, current_month):
                month_canvases += (
                    f'<div class="mini-chart"></div>')
            else:
                month_canvases += (
                    f'<div class="mini-chart">'
                    f'<canvas id="yc-{yr}-{m}"></canvas>'
                    f'<div class="mini-label">{m}월</div>'
                    f'</div>')

        year_tables += f'''
        <div class="year-panel" id="year-{yr}"
             style="display:{display}">
          <div class="year-charts-row">
            {month_canvases}
          </div>
          <table class="matrix-table">
            <tr><th>선박</th>{headers}</tr>
            {rows}
          </table>
        </div>'''

    # Year selector buttons
    year_btns = ""
    for yr in years:
        active = "active" if yr == latest_year else ""
        year_btns += (
            f'<button class="year-btn {active}" '
            f'onclick="switchYear({yr})">{yr}</button>')

    # Mail tab
    mail_html = ""
    if mail_drafts:
        for d in mail_drafts:
            escaped_body = d["body"].replace("\\", "\\\\") \
                .replace("`", "\\`").replace("'", "\\'") \
                .replace("\n", "\\n")
            escaped_subj = d["subject"].replace("'", "\\'")
            mail_html += (
                f'<div class="mail-card">'
                f'<div class="mail-header">'
                f'<strong>{d["vessel_name"]}</strong> '
                f'({d["issue_count"]}건)</div>'
                f'<div class="mail-subject">'
                f'제목: {d["subject"]}</div>'
                f'<pre class="mail-body">{d["body"]}</pre>'
                f'<button class="copy-btn" onclick="'
                f"navigator.clipboard.writeText("
                f"'{escaped_subj}\\n\\n{escaped_body}'"
                f').then(()=>this.textContent="복사완료!")'
                f'">클립보드 복사</button></div>')
    else:
        mail_html = '<p class="no-drafts">미수신 선박 없음</p>'

    period_str = (f"{years[0]}~{years[-1]}년"
                  if len(years) > 1 else f"{years[0]}년")

    html = f'''<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BWTS 선대 관리 대시보드</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<style>
* {{ margin:0; padding:0; box-sizing:border-box; }}
body {{
  font-family: 'Segoe UI','Malgun Gothic',sans-serif;
  background:#f0f2f5; color:#333; font-size:14px;
}}
.header {{
  background:linear-gradient(135deg,#1a365d,#2d5a87);
  color:white; padding:16px 24px;
}}
.header h1 {{ font-size:20px; }}
.header .meta {{ font-size:12px; opacity:.8; margin-top:2px; }}
.toolbar {{
  display:flex; align-items:center; gap:12px;
  background:#fff; padding:10px 16px;
  border-bottom:2px solid #e0e0e0; flex-wrap:wrap;
}}
.year-btn {{
  padding:6px 16px; border:2px solid #1a365d;
  background:#fff; color:#1a365d; border-radius:6px;
  font-weight:bold; font-size:14px; cursor:pointer;
}}
.year-btn.active {{
  background:#1a365d; color:#fff;
}}
.year-btn:hover {{ opacity:.8; }}
.toolbar-sep {{
  width:1px; height:24px; background:#ddd; margin:0 4px;
}}
.tab-btn {{
  padding:6px 14px; border:none; background:transparent;
  color:#666; font-weight:600; font-size:13px;
  cursor:pointer; border-bottom:2px solid transparent;
}}
.tab-btn.active {{
  color:#1a365d; border-bottom-color:#1a365d;
}}
.tab-content {{ display:none; padding:12px 16px; }}
.tab-content.active {{ display:block; }}
.matrix-table {{
  width:100%; border-collapse:collapse;
  background:#fff; border-radius:6px;
  box-shadow:0 1px 3px rgba(0,0,0,.08);
  table-layout:fixed;
}}
.matrix-table th {{
  background:#1a365d; color:white;
  padding:6px 4px; font-size:12px;
  position:sticky; top:0; z-index:1;
}}
.matrix-table td {{ padding:4px 2px; text-align:center; }}
.vessel-code {{
  font-weight:bold; white-space:nowrap;
  font-size:12px; width:48px; cursor:pointer;
  color:#1a365d; text-align:center;
}}
.vessel-code:hover {{
  background:#e8eaf6; text-decoration:underline;
}}
.year-charts-row {{
  display:flex; gap:4px; margin-bottom:12px;
  background:#fff; border-radius:6px; padding:8px 4px;
  box-shadow:0 1px 3px rgba(0,0,0,.08);
  justify-content:center;
}}
.mini-chart {{
  width:calc(100%/12 - 4px); min-width:60px;
  text-align:center;
}}
.mini-chart canvas {{ max-height:80px; }}
.mini-label {{
  font-size:10px; color:#666; font-weight:600;
  margin-top:2px;
}}
.cell {{
  font-size:12px; font-weight:600; border-radius:3px;
  white-space:nowrap; padding:5px 3px; cursor:default;
}}
.cell.future {{ background:#fafafa; }}
.b-count {{ color:#1565C0; font-weight:bold; }}
.d-count {{ color:#C62828; font-weight:bold; }}
.cell.na {{ color:#ccc; }}
.cell:hover {{ opacity:.8; box-shadow:0 0 0 2px #1a365d; }}
#detail-panel {{
  display:none; background:#fff; margin:12px 16px;
  border-radius:8px; padding:16px;
  box-shadow:0 2px 8px rgba(0,0,0,.12);
}}
#detail-panel.show {{ display:flex; gap:20px; flex-wrap:wrap; }}
.detail-left {{ flex:1; min-width:280px; }}
.detail-right {{ flex:1; min-width:280px; }}
.detail-section {{
  margin-bottom:10px; padding:8px 10px;
  background:#f8f9fa; border-radius:6px;
}}
.detail-section h4 {{
  font-size:12px; color:#1a365d; margin-bottom:3px;
}}
.detail-section p {{ font-size:12px; line-height:1.5; }}
.detail-empty {{ padding:16px; text-align:center; color:#999; }}
.grade-reasons {{
  font-size:11px; color:#E65100;
  padding:6px; background:#FFF3E0;
  border-radius:4px; margin-top:6px;
}}
.session-table {{
  width:100%; border-collapse:collapse;
  font-size:11px; margin-top:4px;
}}
.session-table th {{
  background:#e8eaf6; padding:3px 4px;
  text-align:center; font-weight:600;
}}
.session-table td {{
  padding:2px 4px; text-align:center;
  border-bottom:1px solid #eee;
}}
.sess-ok {{ background:#f1f8e9; }}
.sess-bad {{ background:#fce4ec; }}
.sess-na {{ background:#fafafa; }}
.sev-critical {{ color:#c62828; font-weight:bold; }}
.sev-warning {{ color:#e65100; }}
.mail-card {{
  background:#fff; border-radius:8px; padding:14px;
  margin-bottom:10px;
  box-shadow:0 1px 3px rgba(0,0,0,.1);
}}
.mail-header {{ font-size:14px; margin-bottom:6px; }}
.mail-subject {{
  font-size:12px; color:#1a365d;
  margin-bottom:6px; font-weight:600;
}}
.mail-body {{
  font-size:11px; background:#f5f5f5;
  padding:10px; border-radius:4px;
  white-space:pre-wrap; line-height:1.5;
  max-height:180px; overflow-y:auto;
}}
.copy-btn {{
  margin-top:6px; padding:5px 14px;
  background:#1a365d; color:white;
  border:none; border-radius:4px; cursor:pointer;
  font-size:12px;
}}
.copy-btn:hover {{ background:#2d5a87; }}
.no-drafts {{ text-align:center; color:#999; padding:30px; }}
.chart-container {{ height:180px; margin-bottom:8px; }}
</style>
</head>
<body>

<div class="header">
  <h1>BWTS 선대 관리 대시보드</h1>
  <div class="meta">{period_str} | {now} | {len(VESSELS)}척</div>
</div>

<div class="toolbar">
  {year_btns}
  <div class="toolbar-sep"></div>
  <button class="tab-btn active"
    onclick="switchTab('matrix',this)">매트릭스</button>
  <button class="tab-btn"
    onclick="switchTab('mail',this)">미수신 메일 ({len(mail_drafts)})</button>
</div>

<div id="tab-matrix" class="tab-content active">
  {year_tables}

  <div id="detail-panel">
    <div class="detail-left" id="detail-info"></div>
    <div class="detail-right">
      <div class="chart-container">
        <canvas id="opChart"></canvas>
      </div>
      <div class="chart-container" id="troChartWrap">
        <canvas id="troChart"></canvas>
      </div>
    </div>
  </div>
</div>

<div id="tab-mail" class="tab-content">
  {mail_html}
</div>

<script>
const detailData = {json.dumps(detail_json, ensure_ascii=False)};
const chartData = {json.dumps(chart_data, ensure_ascii=False)};
const yearChartData = {json.dumps(year_chart_data, ensure_ascii=False)};

let troChart = null;
let opChart = null;
const yearCharts = {{}};

function switchYear(yr) {{
  document.querySelectorAll('.year-panel').forEach(
    el => el.style.display = 'none');
  document.querySelectorAll('.year-btn').forEach(
    el => el.classList.remove('active'));
  const panel = document.getElementById('year-' + yr);
  if (panel) panel.style.display = 'block';
  event.target.classList.add('active');
  document.getElementById('detail-panel').classList.remove('show');
  initYearChart(yr);
}}

function switchTab(name, btn) {{
  document.querySelectorAll('.tab-content').forEach(
    el => el.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(
    el => el.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  if (btn) btn.classList.add('active');
}}

function initYearChart(yr) {{
  const cd = yearChartData[yr];
  if (!cd || !cd.months) return;
  // Destroy old charts
  if (yearCharts[yr]) {{
    yearCharts[yr].forEach(c => c.destroy());
  }}
  yearCharts[yr] = [];

  cd.months.forEach((m, i) => {{
    const canvas = document.getElementById(
      'yc-' + yr + '-' + m.label.replace('월',''));
    if (!canvas) return;
    const chart = new Chart(canvas, {{
      type: 'doughnut',
      data: {{
        labels: ['양호','점검','미운전','미수신'],
        datasets: [{{
          data: m.values,
          backgroundColor: [
            '#4CAF50','#FF9800','#9E9E9E','#F44336'],
          borderWidth: 1, borderColor: '#fff',
        }}],
      }},
      options: {{
        responsive:true, maintainAspectRatio:true,
        cutout: '50%',
        plugins: {{
          legend:{{ display:false }},
          tooltip: {{
            callbacks: {{
              label: function(ctx) {{
                const pct = m.pcts[ctx.dataIndex];
                return ctx.label + ' ' + ctx.raw + '(' + pct + '%)';
              }}
            }}
          }},
        }},
      }},
    }});
    yearCharts[yr].push(chart);
  }});
}}

function showVessel(code) {{
  // Show all-months detail for this vessel
  const panel = document.getElementById('detail-panel');
  const info = document.getElementById('detail-info');

  // Collect all months for this vessel
  let html = '<h3 style="margin-bottom:12px;color:#1a365d">'
    + code + ' 전체 분석</h3>';

  // Build monthly summary table
  html += '<table class="session-table" style="margin-bottom:12px">';
  html += '<tr><th>기간</th><th>등급</th><th>B</th><th>D</th>'
    + '<th>B-TRO</th><th>D-TRO</th><th>비고</th></tr>';

  const allKeys = Object.keys(detailData).filter(
    k => k.endsWith('_' + code)).sort();
  for (const k of allKeys) {{
    const parts = k.split('_');
    const period = parts[0] + '/' + parts[1];
    // Find summary data from chartData
    html += '<tr onclick="showDetail(\\'' + k + '\\',\\''
      + code + '\\')" style="cursor:pointer">'
      + '<td>' + period + '</td>';
    html += '<td colspan="6" style="text-align:left;font-size:11px">'
      + '(클릭하여 상세 확인)</td></tr>';
  }}
  html += '</table>';

  info.innerHTML = html;
  panel.classList.add('show');
  panel.scrollIntoView({{ behavior:'smooth', block:'start' }});

  // Draw charts — op count first, TRO below (hide if UV)
  const cd = chartData[code];
  if (!cd) return;
  if (troChart) troChart.destroy();
  if (opChart) opChart.destroy();

  // TRO chart: hide for UV type
  const troWrap = document.getElementById('troChartWrap');
  if (cd.no_tro) {{
    troWrap.style.display = 'none';
  }} else {{
    troWrap.style.display = 'block';
    const troCtx = document.getElementById('troChart');
    troChart = new Chart(troCtx, {{
      type:'line',
      data: {{
        labels: cd.periods,
        datasets: [{{
          label:'B-TRO 평균',
          data: cd.tro_b,
          borderColor:'#1565C0',
          backgroundColor:'rgba(21,101,192,0.1)',
          tension:0.3, fill:true, spanGaps:true,
        }}, {{
          label:'D-TRO 평균',
          data: cd.tro_d,
          borderColor:'#C62828',
          tension:0.3, yAxisID:'y2', spanGaps:true,
        }}],
      }},
      options: {{
        responsive:true, maintainAspectRatio:false,
        plugins:{{ title:{{ display:true,
          text: code+' TRO 추이 (전 기간)' }} }},
        scales: {{
          y:{{ title:{{ display:true, text:'B-TRO (ppm)' }},
               min:0, max:15 }},
          y2:{{ position:'right',
                title:{{ display:true, text:'D-TRO (ppm)' }},
                min:0, grid:{{ drawOnChartArea:false }} }},
        }},
      }},
    }});
  }}

  const opCtx = document.getElementById('opChart');
  opChart = new Chart(opCtx, {{
    type:'bar',
    data: {{
      labels: cd.periods,
      datasets: [{{
        label:'Ballast',
        data: cd.b_counts,
        backgroundColor:'#1565C0',
      }}, {{
        label:'Deballast',
        data: cd.d_counts,
        backgroundColor:'#C62828',
      }}],
    }},
    options: {{
      responsive:true, maintainAspectRatio:false,
      plugins:{{ title:{{ display:true,
        text: code+' 월별 운전 횟수' }},
        legend:{{ labels:{{ boxWidth:12 }} }} }},
      scales:{{ y:{{ beginAtZero:true, stacked:true }},
                x:{{ stacked:true }} }},
    }},
  }});
}}

function showDetail(key, code) {{
  const panel = document.getElementById('detail-panel');
  const info = document.getElementById('detail-info');
  info.innerHTML = detailData[key] || '<p>데이터 없음</p>';
  panel.classList.add('show');

  // Scroll to panel
  panel.scrollIntoView({{ behavior: 'smooth', block: 'start' }});

  // Draw charts
  const cd = chartData[code];
  if (!cd) return;

  if (troChart) troChart.destroy();
  if (opChart) opChart.destroy();

  // TRO: hide for UV
  const troWrap2 = document.getElementById('troChartWrap');
  if (cd.no_tro) {{
    troWrap2.style.display = 'none';
  }} else {{
    troWrap2.style.display = 'block';
    const troCtx = document.getElementById('troChart');
    troChart = new Chart(troCtx, {{
      type: 'line',
      data: {{
        labels: cd.periods,
        datasets: [{{
          label: 'B-TRO 평균 (ppm)',
          data: cd.tro_b,
          borderColor: '#1565C0',
          backgroundColor: 'rgba(21,101,192,0.1)',
          tension: 0.3, fill: true, spanGaps: true,
        }}, {{
          label: 'D-TRO 평균 (ppm)',
          data: cd.tro_d,
          borderColor: '#C62828',
          tension: 0.3, yAxisID: 'y2', spanGaps: true,
        }}],
      }},
      options: {{
        responsive: true, maintainAspectRatio: false,
        plugins: {{ title: {{ display: true,
          text: code + ' TRO 추이' }} }},
        scales: {{
          y: {{ title: {{ display: true, text: 'B-TRO' }},
               min: 0, max: 15 }},
          y2: {{ position: 'right',
                title: {{ display: true, text: 'D-TRO' }},
                min: 0, grid: {{ drawOnChartArea: false }} }},
        }},
      }},
    }});
  }}

  const opCtx = document.getElementById('opChart');
  opChart = new Chart(opCtx, {{
    type: 'bar',
    data: {{
      labels: cd.periods,
      datasets: [{{
        label: 'Ballast',
        data: cd.b_counts,
        backgroundColor: '#1565C0',
      }}, {{
        label: 'Deballast',
        data: cd.d_counts,
        backgroundColor: '#C62828',
      }}],
    }},
    options: {{
      responsive: true,
      maintainAspectRatio: false,
      plugins: {{
        title: {{ display: true,
                  text: code + ' 월별 운전 횟수' }},
        legend: {{ labels: {{ boxWidth: 12 }} }},
      }},
      scales: {{
        y: {{ beginAtZero: true, stacked: true }},
        x: {{ stacked: true }},
      }},
    }},
  }});
}}

// Init year chart for default visible year
document.addEventListener('DOMContentLoaded', () => {{
  initYearChart({latest_year});
}});
</script>
</body>
</html>'''

    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(html, encoding="utf-8")
    return output
