// 🛰 관제 — reads the latest watch_snapshot row written by
// pipelines/bwts_log/watch.py (weekdays 09:30). Rules run in Python; this tab
// groups the hits into action bundles (what to do, to whom) and tracks each
// item through 미조치 → 요청함 → 해소 in watch_actions (sql/042). 해소 is set by
// watch.py when the hit disappears (PMS record, log received, ...); 요청함 past
// follow_days shows 기한초과 and re-alarms.
import { sb, dbSave } from '../core/supabase.js';
import { S } from '../core/state.js';
import { $, esc, toast } from '../core/dom.js';
import { go } from '../core/router.js';
import { requireTH } from '../shared/thresholds.js';
import { gmailCompose, vesselMail, SIGN, shipName } from './bwtsLog.js';

let snap = null, old = null, acts = {};

const LV = { '긴급': ['#fde2e2', '#b91c1c'], '주의': ['#fff3d6', '#92400e'], '': ['#e7f6ea', '#166534'] };
const GRADE_C = { '운전양호': '#16a34a', '수리후정상': '#2563eb', '점검필요': '#ea580c', '미수신': '#dc2626',
  '미운전': '#6b7280', '데이터불량': '#9333ea', '판독실패': '#ca8a04' };

// One bundle = one kind of action. mail: draft one Gmail to all checked ships.
const BUNDLES = [
  { id: 'ecu', kinds: ['ECU'], title: 'ECU chemical cleaning 실시 요청',
    how: '본선 일괄 메일 → KINS PMS 실시 기록이 들어오면 자동 해소', mail: ecuMail },
  { id: 'miss', kinds: ['미수신'], title: 'BWTS 로그 제출 독촉',
    how: '본선 일괄 메일 → 로그가 수신·분석되면 자동 해소', mail: missMail },
  { id: 'bad', kinds: ['점검필요'], title: '점검필요 — 원인 확인·본선 점검 요청',
    how: 'BWTS 로그 탭 상세에서 원인 확인 후 ✉ 본선 메일 → 다음 달 로그 양호면 자동 해소', tab: 'bwtsLog' },
  { id: 'rev', kinds: ['데이터불량', '판독실패'], title: '로그 재검토',
    how: '/bwts-review 재판정 또는 본선 재송부 요청 → 판정이 바뀌면 자동 해소', tab: 'bwtsLog' },
  { id: 'cal', kinds: ['검교정'], title: 'BWTS 검교정 일정 요청 (업체)',
    how: '업체에 일정 요청 → 검교정 기록이 갱신되면 자동 해소', tab: 'bwtsCal' },
  { id: 'stale', kinds: ['정체'], title: '정체 업무 정리',
    how: '업무 탭에서 진행·종료 결정 → 조치이력이 기록되면 자동 해소', tab: 'work' },
];

function mount(root) {
  root.innerHTML = '<div class="wrap" id="watchRoot"><div class="loading"><span class="spin"></span> 관제 로딩...</div></div>';
}

async function refresh() {
  try {
    const W = requireTH('watch');
    const { data, error } = await sb.from('watch_snapshot').select('date,payload')
      .eq('system', 'BWTS').order('date', { ascending: false }).limit(1);
    if (error) throw error;
    snap = data[0] || null;
    old = null;
    if (snap) {
      const d = new Date(snap.date); d.setDate(d.getDate() - W.compare_days);
      const r = await sb.from('watch_snapshot').select('date,payload').eq('system', 'BWTS')
        .lte('date', d.toISOString().slice(0, 10)).order('date', { ascending: false }).limit(1);
      old = (r.data || [])[0] || null;
    }
    const a = await sb.from('watch_actions').select('*').eq('status', '요청함');
    if (a.error) throw a.error;
    acts = Object.fromEntries(a.data.map(x => [x.key, x]));
    render();
  } catch (e) {
    $('watchRoot').innerHTML = `<div class="tab-error"><b>⚠ 관제 로드 실패</b>${/watch_/.test(e.message) ? 'sql/041·042 실행 필요' : ''}<code>${esc(e.message)}</code></div>`;
  }
}

