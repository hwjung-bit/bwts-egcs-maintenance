// 📋 업무 — 환경기술파트 전체 업무 (repairs 테이블 전체, sql/027).
//
// 수리이력 탭이 BWTS/EGCS 만 보는 것과 달리 여기는 시스템 구분 없이 전부.
// 같은 행이므로 수리이력에서 고친 내용이 그대로 보이고, 여기서 고친 것도
// 수리이력에 바로 반영된다. 업무관리대장(GAS)에서 옮겨온 기능:
//   셀 클릭 편집 · 조치이력 추가/삭제(최근조치·진행률 미러) · 붙여넣기 일괄 등록
//   (한 줄 = 업무 하나, 선박/시스템/구분 추정 + 기존 업무 중복 판정).
import { S, isLoggedIn, loadData } from '../core/state.js';
import { sb, dbSave } from '../core/supabase.js';
import { $, esc, toast, todayStr, freezeCell, inlineEdit } from '../core/dom.js';
import { matchQuery } from '../shared/search.js';
import { shipOptions, normalizeShipCode } from '../shared/ships.js';
import { requestDriveFolder } from '../shared/drive.js';
import { WORK_STATUS, WORK_STATUS_COLOR } from '../shared/constants.js';

const F = { system: '', ship: '', status: '', q: '', hideDone: true };
try { F.hideDone = localStorage.getItem('work.hideDone') !== '0'; } catch (e) { /* ignore */ }

const OPEN_ACTS = {};   // task id → 조치이력 펼침 여부
const REPAIR_SYS = { BWTS: 1, EGCS: 1 };
const URGENCY = ['', '상', '중', '하'];
const SYSTEMS = ['BWTS', 'EGCS', 'Hi-NAS', 'CII', 'BCM', 'BFM', 'BMS', 'EEOI', 'FOC', 'ESD',
  'SEEMP', 'TPM', 'FAT', 'IMO DCS', 'BUNKER', '규제', '기타'];
const CATEGORIES = ['검교정', '수리', '점검', '발주', '보고서', '레트로핏', '규제', '회신', '자료작성', '세미나', '기타'];
const SOURCES = ['주간회의', '상무', '팀장', '본선요청', '기타'];

// 정렬: 완료·보류는 아래, 나머지는 기한 임박순(기한 없으면 뒤), 같으면 등록 최신순
const STATUS_RANK = { '진행': 0, '확인': 1, '준비중': 2, '방선예정': 3, '대기': 4, '보류': 8, '완료': 9 };

// 수리이력 탭은 앱 전환(5단계)까지 옛 stage 를 읽는다. BWTS/EGCS 행의 상태를
// 여기서 바꾸면 stage 도 같이 맞춰 두 탭이 어긋나지 않게 한다.
const STAGE_OF = { '대기': '미확인', '확인': '확인', '준비중': '수리준비중', '방선예정': '방선예정',
  '진행': '확인', '보류': '확인', '완료': '완료' };

function newId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/* ===== mount / refresh / render ===== */
function mount(root) {
  ensureBulkModal();
  root.innerHTML = `
  <div class="stats" id="workStats"></div>
  <div class="filters" id="workFilters">
    <select id="wfSys"><option value="">전체 시스템</option></select>
    <select id="wfShip"><option value="">전체 선박</option></select>
    <select id="wfStatus"><option value="">전체 상태</option>${WORK_STATUS.map(s => `<option>${s}</option>`).join('')}</select>
    <input type="text" id="wfSearch" placeholder="🔍 검색 — 띄어쓰기로 겹치기 (예: KMB Hi-NAS)" title="선박·시스템·구분·제목·상세·조치·비고·출처 전부 검색. 검색 중엔 완료 건도 보임" value="${esc(F.q)}">
    <label style="font-size:12px;color:#64748b;display:flex;align-items:center;gap:4px;cursor:pointer"><input type="checkbox" id="wfHideDone"${F.hideDone ? ' checked' : ''}> 완료 숨기기</label>
    <button class="add-btn" id="waOpen" title="업무 한 건 등록">+ 업무 추가</button>
    <button class="add-btn" id="wbOpen" style="background:#059669;border-color:#059669" title="여러 줄을 붙여넣어 한 번에 등록 — 한 줄 = 업무 하나">⏎ 붙여넣기 등록</button>
    <span class="count" id="workCnt"></span>
  </div>
  <div class="wrap" id="workRoot"></div>`;
  ensureAddModal();
  $('waOpen').onclick = openAdd;
  const bind = (id, key) => { $(id).onchange = e => { F[key] = e.target.value; render(); }; };
  bind('wfSys', 'system'); bind('wfShip', 'ship'); bind('wfStatus', 'status');
  $('wfSearch').oninput = e => { F.q = e.target.value; render(); };
  $('wfHideDone').onchange = e => {
    F.hideDone = e.target.checked;
    try { localStorage.setItem('work.hideDone', F.hideDone ? '1' : '0'); } catch (err) { /* ignore */ }
    render();
  };
  $('wbOpen').onclick = openBulk;
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
  Object.values(m).forEach(l => l.sort((a, b) =>
    String(b.date || '').localeCompare(String(a.date || '')) ||
    String(b.created_at || '').localeCompare(String(a.created_at || ''))));
  return m;
}

