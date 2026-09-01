// 🔧 수리이력 — repairs table, stage cards, manual entry, Drive folder links.
import { S } from '../core/state.js';
import { sb, dbSave } from '../core/supabase.js';
import { $, esc, toast, todayStr, freezeCell } from '../core/dom.js';
import { STATUS_LIST, STATUS_COLOR, ORIGIN_LIST, ORIGIN_ICON, YEARS } from '../shared/constants.js';
import { getShipOrder, shipByCode, shipOptions } from '../shared/ships.js';
import { findDriveFolder, shipFolderUrl, requestDriveFolder, knownFolderId, repairAtts } from '../shared/drive.js';

const F = { year: '', ship: '', system: '', stage: '', hideDone: true };
try { const v = localStorage.getItem('repairs.hideDone'); if (v !== null) F.hideDone = v === '1'; } catch (e) { /* ignore */ }

function opts(list, cur) {
  return list.map(v => `<option${v === cur ? ' selected' : ''}>${esc(v)}</option>`).join('');
}

function ensureModal() {
  if ($('repairAdd')) return;
  const d = document.createElement('div');
  d.id = 'repairAdd';
  d.innerHTML = `
  <div class="box">
    <h3>🔧 수리이력 직접 등록 <span style="font-weight:400;color:#94a3b8;font-size:11px">— 카톡·전화 등 메일 없이 처리된 건</span></h3>
    <div class="row">
      <label>일자<input id="raDate" type="date"></label>
      <label>선박<select id="raShip"></select></label>
      <label>시스템<select id="raSys"><option>BWTS</option><option>EGCS</option></select></label>
    </div>
    <div class="row">
      <label>접수 경로<select id="raOrigin"></select></label>
      <label>단계<select id="raStage"></select></label>
      <label>장비<input id="raEquip" placeholder="예: TRO 센서"></label>
    </div>
    <label>증상 / 요청 내용<textarea id="raSymptom" placeholder="카톡으로 받은 내용 요약"></textarea></label>
    <label>조치<textarea id="raAction" placeholder="어떻게 클리어됐는지"></textarea></label>
    <div class="btns">
      <button id="raCancel">취소</button>
      <button class="pri" id="raSave">등록</button>
    </div>
  </div>`;
  document.body.appendChild(d);
  d.onclick = e => { if (e.target === d) closeRepairAdd(); };
  $('raCancel').onclick = closeRepairAdd;
  $('raSave').onclick = saveNewRepair;
}

function mount(root) {
  ensureModal();
  root.innerHTML = `
  <div class="stats" id="repairStats"></div>
  <div class="filters" id="repairFilters">
    <select id="rfYear"><option value="">전체 년도</option>${opts(YEARS, F.year)}</select>
    <select id="rfSys"><option value="">전체 시스템</option>${opts(['BWTS', 'EGCS'], F.system)}</select>
    <select id="rfShip"><option value="">전체 선박</option></select>
    <select id="rfStage"><option value="">전체 단계</option>${opts(STATUS_LIST, F.stage)}</select>
    <label style="font-size:12px;color:#64748b;display:flex;align-items:center;gap:4px;cursor:pointer"><input type="checkbox" id="rfHideDone"${F.hideDone ? ' checked' : ''}> 완료 숨기기</label>
    <button class="add-btn" id="raOpen" title="메일 없이 카톡·전화 등으로 처리된 건 등록">➕ 직접 등록</button>
    <span class="count" id="repairCnt"></span>
  </div>
  <div class="wrap" id="repairsRoot"></div>`;
  const bind = (id, key) => { $(id).onchange = e => { F[key] = e.target.value; renderRows(); }; };
  bind('rfYear', 'year'); bind('rfSys', 'system'); bind('rfShip', 'ship'); bind('rfStage', 'stage');
  $('raOpen').onclick = openRepairAdd;
  $('rfHideDone').onchange = e => {
    F.hideDone = e.target.checked;
    try { localStorage.setItem('repairs.hideDone', F.hideDone ? '1' : '0'); } catch (err) { /* ignore */ }
    renderRows();
  };
}

