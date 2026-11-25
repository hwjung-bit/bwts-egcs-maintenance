// 🛰 관제 — reads the latest watch_snapshot row written by
// pipelines/bwts_log/watch.py (weekdays 09:30). Two tables only:
//   본선 요청  — one row per ship (ECU · 로그 미수신 · 점검필요). Checked ships get
//               one Gmail draft each (API, no URL length limit): 문제 → 수치 → 요청 조치.
//   사무실 처리 — 검교정 · 정체 업무 · 재검토: 「요청함 기록」 + link to the tab.
// Item state 미조치 → 요청함 → 해소 lives in watch_actions (sql/042); watch.py sets
// 해소 when the hit disappears and re-alarms past follow_days (기한초과).
import { sb, dbSave } from '../core/supabase.js';
import { $, esc, toast } from '../core/dom.js';
import { go } from '../core/router.js';
import { requireTH } from '../shared/thresholds.js';
import { gmailDraftMany, preloadGmail } from '../shared/gmailDraft.js';
import { vesselMail, SIGN, shipName } from './bwtsLog.js';

let snap = null, acts = {};

const SHIP_KINDS = ['ECU', '미수신', '점검필요'];
const OFFICE_TAB = { '검교정': 'bwtsCal', '정체': 'work', '데이터불량': 'bwtsLog', '판독실패': 'bwtsLog' };
const TAB_LABEL = { bwtsLog: 'BWTS 로그', bwtsCal: '검교정', work: '업무' };

function mount(root) {
  root.innerHTML = '<div class="wrap" id="watchRoot"><div class="loading"><span class="spin"></span> 관제 로딩...</div></div>';
  preloadGmail();
}