function addDays(iso, n) {
  const d = new Date(iso); d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
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
  const today = todayStr();
  const can = isLoggedIn();
  const ed = (id, f, kind) => can ? ` class="edit-cell" onclick="workTab.edit('${id}','${f}','${kind}',this)" title="클릭하여 수정"` : '';
  const rows = filtered.map(t => {
    const eid = esc(t.id);
    const list = acts[t.id] || [];
    // 긴급도 — 상/중/하 배지. 클릭하면 상→중→하→없음 순환.
    const urg = `<span class="urg-badge urg-${esc(t.urgency || 'none')}" onclick="${can ? `workTab.cycleUrgency('${eid}')` : ''}" style="cursor:${can ? 'pointer' : 'default'}" title="긴급도 ${esc(t.urgency || '미지정')}${can ? ' — 클릭: 상→중→하→없음' : ''}">${t.urgency ? '🔥 ' + esc(t.urgency) : '—'}</span>`;
    let dueCls = '';
    if (t.due_date && t.status !== '완료') {
      if (t.due_date < today) dueCls = 'color:#dc2626;font-weight:700';
      else if (t.due_date <= addDays(today, 7)) dueCls = 'color:#d97706;font-weight:700';
    }
    const prog = Number(t.progress || 0);
    const bar = `<span style="display:inline-block;width:56px;height:6px;background:#e5e7eb;border-radius:3px;vertical-align:middle;margin-right:4px"><i style="display:block;width:${prog}%;height:100%;background:#2563eb;border-radius:3px"></i></span><span${ed(eid, 'progress', 'number')}>${prog}%</span>`;
    const stOpts = WORK_STATUS.map(s => `<option${t.status === s ? ' selected' : ''}>${s}</option>`).join('');
    const status = can
      ? `<select class="status-select st-${esc(t.status)}" style="padding:3px 18px 3px 6px" onchange="workTab.setStatus('${eid}',this.value)">${stOpts}</select>`
      : `<span class="status-select st-${esc(t.status)}" style="padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700">${esc(t.status)}</span>`;
    const title = `<div${ed(eid, 'title', 'text')} style="font-weight:600">${esc(t.title || t.symptom || '—')}</div>` +
      `<div${ed(eid, 'detail', 'long')} class="muted${can ? ' edit-cell' : ''}" style="font-size:11px;white-space:pre-wrap;word-break:break-word">${esc(t.detail || (can ? '＋ 상세' : ''))}</div>`;
    const actBtn = `<button onclick="workTab.toggleActs('${eid}')" style="background:none;border:1px solid #cbd5e1;border-radius:6px;cursor:pointer;font-size:11px;padding:1px 6px" title="조치이력 ${list.length}건">🗒 ${list.length}</button>`;
    const main = `<tr data-id="${eid}">` +
      `<td style="white-space:nowrap"><span${ed(eid, 'date', 'date')}>${esc(t.date || '—')}</span></td>` +
      `<td style="white-space:nowrap">${urg}</td>` +
      `<td style="white-space:nowrap"><span${ed(eid, 'ship_code', 'ship')}>${esc(t.ship_code || '—')}</span></td>` +
      `<td style="white-space:nowrap"><span${ed(eid, 'system', 'text')}>${esc(t.system || '—')}</span></td>` +
      `<td style="white-space:nowrap"><span${ed(eid, 'category', 'text')}>${esc(t.category || '—')}</span></td>` +
      `<td style="min-width:220px">${title}</td>` +
      `<td style="white-space:nowrap;${dueCls}"><span${ed(eid, 'due_date', 'date')}>${esc(t.due_date || '—')}</span></td>` +
      `<td style="padding:4px 6px">${status}</td>` +
      `<td style="white-space:nowrap">${bar}</td>` +
      // 최근 조치 = 조치이력 최신 건 (없으면 이관 때 들어온 last_action). 클릭 → 이력 펼침.
      `<td style="max-width:300px;white-space:pre-wrap;word-break:break-word;cursor:pointer" onclick="workTab.toggleActs('${eid}')" title="클릭 → 조치이력 펼치기">` +
        (list[0]
          ? `<span class="muted" style="font-size:11px;white-space:nowrap">${esc(list[0].date || '')}</span> ${esc(list[0].note || '')}`
          : esc(t.last_action || '')) + '</td>' +
      `<td style="white-space:nowrap">${actBtn}` +
        (can ? ` <button id="wdel-${eid}" onclick="workTab.deleteTask('${eid}')" style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:13px" title="삭제 (두 번 클릭)">✕</button>` : '') +
      '</td></tr>';
    const entries = list.map(a =>
      `<div style="font-size:12px;padding:2px 0;display:flex;gap:6px;align-items:baseline"><b style="color:#64748b;white-space:nowrap">${esc(a.date || '')}</b>` +
      (a.progress !== null && a.progress !== undefined ? `<span class="muted">[${a.progress}%]</span>` : '') +
      `<span style="flex:1;white-space:pre-wrap;word-break:break-word">${esc(a.note || '')}</span>` +
      (a.author ? `<span class="muted" style="font-size:11px;white-space:nowrap">${esc(a.author.split('@')[0])}</span>` : '') +
      (can ? `<button onclick="workTab.removeAct('${esc(a.id)}','${eid}')" style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:12px" title="이 기록 삭제">✕</button>` : '') +
      '</div>').join('') || '<div class="muted" style="font-size:12px">조치이력 없음</div>';
    const form = can
      ? `<div style="display:flex;gap:6px;margin-top:6px;align-items:center">` +
        `<input type="date" id="wa-d-${eid}" value="${today}" style="padding:3px 6px;border:1px solid #cbd5e1;border-radius:5px;font-size:12px">` +
        `<input type="number" id="wa-p-${eid}" min="0" max="100" step="5" placeholder="%" style="width:60px;padding:3px 6px;border:1px solid #cbd5e1;border-radius:5px;font-size:12px">` +
        `<input type="text" id="wa-n-${eid}" placeholder="조치 내용 (Enter 로 추가)" style="flex:1;padding:3px 6px;border:1px solid #cbd5e1;border-radius:5px;font-size:12px" onkeydown="if(event.key==='Enter')workTab.addAct('${eid}')">` +
        `<button class="add-btn" style="padding:3px 10px" onclick="workTab.addAct('${eid}')">추가</button></div>`
      : '';
    const detail = `<tr class="detail-row${OPEN_ACTS[t.id] ? ' open' : ''}" data-acts="${eid}"><td colspan="11" style="background:#f8fafc;padding:6px 12px 8px 40px">${entries}${form}</td></tr>`;
    return main + detail;
  }).join('');
  $('workRoot').innerHTML =
    '<table><thead><tr><th style="width:80px">등록일</th><th style="width:56px">긴급</th><th style="width:50px">선박</th><th style="width:70px">시스템</th><th style="width:60px">구분</th><th>제목</th><th style="width:80px">기한</th><th style="width:90px">상태</th><th style="width:110px">진행률</th><th>최근 조치</th><th style="width:50px">이력</th></tr></thead><tbody>' +
    rows + '</tbody></table>' +
    '<div style="margin-top:8px;color:#94a3b8;font-size:11px">셀 클릭 → 수정 · 🔥 → 긴급도 순환 · 기한 빨강=지남, 주황=7일 내 · 최근 조치 = 조치이력 최신 건(클릭 또는 🗒 → 펼치기·추가) · ✕ 두 번 = 삭제 · BWTS/EGCS 건은 🔧 EGCS·BWTS 이력 탭과 같은 행</div>';
}

