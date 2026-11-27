// 🛰 관제 — one ship × item matrix over every watched column (BWTS · EGCS · 수신 ·
// 연료/CII · 업무). Data = latest watch_snapshot (system 'FLEET') written by
// pipelines/bwts_log/watch.py on weekdays; 🆕 = key not in the previous day's
// snapshot. Click a cell -> detail line with 「요청함 기록」 and a link to the tab.
// Checked ships get one Gmail draft each (문제 → 수치 → 요청 조치).
// Item state 미조치 → 요청함 → 해소 lives in watch_actions (sql/042).
import { sb, dbSave } from '../core/supabase.js';
import { $, esc, toast } from '../core/dom.js';
import { go } from '../core/router.js';
import { requireTH } from '../shared/thresholds.js';
import { gmailDraftMany, preloadGmail } from '../shared/gmailDraft.js';
import { vesselMail, SIGN, shipName } from './bwtsLog.js';

let snap = null, prev = null, acts = {}, openCell = null;

const COLS = ['BWTS 로그', 'ECU', 'BWTS 검교정', 'EGCS 상태', 'EGCS 검교정', '수신', '연료·CII', '업무'];
const MAIL_KINDS = ['ECU', '미수신', '점검필요', '벙커미수신', 'BSR미수신', 'EGCS로그'];
const TAB_LABEL = { bwtsLog: 'BWTS 로그', bwtsCal: 'BWTS 검교정', egcsCal: 'EGCS 검교정', status: 'EGCS·BWTS 현황',
  work: '업무', bsr: 'BSR', links: '바로가기' };

function mount(root) {
  root.innerHTML = '<div class="wrap" id="watchRoot"><div class="loading"><span class="spin"></span> 관제 로딩...</div></div>';
  preloadGmail();
}

async function refresh() {
  try {
    const { data, error } = await sb.from('watch_snapshot').select('date,payload')
      .eq('system', 'FLEET').order('date', { ascending: false }).limit(2);
    if (error) throw error;
    [snap, prev] = [data[0] || null, data[1] || null];
    const a = await sb.from('watch_actions').select('*').eq('status', '요청함');
    if (a.error) throw a.error;
    acts = Object.fromEntries(a.data.map(x => [x.key, x]));
    render();
  } catch (e) {
    $('watchRoot').innerHTML = `<div class="tab-error"><b>⚠ 관제 로드 실패</b><code>${esc(e.message)}</code></div>`;
  }
}

const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const ymd = d => d.toISOString().slice(0, 10);
const colOf = h => h.col || (h.kind === '정체' ? '업무' : h.kind === 'ECU' ? 'ECU' : h.kind === '검교정' ? 'BWTS 검교정' : 'BWTS 로그');

function state(h) {
  const a = acts[h.key];
  if (!a) return { s: '미조치', need: true };
  const over = today() > a.due_date;
  return { s: over ? '기한초과' : '요청함', a, need: over };
}
function stateText(st) {
  if (st.s === '미조치') return '미조치';
  return st.s === '기한초과' ? `기한초과 (${st.a.round}차 ${st.a.requested_at})` : `요청함 ${st.a.requested_at} · 기한 ${st.a.due_date}`;
}

// short cell text per hit
function tag(h) {
  const v = snap.payload.ships?.[h.ship] || {};
  const n = (re) => (h.msg.match(re) || [])[1];
  switch (h.kind) {
    case 'ECU': return `+${v.ecu?.over ?? n(/\+(\d+)일/)}일`;
    case '미수신': return '미수신';
    case '점검필요': return v.log?.streak > 1 ? `점검 ${v.log.streak}개월` : '점검필요';
    case '검교정': case 'EGCS검교정': return h.level === '긴급' ? '만료' : '임박';
    case 'EGCS상태': return [...h.msg.matchAll(/(WMS|CEMS|BODY|기타) (\S+)/g)].map(m => `${m[1]} ${m[2] === '문제' ? '불가' : '△'}`).join(' ');
    case '벙커미수신': return '벙커';
    case 'BSR미수신': return 'BSR';
    case 'EGCS로그': return 'EGCS로그';
    case 'CII오류': return `AI ${n(/오류 (\d+)건/)}`;
    case 'BCM': return `BCM ${n(/행 (\d+)건/)}`;
    case 'XPERT': return `X-PERT ${n(/최장 (\S+)/) || ''}`;
    default: return h.kind;
  }
}

