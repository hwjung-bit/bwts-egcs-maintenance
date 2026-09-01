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
const REVIEW_MARK = { requested: '❓', reviewed: '✅', overridden: '✎' };
const COLS = 'ship_code,period,grade,grade_rule,grade_reasons,reception,ballast_count,deballast_count,op_days,' +
  'tro_b_avg,tro_b_min,tro_d_max,tro_b_in_range,tro_d_compliant,trip_count,alarm_count,integrity,flags,' +
  'review_status,final_grade,review_note,reviewed_by,reviewed_at,analyzed_at';

// module state
const F = { year: String(new Date().getFullYear()), filter: '' };
let ROWS = [];              // rows for F.year
let YEARS = [];             // available years
let selected = null;        // {ship_code, period}
let loadedYear = null;

const disp = r => r.final_grade || r.grade;

function mount(root) {
  root.innerHTML = `
  <div class="filters" id="blFilters">
    <select id="blYear"></select>
    <span id="blChips" style="display:flex;gap:4px;flex-wrap:wrap"></span>
    <button class="refresh-btn" id="blReload">🔄 새로고침</button>
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
  let req = 0, rev = 0;
  ROWS.forEach(r => { cnt[disp(r)] = (cnt[disp(r)] || 0) + 1; if (r.review_status === 'requested') req++; if (r.review_status !== 'auto') rev++; });
  const chip = (key, label, n) =>
    `<span class="chip${F.filter === key ? ' active' : ''}" onclick="bwtsLogTab.filter('${key}')">${label} ${n}</span>`;
  $('blChips').innerHTML = chip('', '전체', ROWS.length) +
    GRADES.map(g => chip(g, `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${STYLE[g].dot};margin-right:3px"></span>${g}`, cnt[g] || 0)).join('') +
    chip('requested', '❓ 재검토 대기', req) + chip('reviewed', '검토·수정됨', rev);
  $('blCnt').textContent = `${ROWS.length} vessel-months`;
  renderMatrix();
  if (selected) renderDetail();
}