/* ===== 저장 공통 ===== */
function mirror(id, patch) {
  [S.TASKS, S.REPAIRS].forEach(arr => { const r = arr.find(x => x.id === id); if (r) Object.assign(r, patch); });
}

async function patchTask(id, patch, okMsg) {
  const ok = await dbSave(sb.from('repairs').update(patch).eq('id', id), okMsg);
  if (ok) { mirror(id, patch); render(); }
  return ok;
}

/* 업무관리대장 규칙: →완료 = 진행률 100 (완료일은 DB 트리거), 완료→다른 = 완료일 비움·100% 해제 */
function statusPatch(t, next) {
  const patch = { status: next };
  if (next === '완료') patch.progress = 100;
  else if (t.status === '완료') { patch.completed_at = null; if (Number(t.progress) === 100) patch.progress = 0; }
  if (REPAIR_SYS[t.system]) patch.stage = STAGE_OF[next] || t.stage;
  return patch;
}

/* ===== 핸들러 ===== */
function filterStatus(s) { F.status = F.status === s ? '' : s; render(); }
function toggleActs(id) {
  OPEN_ACTS[id] = !OPEN_ACTS[id];
  const tr = document.querySelector(`#workRoot tr[data-acts="${CSS.escape(id)}"]`);
  if (tr) tr.classList.toggle('open', OPEN_ACTS[id]);
}

async function setStatus(id, next) {
  const t = S.TASKS.find(x => x.id === id); if (!t) return;
  await patchTask(id, statusPatch(t, next), '상태 ' + next);
}

async function cycleUrgency(id) {
  const t = S.TASKS.find(x => x.id === id); if (!t) return;
  const next = URGENCY[(URGENCY.indexOf(t.urgency || '') + 1) % URGENCY.length];
  await patchTask(id, { urgency: next }, next ? '긴급도 ' + next : '긴급도 해제');
}

