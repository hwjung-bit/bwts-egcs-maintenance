// 📋 업무 — 환경기술파트 전체 업무 (repairs 테이블 전체, sql/027).
//
// 수리이력 탭이 BWTS/EGCS 만 보는 것과 달리 여기는 시스템 구분 없이 전부.
// 같은 행이므로 수리이력에서 고친 내용이 그대로 보인다. 3단계 = 읽기 전용;
// 편집·조치이력 추가·붙여넣기 일괄 등록은 4단계에서 붙인다.
import { S } from '../core/state.js';
import { $, esc } from '../core/dom.js';
import { matchQuery } from '../shared/search.js';
import { shipOptions } from '../shared/ships.js';
import { WORK_STATUS, WORK_STATUS_COLOR } from '../shared/constants.js';

const F = { system: '', ship: '', status: '', q: '', hideDone: true };
try { F.hideDone = localStorage.getItem('work.hideDone') !== '0'; } catch (e) { /* ignore */ }

const OPEN_ACTS = {};   // task id → 조치이력 펼침 여부

// 정렬: 완료·보류는 아래, 나머지는 기한 임박순(기한 없으면 뒤), 같으면 등록 최신순
const STATUS_RANK = { '진행': 0, '확인': 1, '준비중': 2, '방선예정': 3, '대기': 4, '보류': 8, '완료': 9 };

function mount(root) {
  root.innerHTML = `
  <div class="stats" id="workStats"></div>
  <div class="filters" id="workFilters">
    <select id="wfSys"><option value="">전체 시스템</option></select>
    <select id="wfShip"><option value="">전체 선박</option></select>
    <select id="wfStatus"><option value="">전체 상태</option>${WORK_STATUS.map(s => `<option>${s}</option>`).join('')}</select>
    <input type="text" id="wfSearch" placeholder="🔍 검색 — 띄어쓰기로 겹치기 (예: KMB Hi-NAS)" title="선박·시스템·구분·제목·상세·조치·비고·출처 전부 검색. 검색 중엔 완료 건도 보임" value="${esc(F.q)}">
    <label style="font-size:12px;color:#64748b;display:flex;align-items:center;gap:4px;cursor:pointer"><input type="checkbox" id="wfHideDone"${F.hideDone ? ' checked' : ''}> 완료 숨기기</label>
    <span class="count" id="workCnt"></span>
  </div>
  <div class="wrap" id="workRoot"></div>`;
  const bind = (id, key) => { $(id).onchange = e => { F[key] = e.target.value; render(); }; };
  bind('wfSys', 'system'); bind('wfShip', 'ship'); bind('wfStatus', 'status');
  $('wfSearch').oninput = e => { F.q = e.target.value; render(); };
  $('wfHideDone').onchange = e => {
    F.hideDone = e.target.checked;
    try { localStorage.setItem('work.hideDone', F.hideDone ? '1' : '0'); } catch (err) { /* ignore */ }
    render();
  };
}

function refresh() {
  const sys = {};
  S.TASKS.forEach(t => { if (t.system) sys[t.system] = (sys[t.system] || 0) + 1; });
  $('wfSys').innerHTML = '<option value="">전체 시스템</option>' +
    Object.keys(sys).sort((a, b) => sys[b] - sys[a]).map(s => `<option>${esc(s)}</option>`).join('');
  $('wfShip').innerHTML = shipOptions(S.TASKS);
  render();
}

function actsByTask() {
  const m = {};
  S.ACTIONS.forEach(a => { (m[a.task_id] = m[a.task_id] || []).push(a); });
  Object.values(m).forEach(l => l.sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))));
  return m;
}