function setParams(p) {
  if (p && 'ship' in p) F.ship = p.ship || '';
}

function refresh() {
  $('rfShip').innerHTML = shipOptions(S.REPAIRS);
  renderRows();
  // pending uploads are a separate small query; render again when it lands
  loadPending().then(renderRows).catch(() => {});
}

function renderRows() {
  const REPAIRS = S.REPAIRS;
  $('rfYear').value = F.year || '';
  $('rfSys').value = F.system;
  $('rfShip').value = F.ship;
  $('rfStage').value = F.stage;

  const filtered = REPAIRS.filter(r => {
    if (F.year && !(r.date || '').startsWith(F.year)) return false;
    if (F.ship && r.ship_code !== F.ship) return false;
    if (F.system && r.system !== F.system) return false;
    if (F.stage && r.stage !== F.stage) return false;
    // 완료 숨기기 — 단계 필터로 '완료'를 직접 고른 경우는 보여준다
    if (F.hideDone && !F.stage && r.stage === '완료') return false;
    return true;
  });
  // 완료만 아래, 나머지는 날짜 최신순
  filtered.sort((a, b) => {
    const da = a.stage === '완료' ? 1 : 0, db = b.stage === '완료' ? 1 : 0;
    if (da !== db) return da - db;
    return String(b.date || '').localeCompare(String(a.date || ''));
  });
  const st = { total: REPAIRS.length, BWTS: 0, EGCS: 0 };
  STATUS_LIST.forEach(s => { st[s] = 0; });
  REPAIRS.forEach(r => {
    if (r.system === 'BWTS') st.BWTS++;
    if (r.system === 'EGCS') st.EGCS++;
    st[r.stage] = (st[r.stage] || 0) + 1;
  });
  const card = (l, n, cls, stage) => {
    const click = stage ? ` onclick="repairsTab.filterStage('${stage}')" style="cursor:pointer"` : '';
    return `<div class="card ${cls}"${click}><div class="num">${n}</div><div class="label">${l}</div></div>`;
  };
  $('repairStats').innerHTML =
    card('전체', st.total, '', '') + card('BWTS', st.BWTS, 'blue', '') + card('EGCS', st.EGCS, 'green', '') +
    STATUS_LIST.map(s => card(s, st[s] || 0, STATUS_COLOR[s], s)).join('');
  const hidden = F.hideDone && !F.stage ? REPAIRS.filter(r => r.stage === '완료').length : 0;
  $('repairCnt').textContent = filtered.length + ' / ' + REPAIRS.length + '건' + (hidden ? ` (완료 ${hidden}건 숨김)` : '');

  if (!REPAIRS.length) {
    $('repairsRoot').innerHTML = '<div class="loading">수리이력 없음</div>';
    return;
  }
  const rows = filtered.map(r => {
    const stOpts = STATUS_LIST.map(s => `<option value="${s}"${r.stage === s ? ' selected' : ''}>${s}</option>`).join('');
    const eid = esc(r.id);
    const org = r.origin && r.origin !== '메일' ? r.origin : '';
    const mailCell = r.email_link
      ? `<a href="${esc(r.email_link)}" target="_blank" style="font-size:11px;text-decoration:none;display:block;max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.email_subject || '메일 열기')}">📧 ${esc((r.email_subject || '').slice(0, 30))}</a>`
      : (org
        ? `<span class="origin-badge" title="메일 없이 ${esc(org)}(으)로 접수된 건">${ORIGIN_ICON[org] || '📝'} ${esc(org)}</span>`
        : '<span class="muted" style="font-size:11px">—</span>');
    const fold = findDriveFolder(r);
    const shipUrl = fold ? '' : shipFolderUrl(r);
    const foldCell = fold
      ? `<a class="fold-link" href="${esc(fold.url)}" target="_blank" title="${esc(fold.name)}">📁 폴더</a>`
      : (shipUrl ? `<a class="fold-link ship" href="${esc(shipUrl)}" target="_blank" title="매칭 폴더 없음 — 선박 폴더 열기">📁 선박</a>` : '');
    const atts = repairAtts(r);
    const attCell = atts.length
      ? `<button class="att-badge" onclick="driveUi.showAtts('${eid}',event)" title="첨부 목록">📄 ${atts.length}</button>` : '';
    return '<tr>' +
      `<td style="white-space:nowrap">${esc(r.date || '—')}</td>` +
      `<td>${esc(r.ship_code)}</td>` +
      `<td><span class="pill pill-${(r.system || '').toLowerCase() === 'bwts' ? 'bwts' : 'egcs'}">${esc(r.system)}</span></td>` +
      `<td class="edit-cell" onclick="repairsTab.editField('${eid}','equip',this)" title="클릭하여 수정">${esc(r.equip || '—')}</td>` +
      `<td style="padding:4px 6px"><select class="status-select st-${esc(r.stage)}" style="padding:3px 18px 3px 6px" onchange="repairsTab.updateField('${eid}','stage',this.value)">${stOpts}</select></td>` +
      `<td>${mailCell}</td>` +
      `<td class="edit-cell" onclick="repairsTab.editField('${eid}','symptom',this)" style="max-width:300px;white-space:pre-wrap;word-break:break-word;cursor:pointer" title="클릭하여 수정">${esc(r.symptom || '—')}</td>` +
      `<td class="edit-cell" onclick="repairsTab.editField('${eid}','action',this)" style="max-width:300px;white-space:pre-wrap;word-break:break-word;cursor:pointer" title="클릭하여 수정">${esc(r.action || '—')}</td>` +
      `<td style="white-space:nowrap">${foldCell}${attCell}` +
        `<button onclick="repairsTab.editFileUrl('${eid}')" style="background:none;border:none;cursor:pointer;font-size:11px;color:#94a3b8" title="Drive 링크 지정/변경">🔗</button>` +
        `<button onclick="repairsTab.openUpload('${eid}')" style="background:none;border:none;cursor:pointer;font-size:12px;color:#2563eb" title="파일 업로드 → Drive 작업폴더 (서비스리포트 등)">⬆</button>` +
        (PENDING[r.id] ? `<span class="up-badge" title="Drive 로 옮기는 중 (5분 내)">⏳${PENDING[r.id]}</span>` : '') +
      '</td>' +
      `<td style="text-align:center"><button onclick="repairsTab.deleteRepair('${eid}')" style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:14px" title="삭제">✕</button></td></tr>`;
  }).join('');
  $('repairsRoot').innerHTML =
    '<table><thead><tr><th style="width:80px">일자</th><th style="width:40px">선박</th><th style="width:50px">시스템</th><th style="width:70px">장비</th><th style="width:100px">단계</th><th style="width:110px">메일</th><th>증상</th><th>조치</th><th style="width:110px">파일</th><th style="width:30px"></th></tr></thead><tbody>' + rows + '</tbody></table>' +
    '<div style="margin-top:8px;color:#94a3b8;font-size:11px">셀 클릭 → 수정 · 📧 → 원본 메일 · 💬 → 메일 없이 접수(카톡 등) · 📁 → Drive 폴더 · 📄 → 첨부 목록 · 🔗 → 선박 폴더 링크 변경</div>';
}