function cellHtml(ship, col, hs, prevKeys) {
  if (!hs.length) return '<td class="muted" style="text-align:center">·</td>';
  const sts = hs.map(state);
  const urg = hs.some(h => h.level === '긴급'), over = sts.some(x => x.s === '기한초과');
  const allReq = sts.every(x => x.s === '요청함');
  const isNew = prevKeys && hs.some(h => !prevKeys.has(h.key));
  const bg = over ? '#b91c1c' : urg ? '#fde2e2' : '#fff3d6', fg = over ? '#fff' : urg ? '#b91c1c' : '#92400e';
  const txt = col === '업무' ? `정체 ${hs.length}` : [...new Set(hs.map(tag))].join(' · ');
  const sel = openCell === `${ship}|${col}`;
  return `<td onclick="watchTab.cell('${esc(ship)}','${esc(col)}')" title="${esc(hs.map(h => h.msg).join('\n'))}"
    style="cursor:pointer;background:${bg};color:${fg};font-weight:600;white-space:nowrap;${allReq ? 'outline:2px solid #2563eb;outline-offset:-2px;' : ''}${sel ? 'box-shadow:inset 0 0 0 2px #111;' : ''}">${isNew ? '🆕' : ''}${esc(txt)}</td>`;
}

function detailHtml() {
  if (!openCell) return '';
  const [ship, col] = openCell.split('|');
  const hs = snap.payload.hits.filter(h => h.ship === ship && colOf(h) === col);
  return `<div class="bl-sec" style="margin:8px 0;border-left:4px solid #111;padding-left:10px">
    <b>${esc(ship)} · ${esc(col)}</b> <a href="#" onclick="watchTab.cell();return false" class="muted">닫기</a>
    ${hs.map(h => {
      const st = state(h);
      const btn = st.need ? `<a href="#" onclick="watchTab.mark(['${esc(h.key)}']);return false">${st.s === '기한초과' ? '재요청 기록' : '요청함 기록'}</a> · ` : '';
      return `<div style="font-size:12px;padding:3px 0">[${esc(h.level)}] ${esc(h.msg)}<br>
        <span style="color:${st.need ? '#b91c1c' : '#1d4ed8'}">${esc(stateText(st))}</span> · ${btn}<a href="#" onclick="watchTab.go('${esc(h.tab)}');return false">${esc(TAB_LABEL[h.tab] || h.tab)} 탭</a></div>`;
    }).join('')}</div>`;
}

function changeHtml(hits) {
  if (!prev) return '<span class="muted">비교할 이전 스냅샷 없음</span>';
  const ok = new Set(prev.payload.hits.map(h => h.key)), nk = new Set(hits.map(h => h.key));
  const nw = hits.filter(h => !ok.has(h.key)), rs = prev.payload.hits.filter(h => !nk.has(h.key));
  const li = (hs, m) => hs.map(h => `<li>${m} <b>${esc(h.ship)}</b> ${esc(colOf(h))} — ${esc(h.msg)}</li>`).join('');
  return `<details style="display:inline-block"><summary>${esc(prev.date)} 대비 <b style="color:#b91c1c">🆕 ${nw.length}</b> · <b style="color:#166534">✅ ${rs.length}</b></summary>
    <ul style="margin:4px 0;padding-left:18px;font-size:12px">${li(nw, '🆕')}${li(rs, '✅')}</ul></details>`;
}