const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const badge = lv => { const [bg, fg] = LV[lv] || LV['']; return `<span style="background:${bg};color:${fg};padding:1px 7px;border-radius:9px;font-weight:600;font-size:11px">${esc(lv || '정상')}</span>`; };

// live state (watch_actions) — the snapshot's follow is a 09:30 copy
function state(h) {
  const a = acts[h.key];
  if (!a) return { s: '미조치' };
  return { s: '요청함', a, over: today() > a.due_date };
}
function stateHtml(st) {
  if (st.s === '미조치') return '<span style="color:#b91c1c;font-weight:600">미조치</span>';
  const days = Math.round((new Date(today()) - new Date(st.a.requested_at)) / 864e5);
  return st.over
    ? `<span style="color:#fff;background:#b91c1c;padding:1px 6px;border-radius:6px;font-weight:600">기한초과</span> <span class="muted" style="font-size:11px">${st.a.round}차 ${esc(st.a.requested_at)} · 기한 ${esc(st.a.due_date)}</span>`
    : `<span style="color:#2563eb;font-weight:600">요청함 D+${days}</span> <span class="muted" style="font-size:11px">${st.a.round > 1 ? st.a.round + '차 · ' : ''}기한 ${esc(st.a.due_date)}</span>`;
}

function bundleHtml(b, hits) {
  const items = hits.filter(h => b.kinds.includes(h.kind));
  if (!items.length) return '';
  const sts = items.map(state);
  const n = { todo: sts.filter(x => x.s === '미조치').length, over: sts.filter(x => x.over).length };
  n.wait = items.length - n.todo - n.over;
  const urgent = n.todo + n.over;
  const rows = items.map((h, i) => {
    const st = sts[i], need = st.s === '미조치' || st.over;
    const pick = b.mail ? `<input type="checkbox" class="wpick-${b.id}" value="${esc(h.key)}" ${need ? 'checked' : ''}>` : '';
    const btn = b.mail ? '' : need
      ? `<button class="refresh-btn" onclick="watchTab.mark('${esc(b.id)}',['${esc(h.key)}'])">${st.over ? '재요청 기록' : '요청함 기록'}</button>`
      : '';
    return `<tr><td>${pick}</td><td>${badge(h.level)}</td><td><b>${esc(h.ship)}</b></td>
      <td style="text-align:left">${esc(h.msg)}</td><td style="text-align:left">${stateHtml(st)}</td><td>${btn}</td></tr>`;
  }).join('');
  const act = b.mail
    ? `<button class="add-btn" onclick="watchTab.mail('${b.id}')">✉ 선택 선박 메일 작성 + 요청함 기록</button>`
    : `<button class="refresh-btn" onclick="watchTab.go('${b.tab}')">${esc({ bwtsLog: 'BWTS 로그 탭', bwtsCal: '검교정 탭', work: '업무 탭' }[b.tab])}으로</button>`;
  return `<div class="bl-sec" style="margin-bottom:10px;border-left:4px solid ${urgent ? '#b91c1c' : '#2563eb'};padding-left:10px">
    <div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap">
      <h4 style="margin:0">${esc(b.title)} — ${items.length}건</h4>
      <span style="font-size:12px"><b style="color:#b91c1c">미조치 ${n.todo}</b> · <span style="color:#2563eb">요청함 ${n.wait}</span> · <b style="color:#b91c1c">기한초과 ${n.over}</b></span>
      <span style="margin-left:auto">${act}</span>
    </div>
    <div class="muted" style="font-size:12px;margin:2px 0 6px">처리: ${esc(b.how)} · 요청 후 ${requireTH('watch').follow_days[b.kinds[0]]}일 지나면 기한초과</div>
    <table class="cal-table"><thead><tr><th></th><th>등급</th><th>선박</th><th>내용</th><th>진행</th><th></th></tr></thead><tbody>${rows}</tbody></table>
  </div>`;
}

