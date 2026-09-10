// 🧪 BWTS 로그 — vessel × month grade matrix from bwts_log_analysis
// (written by pipelines/bwts_log/run.py), with the review loop:
//   「재검토 요청」 → bwts_reviews + review_status='requested'  → /bwts-review 스킬이 답함
//   「등급 수정」   → final_grade + review_status='overridden'
// Display grade = final_grade ?? grade. 판독실패 is the parser-miss flag from
// integrity.py and is drawn hatched so it never reads as 미운전.
import { S } from '../core/state.js';
import { sb, dbSave } from '../core/supabase.js';
import { $, esc, toast } from '../core/dom.js';
import { getShipOrder, shipByCode } from '../shared/ships.js';
import { requireTH } from '../shared/thresholds.js';

export const GRADES = ['운전양호', '점검필요', '수리후정상', '미운전', '미수신', '데이터불량', '판독실패'];
const STYLE = {
  '운전양호':   { bg: '#E8F5E9', fg: '#2E7D32', dot: '#4CAF50' },
  '점검필요':   { bg: '#FFF3E0', fg: '#E65100', dot: '#FF9800' },
  '수리후정상': { bg: '#E3F2FD', fg: '#1565C0', dot: '#42A5F5' },
  '미운전':     { bg: '#F5F5F5', fg: '#757575', dot: '#9E9E9E' },
  '미수신':     { bg: '#FFEBEE', fg: '#C62828', dot: '#F44336' },
  '데이터불량': { bg: '#F3E5F5', fg: '#6A1B9A', dot: '#9C27B0' },
  '판독실패':   { bg: 'repeating-linear-gradient(135deg,#FFF9C4 0 6px,#FFE082 6px 12px)', fg: '#7A5C00', dot: '#FDD835' },
};
const REVIEW_MARK = { requested: '❓', reviewed: '✅', overridden: '✎', escalated: '🚩' };
const COLS = 'ship_code,period,grade,grade_rule,grade_reasons,reception,ballast_count,deballast_count,op_days,' +
  'tro_b_avg,tro_b_min,tro_d_max,tro_b_in_range,tro_d_compliant,trip_count,alarm_count,integrity,chattering,' +
  'review_status,final_grade,review_note,reviewed_by,reviewed_at,analyzed_at';

// module state
const F = { year: String(new Date().getFullYear()), filter: '' };
let ROWS = [];              // rows for F.year
let YEARS = [];             // available years
let selected = null;        // {ship_code, period}
let loadedYear = null;

const disp = r => r.final_grade || r.grade;
// 채터링은 ⚙ 참고표시가 아니라 전용 밸브 아이콘으로 따로 그린다. 과거 행의
// flags 에 남아 있는 옛 문구는 여기서 걸러 이중 표시를 막는다.
const flagsOf = r => ((r.integrity && r.integrity.flags) || r.flags || [])
  .filter(f => !String(f).startsWith('밸브 채터링'));

// 등급과 무관한 부수 문제. 임계값은 contracts/thresholds.json 한 곳에서만 온다.
function chatterOf(r) {
  const bl = requireTH('bwts_log');
  const worth = (r.chattering || [])
    .filter(c => (c.chatter_events || 0) >= bl.chatter_report_min_events);
  if (!worth.length) return null;
  const severe = worth.filter(c => (c.chatter_events || 0) >= bl.chatter_severe_min_events);
  return { level: severe.length ? '심각' : '주의', valves: worth, severe: severe.length };
}

// reception 은 파이프라인 내부 코드라 화면용 한글로 옮긴다.
const RECV = {
  full: '수신', pdf_only: 'PDF만', zip: 'ZIP만', null: '빈파일',
  folder_only: '폴더만', missing: '미수신',
};
const recvOf = r => RECV[r.reception] || (r.reception ? '수신' : '');

// 칸에 세는 「문제」는 BWTS 본체 문제만 — 등급을 가른 사유 개수.
// 밸브 채터링·참고표시 같은 부수 문제는 등급과 무관하므로 세지 않는다.
const issueCount = r => (r.grade_reasons || []).length;

// 상세 패널: 표시 기준을 넘은 밸브만, 심한 순서로. 기준 미만은 접어서 건수만.
function chatterDetail(chat) {
  const bl = requireTH('bwts_log');
  const list = (chat || []).filter(c => typeof c === 'object');
  const worth = list.filter(c => (c.chatter_events || 0) >= bl.chatter_report_min_events)
    .sort((a, b) => (b.chatter_events || 0) - (a.chatter_events || 0));
  const minor = list.length - worth.length;
  if (!worth.length) {
    return minor ? `<div class="muted" style="margin-bottom:6px">밸브 채터링: 경미 ${minor}건 `
      + `(${bl.chatter_report_min_events}회 미만 — 표시 생략)</div>` : '';
  }
  const rows = worth.map(c => {
    const sev = (c.chatter_events || 0) >= bl.chatter_severe_min_events ? '심각' : '주의';
    const col = sev === '심각' ? '#dc2626' : '#ea580c';
    return `<li>${VALVE_SVG(col)} <b>${esc(c.valve || '?')}</b> — ${c.chatter_events}회`
      + ` <span style="color:${col};font-weight:600">${sev}</span>`
      + ` · 버스트 ${c.burst_count}회, 최악 ${c.worst_burst_size}회`
      + ` (${esc(c.worst_burst_start || '')}~${esc(c.worst_burst_end || '')},`
      + ` 평균 ${c.avg_interval_sec}초 간격)</li>`;
  }).join('');
  return `<div style="margin-bottom:6px"><b>밸브 채터링 (등급 무관)</b>`
    + `<ul style="margin:4px 0 0 16px">${rows}</ul>`
    + (minor ? `<div class="muted" style="font-size:11px">그 외 경미 ${minor}건 생략`
      + ` (${bl.chatter_report_min_events}회 미만)</div>` : '') + '</div>';
}

// P&ID 게이트 밸브 기호 (마주 보는 삼각형 + 스템)
const VALVE_SVG = color =>
  `<svg viewBox="0 0 16 12" width="13" height="10" style="vertical-align:-1px" aria-hidden="true">` +
  `<path d="M2 2 L2 10 L8 6 Z M14 2 L14 10 L8 6 Z" fill="${color}"/>` +
  `<path d="M8 6 L8 2 M5 1.5 L11 1.5" stroke="${color}" stroke-width="1.4" fill="none"/></svg>`;