/* ===== handlers ===== */
function filterStage(stage) { F.stage = stage; renderRows(); }

function editField(id, field, el) {
  const r = S.REPAIRS.find(x => x.id === id);
  if (!r) return;
  const cur = r[field] || '';
  const isLong = (field === 'symptom' || field === 'action');
  const unfreeze = freezeCell(el);          // keep the column where it is
  const h = Math.max(isLong ? 60 : 0, el.getBoundingClientRect().height);
  const node = document.createElement(isLong ? 'textarea' : 'input');
  node.value = cur;
  node.style.cssText = isLong
    ? `width:100%;box-sizing:border-box;min-height:${h}px;font-size:12px;padding:4px;border:1px solid #3b82f6;border-radius:4px;outline:none;font-family:inherit;resize:vertical`
    : 'width:100%;box-sizing:border-box;font-size:12px;padding:3px 6px;border:1px solid #3b82f6;border-radius:4px;outline:none';
  el.textContent = ''; el.appendChild(node); node.focus();
  const save = () => { node.onblur = null; const v = node.value.trim(); r[field] = v; el.textContent = v || '—'; unfreeze(); updateField(id, field, v); };
  node.onblur = save;
  node.onkeydown = e => {
    if (!isLong && e.key === 'Enter') node.blur();
    if (e.key === 'Escape') { node.onblur = null; el.textContent = cur || '—'; unfreeze(); }
  };
}