function render() {
  const root = $('watchRoot');
  if (!snap) { root.innerHTML = '<div class="muted">관제 스냅샷 없음 — pipelines/bwts_log/watch.py 실행 전</div>'; return; }
  const p = snap.payload, m = p.meta || {}, cols = p.cols || COLS;
  const prevKeys = prev ? new Set(prev.payload.hits.map(h => h.key)) : null;
  const by = {};
  p.hits.forEach(h => { (by[h.ship] = by[h.ship] || []).push(h); });
  const score = s => by[s].filter(h => h.level === '긴급').length * 100 + by[s].length;
  const ships = Object.keys(by).filter(s => s !== '공통').sort((a, b) => score(b) - score(a) || a.localeCompare(b));
  if (by['공통']) ships.push('공통');
  const fine = (p.fleet || []).filter(s => !by[s]);
  const rows = ships.map(s => {
    const mailable = by[s].some(h => MAIL_KINDS.includes(h.kind));
    const need = by[s].some(h => MAIL_KINDS.includes(h.kind) && state(h).need);
    return `<tr><td>${mailable ? `<input type="checkbox" class="wpick" value="${esc(s)}" ${need ? 'checked' : ''}>` : ''}</td>
      <td><b>${esc(s)}</b></td>${cols.map(c => cellHtml(s, c, by[s].filter(h => colOf(h) === c), prevKeys)).join('')}</tr>`;
  }).join('');
  const urg = p.hits.filter(h => h.level === '긴급').length;
  root.innerHTML = `
    <div style="display:flex;gap:12px;align-items:baseline;flex-wrap:wrap;margin-bottom:6px">
      <h3 style="margin:0">🛰 관제</h3>
      <span style="font-size:13px"><b style="color:#b91c1c">긴급 ${urg}</b> · 주의 ${p.hits.length - urg} · 선박 ${ships.length}</span>
      <span style="font-size:13px">${changeHtml(p.hits)}</span>
      <span class="muted" style="font-size:12px">기준 ${esc(snap.date)} ${esc((m.at || '').slice(11))} · PMS ${esc((m.pms_at || '없음').slice(0, 10))}</span>
      <button class="add-btn" style="margin-left:auto" onclick="watchTab.mail()">✉ 체크 선박 메일 (선박별 1통)</button>
    </div>
    ${m.note ? `<div class="tab-error" style="margin-bottom:6px"><b>⚠ ${esc(m.note)}</b></div>` : ''}
    <div style="overflow-x:auto"><table class="cal-table" style="font-size:12px">
      <thead><tr><th></th><th>선박</th>${cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>
    <div class="muted" style="font-size:11px;margin-top:4px">빨강 긴급 · 노랑 주의 · 파랑 테두리 요청함 · 진빨강 기한초과 · 🆕 전일 대비 신규 · △ 운용가능 · 칸 클릭 = 상세
      ${fine.length ? ` · 정상 ${fine.length}척: ${esc(fine.join(' '))}` : ''}</div>
    ${detailHtml()}`;
}

function cell(ship, col) {
  openCell = ship && openCell !== `${ship}|${col}` ? `${ship}|${col}` : null;
  render();
}

/* ===== actions ===== */
async function mark(keys, note) {
  const W = requireTH('watch');
  const hits = snap.payload.hits;
  const rows = keys.map(k => {
    const h = hits.find(x => x.key === k), p0 = acts[k];
    const d = new Date(today()); d.setDate(d.getDate() + (W.follow_days[h.kind] || 7));
    return { key: k, kind: h.kind, ship_code: h.ship, status: '요청함', requested_at: today(),
      due_date: ymd(d), round: p0 ? p0.round + 1 : 1,
      note: note || '', resolved_at: null, updated_at: new Date().toISOString() };
  });
  const ok = await dbSave(sb.from('watch_actions').upsert(rows), `요청함 기록 ${rows.length}건`);
  if (!ok) return;
  rows.forEach(r => { acts[r.key] = r; });
  render();
}

// ===== ship mail: 문제 → 수치 → 요청 조치 =====
// Actions come from thresholds.json watch.mail_actions (manual-based). A finer
// analysis (Smart Platform TOTALLOG …) that writes hit.detail.findings
// [{ko, en, action_ko, action_en}] replaces them.
function reasonsOf(h) {
  return h.detail?.grade_reasons?.length ? h.detail.grade_reasons
    : (h.msg.split(' — ')[1] || '').split(', ').filter(Boolean);
}

function figLines(d) {
  if (!d) return [];
  const bl = requireTH('bwts_log'), out = [];
  if (d.tro_b_avg != null) out.push(`Ballast ${d.ballast_count}회, 주입 TRO 평균 ${d.tro_b_avg} ppm (최저 ${d.tro_b_min}) — 기준 ${bl.tro_ballast_min_ppm}~${bl.tro_ballast_max_ppm} ppm`,
    `Ballast ${d.ballast_count} times, injection TRO avg ${d.tro_b_avg} ppm (required ${bl.tro_ballast_min_ppm}~${bl.tro_ballast_max_ppm})`);
  if (d.tro_d_max != null && d.tro_d_max > bl.tro_deballast_max_ppm) out.push(`De-ballast 배출 TRO 최대 ${d.tro_d_max} ppm — 기준 ${bl.tro_deballast_max_ppm} ppm 이하`,
    `Discharge TRO max ${d.tro_d_max} ppm (limit ${bl.tro_deballast_max_ppm})`);
  if (d.trip_count) out.push(`Trip ${d.trip_count}회 / ${d.trip_count} trip(s)`);
  return out;
}

const SEND = {
  '벙커미수신': ['WEEKLY BUNKER CONDITION REPORT', 'WEEKLY BUNKER CONDITION REPORT'],
  'BSR미수신': ['BUNKER SOUNDING REPORT (BSR)', 'BUNKER SOUNDING REPORT (BSR)'],
  'EGCS로그': ['EGCS 일일 DATA LOG', 'EGCS daily DATA LOG'],
};