function edit(id, field, kind, el) {
  const t = S.TASKS.find(x => x.id === id); if (!t) return;
  const cur = t[field] == null ? '' : String(t[field]);
  const save = async v => {
    const patch = {};
    if (kind === 'ship') { const c = normalizeShipCode(v); patch[field] = c || null; }
    else if (kind === 'number') { const n = Math.max(0, Math.min(100, Number(v.replace(/\D/g, '') || 0))); patch[field] = n; }
    else if (kind === 'date') patch[field] = v || null;
    else patch[field] = v;
    if (String(patch[field] == null ? '' : patch[field]) === cur) { render(); return; }
    // 시스템이 BWTS/EGCS 로 바뀌면 수리이력 탭에도 나타나므로 옛 stage 를 채워 둔다
    if (field === 'system' && REPAIR_SYS[v] && !REPAIR_SYS[t.system]) { patch.stage = STAGE_OF[t.status] || '미확인'; if (!t.symptom) patch.symptom = t.title || ''; }
    if (field === 'title' && REPAIR_SYS[t.system]) patch.symptom = v;
    if (field === 'category' && REPAIR_SYS[t.system]) patch.equip = v;
    if (field === 'last_action' && REPAIR_SYS[t.system]) patch.action = v;
    await patchTask(id, patch, '저장됨');
  };
  if (kind === 'long') {
    const unfreeze = freezeCell(el);
    const h = Math.max(60, el.getBoundingClientRect().height);
    const ta = document.createElement('textarea');
    ta.value = cur;
    ta.style.cssText = `width:100%;box-sizing:border-box;min-height:${h}px;font-size:12px;padding:4px;border:1px solid #3b82f6;border-radius:4px;outline:none;font-family:inherit;resize:vertical`;
    el.textContent = ''; el.appendChild(ta); ta.focus();
    ta.onblur = () => { ta.onblur = null; unfreeze(); save(ta.value.trim()); };
    ta.onkeydown = e => { if (e.key === 'Escape') { ta.onblur = null; unfreeze(); render(); } };
    return;
  }
  inlineEdit(el, cur, v => save(v), {
    type: kind === 'date' ? 'date' : 'text',
    css: kind === 'number' ? 'width:56px;font-size:12px;padding:3px 6px;border:1px solid #3b82f6;border-radius:4px;outline:none' : undefined,
    restore: () => render(),
  });
}

/* ===== 삭제 (두 번 클릭 — 팝업 없이) ===== */
const DEL_ARM = {};
async function deleteTask(id) {
  const btn = $('wdel-' + id);
  if (!DEL_ARM[id]) {
    DEL_ARM[id] = setTimeout(() => { delete DEL_ARM[id]; if (btn) { btn.textContent = '✕'; btn.style.fontWeight = ''; } }, 4000);
    if (btn) { btn.textContent = '삭제?'; btn.style.fontWeight = '700'; }
    return;
  }
  clearTimeout(DEL_ARM[id]); delete DEL_ARM[id];
  // work_actions·folder_requests 는 ON DELETE CASCADE. GAS 폴더는 남는다(파일 보존).
  const ok = await dbSave(sb.from('repairs').delete().eq('id', id), '삭제됨');
  if (!ok) return;
  S.TASKS = S.TASKS.filter(t => t.id !== id);
  S.REPAIRS = S.REPAIRS.filter(t => t.id !== id);
  S.ACTIONS = S.ACTIONS.filter(a => a.task_id !== id);
  render();
}

/* ===== 조치이력 ===== */
async function addAct(taskId) {
  const t = S.TASKS.find(x => x.id === taskId); if (!t) return;
  const note = ($('wa-n-' + taskId).value || '').trim();
  if (!note) { $('wa-n-' + taskId).focus(); return; }
  const date = $('wa-d-' + taskId).value || todayStr();
  const p = $('wa-p-' + taskId).value;
  const rec = { id: newId('wa_'), task_id: taskId, date, progress: p === '' ? null : Number(p), note,
    author: (S.USER && S.USER.email) || '' };
  const ok = await dbSave(sb.from('work_actions').insert(rec), '조치이력 추가');
  if (!ok) return;
  S.ACTIONS.unshift(rec);
  OPEN_ACTS[taskId] = true;
  // 업무관리대장과 같이 최근조치·진행률을 업무 행에 미러
  const patch = { last_action: note };
  if (rec.progress !== null) patch.progress = rec.progress;
  if (REPAIR_SYS[t.system]) patch.action = note;
  await patchTask(taskId, patch);
}

async function removeAct(id, taskId) {
  const ok = await dbSave(sb.from('work_actions').delete().eq('id', id), '기록 삭제');
  if (!ok) return;
  S.ACTIONS = S.ACTIONS.filter(a => a.id !== id);
  OPEN_ACTS[taskId] = true;
  render();
}