function mount(root) {
  root.innerHTML = `
  <div class="filters" id="blFilters">
    <select id="blYear"></select>
    <span id="blChips" style="display:flex;gap:4px;flex-wrap:wrap"></span>
    <button class="refresh-btn" id="blReload">🔄 새로고침</button>
    <a href="https://drive.google.com/drive/folders/1uyWbZUdTIkegHJUBnC5MQs4QEWQanBxE" target="_blank"
      style="text-decoration:none;background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:5px 14px;font-size:12px;font-weight:600;color:#15803d"
      title="Google Drive BWTS LOG DATA 폴더 열기">📁 LOG 폴더</a>
    <a href="kmtcfolder:bwtslog"
      style="text-decoration:none;background:#eff6ff;border:1px solid #93c5fd;border-radius:8px;padding:5px 14px;font-size:12px;font-weight:600;color:#1d4ed8"
      title="내 PC 탐색기로 열기 — kmtcfolder 프로토콜 등록된 PC에서만 작동 (scripts/register_kmtcfolder.reg)">💻 PC 폴더</a>
    <button onclick="bwtsLogTab.runAnalysis()"
      style="cursor:pointer;background:#fdf4ff;border:1px solid #d8b4fe;border-radius:8px;padding:5px 14px;font-size:12px;font-weight:600;color:#7e22ce"
      title="로컬 Claude Code 로 /bwts-analysis 실행 — kmtcfolder 등록된 PC에서만 작동">🤖 로그 분석 실행</button>
    <button onclick="bwtsLogTab.chatterList()"
      style="cursor:pointer;background:#fff7ed;border:1px solid #fdba74;border-radius:8px;padding:5px 14px;font-size:12px;font-weight:600;color:#c2410c"
      title="밸브 채터링 걸린 선박·월을 한 번에 목록으로">🔧 채터링 목록</button>
    <button onclick="bwtsLogTab.missingMail('ko')"
      style="cursor:pointer;background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;padding:5px 14px;font-size:12px;font-weight:600;color:#b91c1c"
      title="최신 분석월 미수신 선박에 로그 제출 요청 메일 — 한글">✉ 미수신 요청</button>
    <button onclick="bwtsLogTab.missingMail('ko_en')"
      style="cursor:pointer;background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;padding:5px 10px;font-size:12px;font-weight:600;color:#b91c1c"
      title="같은 메일을 한글+영문으로">한/영</button>
    <span class="count" id="blCnt"></span>
  </div>
  <div class="wrap">
    <div id="blMatrix"></div>
    <div id="blDetail" class="bl-detail" style="display:none"></div>
    <div style="margin-top:8px;color:#94a3b8;font-size:11px">
      셀 클릭 → 상세·재검토 · 표시 등급 = 검토 후 등급(있으면) 또는 자동 판정 ·
      빗금 = 판독실패(파서가 못 읽은 것으로 의심 — 미운전 아님) · ⚙ 밸브 채터링(참고, 등급 무관) · ❓ 재검토 요청 중 · ✅ 검토 완료 · ✎ 등급 수정됨 ·
      갱신: <code>pipelines/bwts_log/run.py</code></div>
  </div>`;
  $('blYear').onchange = e => { F.year = e.target.value; loadYear().then(renderAll); };
  $('blReload').onclick = () => { loadedYear = null; loadYear().then(renderAll); };
}

async function loadYear() {
  if (loadedYear === F.year && ROWS.length) return;
  $('blMatrix').innerHTML = '<div class="loading"><span class="spin"></span> 로딩...</div>';
  const res = await sb.from('bwts_log_analysis').select(COLS)
    .gte('period', F.year + '-01').lte('period', F.year + '-12').order('period');
  if (res.error) throw new Error('bwts_log_analysis 조회 실패: ' + res.error.message +
    (/does not exist|relation|Could not find the table|schema cache/.test(res.error.message) ? ' — sql/018_bwts_log_analysis.sql 을 먼저 실행' : ''));
  ROWS = res.data || [];
  loadedYear = F.year;
  if (!YEARS.length) {
    const y = await sb.from('bwts_log_analysis').select('period').order('period', { ascending: true }).limit(1);
    const first = y.data && y.data[0] ? +y.data[0].period.slice(0, 4) : new Date().getFullYear();
    for (let yy = new Date().getFullYear(); yy >= first; yy--) YEARS.push(String(yy));
    if (!YEARS.includes(F.year)) F.year = YEARS[0];
  }
}

function refresh() {
  loadYear().then(renderAll).catch(e => {
    $('blMatrix').innerHTML = `<div class="tab-error"><b>⚠ BWTS 로그 데이터 로드 실패</b><code>${esc(e.message)}</code></div>`;
  });
}

function renderAll() {
  $('blYear').innerHTML = YEARS.map(y => `<option${y === F.year ? ' selected' : ''}>${y}</option>`).join('');
  const cnt = {};
  GRADES.forEach(g => { cnt[g] = 0; });
  let req = 0, rev = 0, esc_ = 0;
  ROWS.forEach(r => {
    cnt[disp(r)] = (cnt[disp(r)] || 0) + 1;
    if (r.review_status === 'requested') req++;
    if (r.review_status === 'escalated') esc_++;
    if (r.review_status !== 'auto') rev++;
  });
  // 등급별 칩을 한 줄로 늘어놓으면 화면 폭을 다 먹는다 — 드롭다운 하나로.
  const opt = (key, label, n) =>
    `<option value="${key}"${F.filter === key ? ' selected' : ''}>${label} (${n})</option>`;
  $('blChips').innerHTML =
    `<select id="blFilterSel" onchange="bwtsLogTab.filter(this.value)" title="등급·검토 상태로 걸러보기">`
    + opt('', '전체', ROWS.length)
    + GRADES.map(g => opt(g, g, cnt[g] || 0)).join('')
    + opt('requested', '❓ 재검토 대기', req)
    + opt('escalated', '🚩 확인요청', esc_)
    + opt('reviewed', '검토·수정됨', rev)
    + '</select>';
  const bl = requireTH('bwts_log');
  $('blCnt').innerHTML = `${ROWS.length} vessel-months`
    + `<span class="muted" style="margin-left:10px;font-size:11px">`
    + `${VALVE_SVG('#dc2626')} 채터링 심각(${bl.chatter_severe_min_events}회+) · `
    + `${VALVE_SVG('#ea580c')} 주의(${bl.chatter_report_min_events}~) · ⚙ 참고표시 · 🚩 확인요청</span>`;
  renderMatrix();
  if (selected) renderDetail();
}

function matches(r) {
  if (!F.filter) return true;
  if (F.filter === 'requested') return r.review_status === 'requested';
  if (F.filter === 'escalated') return r.review_status === 'escalated';
  if (F.filter === 'reviewed') return r.review_status !== 'auto';
  return disp(r) === F.filter;
}