function problemBlocks(h) {
  const v = snap.payload.ships?.[h.ship] || {};
  if (SEND[h.kind]) {
    const [ko, en] = SEND[h.kind];
    return [{ p: `${ko} 미접수 — ${h.msg}`, pe: `${en} not received`,
      a: [[`${ko} 송부 바랍니다`, `Please send the ${en}`]] }];
  }
  if (h.kind === 'ECU') {
    const e = v.ecu || {};
    return [{ p: `ECU chemical cleaning 주기(1개월) 초과 — 마지막 실시 ${e.last || '-'} (+${e.over}일)`,
      pe: `ECU chemical cleaning overdue (1-month interval) — last ${e.last || '-'}`,
      a: [['ECU chemical cleaning 실시 후 KINS PMS 에 기록', 'Carry out ECU chemical cleaning and record it in KINS PMS']] }];
  }
  if (h.kind === '미수신') {
    const lp = v.log?.period || '';
    return [{ p: `${lp} BWTS LOG DATA 미접수`, pe: `BWTS LOG DATA for ${lp} not received`,
      a: [['LOG DATA 송부 (메일 제목: [선박코드]_BWTS_LOG_DATA_(YYYY.MM))', 'Send the LOG DATA (subject: [code]_BWTS_LOG_DATA_(YYYY.MM))']] }];
  }
  if (h.detail?.findings?.length) {
    return h.detail.findings.map(f => ({ p: f.ko, pe: f.en, a: [[f.action_ko, f.action_en]] }));
  }
  const n = v.log?.streak || 1, lp = h.detail?.period || v.log?.period || '';
  const rules = requireTH('watch').mail_actions;
  const figs = figLines(h.detail);
  return reasonsOf(h).filter(r => r !== 'ALFA LAVAL').map((r, i) => {
    const rule = rules.find(x => r.includes(x.match));
    return { p: `${lp} 로그 분석 — ${r}${n > 1 ? ` (${n}개월 연속)` : ''}`,
      pe: `${lp} log analysis — ${rule ? rule.en : r}${n > 1 ? ` (${n} months in a row)` : ''}`,
      f: i === 0 ? figs : [], ref: rule?.ref,
      a: rule ? rule.actions : [['원인 확인 후 조치 내용 회신', 'Check the cause and reply with the action taken']] };
  });
}

function shipMail(ship) {
  const hits = snap.payload.hits.filter(h => h.ship === ship && MAIL_KINDS.includes(h.kind));
  const due = new Date(); due.setDate(due.getDate() + 5);
  const L = ['수신: 기관장님 / Chief Engineer', '',
    '1. 관리 현황 확인 결과 아래 사항이 확인되어 점검·조치를 요청드립니다.',
    '   The items below were found in our status review. Please check and take action.', ''];
  hits.flatMap(problemBlocks).forEach((b, k) => {
    L.push(`[문제 ${k + 1}] ${b.p}`, `${b.pe}`);
    (b.f || []).forEach(x => L.push(`   · ${x}`));
    L.push('   요청 조치 / Action:');
    b.a.forEach(([ko, en], j) => L.push(`   ${j + 1}) ${ko}`, `      ${en}`));
    if (b.ref) L.push(`   (Ref. ${b.ref})`);
    L.push('');
  });
  L.push(`2. 조치 결과(사진 포함) 또는 실시 예정일을 ${due.getMonth() + 1}월 ${due.getDate()}일까지 회신 바랍니다.`,
    `   Please reply with the result (with photos) or the planned date by ${ymd(due)}.`);
  const text = L.join('\n') + '\n' + SIGN;
  const html = text.split('\n').map(l => `<div>${l ? esc(l).replace(/^ +/, sp => '&nbsp;'.repeat(sp.length)) : '<br>'}</div>`).join('');
  return { to: vesselMail(ship), subject: `[KMTC SM][ETP] ${shipName(ship)} 점검·조치 요청의 건 / Check & action request`,
    html, text, keys: hits.map(h => h.key) };
}

function mail() {
  const ships = [...document.querySelectorAll('.wpick:checked')].map(x => x.value);
  if (!ships.length) { toast('체크된 선박 없음'); return; }
  const ms = ships.map(shipMail);
  gmailDraftMany(ms.map(({ to, subject, html }) => ({ to, subject, html })),
    () => mark(ms.flatMap(m => m.keys), '메일 작성'));
}

window.watchTab = { go, mark, mail, cell, shipMail };

export default { id: 'watch', mount, refresh };