/* ===== 단건 등록 ===== */
function ensureAddModal() {
  if ($('workAdd')) return;
  const d = document.createElement('div');
  d.id = 'workAdd';
  const opt = (list, blank) => (blank ? '<option value=""></option>' : '') + list.map(v => `<option>${esc(v)}</option>`).join('');
  d.innerHTML = `
  <div class="box">
    <h3>📋 업무 추가</h3>
    <div class="row">
      <label>선박<input id="waShip" list="dlShips" placeholder="예: KMB (없으면 비움)" maxlength="3" style="text-transform:uppercase" autocomplete="off"></label>
      <label>시스템<input id="waSys" list="waSysList" placeholder="BWTS / Hi-NAS / CII …" autocomplete="off"><datalist id="waSysList">${opt(SYSTEMS)}</datalist></label>
      <label>구분<select id="waCat">${opt(CATEGORIES)}</select></label>
    </div>
    <label>제목<input id="waTitle" placeholder="예: KMB Hi-NAS autopilot 자재 발주"></label>
    <label>상세 / 지시내용<textarea id="waDetail" placeholder="선택"></textarea></label>
    <div class="row">
      <label>기한<input id="waDue" type="date"></label>
      <label>상태<select id="waStatus">${opt(WORK_STATUS)}</select></label>
      <label>긴급도<select id="waUrg">${opt(URGENCY.slice(1), true)}</select></label>
      <label>출처<input id="waSource" list="waSourceList" placeholder="주간회의 등"><datalist id="waSourceList">${opt(SOURCES)}</datalist></label>
    </div>
    <div class="btns">
      <button id="waCancel">취소</button>
      <button class="pri" id="waSave">등록</button>
    </div>
  </div>`;
  document.body.appendChild(d);
  d.onclick = e => { if (e.target === d) closeAdd(); };
  $('waCancel').onclick = closeAdd;
  $('waSave').onclick = saveAdd;
  $('waTitle').onkeydown = e => { if (e.key === 'Enter') saveAdd(); };
}
function openAdd() {
  if (!isLoggedIn()) { toast('로그인 필요'); return; }
  ['waShip', 'waSys', 'waTitle', 'waDetail', 'waDue', 'waSource'].forEach(id => { $(id).value = ''; });
  $('waCat').value = '기타'; $('waStatus').value = '대기'; $('waUrg').value = '';
  $('workAdd').classList.add('open'); $('waTitle').focus();
}
function closeAdd() { $('workAdd').classList.remove('open'); }
async function saveAdd() {
  const title = $('waTitle').value.trim();
  if (!title) { toast('제목을 입력하세요'); $('waTitle').focus(); return; }
  const status = $('waStatus').value || '대기';
  const sys = $('waSys').value.trim();
  const r = { id: newId('WK_'), ship_code: normalizeShipCode($('waShip').value) || null, system: sys, date: todayStr(),
    title, detail: $('waDetail').value.trim(), source: $('waSource').value.trim(), category: $('waCat').value,
    requester: '', due_date: $('waDue').value || null, status, progress: status === '완료' ? 100 : 0,
    urgency: $('waUrg').value, origin: '업무', note: '' };
  if (REPAIR_SYS[sys]) { r.stage = STAGE_OF[status] || '미확인'; r.symptom = title; r.equip = r.category; }
  const btn = $('waSave'); btn.disabled = true;
  const ok = await dbSave(sb.from('repairs').insert(r), '업무 등록됨');
  btn.disabled = false;
  if (!ok) return;
  if (REPAIR_SYS[sys]) { try { await requestDriveFolder(r); } catch (e) { console.warn('folder request', e); } }
  closeAdd();
  await loadData();
}

/* ===== 붙여넣기 일괄 등록 (업무관리대장 Bulk.js 이식) ===== */
const BULK_MAX = 80, MATCH_MIN = 0.55, LIST_MIN = 0.3, MIN_HITS = 2, FLOOR = 4;
// 제목만 보고 판정. strong 규칙이 약한 규칙을 이기고, 같으면 뒤에 나온 낱말이 이긴다
// (한국어는 끝 동사가 행동: '… 검교정 라스텍 발주' = 발주).
const CAT_RULES = [
  { cat: '검교정', strong: 1, words: ['검교정', '교정', '캘리브', 'calibration'] },
  { cat: '발주', strong: 1, words: ['발주', '견적', 'rfq', '구매', '주문', '계약'] },
  { cat: '수리', strong: 1, words: ['수리', '교체', '보수', '재생', '오버홀'] },
  { cat: '보고서', strong: 1, words: ['보고서', '리포트', '제안서'] },
  { cat: '레트로핏', strong: 1, words: ['레트로핏', '설치', '포설', '개조'] },
  { cat: '세미나', strong: 1, words: ['세미나', '교육'] },
  { cat: '점검', words: ['점검', '확인', '검토', '진단', '테스트'] },
  { cat: '규제', words: ['규제', '협약', '개정', '인증', '증서'] },
  { cat: '회신', words: ['회신', '전달', '송부', '제출', '답변', '요청', '통보', '보고'] },
  { cat: '자료작성', words: ['작성', '정리', '분석', '취합', '자료', '집계'] },
];
const STOP = { '및': 1, '관련': 1, '내용': 1, '건': 1, '요청': 1, '확인': 1, '작성': 1, '검토': 1, '정리': 1,
  '전달': 1, '본선': 1, '진행': 1, '대기': 1, '완료': 1, '보류': 1, 'PO': 1, 'RST': 1, 'ALL': 1 };
