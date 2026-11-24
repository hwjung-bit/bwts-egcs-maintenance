// 🛰 관제 — reads the latest watch_snapshot row written by
// pipelines/bwts_log/watch.py (weekdays 09:30). All rules run in Python;
// this tab only shows the result, the change since compare_days ago and the
// task candidates (register button) while bwts_followup auto mode is off.
import { sb, dbSave } from '../core/supabase.js';
import { S } from '../core/state.js';
import { $, esc, toast } from '../core/dom.js';
import { go } from '../core/router.js';

const COMPARE_DAYS = 7;   // contracts/thresholds.json watch.compare_days
let snap = null, old = null;

const LV = { '긴급': ['#fde2e2', '#b91c1c'], '주의': ['#fff3d6', '#92400e'], '': ['#e7f6ea', '#166534'] };
const GRADE_C = { '운전양호': '#16a34a', '수리후정상': '#2563eb', '점검필요': '#ea580c', '미수신': '#dc2626',
  '미운전': '#6b7280', '데이터불량': '#9333ea', '판독실패': '#ca8a04' };

function mount(root) {
  root.innerHTML = '<div class="wrap" id="watchRoot"><div class="loading"><span class="spin"></span> 관제 로딩...</div></div>';
}

async function refresh() {
  try {
    const { data, error } = await sb.from('watch_snapshot').select('date,payload')
      .eq('system', 'BWTS').order('date', { ascending: false }).limit(1);
    if (error) throw error;
    snap = data[0] || null;
    old = null;
    if (snap) {
      const d = new Date(snap.date); d.setDate(d.getDate() - COMPARE_DAYS);
      const r = await sb.from('watch_snapshot').select('date,payload').eq('system', 'BWTS')
        .lte('date', d.toISOString().slice(0, 10)).order('date', { ascending: false }).limit(1);
      old = (r.data || [])[0] || null;
    }
    render();
  } catch (e) {
    $('watchRoot').innerHTML = `<div class="tab-error"><b>⚠ 관제 로드 실패</b>${/watch_snapshot/.test(e.message) ? 'sql/041_watch_snapshot.sql 실행 필요' : ''}<code>${esc(e.message)}</code></div>`;
  }
}

const badge = lv => { const [bg, fg] = LV[lv] || LV['']; return `<span style="background:${bg};color:${fg};padding:1px 7px;border-radius:9px;font-weight:600;font-size:11px">${esc(lv || '정상')}</span>`; };

function changeHtml(p) {
  if (!old) return `<div class="muted">비교 기준(${COMPARE_DAYS}일 전) 스냅샷 없음 — ${COMPARE_DAYS}일 쌓이면 표시</div>`;
  const ok = new Set(old.payload.hits.map(h => h.key)), nk = new Set(p.hits.map(h => h.key));
  const nw = p.hits.filter(h => !ok.has(h.key)), rs = old.payload.hits.filter(h => !nk.has(h.key));
  const li = (hs, mark) => hs.map(h => `<li>${mark} <b>${esc(h.ship)}</b> ${esc(h.kind)} — ${esc(h.msg)}</li>`).join('');
  return `<div class="muted" style="margin-bottom:4px">${esc(old.date)} 대비: 신규 ${nw.length} · 해결 ${rs.length}</div>
    <ul style="margin:0;padding-left:18px">${li(nw, '🆕')}${li(rs, '✅')}</ul>`;
}