function render() {
  const TASKS = S.TASKS;
  $('wfSys').value = F.system; $('wfShip').value = F.ship; $('wfStatus').value = F.status;

  const filtered = TASKS.filter(t => {
    if (F.system && t.system !== F.system) return false;
    if (F.ship && t.ship_code !== F.ship) return false;
    if (F.status && t.status !== F.status) return false;
    if (F.hideDone && !F.status && !F.q && t.status === '완료') return false;
    if (F.q && !matchQuery(F.q, t.date, t.ship_code, t.system, t.category, t.title, t.detail,
      t.last_action, t.next_action, t.note, t.source, t.status)) return false;
    return true;
  });
  filtered.sort((a, b) => {
    const ra = STATUS_RANK[a.status] ?? 5, rb = STATUS_RANK[b.status] ?? 5;
    if (ra !== rb) return ra - rb;
    const da = a.due_date || '9999', db = b.due_date || '9999';
    if (da !== db) return da.localeCompare(db);
    return String(b.date || '').localeCompare(String(a.date || ''));
  });

  const st = { total: TASKS.length };
  WORK_STATUS.forEach(s => { st[s] = 0; });
  TASKS.forEach(t => { st[t.status] = (st[t.status] || 0) + 1; });
  const card = (l, n, cls, status) => {
    const click = status ? ` onclick="workTab.filterStatus('${status}')" style="cursor:pointer"` : '';
    return `<div class="card ${cls}"${click}><div class="num">${n}</div><div class="label">${l}</div></div>`;
  };
  $('workStats').innerHTML = card('전체', st.total, '', '') +
    WORK_STATUS.map(s => card(s, st[s] || 0, WORK_STATUS_COLOR[s], s)).join('');
  const hidden = F.hideDone && !F.status && !F.q ? TASKS.filter(t => t.status === '완료').length : 0;
  $('workCnt').textContent = filtered.length + ' / ' + TASKS.length + '건' + (hidden ? ` (완료 ${hidden}건 숨김)` : '');

  if (!TASKS.length) { $('workRoot').innerHTML = '<div class="loading">업무 없음</div>'; return; }

  const acts = actsByTask();
  const today = new Date().toISOString().slice(0, 10);
  const rows = filtered.map(t => {
    const eid = esc(t.id);
    const list = acts[t.id] || [];
    const urg = t.urgency === '상' ? '🔥' : (t.urgency === '중' ? '<span style="opacity:.45">🔥</span>' : '');
    let dueCls = '';
    if (t.due_date && t.status !== '완료') {
      if (t.due_date < today) dueCls = 'color:#dc2626;font-weight:700';
      else if (t.due_date <= addDays(today, 7)) dueCls = 'color:#d97706;font-weight:700';
    }
    const prog = Number(t.progress || 0);
    const bar = `<span style="display:inline-block;width:56px;height:6px;background:#e5e7eb;border-radius:3px;vertical-align:middle;margin-right:4px"><i style="display:block;width:${prog}%;height:100%;background:#2563eb;border-radius:3px"></i></span>${prog}%`;
    const title = esc(t.title || t.symptom || '—') +
      (t.detail ? `<div class="muted" style="font-size:11px;white-space:pre-wrap;word-break:break-word">${esc(t.detail)}</div>` : '');
    const actBtn = list.length
      ? `<button onclick="workTab.toggleActs('${eid}')" style="background:none;border:1px solid #cbd5e1;border-radius:6px;cursor:pointer;font-size:11px;padding:1px 6px" title="조치이력 ${list.length}건">🗒 ${list.length}</button>`
      : '';
    const main = `<tr data-id="${eid}">` +
      `<td style="white-space:nowrap">${esc(t.date || '—')}</td>` +
      `<td style="white-space:nowrap">${urg}${esc(t.ship_code || '—')}</td>` +
      `<td style="white-space:nowrap">${esc(t.system || '—')}</td>` +
      `<td style="white-space:nowrap">${esc(t.category || '—')}</td>` +
      `<td style="min-width:220px">${title}</td>` +
      `<td style="white-space:nowrap;${dueCls}">${esc(t.due_date || '—')}</td>` +
      `<td><span class="status-select st-${esc(t.status)}" style="padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700">${esc(t.status)}</span></td>` +
      `<td style="white-space:nowrap">${bar}</td>` +
      `<td style="max-width:220px;white-space:pre-wrap;word-break:break-word">${esc(t.last_action || '')}</td>` +
      `<td style="max-width:220px;white-space:pre-wrap;word-break:break-word">${esc(t.next_action || '')}</td>` +
      `<td style="white-space:nowrap">${actBtn}</td></tr>`;
    const detail = list.length
      ? `<tr class="detail-row${OPEN_ACTS[t.id] ? ' open' : ''}" data-acts="${eid}"><td colspan="11" style="background:#f8fafc;padding:6px 12px 8px 40px">` +
        list.map(a => `<div style="font-size:12px;padding:2px 0"><b style="color:#64748b">${esc(a.date || '')}</b>` +
          (a.progress !== null && a.progress !== undefined ? ` <span class="muted">[${a.progress}%]</span>` : '') +
          ` ${esc(a.note || '')}` + (a.author ? ` <span class="muted" style="font-size:11px">— ${esc(a.author)}</span>` : '') + '</div>').join('') +
        '</td></tr>'
      : '';
    return main + detail;
  }).join('');
  $('workRoot').innerHTML =
    '<table><thead><tr><th style="width:80px">등록일</th><th style="width:50px">선박</th><th style="width:70px">시스템</th><th style="width:60px">구분</th><th>제목</th><th style="width:80px">기한</th><th style="width:70px">상태</th><th style="width:100px">진행률</th><th>최근조치</th><th>다음조치</th><th style="width:50px">이력</th></tr></thead><tbody>' +
    rows + '</tbody></table>' +
    '<div style="margin-top:8px;color:#94a3b8;font-size:11px">읽기 전용(1차) · 🔥 긴급 상 · 기한 빨강=지남, 주황=7일 내 · 🗒 → 조치이력 펼치기 · BWTS/EGCS 건은 🔧 수리이력 탭과 같은 행</div>';
}

function addDays(iso, n) {
  const d = new Date(iso); d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function filterStatus(s) { F.status = F.status === s ? '' : s; render(); }
function toggleActs(id) {
  OPEN_ACTS[id] = !OPEN_ACTS[id];
  const tr = document.querySelector(`#workRoot tr[data-acts="${CSS.escape(id)}"]`);
  if (tr) tr.classList.toggle('open', OPEN_ACTS[id]);
}

window.workTab = { filterStatus, toggleActs };

export default { id: 'work', mount, refresh };