function renderMatrix() {
  if (!ROWS.length) {
    $('blMatrix').innerHTML = `<div class="loading">${F.year}년 분석 데이터 없음 — run.py 실행 필요</div>`;
    return;
  }
  const byKey = {};
  ROWS.forEach(r => { byKey[r.ship_code + '|' + r.period] = r; });
  const months = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'));
  const ships = getShipOrder().filter(c => ROWS.some(r => r.ship_code === c) || true);
  const head = '<tr><th style="width:56px">선박</th>' + months.map(m => `<th style="text-align:center">${+m}월</th>`).join('') + '</tr>';
  const body = ships.map(code => {
    const s = shipByCode(code);
    const tds = months.map(m => {
      const r = byKey[code + '|' + F.year + '-' + m];
      if (!r) return '<td class="bl-cell bl-empty"></td>';
      const g = disp(r);
      const st = STYLE[g] || STYLE['미수신'];
      const dim = matches(r) ? '' : 'opacity:.18;';
      const sel = selected && selected.ship_code === r.ship_code && selected.period === r.period ? 'outline:2px solid #2563eb;' : '';
      const mark = REVIEW_MARK[r.review_status] || '';
      // 칸에는 등급 · 수신 여부 · BWTS 본체 문제 개수만. 밸브 채터링 같은
      // 부수 문제는 숫자에 넣지 않는다 — 세부는 칸을 눌러 상세에서 본다.
      const sub = g === '미수신' ? '' :
        [recvOf(r), issueCount(r) ? `문제 ${issueCount(r)}` : ''].filter(Boolean).join(' · ');
      const fl = flagsOf(r);
      const flag = fl.length ? ` <span class="bl-flag" title="${esc(fl.join(', '))}">⚙</span>` : '';
      const ch = chatterOf(r);
      const valve = ch
        ? ` <span title="밸브 채터링 ${ch.level} — ${esc(ch.valves.map(v => v.valve + ' ' + v.chatter_events + '회').join(', '))}">`
          + VALVE_SVG(ch.level === '심각' ? '#dc2626' : '#ea580c') + '</span>'
        : '';
      return `<td class="bl-cell" style="background:${st.bg};color:${st.fg};${dim}${sel}" onclick="bwtsLogTab.select('${esc(r.ship_code)}','${esc(r.period)}')" title="${esc(code)} ${esc(r.period)} ${esc(g)}${r.grade !== g ? ' (자동: ' + esc(r.grade) + ')' : ''}">` +
        `<div class="bl-g">${esc(g)}${mark ? ' <span class="bl-mark">' + mark + '</span>' : ''}${flag}${valve}</div><div class="bl-sub">${esc(sub)}</div></td>`;
    }).join('');
    return `<tr><td><b>${esc(code)}</b><div style="font-size:10px;color:#94a3b8">${esc(s ? (s.bwts_maker || '') : '')}</div></td>${tds}</tr>`;
  }).join('');
  $('blMatrix').innerHTML = `<div style="overflow-x:auto"><table class="bl-matrix"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

/* ===== detail ===== */
function select(ship_code, period) {
  selected = { ship_code, period };
  renderMatrix();
  renderDetail();
  $('blDetail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function renderDetail() {
  const r = ROWS.find(x => x.ship_code === selected.ship_code && x.period === selected.period);
  const box = $('blDetail');
  if (!r) { box.style.display = 'none'; return; }
  box.style.display = '';
  const g = disp(r);
  const st = STYLE[g] || STYLE['미수신'];
  const num = v => v == null ? '—' : (+v).toFixed(2);
  const reasons = (r.grade_reasons || []).map(x => `<li>${esc(x)}</li>`).join('') || '<li class="muted">—</li>';
  const fl = flagsOf(r);
  const flagsHtml = fl.length
    ? `<div class="bl-sec"><h4>참고 표시 (등급 무관)</h4><ul>${fl.map(x => `<li>⚙ ${esc(x)}</li>`).join('')}</ul></div>` : '';
  const integ = r.integrity && r.integrity.hits && r.integrity.hits.length
    ? `<div class="bl-sec"><h4>판독 무결성 검사 (${esc(r.integrity.hits.join(', '))})</h4><ul>${(r.integrity.detail || []).map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : '';
  const review = r.review_status !== 'auto'
    ? `<div class="bl-sec bl-review"><h4>검토 결과 — ${esc(r.review_status)}${r.final_grade ? ' → <b>' + esc(r.final_grade) + '</b>' : ''}</h4>
       ${r.review_status === 'escalated' ? '<div style="color:#b91c1c;font-weight:600;margin-bottom:4px">🚩 자동 재검토 실패 — 사람 확인 필요. 「재분석」을 누르면 다시 시도한다</div>' : ''}
       <div>${esc(r.review_note || '')}</div><div class="muted" style="font-size:11px">${esc(r.reviewed_by || '')} ${r.reviewed_at ? esc(r.reviewed_at.slice(0, 16).replace('T', ' ')) : ''}</div></div>` : '';
  box.innerHTML = `
  <div class="bl-head">
    <span class="bl-badge" style="background:${st.bg};color:${st.fg}">${esc(g)}</span>
    <b>${esc(r.ship_code)}</b> ${esc(r.period)}
    ${r.grade !== g ? `<span class="muted">자동 판정: ${esc(r.grade)}</span>` : ''}
    ${r.grade_rule && r.grade_rule !== r.grade ? `<span class="muted">룰 판정: ${esc(r.grade_rule)}</span>` : ''}
    <span class="muted" style="font-size:11px">분석 ${esc((r.analyzed_at || '').slice(0, 16).replace('T', ' '))}</span>
    <div class="spacer"></div>
    <button class="add-btn" onclick="bwtsLogTab.issueMail('ko')"
      title="이 달 등급 사유로 본선에 확인 요청 메일">✉ 본선 메일</button>
    <button class="add-btn" onclick="bwtsLogTab.issueMail('ko_en')"
      title="한글+영문 병기">✉ 한/영</button>
    <button class="refresh-btn" onclick="bwtsLogTab.reanalyze()"
      title="이 선박·월만 다시 분석 — 로컬 Claude Code 가 열린다">🔄 재분석</button>
    <button class="add-btn" onclick="bwtsLogTab.requestReview()">❓ 재검토 요청</button>
    <button class="refresh-btn" onclick="bwtsLogTab.override()">✎ 등급 수정</button>
    <button class="refresh-btn" onclick="bwtsLogTab.close()">✕</button>
  </div>
  <div class="bl-grid">
    <div class="bl-sec"><h4>판정 사유</h4><ul>${reasons}</ul></div>
    <div class="bl-sec"><h4>운전</h4>
      <div>수신: ${esc(r.reception || '—')}</div>
      <div>Ballast ${r.ballast_count} / Deballast ${r.deballast_count} · 운전일 ${r.op_days}</div>
      <div>알람 ${r.alarm_count} · Trip ${r.trip_count}</div></div>
    <div class="bl-sec"><h4>TRO (warm-up 제외)</h4>
      <div>주입 avg ${num(r.tro_b_avg)} / min ${num(r.tro_b_min)} ppm ${r.tro_b_in_range === false ? '<span class="lv-expired pill">범위 이탈</span>' : r.tro_b_in_range ? '<span class="lv-ok pill">정상</span>' : ''}</div>
      <div>배출 max ${num(r.tro_d_max)} ppm ${r.tro_d_compliant === false ? '<span class="lv-expired pill">초과</span>' : r.tro_d_compliant ? '<span class="lv-ok pill">정상</span>' : ''}</div></div>
    ${flagsHtml}${integ}${review}
  </div>
  <div id="blSessions" class="bl-sec"><span class="spin"></span> 세션·재검토 이력 로딩...</div>`;
  // Heavy parts on demand: full summary (sessions) + review thread
  const [sum, rv] = await Promise.all([
    sb.from('bwts_log_analysis').select('summary').eq('ship_code', r.ship_code).eq('period', r.period).maybeSingle(),
    sb.from('bwts_reviews').select('*').eq('ship_code', r.ship_code).eq('period', r.period).order('created_at'),
  ]);
  if (!selected || selected.ship_code !== r.ship_code || selected.period !== r.period) return;
  const sess = (sum.data && sum.data.summary && sum.data.summary.session_summaries) || [];
  const chat = (sum.data && sum.data.summary && sum.data.summary.chattering) || [];
  const rp = (sum.data && sum.data.summary && sum.data.summary.recovery_pattern) || {};
  // 일자~판정은 붙여서 한 눈에 읽히게 폭을 고정하고, 숫자는 자릿수를 맞춰
  // 오른쪽 정렬한다. 남는 폭은 비고가 가져가고 거기서만 줄바꿈된다.
  const NUM = 'text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap';
  const sessRows = sess.slice(0, 60).map(x =>
    `<tr><td style="white-space:nowrap">${esc(x.date || '')}</td>` +
    `<td style="white-space:nowrap">${esc(x.mode || '')}</td>` +
    `<td style="${NUM}">${x.duration_min != null ? Math.round(x.duration_min) : '—'}</td>` +
    `<td style="${NUM}">${x.stable_avg != null ? (+x.stable_avg).toFixed(2) : '—'}</td>` +
    `<td style="${NUM}">${x.stable_min != null ? (+x.stable_min).toFixed(2) : '—'}</td>` +
    `<td style="${NUM}">${x.stable_max != null ? (+x.stable_max).toFixed(2) : '—'}</td>` +
    `<td style="text-align:center;white-space:nowrap">${x.in_range === false ? '<span class="lv-expired pill">이탈</span>' : x.in_range ? '<span class="lv-ok pill">OK</span>' : ''}</td>` +
    `<td style="color:#c2410c">${esc(x.issue || '')}</td></tr>`).join('');
  const thread = (rv.data || []).map(q =>
    `<div class="bl-q"><div><b>Q</b> ${esc(q.question)} <span class="muted" style="font-size:11px">${esc(q.requested_by || '')} ${esc((q.created_at || '').slice(0, 16).replace('T', ' '))}</span></div>` +
    (q.answer ? `<div class="bl-a"><b>A</b> ${esc(q.answer)} <span class="muted" style="font-size:11px">${esc(q.answered_by || '')} ${esc((q.answered_at || '').slice(0, 16).replace('T', ' '))}</span></div>` : '<div class="muted" style="font-size:11px">답변 대기 — 로컬에서 /bwts-review 실행</div>') + '</div>').join('');
  $('blSessions').innerHTML =
    (rp.pattern ? `<div style="margin-bottom:6px"><b>회복 패턴:</b> ${esc(rp.pattern)} — ${esc(rp.detail || '')}</div>` : '') +
    chatterDetail(chat) +
    `<h4>세션 (${sess.length}${sess.length > 60 ? ', 60개 표시' : ''})</h4>` +
    (sessRows ? `<table class="cal-table" style="table-layout:fixed;width:100%">`
      + `<colgroup><col style="width:88px"><col style="width:64px"><col style="width:46px">`
      + `<col style="width:66px"><col style="width:58px"><col style="width:58px">`
      + `<col style="width:56px"><col></colgroup>`
      + `<thead><tr><th>일자</th><th>모드</th><th style="text-align:right">분</th>`
      + `<th style="text-align:right">TRO avg</th><th style="text-align:right">min</th>`
      + `<th style="text-align:right">max</th><th style="text-align:center">판정</th>`
      + `<th>비고</th></tr></thead><tbody>${sessRows}</tbody></table>`
      : '<div class="muted">세션 없음</div>') +
    `<h4 style="margin-top:12px">재검토 이력 (${(rv.data || []).length})</h4>${thread || '<div class="muted">없음</div>'}`;
}

function close() { selected = null; $('blDetail').style.display = 'none'; renderMatrix(); }
function filter(k) { F.filter = k; renderAll(); }

/* ===== 채터링 목록 — 월·선박으로 좁혀 보고, 그대로 메일에 붙인다 ===== */
const CH = { month: '', ship: '', view: 'detail', lang: 'ko', picked: new Set() };

function chatterItems() {
  const out = [];
  ROWS.forEach(r => {
    if (CH.month && r.period !== CH.month) return;
    if (CH.ship && r.ship_code !== CH.ship) return;
    const ch = chatterOf(r);
    if (ch) ch.valves.forEach(v => out.push({ r, v }));
  });
  return out.sort((a, b) => (b.v.chatter_events || 0) - (a.v.chatter_events || 0));
}

// 선박별 집계 — 몇 달째 반복되는지가 "수리가 안 되고 있다"의 신호다.
function chatterByShip(items) {
  const severeMin = requireTH('bwts_log').chatter_severe_min_events;
  const by = {};
  items.forEach(({ r, v }) => {
    const s = by[r.ship_code] || (by[r.ship_code] = {
      code: r.ship_code, months: new Set(), valves: {}, count: 0, severe: 0,
      worst: 0, last: '', lastGrade: '',
    });
    s.months.add(r.period);
    s.valves[v.valve] = (s.valves[v.valve] || 0) + (v.chatter_events || 0);
    s.count++;
    if ((v.chatter_events || 0) >= severeMin) s.severe++;
    if ((v.chatter_events || 0) > s.worst) s.worst = v.chatter_events || 0;
    if (r.period > s.last) { s.last = r.period; s.lastGrade = disp(r); }
  });
  return Object.values(by).map(s => ({
    ...s,
    monthCount: s.months.size,
    topValve: Object.entries(s.valves).sort((a, b) => b[1] - a[1])[0][0],
  })).sort((a, b) => b.monthCount - a.monthCount || b.worst - a.worst);
}

function chatterSet(k, v) { CH[k] = v; chatterList(); }

function chatterList() {
  const bl = requireTH('bwts_log');
  const items = chatterItems();
  const months = [...new Set(ROWS.map(r => r.period))].sort();
  const ships = [...new Set(ROWS.filter(r => chatterOf(r)).map(r => r.ship_code))].sort();

  const sel = (id, cur, opts, all) =>
    `<select onchange="bwtsLogTab.chatterSet('${id}', this.value)">`
    + `<option value=""${cur ? '' : ' selected'}>${all}</option>`
    + opts.map(o => `<option${o === cur ? ' selected' : ''}>${esc(o)}</option>`).join('')
    + '</select>';

  const head = `<div class="bl-head" style="flex-wrap:wrap;gap:6px">`
    + `<b>밸브 채터링 — ${esc(F.year)}년</b>`
    + sel('month', CH.month, months, '전체 월')
    + sel('ship', CH.ship, ships, '전체 선박')
    + `<select onchange="bwtsLogTab.chatterSet('view', this.value)">`
    + `<option value="detail"${CH.view === 'detail' ? ' selected' : ''}>월별 상세</option>`
    + `<option value="ship"${CH.view === 'ship' ? ' selected' : ''}>선박별 요약</option></select>`
    + `<div class="spacer"></div>`
    + `<button class="refresh-btn" onclick="bwtsLogTab.copyChatter()">📋 표 복사</button>`
    + `<button class="refresh-btn" onclick="bwtsLogTab.copyChatterMail()">📄 전체 텍스트</button>`
    + `<button class="add-btn" onclick="bwtsLogTab.chatterMailSelected('ko')"`
    + ` title="체크한 선박 전부를 받는 사람으로 한 통 작성 — 한글">`
    + `✉ 선박 메일${CH.picked.size ? ' (' + CH.picked.size + '척)' : ''}</button>`
    + `<button class="add-btn" onclick="bwtsLogTab.chatterMailSelected('ko_en')"`
    + ` title="같은 메일을 한글+영문으로">✉ 한/영</button>`
    + `<button class="refresh-btn" onclick="bwtsLogTab.close()">✕</button></div>`;

  const box = $('blDetail');
  box.style.display = 'block';
  if (!items.length) {
    box.innerHTML = head + `<div class="muted" style="padding:10px">`
      + `${bl.chatter_report_min_events}회 이상 채터링 없음</div>`;
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }

  let table;
  if (CH.view === 'ship') {
    const rows = chatterByShip(items).map(s =>
      `<tr style="cursor:pointer" onclick="bwtsLogTab.select('${esc(s.code)}','${esc(s.last)}')">`
      + `<td onclick="event.stopPropagation()"><input type="checkbox"${CH.picked.has(s.code) ? ' checked' : ''}`
      + ` onchange="bwtsLogTab.chatterPick('${esc(s.code)}', this.checked)" title="메일 대상"></td>`
      + `<td><b>${esc(s.code)}</b></td>`
      + `<td style="text-align:right;font-weight:${s.monthCount >= 3 ? '700' : '400'};`
      + `color:${s.monthCount >= 3 ? '#dc2626' : 'inherit'}">${s.monthCount}개월</td>`
      + `<td style="text-align:right">${s.count}</td>`
      + `<td style="text-align:right">${s.severe}</td>`
      + `<td>${esc(s.topValve)}</td>`
      + `<td style="text-align:right">${s.worst.toLocaleString()}</td>`
      + `<td>${esc(s.last)}</td><td>${esc(s.lastGrade)}</td>`
      + `<td><button class="refresh-btn" style="padding:2px 8px"`
      + ` onclick="event.stopPropagation();bwtsLogTab.chatterMail('${esc(s.code)}')"`
      + ` title="${esc(vesselMail(s.code))}로 메일 작성">✉ 메일</button></td></tr>`).join('');
    const allPicked = ships.length && ships.every(c => CH.picked.has(c));
    table = `<table class="cal-table"><thead><tr>`
      + `<th><input type="checkbox"${allPicked ? ' checked' : ''}`
      + ` onchange="bwtsLogTab.chatterPick('*', this.checked)" title="전체 선택"></th>`
      + `<th>선박</th><th>발생 개월</th>`
      + `<th>건수</th><th>심각</th><th>최다 밸브</th><th style="text-align:right">최대 횟수</th>`
      + `<th>최근 발생</th><th>그 달 등급</th><th>본선 통보</th></tr></thead><tbody>${rows}</tbody></table>`
      + `<div class="muted" style="font-size:11px;margin-top:6px">`
      + `발생 개월 3 이상(빨강) = 여러 달 반복 — 수리가 안 되고 있다는 신호</div>`;
  } else {
    const rows = items.map(({ r, v }) => {
      const sev = (v.chatter_events || 0) >= bl.chatter_severe_min_events ? '심각' : '주의';
      const col = sev === '심각' ? '#dc2626' : '#ea580c';
      return `<tr style="cursor:pointer" onclick="bwtsLogTab.select('${esc(r.ship_code)}','${esc(r.period)}')">`
        + `<td onclick="event.stopPropagation()"><input type="checkbox"${CH.picked.has(r.ship_code) ? ' checked' : ''}`
        + ` onchange="bwtsLogTab.chatterPick('${esc(r.ship_code)}', this.checked)" title="메일 대상"></td>`
        + `<td><b>${esc(r.ship_code)}</b></td><td>${esc(r.period)}</td>`
        + `<td>${VALVE_SVG(col)} ${esc(v.valve || '?')}</td>`
        + `<td style="text-align:right">${(v.chatter_events || 0).toLocaleString()}</td>`
        + `<td style="color:${col};font-weight:600">${sev}</td>`
        + `<td style="text-align:right">${v.burst_count}</td>`
        + `<td>${esc(v.worst_burst_start || '')}</td>`
        + `<td>${esc(disp(r))}</td>`
        + `<td><button class="refresh-btn" style="padding:2px 8px"`
        + ` onclick="event.stopPropagation();bwtsLogTab.chatterMail('${esc(r.ship_code)}')"`
        + ` title="${esc(vesselMail(r.ship_code))}로 메일 작성">✉</button></td></tr>`;
    }).join('');
    const shipsInView = [...new Set(items.map(i => i.r.ship_code))];
    const allPickedD = shipsInView.length && shipsInView.every(c => CH.picked.has(c));
    table = `<table class="cal-table"><thead><tr>`
      + `<th><input type="checkbox"${allPickedD ? ' checked' : ''}`
      + ` onchange="bwtsLogTab.chatterPick('*', this.checked)" title="전체 선택"></th>`
      + `<th>선박</th><th>월</th><th>밸브</th>`
      + `<th style="text-align:right">횟수</th><th>심각도</th><th style="text-align:right">버스트</th>`
      + `<th>최악 시각</th><th>그 달 등급</th><th>메일</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  const shipSet = new Set(items.map(i => i.r.ship_code));
  const severe = items.filter(i => (i.v.chatter_events || 0) >= bl.chatter_severe_min_events).length;
  box.innerHTML = head
    + `<div class="muted" style="margin:4px 0 8px">${shipSet.size}척 · ${items.length}건`
    + ` (심각 ${severe}) · ${bl.chatter_report_min_events}회 이상만</div>`
    + table
    + `<div class="muted" style="font-size:11px;margin-top:6px">행을 누르면 그 칸 상세로 이동. `
    + `채터링은 등급에 반영되지 않는다 — BWTS 본체 판정과 별개.</div>`;
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function copyChatter() {
  const bl = requireTH('bwts_log');
  const items = chatterItems();
  let text;
  if (CH.view === 'ship') {
    text = ['선박\t발생개월\t건수\t심각\t최다밸브\t최대횟수\t최근발생\t등급']
      .concat(chatterByShip(items).map(s =>
        [s.code, s.monthCount, s.count, s.severe, s.topValve, s.worst, s.last, s.lastGrade].join('\t')))
      .join('\n');
  } else {
    text = ['선박\t월\t밸브\t횟수\t심각도\t버스트\t최악시각\t등급']
      .concat(items.map(({ r, v }) =>
        [r.ship_code, r.period, v.valve, v.chatter_events,
          (v.chatter_events || 0) >= bl.chatter_severe_min_events ? '심각' : '주의',
          v.burst_count, v.worst_burst_start, disp(r)].join('\t')))
      .join('\n');
  }
  navigator.clipboard.writeText(text)
    .then(() => toast('표 복사 — 엑셀에 붙여넣기'))
    .catch(() => toast('복사 실패 — 표를 직접 선택해 주세요'));
}

// 선박별 문장. 본선 통보 메일에 그대로 붙일 수 있는 형태로.
function copyChatterMail() {
  const bl = requireTH('bwts_log');
  const items = chatterItems();
  if (!items.length) { toast('대상 없음'); return; }
  const scope = CH.month ? CH.month : `${F.year}년`;
  const lines = chatterByShip(items).map(s => {
    const mine = items.filter(i => i.r.ship_code === s.code);
    const det = mine.map(({ r, v }) =>
      `   - ${r.period} ${v.valve} ${(v.chatter_events || 0).toLocaleString()}회`
      + ` (${(v.chatter_events || 0) >= bl.chatter_severe_min_events ? '심각' : '주의'},`
      + ` 버스트 ${v.burst_count}회, 최악 ${v.worst_burst_start})`).join('\n');
    return `[${s.code}] ${s.monthCount}개월 ${s.count}건`
      + (s.monthCount >= 3 ? ' — 반복 발생, 수리 확인 요망' : '')
      + `\n${det}`;
  });
  const text = `BWTS 밸브 채터링 현황 (${scope})\n`
    + `대상: ${new Set(items.map(i => i.r.ship_code)).size}척 ${items.length}건`
    + ` (${bl.chatter_report_min_events}회 이상)\n\n`
    + lines.join('\n\n')
    + `\n\n※ 채터링은 BWTS 운전 등급과 별개의 부수 항목입니다.`;
  navigator.clipboard.writeText(text)
    .then(() => toast('메일용 텍스트 복사 완료'))
    .catch(() => toast('복사 실패'));
}

/* ===== 본선 메일 =====
   주소는 mail_log 에서 확인된 규칙: kmtc<코드>@sea-one.com (21척 전부 일치).
   Gmail 작성창을 열면 Gmail 이 곧바로 임시보관함에 저장한다.
   본선이 읽는 글이므로 버스트·평균간격 같은 분석 용어는 넣지 않는다 —
   밸브 번호와 횟수, 그리고 그게 무슨 현상인지만. */
const vesselMail = code => `kmtc${String(code).toLowerCase()}@sea-one.com`;

// Gmail 작성창. 반드시 클릭 핸들러 안에서 동기적으로 열어야 팝업 차단을 안 맞는다 —
// 그 앞에 prompt() 같은 모달을 두면 웨일은 제스처가 끝난 것으로 보고 막는다.
// 본문은 항상 URL 에 싣는다. 본문을 짧게 유지하는 게 전제 — 6척 한/영 기준 ~4,000자로
// Gmail 한도 안. 길어져 400 이 나면 문구를 줄이지 클립보드로 우회하지 않는다.
function gmailCompose(to, subject, body) {
  const url = 'https://mail.google.com/mail/?view=cm&fs=1'
    + '&to=' + encodeURIComponent(to)
    + '&su=' + encodeURIComponent(subject)
    + '&body=' + encodeURIComponent(body);
  const w = window.open(url, '_blank');
  if (!w) {
    toast('팝업이 차단됨 — 주소창 오른쪽 차단 아이콘에서 허용 후 다시');
    return;
  }
  toast(`${to.split(',').length}명 작성창 — 그대로 두면 임시보관함에 저장됨`);
}

// 등급 사유는 한국어 문구로 저장된다. 자주 나오는 것만 영문을 붙인다.
function reasonEn(s) {
  const m = [
    [/^주입 TRO 범위 이탈.*/, 'Injection TRO out of the required range'],
    [/^배출 TRO 기준 초과.*/, 'Discharge TRO above the allowed limit'],
    [/^Trip (\d+)건/, (x, n) => `Trip occurred ${n} time(s)`],
    [/^밸브 채터링.*/, 'Valve open/close signal repeating'],
  ];
  for (const [re, en] of m) {
    const g = s.match(re);
    if (g) return typeof en === 'function' ? en(...g) : en;
  }
  return null;
}

function periodLabel() {
  return CH.month ? `${CH.month.slice(0, 4)}년 ${+CH.month.slice(5)}월` : `${F.year}년`;
}

// 채터링 통보 — /mail 지침 양식. 여러 척을 체크해 한 통으로 보낸다: 받는 사람은
// 체크한 선박 전부, 본문은 "VRCS 신호 검토 요청" + 선박별 밸브 이름·횟수·정도만.
// 버스트·최악시각 같은 분석 용어는 화면 표에만 두고 메일엔 넣지 않는다.
const SENDER_KO = 'KMTC SM ETP / 정현우 과장';
const SENDER_EN = 'KMTC SM ETP / Hyunwoo Jung';

// Gmail 작성 URL 로 여는 메일에는 계정 서명이 안 붙는다 — 본문 끝에 직접 넣는다.
const SIGN = [
  '',
  '감사합니다. thanks,',
  '==========================================================',
  '정 현 우 (H.W. JUNG 鄭 泫 禹 / 과장 (Manager)',
  'Environment Tech. Part / Repair & Supply Team',
  'KMTC Ship Management Co.,Ltd. (KMTC SM)',
  'E-mail : hwjung@ekmtc.com',
  'Office : TEL : +82-51-790-2473 / FAX : +82-51-466-5217',
  'M.P : +82-10-7930-3820',
  '==========================================================',
].join('\n');
const shipName = code => { const s = shipByCode(code); return (s && s.name) || code; };
const replyBy = () => { const d = new Date(); d.setDate(d.getDate() + 5); return d; };
const koDate = d => `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;

// code → [{valve, n, months}] 심한 순
function valvesByShip(codes) {
  const out = {};
  chatterItems().forEach(({ r, v }) => {
    if (!codes.includes(r.ship_code)) return;
    const s = out[r.ship_code] || (out[r.ship_code] = {});
    const b = s[v.valve] || (s[v.valve] = { n: 0, months: new Set() });
    b.n += v.chatter_events || 0;
    b.months.add(r.period);
  });
  const res = {};
  Object.entries(out).forEach(([code, vs]) => {
    res[code] = Object.entries(vs).map(([valve, b]) => ({ valve, n: b.n, months: b.months.size }))
      .sort((a, b) => b.n - a.n);
  });
  return res;
}

function chatterMailBody(codes, lang) {
  const bl = requireTH('bwts_log');
  const sev = n => n >= bl.chatter_severe_min_events ? '심각' : '주의';
  const sevEn = n => n >= bl.chatter_severe_min_events ? 'severe' : 'caution';
  const by = valvesByShip(codes);
  const ships = codes.filter(c => by[c]);
  const per = CH.month ? `${+CH.month.slice(0, 4)}년 ${+CH.month.slice(5)}월` : `${F.year}년`;
  const due = replyBy();
  const multi = ships.length > 1;
  const recv = multi ? '하기 선박 / 선장님, 기관장님' : `${shipName(ships[0])} / 선장님, 기관장님`;
  const line = (c, ko) => `${shipName(c)} : ` + by[c].map(x =>
    `${x.valve} ${x.n.toLocaleString()}${ko ? '회' : ''} (${ko ? sev(x.n) : sevEn(x.n)}${x.months > 1 ? (ko ? `, ${x.months}개월` : `, ${x.months} months`) : ''})`).join(' / ');

  const L = [];
  L.push(`수신 : ${recv}`);
  L.push(`발신 : ${SENDER_KO}`);
  L.push('');
  L.push('업무에 수고가 많으십니다.');
  L.push('');
  L.push('밸브 채터링 과다로 BWTS 로그가 과다 기록되며, BWTS 시스템에 DATA LOG 가 과도하게 쌓여 성능이 저하되는 문제가 발생합니다.');
  L.push('');
  L.push(`${per} BWTS 로그 확인 결과 하기 선박의 밸브에서 채터링(열림·닫힘 신호 반복)이 확인되어 밸브 및 VRCS 시스템 점검을 요청드립니다.`);
  L.push('');
  L.push('■ 요청 사항');
  L.push('1) 하기 밸브 채터링 및 VRCS 시스템 점검');
  L.push('2) 작업 예정일 회신. 이미 수리한 경우 수리 완료 및 조치 내역 회신');
  L.push(`3) 회신 희망일 : ${koDate(due)}`);
  L.push('');
  L.push(`■ ${per} 선박별 확인 현상 (밸브 : 개폐 신호 횟수)`);
  ships.forEach((c, i) => L.push(`${i + 1}) ${line(c, true)}`));
  L.push('');
  L.push('■ 참고 사항');
  L.push('1) 밸브 개폐 신호 반복은 BWTS 운전 등급과는 별개의 점검 항목입니다.');
  if (multi) L.push('2) 본 메일은 해당 선박에 일괄 발송되었습니다. 자선 항목만 확인해 주시기 바랍니다.');
  const ko = L.join('\n');
  if (lang === 'ko') return ko;

  const E = ['', '----------------------------------------', '',
    `TO : ${multi ? 'Vessels below' : shipName(ships[0])} / Master, Chief Engineer`,
    `FR : ${SENDER_EN}`, '',
    'Dear Master and Chief Engineer,', '',
    'Excessive valve chattering floods the BWTS log, and the DATA LOG built up in the BWTS system degrades its performance.', '',
    `Our review of the ${CH.month || F.year} BWTS log shows valve chattering (repeating open/close signal) on the valves below. Please check the valves and the VRCS system.`, '',
    '■ Request',
    '1) Check the valves below and the VRCS (valve remote control) system',
    '2) Reply with the planned work date. If already repaired, reply that it is done and what was done',
    `3) Reply requested by ${due.toISOString().slice(0, 10)}`, '',
    '■ What the log shows (valve : open/close signal count)'];
  ships.forEach((c, i) => E.push(`${i + 1}) ${line(c, false)}`));
  E.push('', '* This item is separate from the BWTS operation grade.');
  if (multi) E.push('* Sent to all vessels listed. Please check your own vessel\'s item only.');
  // 맺음 인사는 SIGN 이 대신한다 ('감사합니다. thanks,')
  return ko + '\n' + E.join('\n');
}

function chatterMailMulti(codes, lang) {
  const by = valvesByShip(codes);
  const ships = codes.filter(c => by[c]);
  if (!ships.length) { toast('선택한 선박에 표시할 채터링이 없음'); return; }
  lang = lang || 'ko';
  CH.lang = lang;
  const per = CH.month ? `${+CH.month.slice(5)}월` : `${F.year}년`;
  // 제목은 한글·영문 병기 — 본선에서 영문만 읽는 경우가 있다.
  const subject = `[KMTC SM][ETP] BWTS 밸브 채터링 및 VRCS 점검 요청의 건 (${per})`
    + ` / BWTS Valve Chattering & VRCS Inspection Request (${CH.month || F.year})`;
  gmailCompose(ships.map(vesselMail).join(','), subject,
    chatterMailBody(ships, lang) + '\n' + SIGN);
}

function chatterMail(code) { chatterMailMulti([code], 'ko'); }

// 헤더 버튼: 체크한 선박 → 한 통. 체크 없으면 드롭다운 선박, 그것도 없고 한 척뿐이면 그 척.
// 언어는 버튼으로 받는다 — 여기서 prompt() 를 띄우면 그 뒤의 window.open 이 팝업 차단에 걸린다.
function chatterMailSelected(lang) {
  if (CH.picked.size) { chatterMailMulti([...CH.picked], lang); return; }
  const ships = [...new Set(chatterItems().map(i => i.r.ship_code))];
  const code = CH.ship || (ships.length === 1 ? ships[0] : '');
  if (!code) { toast('선박을 체크하거나 드롭다운에서 고르세요'); return; }
  chatterMailMulti([code], lang);
}

function chatterPick(code, on) {
  if (code === '*') {
    const all = [...new Set(chatterItems().map(i => i.r.ship_code))];
    on ? all.forEach(c => CH.picked.add(c)) : CH.picked.clear();
  } else {
    on ? CH.picked.add(code) : CH.picked.delete(code);
  }
  chatterList();
}

// BWTS 본체 문제 통보 — 등급을 가른 사유만
function issueMail(lang) {
  if (!selected) return;
  const r = ROWS.find(x => x.ship_code === selected.ship_code && x.period === selected.period);
  if (!r) return;
  const reasons = r.grade_reasons || [];
  if (!reasons.length) { toast('이 달은 등급 사유가 없음 — 보낼 내용이 없습니다'); return; }
  const per = `${r.period.slice(0, 4)}년 ${+r.period.slice(5)}월`;

  const ko = [
    `${per} BWTS 로그 확인 결과, 아래 사항이 확인되었습니다.`,
    ``,
    ...reasons.map(x => `  - ${x}`),
    ``,
    `해당 기간 판정: ${disp(r)}`,
    ``,
    `원인 확인 후 조치 내역을 회신해 주시기 바랍니다.`,
    `조치가 어려운 경우 필요한 자재·지원 사항을 함께 알려 주십시오.`,
  ].join('\n');

  let body = ko;
  if (lang === 'ko_en') {
    const en = reasons.map(x => `  - ${reasonEn(x) || x}`);
    body += '\n\n' + [
      `----------------------------------------`,
      ``,
      `Our review of the BWTS log for ${r.period} found the following.`,
      ``,
      ...en,
      ``,
      `Assessment for the period: ${disp(r)}`,
      ``,
      `Please check the cause and reply with the action taken.`,
      `If it cannot be resolved onboard, advise the parts or support required.`,
    ].join('\n');
  }
  gmailCompose(vesselMail(r.ship_code),
    `[${r.ship_code}] BWTS 운전 상태 확인 요청 (${r.period})`, body + '\n' + SIGN);
}

/* ===== 미수신 로그 제출 요청 =====
   그 달 판정이 미수신(또는 폴더만/빈파일)인 선박에 한 통. 요청 파일은 메이커마다
   다르므로 선박별로 적는다. KDE 는 ERMA FIRST 리트로핏이라 우리도 제출 형식을
   확정하지 못했으므로 파일 목록을 지정하지 않고 생성 가능한 로그와 형식을 묻는다. */
const MISSING_GRADES = ['미수신'];
const MAKER_FILES = {
  techcross: ['DATALOG', 'EVENTLOG', 'OPERATIONTIMELOG', 'TOTALLOG'],
  alfalaval: ['PureBallast 운전 로그 (csv 또는 xlsx)'],
};

function makerOf(code) {
  const s = shipByCode(code);
  const m = String((s && s.bwts_maker) || '').toUpperCase();
  if (m.includes('ERMA')) return 'ermafirst';
  if (m.includes('ALFA')) return 'alfalaval';
  if (m.includes('TECHCROSS') || m.includes('테크로스')) return 'techcross';
  return 'techcross';
}

function missingShips(period) {
  return ROWS.filter(r => r.period === period && MISSING_GRADES.includes(disp(r)))
    .map(r => r.ship_code).sort();
}

function missingMailBody(period, codes, lang) {
  const [y, m] = [period.slice(0, 4), +period.slice(5)];
  const per = `${y}년 ${m}월`;
  const due = replyBy();
  const multi = codes.length > 1;
  const recv = multi ? '하기 선박 / 선장님, 기관장님'
    : `${shipName(codes[0])} / 선장님, 기관장님`;
  const subj = `[CODE]_BWTS_LOG_DATA_(${y}.${String(m).padStart(2, '0')})`;

  const L = [];
  L.push(`수신 : ${recv}`);
  L.push(`발신 : ${SENDER_KO}`);
  L.push('');
  L.push('업무에 수고가 많으십니다.');
  L.push('');
  L.push(`${per} BWTS LOG DATA 가 아직 접수되지 않아 제출을 요청드립니다. BWTS 운전 기록은 규제 대응 자료로 매월 취합되고 있어, 미제출 시 해당 월 운전 상태를 확인할 수 없습니다.`);
  L.push('');
  L.push('■ 요청 사항');
  L.push(`1) ${per} BWTS LOG DATA 송부`);
  L.push(`2) 메일 제목 : ${subj} (CODE = 자선 3자리 코드)`);
  L.push(`3) 회신 희망일 : ${koDate(due)}`);
  L.push('');
  L.push('■ 선박별 요청 자료');
  codes.forEach((c, i) => {
    const mk = makerOf(c);
    if (mk === 'ermafirst') {
      L.push(`${i + 1}) ${shipName(c)} : BWTS 교체 이후 제출 형식이 확정되지 않았습니다.`);
      L.push('   본선 시스템에서 추출 가능한 운전 로그 전부와, 추출 화면·파일 형식을 함께 회신해 주시기 바랍니다.');
    } else {
      L.push(`${i + 1}) ${shipName(c)} : ${MAKER_FILES[mk].join(', ')}`);
    }
  });
  L.push('');
  L.push('■ 참고 사항');
  L.push('1) 로그 추출 방법 : HMI LOG 버튼 → 기간 설정 → 자료 선택 → CREATE (Troubleshooting Book 5.1 p.44)');
  L.push('2) 이미 송부하셨다면 송부 일자와 수신처를 회신해 주시기 바랍니다.');
  if (multi) L.push('3) 본 메일은 해당 선박에 일괄 발송되었습니다. 자선 항목만 확인해 주시기 바랍니다.');
  const ko = L.join('\n');
  if (lang === 'ko') return ko;

  const E = ['', '----------------------------------------', '',
    `TO : ${multi ? 'Vessels below' : shipName(codes[0])} / Master, Chief Engineer`,
    `FR : ${SENDER_EN}`, '',
    'Dear Master and Chief Engineer,', '',
    `We have not received the BWTS LOG DATA for ${y}-${String(m).padStart(2, '0')}. The BWTS operation record is collected monthly for regulatory reporting, and without it we cannot confirm the month's operation.`, '',
    '■ Request',
    `1) Send the BWTS LOG DATA for ${y}-${String(m).padStart(2, '0')}`,
    `2) Mail subject : ${subj} (CODE = your 3-letter ship code)`,
    `3) Reply requested by ${due.toISOString().slice(0, 10)}`, '',
    '■ Files required, per vessel'];
  codes.forEach((c, i) => {
    if (makerOf(c) === 'ermafirst') {
      E.push(`${i + 1}) ${shipName(c)} : the submission format has not been fixed since the BWTS was replaced.`);
      E.push('   Please send every operation log the system can export, and advise the export screen and file format.');
    } else {
      E.push(`${i + 1}) ${shipName(c)} : ${MAKER_FILES[makerOf(c)].join(', ')}`);
    }
  });
  E.push('', '■ Note',
    '1) Export: HMI LOG button - set the period - select the data - CREATE (Troubleshooting Book 5.1 p.44)',
    '2) If already sent, advise the date sent and the recipient.');
  if (multi) E.push('3) Sent to all vessels listed. Please check your own vessel\'s item only.');
  return ko + '\n' + E.join('\n');
}

function missingMail(lang) {
  const periods = [...new Set(ROWS.map(r => r.period))].sort();
  const period = periods.length ? periods[periods.length - 1] : '';
  if (!period) { toast('데이터 없음'); return; }
  const codes = missingShips(period);
  if (!codes.length) { toast(`${period} 미수신 선박 없음`); return; }
  const m = +period.slice(5);
  const subject = `[KMTC SM][ETP] ${m}월 BWTS LOG DATA 제출 요청의 건`
    + ` / Request for BWTS LOG DATA (${period})`;
  gmailCompose(codes.map(vesselMail).join(','), subject,
    missingMailBody(period, codes, lang) + '\n' + SIGN);
}

/* ===== 로컬 분석 실행 (kmtcfolder 프로토콜 → 로컬 Claude Code) =====
   핸들러(scripts/open_local_folder.ps1)가 period/ships 를 화이트리스트로
   검사한다. 형식이 어긋나면 파라미터를 버리고 전체 분석으로 떨어진다. */
function launch(period, ships) {
  const q = [];
  if (period) q.push('period=' + period);
  if (ships) q.push('ships=' + ships);
  const url = 'kmtcfolder:bwts-analysis' + (q.length ? '?' + q.join('&') : '');
  toast(ships ? `${ships} ${period} 재분석 — 터미널 확인` : '로그 분석 실행 — 터미널 확인');
  location.href = url;
}

function runAnalysis() {
  const months = [...new Set(ROWS.map(r => r.period))].sort();
  const last = months.length ? months[months.length - 1] : '';
  const p = prompt('분석할 월 (YYYY-MM). 비우면 전체 기간 분석', last);
  if (p === null) return;
  const period = p.trim();
  if (period && !/^\d{4}-\d{2}$/.test(period)) { toast('YYYY-MM 형식으로 입력하세요'); return; }
  launch(period, '');
}

async function reanalyze() {
  if (!selected) return;
  const r = ROWS.find(x => x.ship_code === selected.ship_code && x.period === selected.period);
  if (!r) return;
  // 🚩 건은 auto 로 되돌려야 재검토 루프가 다시 집는다 (list 는 auto 만 본다)
  if (r.review_status === 'escalated') {
    const patch = { review_status: 'auto', review_note: null, reviewed_by: null, reviewed_at: null };
    if (!await dbSave(sb.from('bwts_log_analysis').update(patch)
      .eq('ship_code', r.ship_code).eq('period', r.period), '🚩 해제 — 재분석 대상으로 복귀')) return;
    Object.assign(r, patch);
    renderAll();
  }
  launch(r.period, r.ship_code);
}

/* ===== review loop ===== */
async function requestReview() {
  const r = ROWS.find(x => x.ship_code === selected.ship_code && x.period === selected.period);
  if (!r) return;
  const q = prompt(`${r.ship_code} ${r.period} — 무엇이 이상한가요? (예: 운전기록 있는데 미운전으로 나옴)`, '');
  if (q === null) return;
  const ok = await dbSave(sb.from('bwts_reviews').insert({
    ship_code: r.ship_code, period: r.period, question: q.trim() || '(재검토 요청)',
    requested_by: S.USER && S.USER.email, status: 'pending',
  }), '재검토 요청 등록 — 로컬에서 /bwts-review 실행 시 처리');
  if (!ok) return;
  const ok2 = await dbSave(sb.from('bwts_log_analysis').update({ review_status: 'requested' })
    .eq('ship_code', r.ship_code).eq('period', r.period));
  if (ok2) r.review_status = 'requested';
  renderAll();
}

async function override() {
  const r = ROWS.find(x => x.ship_code === selected.ship_code && x.period === selected.period);
  if (!r) return;
  const cur = disp(r);
  const pick = prompt(`${r.ship_code} ${r.period} 등급 수정 — 번호 입력\n` +
    GRADES.map((g, i) => `${i + 1}. ${g}${g === cur ? ' (현재)' : ''}`).join('\n') + '\n0. 수정 취소(자동 판정으로 되돌림)', '');
  if (pick === null) return;
  const n = parseInt(pick, 10);
  if (isNaN(n) || n < 0 || n > GRADES.length) { toast('번호를 입력하세요'); return; }
  let patch;
  if (n === 0) {
    patch = { final_grade: null, review_status: 'auto', review_note: null, reviewed_by: null, reviewed_at: null };
  } else {
    const note = prompt('수정 사유 (필수) — 라벨 데이터로 쌓여 룰 개선에 쓰입니다', r.review_note || '');
    if (note === null) return;
    if (!note.trim()) { toast('사유는 필수'); return; }
    patch = { final_grade: GRADES[n - 1], review_status: 'overridden', review_note: note.trim(),
      reviewed_by: S.USER && S.USER.email, reviewed_at: new Date().toISOString() };
  }
  const ok = await dbSave(sb.from('bwts_log_analysis').update(patch)
    .eq('ship_code', r.ship_code).eq('period', r.period), n === 0 ? '자동 판정으로 되돌림' : `등급 → ${GRADES[n - 1]}`);
  if (!ok) return;
  Object.assign(r, patch);
  renderAll();
}

window.bwtsLogTab = { select, close, filter, requestReview, override, runAnalysis, reanalyze,
  chatterList, chatterSet, copyChatter, copyChatterMail, chatterMail, chatterMailMulti,
  chatterMailSelected, chatterPick, issueMail, missingMail,
  _test: { setRows: (rows, years) => { ROWS = rows; YEARS = years; loadedYear = F.year; } } };

export default { id: 'bwtsLog', mount, refresh, destroy: () => { selected = null; } };