function matches(r) {
  if (!F.filter) return true;
  if (F.filter === 'requested') return r.review_status === 'requested';
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
      const ops = (r.ballast_count || 0) + (r.deballast_count || 0);
      const sub = g === '미수신' ? '' : (g === '판독실패' ? (r.integrity && r.integrity.hits ? r.integrity.hits.join(' ') : '') : (ops ? `B${r.ballast_count}/D${r.deballast_count}` : ''));
      const flag = (r.flags && r.flags.length) ? ` <span class="bl-flag" title="${esc(r.flags.join(', '))}">⚙</span>` : '';
      return `<td class="bl-cell" style="background:${st.bg};color:${st.fg};${dim}${sel}" onclick="bwtsLogTab.select('${esc(r.ship_code)}','${esc(r.period)}')" title="${esc(code)} ${esc(r.period)} ${esc(g)}${r.grade !== g ? ' (자동: ' + esc(r.grade) + ')' : ''}">` +
        `<div class="bl-g">${esc(g)}${mark ? ' <span class="bl-mark">' + mark + '</span>' : ''}${flag}</div><div class="bl-sub">${esc(sub)}</div></td>`;
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
  const flagsHtml = (r.flags && r.flags.length)
    ? `<div class="bl-sec"><h4>참고 표시 (등급 무관)</h4><ul>${r.flags.map(x => `<li>⚙ ${esc(x)}</li>`).join('')}</ul></div>` : '';
  const integ = r.integrity && r.integrity.hits && r.integrity.hits.length
    ? `<div class="bl-sec"><h4>판독 무결성 검사 (${esc(r.integrity.hits.join(', '))})</h4><ul>${(r.integrity.detail || []).map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : '';
  const review = r.review_status !== 'auto'
    ? `<div class="bl-sec bl-review"><h4>검토 결과 — ${esc(r.review_status)}${r.final_grade ? ' → <b>' + esc(r.final_grade) + '</b>' : ''}</h4>
       <div>${esc(r.review_note || '')}</div><div class="muted" style="font-size:11px">${esc(r.reviewed_by || '')} ${r.reviewed_at ? esc(r.reviewed_at.slice(0, 16).replace('T', ' ')) : ''}</div></div>` : '';
  box.innerHTML = `
  <div class="bl-head">
    <span class="bl-badge" style="background:${st.bg};color:${st.fg}">${esc(g)}</span>
    <b>${esc(r.ship_code)}</b> ${esc(r.period)}
    ${r.grade !== g ? `<span class="muted">자동 판정: ${esc(r.grade)}</span>` : ''}
    ${r.grade_rule && r.grade_rule !== r.grade ? `<span class="muted">룰 판정: ${esc(r.grade_rule)}</span>` : ''}
    <span class="muted" style="font-size:11px">분석 ${esc((r.analyzed_at || '').slice(0, 16).replace('T', ' '))}</span>
    <div class="spacer"></div>
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
  const sessRows = sess.slice(0, 60).map(x =>
    `<tr><td>${esc(x.date || '')}</td><td>${esc(x.mode || '')}</td><td style="text-align:right">${x.duration_min != null ? Math.round(x.duration_min) : '—'}</td>` +
    `<td style="text-align:right">${x.stable_avg != null ? (+x.stable_avg).toFixed(2) : '—'}</td><td style="text-align:right">${x.stable_min != null ? (+x.stable_min).toFixed(2) : '—'}</td><td style="text-align:right">${x.stable_max != null ? (+x.stable_max).toFixed(2) : '—'}</td>` +
    `<td>${x.in_range === false ? '<span class="lv-expired pill">이탈</span>' : x.in_range ? '<span class="lv-ok pill">OK</span>' : ''}</td><td style="color:#c2410c">${esc(x.issue || '')}</td></tr>`).join('');
  const thread = (rv.data || []).map(q =>
    `<div class="bl-q"><div><b>Q</b> ${esc(q.question)} <span class="muted" style="font-size:11px">${esc(q.requested_by || '')} ${esc((q.created_at || '').slice(0, 16).replace('T', ' '))}</span></div>` +
    (q.answer ? `<div class="bl-a"><b>A</b> ${esc(q.answer)} <span class="muted" style="font-size:11px">${esc(q.answered_by || '')} ${esc((q.answered_at || '').slice(0, 16).replace('T', ' '))}</span></div>` : '<div class="muted" style="font-size:11px">답변 대기 — 로컬에서 /bwts-review 실행</div>') + '</div>').join('');
  $('blSessions').innerHTML =
    (rp.pattern ? `<div style="margin-bottom:6px"><b>회복 패턴:</b> ${esc(rp.pattern)} — ${esc(rp.detail || '')}</div>` : '') +
    (chat.length ? `<div style="margin-bottom:6px;color:#c2410c"><b>밸브 채터링:</b> ${chat.map(c => esc(typeof c === 'string' ? c : (c.valve || c.device || JSON.stringify(c)))).join(', ')}</div>` : '') +
    `<h4>세션 (${sess.length}${sess.length > 60 ? ', 60개 표시' : ''})</h4>` +
    (sessRows ? `<table class="cal-table"><thead><tr><th>일자</th><th>모드</th><th>분</th><th>TRO avg</th><th>min</th><th>max</th><th>판정</th><th>비고</th></tr></thead><tbody>${sessRows}</tbody></table>` : '<div class="muted">세션 없음</div>') +
    `<h4 style="margin-top:12px">재검토 이력 (${(rv.data || []).length})</h4>${thread || '<div class="muted">없음</div>'}`;
}

function close() { selected = null; $('blDetail').style.display = 'none'; renderMatrix(); }
function filter(k) { F.filter = k; renderAll(); }

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

window.bwtsLogTab = { select, close, filter, requestReview, override,
  _test: { setRows: (rows, years) => { ROWS = rows; YEARS = years; loadedYear = F.year; } } };

export default { id: 'bwtsLog', mount, refresh, destroy: () => { selected = null; } };