function editFileUrl(id) {
  const r = S.REPAIRS.find(x => x.id === id);
  if (!r) return;
  let val = prompt(r.ship_code + ' 파일 링크 지정 — Drive 파일 우클릭 > 링크복사 > 붙여넣기 (비우면 삭제)', r.file_url || '');
  if (val === null) return;
  val = val.trim();
  r.file_url = val || null;
  dbSave(sb.from('repairs').update({ file_url: val || null }).eq('id', id),
    r.ship_code + (val ? ' 파일 링크 저장' : ' 파일 링크 삭제'))
    .then(ok => { if (ok) renderRows(); });
}

async function updateField(id, field, val) {
  const patch = {}; patch[field] = val;
  await dbSave(sb.from('repairs').update(patch).eq('id', id), field + ' 저장됨');
}

async function deleteRepair(id) {
  const r = S.REPAIRS.find(x => x.id === id);
  if (!r) return;
  // Only this row's own job folder — never the ship folder, which 21
  // vessels share, and never a near match belonging to another repair
  const foldId = await knownFolderId(r);
  const fold = foldId ? S.DRIVE_FOLDERS.find(f => f.id === foldId) : null;
  const msg = foldId
    ? '이 수리 기록과 Drive 폴더를 삭제할까요?\n\n' + (fold ? fold.name : foldId) + '\n\n폴더는 휴지통으로 이동합니다 (복구 가능).'
    : '이 수리 기록을 삭제할까요?';
  if (!confirm(msg)) return;
  if (foldId) {
    await dbSave(sb.from('folder_trash_requests').upsert({
      folder_id: foldId, repair_id: id, ship_code: r.ship_code, system: r.system,
      folder_name: fold ? fold.name : '', status: 'pending',
    }, { onConflict: 'folder_id', ignoreDuplicates: true }));
  }
  // 아직 큐에 남은 생성 요청은 지우지 않고 취소로 표시한다 —
  // GAS 가 이미 폴더를 만들고 있으면 행을 지워도 폴더만 남는다
  await dbSave(sb.from('folder_requests').update({ status: 'cancelled' }).eq('repair_id', id));
  const ok = await dbSave(sb.from('repairs').delete().eq('id', id), foldId ? '삭제됨 — 폴더는 휴지통으로' : '삭제됨');
  if (!ok) return;
  S.REPAIRS = S.REPAIRS.filter(x => x.id !== id);
  renderRows();
}