let BULK = [];   // 미리보기 항목

function categoryOf(text) {
  const low = String(text).toLowerCase();
  let cat = '', at = -1, strong = 0;
  CAT_RULES.forEach(rule => {
    const s = rule.strong ? 1 : 0;
    if (s < strong) return;
    rule.words.forEach(w => {
      const p = low.lastIndexOf(w);
      if (p === -1) return;
      if (s > strong || p > at) { strong = s; at = p; cat = rule.cat; }
    });
  });
  return cat || '기타';
}
function tokens(s) {
  const out = {};
  String(s || '').toUpperCase().split(/[^0-9A-Z가-힣]+/).forEach(p => { if (p.length >= 2 && !STOP[p]) out[p] = 1; });
  return out;
}
function parseLine(line, ships) {
  const raw = line;
  let urgency = '', detail = '', ship = '', system = '';
  const um = /^[\[(（]\s*(상|중|하)\s*[\])）]\s*/.exec(line);
  if (um) { urgency = um[1]; line = line.slice(um[0].length).trim(); }
  const m = /^(.*\S)\s*[(（]([^()（）]*)[)）]\s*$/.exec(line);
  if (m && m[2].trim()) { line = m[1].trim(); detail = m[2].trim(); }
  const head = /^([A-Za-z][A-Za-z0-9]{1,4})\b[\s:·]*/.exec(line);
  if (head && ships[head[1].toUpperCase()]) { ship = head[1].toUpperCase(); line = line.slice(head[0].length).trim(); }
  const hay = (line + ' ' + detail).toUpperCase();
  let best = -1;
  SYSTEMS.forEach(s => { if (s === '기타') return; const at = hay.indexOf(s.toUpperCase()); if (at !== -1 && (best === -1 || at < best)) { best = at; system = s; } });
  return { raw, ship, system, category: categoryOf(line), title: line, detail, urgency };
}
function candidates(it, open) {
  const a = tokens(it.title + ' ' + it.detail), ak = Object.keys(a);
  if (!ak.length) return [];
  const out = [];
  open.forEach(t => {
    if (it.ship && t.ship_code && it.ship !== t.ship_code) return;   // 다른 선박 업무는 후보 제외
    const b = tokens((t.title || t.symptom || '') + ' ' + (t.detail || '')), bk = Object.keys(b);
    if (!bk.length) return;
    let hit = 0; ak.forEach(k => { if (b[k]) hit++; });
    if (hit < MIN_HITS) return;
    let score = hit / Math.max(FLOOR, Math.min(ak.length, bk.length));
    if (it.ship && t.ship_code && it.ship === t.ship_code) score += 0.1;
    if (score < LIST_MIN) return;
    out.push({ id: t.id, score: Math.min(score, 1) });
  });
  out.sort((x, y) => y.score - x.score);
  return out.slice(0, 5);
}

function ensureBulkModal() {
  if ($('workBulk')) return;
  const d = document.createElement('div');
  d.id = 'workBulk';
  d.innerHTML = `
  <div class="box">
    <h3>⏎ 붙여넣기 일괄 등록 <span style="font-weight:400;color:#94a3b8;font-size:11px">— 한 줄 = 업무 하나. "[상] KMB Hi-NAS … (상세)" 형식, ──── 줄은 무시</span></h3>
    <div class="row">
      <label>출처<input id="wbSource" list="wbSourceList" placeholder="주간회의 등"><datalist id="wbSourceList">${SOURCES.map(s => `<option>${s}</option>`).join('')}</datalist></label>
      <label>지시자<input id="wbReq" placeholder="선택"></label>
      <label>기한(공통)<input id="wbDue" type="date"></label>
    </div>
    <label>목록<textarea id="wbText" rows="6" placeholder="[상] KMB Hi-NAS autopilot 자재 발주 (견적 접수됨)&#10;KCB BWTS UV 램프 교체&#10;분기 CII 운항지표 집계 보고서 작성"></textarea></label>
    <div id="wbPreview"></div>
    <div class="btns">
      <button id="wbCancel">취소</button>
      <button id="wbParse">분석</button>
      <button class="pri" id="wbApply" disabled>일괄 등록</button>
    </div>
  </div>`;
  document.body.appendChild(d);
  d.onclick = e => { if (e.target === d) closeBulk(); };
  $('wbCancel').onclick = closeBulk;
  $('wbParse').onclick = parseBulk;
  $('wbApply').onclick = applyBulk;
}
function openBulk() {
  if (!isLoggedIn()) { toast('로그인 필요'); return; }
  BULK = []; $('wbPreview').innerHTML = ''; $('wbApply').disabled = true; $('wbApply').textContent = '일괄 등록';
  $('workBulk').classList.add('open'); $('wbText').focus();
}
function closeBulk() { $('workBulk').classList.remove('open'); }