function todoHtml(p) {
  const cand = {};
  (p.candidates || []).forEach(c => { (cand[c.task.ship_code] = cand[c.task.ship_code] || []).push(c); });
  const has = id => (S.TASKS || []).some(t => t.id === id);
  const rows = p.hits.map(h => {
    const cs = (cand[h.ship] || []).filter(c => (h.kind === 'ECU') === c.task.id.startsWith('BE_')
      && ['ECU', '점검필요'].includes(h.kind));
    const btn = cs.map(c => has(c.task.id)
      ? `<span class="muted" style="font-size:11px">등록됨</span>`
      : `<button class="refresh-btn" onclick="watchTab.register('${esc(c.task.id)}')">업무 등록</button>`).join(' ');
    return `<tr><td>${badge(h.level)}</td><td><b>${esc(h.ship)}</b></td><td>${esc(h.kind)}</td>
      <td style="text-align:left"><a href="javascript:void 0" onclick="watchTab.go('${esc(h.tab)}')">${esc(h.msg)}</a></td><td>${btn}</td></tr>`;
  }).join('');
  return rows ? `<table class="cal-table"><thead><tr><th>등급</th><th>선박</th><th>구분</th><th>내용</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
    : '<div class="muted">해당 없음</div>';
}

function shipHtml(p) {
  const rows = Object.entries(p.ships).map(([s, v]) => {
    const g = v.log.grade, e = v.ecu, c = v.cal;
    const ecu = !e ? '<span class="muted">-</span>'
      : `<span style="color:${e.over > 0 ? '#b91c1c' : '#166534'}">${esc(e.last)}${e.over > 0 ? ` (+${e.over}일)` : ''}</span>`;
    const cal = !c ? '<span class="muted">-</span>'
      : `<span style="color:${c.days <= 0 ? '#b91c1c' : '#92400e'}">${esc(c.due)} (${c.days}일)</span>`;
    return `<tr><td><b>${esc(s)}</b></td><td>${badge(v.level)}</td>
      <td style="cursor:pointer" onclick="watchTab.go('bwtsLog')"><span style="color:${GRADE_C[g] || '#333'};font-weight:600">${esc(g)}</span>${v.log.streak > 1 ? ` ${v.log.streak}개월` : ''}</td>
      <td style="cursor:pointer" onclick="watchTab.go('bwtsLog')">${ecu}</td>
      <td style="cursor:pointer" onclick="watchTab.go('work')">${v.tasks || '<span class="muted">0</span>'}</td>
      <td style="cursor:pointer" onclick="watchTab.go('bwtsCal')">${cal}</td></tr>`;
  }).join('');
  const lp = Object.values(p.ships)[0]?.log.period || '';
  return `<table class="cal-table"><thead><tr><th>선박</th><th>상태</th><th>로그 ${esc(lp)}</th><th>ECU 마지막 세정</th><th>열린 업무</th><th>검교정 임박</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function render() {
  const root = $('watchRoot');
  if (!snap) { root.innerHTML = '<div class="muted">관제 스냅샷 없음 — pipelines/bwts_log/watch.py 실행 전</div>'; return; }
  const p = snap.payload, m = p.meta || {};
  const n = lv => p.hits.filter(h => h.level === lv).length;
  root.innerHTML = `
    <div style="display:flex;gap:12px;align-items:baseline;flex-wrap:wrap;margin-bottom:8px">
      <h3 style="margin:0">🛰 BWTS 관제</h3>
      <span>${badge('긴급')} ${n('긴급')} &nbsp; ${badge('주의')} ${n('주의')}</span>
      <span class="muted" style="font-size:12px">기준 ${esc(snap.date)} · 갱신 ${esc((m.at || '').replace('T', ' '))} · PMS ${esc((m.pms_at || '없음').replace('T', ' '))}${m.pms_ok ? '' : ' ⚠ 오래됨'} · 업무 ${m.auto_register ? '자동 등록' : '후보만 (PMS 카드 M1 수정 후 자동 등록 전환)'}</span>
    </div>
    ${m.note ? `<div class="tab-error" style="margin-bottom:8px"><b>⚠ ${esc(m.note)}</b></div>` : ''}
    <div class="bl-sec" style="margin-bottom:10px"><h4>지난주 대비</h4>${changeHtml(p)}</div>
    <div class="bl-sec" style="margin-bottom:10px"><h4>오늘 할 일</h4>${todoHtml(p)}</div>
    <div class="bl-sec"><h4>선박별 상태</h4>${shipHtml(p)}</div>`;
}

async function register(id) {
  const c = (snap.payload.candidates || []).find(x => x.task.id === id);
  if (!c || (S.TASKS || []).some(t => t.id === id)) return;
  const ok = await dbSave(sb.from('repairs').insert(c.task), `업무 등록: ${c.task.title}`);
  if (!ok) return;
  if (c.action) await sb.from('work_actions').insert(c.action);
  (S.TASKS = S.TASKS || []).unshift(c.task);
  if (c.action) (S.ACTIONS = S.ACTIONS || []).unshift(c.action);
  toast('업무 탭에 등록했습니다');
  render();
}

window.watchTab = { go, register };

export default { id: 'watch', mount, refresh };