function changeHtml(p) {
  const W = requireTH('watch');
  if (!old) return `<span class="muted">지난주 대비: ${W.compare_days}일 전 스냅샷 없음 (기록이 쌓이면 표시)</span>`;
  const ok = new Set(old.payload.hits.map(h => h.key)), nk = new Set(p.hits.map(h => h.key));
  const nw = p.hits.filter(h => !ok.has(h.key)), rs = old.payload.hits.filter(h => !nk.has(h.key));
  const li = (hs, mark) => hs.map(h => `<li>${mark} <b>${esc(h.ship)}</b> ${esc(h.kind)} — ${esc(h.msg)}</li>`).join('');
  return `<details><summary>지난주(${esc(old.date)}) 대비: 신규 ${nw.length} · 해결 ${rs.length}</summary>
    <ul style="margin:4px 0;padding-left:18px">${li(nw, '🆕')}${li(rs, '✅')}</ul></details>`;
}

function shipHtml(p) {
  const rows = Object.entries(p.ships).map(([s, v]) => {
    const g = v.log.grade, e = v.ecu, c = v.cal;
    const ecu = !e ? '<span class="muted">-</span>'
      : `<span style="color:${e.over > 0 ? '#b91c1c' : '#166534'}">${esc(e.last)}${e.over > 0 ? ` (+${e.over}일)` : ''}</span>`;
    const cal = !c ? '<span class="muted">-</span>'
      : `<span style="color:${c.days <= 0 ? '#b91c1c' : '#92400e'}">${esc(c.due)} (${c.days}일)</span>`;
    return `<tr><td><b>${esc(s)}</b></td><td>${badge(v.level)}</td>
      <td><span style="color:${GRADE_C[g] || '#333'};font-weight:600">${esc(g)}</span>${v.log.streak > 1 ? ` ${v.log.streak}개월` : ''}</td>
      <td>${ecu}</td><td>${v.tasks || '<span class="muted">0</span>'}</td><td>${cal}</td></tr>`;
  }).join('');
  const lp = Object.values(p.ships)[0]?.log.period || '';
  return `<details><summary>선박별 상태 (${Object.keys(p.ships).length}척)</summary>
    <table class="cal-table"><thead><tr><th>선박</th><th>상태</th><th>로그 ${esc(lp)}</th><th>ECU 마지막 세정</th><th>열린 업무</th><th>검교정 임박</th></tr></thead><tbody>${rows}</tbody></table></details>`;
}

function render() {
  const root = $('watchRoot');
  if (!snap) { root.innerHTML = '<div class="muted">관제 스냅샷 없음 — pipelines/bwts_log/watch.py 실행 전</div>'; return; }
  const p = snap.payload, m = p.meta || {};
  const sts = p.hits.map(state);
  const todo = sts.filter(x => x.s === '미조치').length, over = sts.filter(x => x.over).length;
  const order = BUNDLES.map(b => {
    const its = p.hits.filter(h => b.kinds.includes(h.kind));
    const need = its.filter(h => { const s = state(h); return s.s === '미조치' || s.over; }).length;
    return { b, need, urg: its.some(h => h.level === '긴급') };
  }).sort((x, y) => (y.need > 0) - (x.need > 0) || y.urg - x.urg);
  root.innerHTML = `
    <div style="display:flex;gap:12px;align-items:baseline;flex-wrap:wrap;margin-bottom:6px">
      <h3 style="margin:0">🛰 BWTS 관제</h3>
      <span style="font-size:13px">할 일 <b style="color:#b91c1c">미조치 ${todo}</b> · <b style="color:#b91c1c">기한초과 ${over}</b> · 요청 후 대기 ${p.hits.length - todo - over}</span>
      <span class="muted" style="font-size:12px">기준 ${esc(snap.date)} · 갱신 ${esc((m.at || '').replace('T', ' '))} · PMS ${esc((m.pms_at || '없음').replace('T', ' '))}${m.pms_ok ? '' : ' ⚠ 오래됨'}</span>
    </div>
    ${m.note ? `<div class="tab-error" style="margin-bottom:8px"><b>⚠ ${esc(m.note)}</b></div>` : ''}
    <div style="margin-bottom:10px">${changeHtml(p)}</div>
    ${order.map(x => bundleHtml(x.b, p.hits)).join('')}
    <div class="bl-sec">${shipHtml(p)}</div>`;
}