function parseBulk() {
  const lines = String($('wbText').value || '').split(/\r?\n/)
    .map(l => l.replace(/^\s*[-*·•\d]+[.)]?\s*/, '').trim())
    .filter(l => l.length > 1 && /[0-9A-Za-z가-힣]/.test(l) && !/^[─━—=_]{2,}/.test(l));
  if (!lines.length) { toast('붙여넣은 줄이 없습니다'); return; }
  if (lines.length > BULK_MAX) { toast(`한 번에 ${BULK_MAX}줄까지 (입력 ${lines.length}줄)`); return; }
  const ships = {}; S.SHIPS.forEach(s => { if (s.code) ships[String(s.code).toUpperCase()] = 1; });
  const open = S.TASKS.filter(t => t.status !== '완료');
  BULK = lines.map((line, i) => {
    const it = parseLine(line, ships);
    it.key = 'b' + i;
    it.candidates = candidates(it, open);
    const top = it.candidates[0];
    it.action = top && top.score >= MATCH_MIN ? 'update' : 'new';
    it.matchId = it.action === 'update' ? top.id : '';
    it.status = '대기'; it.progress = '';
    return it;
  });
  renderBulk();
}

function taskLabel(t) { return (t.ship_code ? `[${t.ship_code}] ` : '') + (t.title || t.symptom || '') + ' · ' + (t.status || ''); }
function matchSelect(it) {
  const byId = {}; S.TASKS.forEach(t => { byId[t.id] = t; });
  const cand = it.candidates.map(c => byId[c.id]).filter(Boolean);
  const seen = {}; cand.forEach(t => { seen[t.id] = 1; });
  const rest = S.TASKS.filter(t => t.status !== '완료' && !seen[t.id]);
  const same = rest.filter(t => it.ship && t.ship_code === it.ship);
  const others = rest.filter(t => !(it.ship && t.ship_code === it.ship));
  const opt = t => `<option value="${esc(t.id)}"${t.id === it.matchId ? ' selected' : ''}>${esc(taskLabel(t))}</option>`;
  let html = '<option value="">— 대상 업무 선택 —</option>';
  if (cand.length) html += `<optgroup label="비슷한 업무 (${cand.length})">${cand.map(opt).join('')}</optgroup>`;
  if (same.length) html += `<optgroup label="같은 선박 (${same.length})">${same.map(opt).join('')}</optgroup>`;
  if (others.length) html += `<optgroup label="그 외 진행 중 (${others.length})">${others.map(opt).join('')}</optgroup>`;
  return `<select class="bmatch" data-k="${it.key}">${html}</select>`;
}
function renderBulk() {
  const sel = (cls, list, cur, k, allowBlank) =>
    `<select class="${cls}" data-k="${k}">${allowBlank ? '<option value=""></option>' : ''}${list.map(v => `<option${v === cur ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select>`;
  const rows = BULK.map(it => `
    <tr data-k="${it.key}" class="wb-${it.action}">
      <td>${sel('baction', [], '', it.key).replace('</select>', `<option value="new"${it.action === 'new' ? ' selected' : ''}>신규</option><option value="update"${it.action === 'update' ? ' selected' : ''}>기존에 추가</option><option value="skip"${it.action === 'skip' ? ' selected' : ''}>제외</option></select>`)}</td>
      <td>${matchSelect(it)}</td>
      <td><input class="bf" data-f="ship" data-k="${it.key}" value="${esc(it.ship)}" style="text-transform:uppercase"></td>
      <td>${sel('bf', SYSTEMS, it.system, it.key, true).replace('class="bf"', `class="bf" data-f="system"`)}</td>
      <td>${sel('bf', CATEGORIES, it.category, it.key, false).replace('class="bf"', `class="bf" data-f="category"`)}</td>
      <td><input class="bf" data-f="title" data-k="${it.key}" value="${esc(it.title)}"></td>
      <td><input class="bf" data-f="detail" data-k="${it.key}" value="${esc(it.detail)}"></td>
      <td>${sel('bf', URGENCY.slice(1), it.urgency, it.key, true).replace('class="bf"', `class="bf" data-f="urgency"`)}</td>
      <td>${sel('bf', WORK_STATUS, it.status, it.key, true).replace('class="bf"', `class="bf" data-f="status"`)}</td>
      <td><input class="bf" data-f="progress" data-k="${it.key}" type="number" min="0" max="100" step="5" value="${esc(it.progress)}" placeholder="%"></td>
    </tr>`).join('');
  $('wbPreview').innerHTML = `
    <div class="muted" style="font-size:11px;margin:6px 0">각 줄의 동작(신규 / 기존에 추가 / 제외)과 값을 고친 뒤 등록. "기존에 추가"는 새 업무를 만들지 않고 고른 업무에 조치이력만 남깁니다.</div>
    <div style="overflow-y:auto;overflow-x:hidden;max-height:52vh"><table class="wb-table"><thead><tr><th style="width:92px">동작</th><th style="width:240px">대상 업무</th><th style="width:60px">선박</th><th style="width:104px">시스템</th><th style="width:96px">구분</th><th>제목</th><th style="width:24%">상세</th><th style="width:62px">긴급</th><th style="width:92px">상태</th><th style="width:62px">%</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  $('wbPreview').querySelectorAll('.baction').forEach(s => { s.onchange = () => { const it = BULK.find(x => x.key === s.dataset.k); it.action = s.value; s.closest('tr').className = 'wb-' + s.value; }; });
  $('wbPreview').querySelectorAll('.bmatch').forEach(s => { s.onchange = () => { BULK.find(x => x.key === s.dataset.k).matchId = s.value; }; });
  $('wbPreview').querySelectorAll('.bf').forEach(el => { el.onchange = () => { BULK.find(x => x.key === el.dataset.k)[el.dataset.f] = el.value.trim(); }; });
  $('wbApply').disabled = false;
  const n = counts();
  $('wbApply').textContent = `일괄 등록 (신규 ${n.neu} · 추가 ${n.upd})`;
}
function counts() {
  const n = { neu: 0, upd: 0, skip: 0, unpicked: 0 };
  BULK.forEach(it => {
    if (it.action === 'skip' || !it.title) n.skip++;
    else if (it.action === 'update') { if (it.matchId) n.upd++; else n.unpicked++; }
    else n.neu++;
  });
  return n;
}

let ARMED = false;
async function applyBulk() {
  const n = counts();
  if (!n.neu && !n.upd) { toast('등록할 항목이 없습니다'); return; }
  if (n.unpicked) { toast(`"기존에 추가" ${n.unpicked}줄에 대상 업무를 고르세요`); return; }
  const btn = $('wbApply');
  if (!ARMED) { ARMED = true; btn.classList.add('armed'); btn.textContent = `신규 ${n.neu} · 추가 ${n.upd} 등록? (다시 클릭)`;
    setTimeout(() => { ARMED = false; btn.classList.remove('armed'); btn.textContent = `일괄 등록 (신규 ${n.neu} · 추가 ${n.upd})`; }, 6000); return; }
  ARMED = false; btn.disabled = true; btn.textContent = '등록 중…';
  const today = todayStr(), email = (S.USER && S.USER.email) || '';
  const source = $('wbSource').value.trim(), requester = $('wbReq').value.trim(), due = $('wbDue').value || null;
  const newRows = [], acts = [], patches = [];
  BULK.forEach(it => {
    if (it.action === 'skip' || !it.title) return;
    const detail = it.detail || '';
    if (it.action === 'update' && it.matchId) {
      const t = S.TASKS.find(x => x.id === it.matchId); if (!t) return;
      const note = it.title + (detail ? ' — ' + detail : '');
      const prog = it.progress === '' ? null : Number(it.progress);
      acts.push({ id: newId('wa_'), task_id: t.id, date: today, progress: prog, note, author: email });
      const patch = { last_action: note };
      if (prog !== null) patch.progress = prog;
      if (it.status) Object.assign(patch, statusPatch(t, it.status));
      if (it.urgency) patch.urgency = it.urgency;
      if (REPAIR_SYS[t.system]) patch.action = note;
      patches.push({ id: t.id, patch });
      return;
    }
    const status = it.status || '대기';
    const r = { id: newId('WK_'), ship_code: it.ship || null, system: it.system || '', date: today,
      title: it.title, detail, source, category: it.category || '', requester, due_date: due,
      status, progress: it.progress === '' ? (status === '완료' ? 100 : 0) : Number(it.progress),
      urgency: it.urgency || '', origin: '업무', note: '' };
    if (REPAIR_SYS[r.system]) { r.stage = STAGE_OF[status] || '미확인'; r.symptom = r.title; r.equip = r.category; }
    newRows.push(r);
  });
  try {
    if (newRows.length) { const res = await sb.from('repairs').insert(newRows); if (res.error) throw res.error; }
    if (acts.length) { const res = await sb.from('work_actions').insert(acts); if (res.error) throw res.error; }
    for (const p of patches) { const res = await sb.from('repairs').update(p.patch).eq('id', p.id); if (res.error) throw res.error; }
    // 수리이력과 같은 규칙: BWTS/EGCS 신규건은 Drive 작업폴더를 요청한다
    for (const r of newRows) { if (REPAIR_SYS[r.system]) { try { await requestDriveFolder(r); } catch (e) { console.warn('folder request', e); } } }
    toast(`신규 ${newRows.length}건 · 기록 추가 ${acts.length}건 등록됨`);
    closeBulk();
    await loadData();
  } catch (e) {
    toast('등록 실패: ' + (e.message || e));
    btn.disabled = false; btn.textContent = `일괄 등록 (신규 ${n.neu} · 추가 ${n.upd})`;
  }
}

window.workTab = { filterStatus, toggleActs, edit, setStatus, cycleUrgency, addAct, removeAct, deleteTask };

export default { id: 'work', mount, refresh };