async function refresh() {
  try {
    const { data, error } = await sb.from('watch_snapshot').select('date,payload')
      .eq('system', 'BWTS').order('date', { ascending: false }).limit(1);
    if (error) throw error;
    snap = data[0] || null;
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

// live state (watch_actions); need = 미조치 or 기한초과
function state(h) {
  const a = acts[h.key];
  if (!a) return { s: '미조치', need: true };
  const over = today() > a.due_date;
  return { s: over ? '기한초과' : '요청함', a, need: over };
}
function stateHtml(st) {
  if (st.s === '미조치') return '<b style="color:#b91c1c">미조치</b>';
  const d = Math.round((new Date(today()) - new Date(st.a.requested_at)) / 864e5);
  return st.s === '기한초과'
    ? `<b style="color:#fff;background:#b91c1c;padding:1px 6px;border-radius:6px">기한초과</b> <span class="muted">${st.a.round}차 요청 ${esc(st.a.requested_at)}</span>`
    : `<span style="color:#2563eb">요청함 D+${d}</span> <span class="muted">기한 ${esc(st.a.due_date)}</span>`;
}

// short problem label for the table
function label(h) {
  const v = snap.payload.ships[h.ship] || {};
  if (h.kind === 'ECU') return `ECU cleaning +${v.ecu?.over}일`;
  if (h.kind === '미수신') return `${v.log?.period} 로그 미수신`;
  const n = v.log?.streak || 1;
  return `점검필요${n > 1 ? ` ${n}개월` : ''} — ${reasonsOf(h).filter(r => r !== 'ALFA LAVAL').join(', ')}`;
}

function shipTable(hits) {
  const ships = [...new Set(hits.map(h => h.ship))];
  if (!ships.length) return '<div class="muted">본선 요청 없음</div>';
  const rows = ships.map(s => {
    const hs = hits.filter(h => h.ship === s), sts = hs.map(state);
    const need = sts.some(x => x.need);
    return `<tr><td><input type="checkbox" class="wpick" value="${esc(s)}" ${need ? 'checked' : ''}></td>
      <td><b>${esc(s)}</b></td>
      <td style="text-align:left">${hs.map((h, i) => `<div>${esc(label(h))} · ${stateHtml(sts[i])}</div>`).join('')}</td></tr>`;
  }).join('');
  return `<table class="cal-table"><thead><tr><th></th><th>선박</th><th>문제 · 진행</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function officeTable(hits) {
  if (!hits.length) return '<div class="muted">사무실 처리 없음</div>';
  const rows = hits.map(h => {
    const st = state(h), tab = OFFICE_TAB[h.kind];
    const btn = st.need ? `<button class="refresh-btn" onclick="watchTab.mark(['${esc(h.key)}'])">${st.s === '기한초과' ? '재요청 기록' : '요청함 기록'}</button>` : '';
    return `<tr><td><b>${esc(h.ship)}</b></td><td style="text-align:left">${esc(h.msg)}</td>
      <td style="text-align:left">${stateHtml(st)}</td>
      <td>${btn} <button class="refresh-btn" onclick="watchTab.go('${tab}')">${TAB_LABEL[tab]} 탭</button></td></tr>`;
  }).join('');
  return `<table class="cal-table"><thead><tr><th>선박</th><th>내용</th><th>진행</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

function render() {
  const root = $('watchRoot');
  if (!snap) { root.innerHTML = '<div class="muted">관제 스냅샷 없음 — pipelines/bwts_log/watch.py 실행 전</div>'; return; }
  const p = snap.payload, m = p.meta || {};
  const shipHits = p.hits.filter(h => SHIP_KINDS.includes(h.kind));
  const office = p.hits.filter(h => !SHIP_KINDS.includes(h.kind));
  const todoShips = new Set(shipHits.filter(h => state(h).need).map(h => h.ship)).size;
  root.innerHTML = `
    <div style="display:flex;gap:12px;align-items:baseline;flex-wrap:wrap;margin-bottom:8px">
      <h3 style="margin:0">🛰 BWTS 관제</h3>
      <span class="muted" style="font-size:12px">기준 ${esc(snap.date)} · PMS ${esc((m.pms_at || '없음').slice(0, 10))}${m.pms_ok ? '' : ' ⚠ 오래됨'}</span>
    </div>
    ${m.note ? `<div class="tab-error" style="margin-bottom:8px"><b>⚠ ${esc(m.note)}</b></div>` : ''}
    <div class="bl-sec" style="margin-bottom:12px">
      <div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap">
        <h4 style="margin:0">본선 요청 — 조치 필요 ${todoShips}척</h4>
        <button class="add-btn" style="margin-left:auto" onclick="watchTab.mail()">✉ 선택 선박 메일 만들기 (선박별 1통)</button>
      </div>
      <div class="muted" style="font-size:12px;margin:2px 0 6px">메일 = 선박별 문제·수치·매뉴얼 조치, Gmail 임시보관함에 저장 + 요청함 기록. PMS·로그에 반영되면 자동 해소</div>
      ${shipTable(shipHits)}
    </div>
    <div class="bl-sec"><h4 style="margin:0 0 6px">사무실 처리</h4>${officeTable(office)}</div>`;
}

/* ===== actions ===== */
async function mark(keys, note) {
  const W = requireTH('watch');
  const hits = snap.payload.hits;
  const rows = keys.map(k => {
    const h = hits.find(x => x.key === k), prev = acts[k];
    const d = new Date(today()); d.setDate(d.getDate() + W.follow_days[h.kind]);
    return { key: k, kind: h.kind, ship_code: h.ship, status: '요청함', requested_at: today(),
      due_date: ymd(d), round: prev ? prev.round + 1 : 1,
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

function problemBlocks(h) {
  const v = snap.payload.ships[h.ship] || {};
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
  const hits = snap.payload.hits.filter(h => h.ship === ship && SHIP_KINDS.includes(h.kind));
  const due = new Date(); due.setDate(due.getDate() + 5);
  const L = ['수신: 기관장님 / Chief Engineer', '',
    '1. BWTS 관리 현황 확인 결과 아래 사항이 확인되어 점검·조치를 요청드립니다.',
    '   The items below were found in the BWTS status review. Please check and take action.', ''];
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
  return { to: vesselMail(ship), subject: `[KMTC SM][ETP] ${shipName(ship)} BWTS 점검·조치 요청의 건 / BWTS check & action request`,
    html, text, keys: hits.map(h => h.key) };
}

function mail() {
  const ships = [...document.querySelectorAll('.wpick:checked')].map(x => x.value);
  if (!ships.length) { toast('선택된 선박 없음'); return; }
  const ms = ships.map(shipMail);
  gmailDraftMany(ms.map(({ to, subject, html }) => ({ to, subject, html })),
    () => mark(ms.flatMap(m => m.keys), '메일 작성'));
}

window.watchTab = { go, mark, mail, shipMail };

export default { id: 'watch', mount, refresh };