/* ===== Manual entry (메일 없이 처리된 건) ===== */
function openRepairAdd() {
  const order = getShipOrder();
  $('raShip').innerHTML = order.map(c => {
    const s = shipByCode(c);
    const nm = s && s.name ? ' — ' + s.name : '';
    return `<option value="${esc(c)}">${esc(c + nm)}</option>`;
  }).join('');
  $('raOrigin').innerHTML = ORIGIN_LIST.map(o => `<option>${o}</option>`).join('');
  $('raStage').innerHTML = STATUS_LIST.map(st => `<option${st === '완료' ? ' selected' : ''}>${st}</option>`).join('');
  $('raDate').value = todayStr();
  if (F.ship) $('raShip').value = F.ship;
  if (F.system) $('raSys').value = F.system;
  ['raEquip', 'raSymptom', 'raAction'].forEach(id => { $(id).value = ''; });
  $('repairAdd').classList.add('open');
  $('raSymptom').focus();
}
function closeRepairAdd() { $('repairAdd').classList.remove('open'); }

async function saveNewRepair() {
  if (!S.USER) { toast('로그인 후 등록할 수 있습니다'); return; }
  const v = id => $(id).value.trim();
  const symptom = v('raSymptom');
  if (!symptom) { toast('증상/요청 내용을 입력하세요'); return; }
  const origin = v('raOrigin');
  const newR = {
    id: 'MN_' + Date.now(),
    ship_code: v('raShip'), system: v('raSys'), date: v('raDate') || null,
    equip: v('raEquip'), stage: v('raStage'), symptom, action: v('raAction'),
    parts: '', cost: '', attachments: '[]', history: '[]',
    email_subject: '', email_link: '', needs_review: false, source_msg_id: '',
    origin,
  };
  const res = await sb.from('repairs').insert(newR).select();
  if (res.error) {
    const m = res.error.message || '';
    toast(/origin/.test(m) ? 'origin 컬럼 없음 — sql/012_repair_origin.sql 먼저 실행' : '등록 실패: ' + m);
    return;
  }
  S.REPAIRS.unshift(res.data && res.data[0] ? res.data[0] : newR);
  closeRepairAdd();
  refresh();
  toast(newR.ship_code + ' ' + origin + ' 건 등록됨');
  await requestDriveFolder(newR);
}

/* ===== Upload → Drive 작업폴더 (sql/022, GAS processUploadRequests_) =====
   파일은 Supabase Storage 에 잠깐 머물다 GAS 5분 트리거가 선박/시스템/날짜
   폴더로 옮기고 attachments 에 링크를 채운다. 여기서는 큐에 넣기만 한다. */
let PENDING = {};           // repair_id → pending upload count
let uploadTarget = null;

async function loadPending() {
  const res = await sb.from('upload_requests').select('repair_id,status')
    .in('status', ['pending', 'processing']);
  PENDING = {};
  (res.data || []).forEach(x => { PENDING[x.repair_id] = (PENDING[x.repair_id] || 0) + 1; });
}

function ensureUploadModal() {
  if ($('repairUpload')) return;
  const d = document.createElement('div');
  d.id = 'repairUpload';
  d.innerHTML = `
  <div class="box">
    <h3>⬆ 파일 업로드 <span id="ruTitle" style="font-weight:400;color:#94a3b8;font-size:11px"></span></h3>
    <label>파일 (여러 개 가능, 50MB 이하)<input id="ruFiles" type="file" multiple></label>
    <div class="up-list" id="ruList"></div>
    <label>조치 내용 / 메모 (선택 — 수리이력 '조치'에 날짜와 함께 추가됨)<textarea id="ruNote" placeholder="예: 테크로스 방선 점검 완료, TRO 센서 교체. 서비스리포트 첨부"></textarea></label>
    <div style="font-size:11px;color:#94a3b8">저장 위치: Drive › 시스템 › 선박 › "날짜 제목" 작업폴더 (없으면 자동 생성). 5분 내 📄 첨부 목록에 링크가 생깁니다.</div>
    <div class="btns">
      <button id="ruCancel">취소</button>
      <button class="pri" id="ruSave">업로드</button>
    </div>
  </div>`;
  document.body.appendChild(d);
  d.onclick = e => { if (e.target === d) closeUpload(); };
  $('ruCancel').onclick = closeUpload;
  $('ruSave').onclick = submitUpload;
  $('ruFiles').onchange = () => {
    const fs = [...$('ruFiles').files];
    $('ruList').innerHTML = fs.map(f => `• ${esc(f.name)} (${(f.size / 1024).toFixed(0)}KB)`).join('<br>');
  };
}