/* ===== actions ===== */
async function mark(bid, keys, note) {
  const b = BUNDLES.find(x => x.id === bid);
  const d = new Date(today()); d.setDate(d.getDate() + requireTH('watch').follow_days[b.kinds[0]]);
  const hits = snap.payload.hits;
  const rows = keys.map(k => {
    const h = hits.find(x => x.key === k), prev = acts[k];
    return { key: k, kind: h.kind, ship_code: h.ship, status: '요청함', requested_at: today(),
      due_date: d.toISOString().slice(0, 10), round: prev ? prev.round + 1 : 1,
      note: note || '', resolved_at: null, updated_at: new Date().toISOString() };
  });
  const ok = await dbSave(sb.from('watch_actions').upsert(rows), `요청함 기록 ${rows.length}건`);
  if (!ok) return;
  rows.forEach(r => { acts[r.key] = r; });
  render();
}

function picked(bid) {
  return [...document.querySelectorAll(`.wpick-${bid}:checked`)].map(x => x.value);
}

function shipLines(keys, f) {
  const hits = snap.payload.hits;
  return keys.map(k => hits.find(h => h.key === k)).map(f).join('\n');
}

function ecuMail(keys) {
  const ships = snap.payload.ships;
  const due = new Date(); due.setDate(due.getDate() + 5);
  const body = [
    '수신: 각 선박 기관장님 / Chief Engineers',
    '',
    '1. BWTS ECU chemical cleaning 실시 주기(1개월)가 지나 실시를 요청드립니다.',
    '   Please carry out the BWTS ECU chemical cleaning (1-month interval exceeded).',
    '',
    '2. 선박별 마지막 실시일 / Last cleaning date',
    shipLines(keys, h => `   - ${shipName(h.ship)}: ${(ships[h.ship]?.ecu || {}).last || '-'}`),
    '',
    '3. 실시 후 KINS PMS 에 작업 기록을 입력 바랍니다.',
    '   After the work, please record it in KINS PMS.',
    '',
    `4. 실시 예정일 회신 기한: ${due.getMonth() + 1}월 ${due.getDate()}일`,
    `   Please reply with the planned date by ${due.toISOString().slice(0, 10)}.`,
  ].join('\n');
  return ['[KMTC SM][ETP] BWTS ECU CHEMICAL CLEANING 실시 요청의 건 / Request for ECU chemical cleaning', body];
}

function missMail(keys) {
  const p = Object.values(snap.payload.ships)[0]?.log.period || '';
  const body = [
    '수신: 각 선박 기관장님 / Chief Engineers',
    '',
    `1. ${p} BWTS LOG DATA 가 아직 접수되지 않아 제출을 요청드립니다.`,
    `   BWTS LOG DATA for ${p} has not been received. Please send it.`,
    '',
    '2. 대상 선박 / Vessels',
    shipLines(keys, h => `   - ${shipName(h.ship)}`),
    '',
    '3. 메일 제목: [선박코드]_BWTS_LOG_DATA_(YYYY.MM)',
  ].join('\n');
  return [`[KMTC SM][ETP] ${p} BWTS LOG DATA 제출 요청의 건 / Request for BWTS LOG DATA (${p})`, body];
}

function mail(bid) {
  const b = BUNDLES.find(x => x.id === bid);
  const keys = picked(bid);
  if (!keys.length) { toast('선택된 선박 없음'); return; }
  const ships = [...new Set(keys.map(k => snap.payload.hits.find(h => h.key === k).ship))];
  const [subject, body] = b.mail(keys);
  gmailCompose(ships.map(vesselMail).join(','), subject, body + '\n' + SIGN);   // sync: popup-safe
  mark(bid, keys, '메일 작성');
}

window.watchTab = { go, mark, mail };

export default { id: 'watch', mount, refresh };