function openUpload(id) {
  const r = S.REPAIRS.find(x => x.id === id);
  if (!r) return;
  ensureUploadModal();
  uploadTarget = r;
  $('ruTitle').textContent = `— ${r.ship_code} ${r.system} ${r.date || ''} ${(r.symptom || r.email_subject || '').slice(0, 40)}`;
  $('ruFiles').value = ''; $('ruList').innerHTML = ''; $('ruNote').value = '';
  $('repairUpload').classList.add('open');
}
function closeUpload() { $('repairUpload').classList.remove('open'); uploadTarget = null; }

async function submitUpload() {
  const r = uploadTarget;
  if (!r) return;
  const files = [...$('ruFiles').files];
  const note = $('ruNote').value.trim();
  if (!files.length && !note) { toast('파일 또는 메모를 입력하세요'); return; }
  if (files.some(f => f.size > 50 * 1024 * 1024)) { toast('50MB 초과 파일이 있습니다'); return; }
  $('ruSave').disabled = true; $('ruSave').textContent = '업로드 중...';
  const who = S.USER && S.USER.email;
  let okCount = 0;
  try {
    for (const f of files) {
      const safe = f.name.replace(/[\\/:*?"<>|]+/g, '_');
      const path = `${r.id}/${Date.now()}_${safe}`;
      const up = await sb.storage.from('repair_uploads').upload(path, f, { upsert: false, contentType: f.type || 'application/octet-stream' });
      if (up.error) { toast(`업로드 실패 (${f.name}): ${up.error.message}`); continue; }
      const ins = await sb.from('upload_requests').insert({
        repair_id: r.id, ship_code: r.ship_code, system: r.system, req_date: r.date || null,
        title: r.symptom || r.email_subject || '', object_path: path, file_name: safe, file_size: f.size,
        user_note: note || null, requested_by: who, status: 'pending',
      });
      if (ins.error) { toast(`큐 등록 실패 (${f.name}): ${ins.error.message}`); continue; }
      okCount++;
      // 프론트 목록에도 이름을 미리 넣어 둔다 — GAS 가 url 만 채운다
      const atts = repairAtts(r);
      if (!atts.some(a => a.name === safe)) {
        atts.push({ name: safe });
        r.attachments = JSON.stringify(atts);
        await sb.from('repairs').update({ attachments: r.attachments }).eq('id', r.id);
      }
    }
    if (note) {
      const stamp = todayStr();
      const action = (r.action ? r.action + '\n' : '') + `[${stamp}] ${note}`;
      let hist = [];
      try { hist = JSON.parse(r.history || '[]'); } catch (e) { hist = []; }
      if (!Array.isArray(hist)) hist = [];
      hist.push({ date: stamp, by: who, note, files: files.map(f => f.name) });
      const ok = await dbSave(sb.from('repairs').update({ action, history: JSON.stringify(hist) }).eq('id', r.id));
      if (ok) { r.action = action; r.history = JSON.stringify(hist); }
    }
    toast(okCount ? `${okCount}개 파일 업로드 — 5분 내 Drive 작업폴더로 이동` : (note ? '메모 저장됨' : '업로드된 파일 없음'));
    closeUpload();
    await loadPending();
    renderRows();
  } finally {
    $('ruSave').disabled = false; $('ruSave').textContent = '업로드';
  }
}

window.repairsTab = { filterStage, editField, editFileUrl, updateField, deleteRepair, openUpload };

export default { id: 'repairs', mount, refresh, setParams };
