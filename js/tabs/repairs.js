// 🔧 수리이력 — repairs table, stage cards, manual entry, Drive folder links.
import { S } from '../core/state.js';
import { matchQuery } from '../shared/search.js';
import { sb, dbSave } from '../core/supabase.js';
import { $, esc, toast, todayStr, freezeCell } from '../core/dom.js';
import { STATUS_LIST, STATUS_COLOR, ORIGIN_LIST, ORIGIN_ICON, YEARS } from '../shared/constants.js';
import { getShipOrder, shipByCode, shipOptions } from '../shared/ships.js';
import { findDriveFolder, shipFolderUrl, requestDriveFolder, knownFolderId, repairAtts } from '../shared/drive.js';

const F = { year: '', ship: '', system: '', stage: '', hideDone: true, q: '' };
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
    <input type="text" id="rfSearch" placeholder="🔍 검색 — 띄어쓰기로 겹치기 (예: KMU CEMS)" title="선박·장비·증상·조치·메일제목·부품·단계·날짜 전부 검색. 검색 중엔 완료 건도 보임" value="${esc(F.q)}">
    <label style="font-size:12px;color:#64748b;display:flex;align-items:center;gap:4px;cursor:pointer"><input type="checkbox" id="rfHideDone"${F.hideDone ? ' checked' : ''}> 완료 숨기기</label>
    <button class="add-btn" id="raOpen" title="메일 없이 카톡·전화 등으로 처리된 건 등록">➕ 직접 등록</button>
    <button class="add-btn" id="fileSaveOpen" style="background:#059669;border-color:#059669" title="파일 + 한 줄 정보 → Drive 작업폴더 자동 생성·저장">📥 파일 저장</button>
    <span class="count" id="repairCnt"></span>
  </div>
  <div class="wrap" id="repairsRoot"></div>`;
  const bind = (id, key) => { $(id).onchange = e => { F[key] = e.target.value; renderRows(); }; };
  bind('rfYear', 'year'); bind('rfSys', 'system'); bind('rfShip', 'ship'); bind('rfStage', 'stage');
  $('rfSearch').oninput = e => { F.q = e.target.value; renderRows(); };
  $('raOpen').onclick = openRepairAdd;
  $('fileSaveOpen').onclick = () => openUpload(null);
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
    // 완료 숨기기 — 단계 필터로 '완료'를 직접 고르거나 검색 중이면 보여준다
    if (F.hideDone && !F.stage && !F.q && r.stage === '완료') return false;
    if (F.q && !matchQuery(F.q, r.date, r.ship_code, r.system, r.equip, r.stage, r.origin,
      r.symptom, r.email_subject, r.action, r.parts)) return false;
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
  const hidden = F.hideDone && !F.stage && !F.q ? REPAIRS.filter(r => r.stage === '완료').length : 0;
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
    <h3 id="ruHead">⬆ 파일 업로드 <span id="ruTitle" style="font-weight:400;color:#94a3b8;font-size:11px"></span></h3>
    <div id="ruMeta">
      <div class="row">
        <label>날짜<input id="ruDate" type="date"></label>
        <label>선박<select id="ruShip"></select></label>
        <label>시스템<select id="ruSys"><option>BWTS</option><option>EGCS</option></select></label>
      </div>
      <div class="row">
        <label>장비<input id="ruEquip" placeholder="예: CEMS, TRO 센서, WMS1"></label>
        <label>단계<select id="ruStage"></select></label>
      </div>
      <label>내용 (짧게)<input id="ruDesc" placeholder="예: 방선점검 정상확인"></label>
      <div id="ruPreview" style="font-size:11px;color:#2563eb;margin:-4px 0 8px;min-height:14px"></div>
    </div>
    <div id="ruDrop" class="dropzone">여기에 파일을 <b>드래그</b>하거나 클릭해서 선택 (여러 개 가능, 50MB 이하)<input id="ruFiles" type="file" multiple style="display:none"></div>
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
  const drop = $('ruDrop');
  drop.onclick = e => { if (e.target.id !== 'ruFiles') $('ruFiles').click(); };
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); addFiles([...e.dataTransfer.files]); };
  $('ruFiles').onchange = () => { addFiles([...$('ruFiles').files]); $('ruFiles').value = ''; };
  ['ruDate', 'ruShip', 'ruSys', 'ruEquip', 'ruDesc'].forEach(id => { $(id).oninput = renderPreview; $(id).onchange = renderPreview; });
}

let pickedFiles = [];
function addFiles(list) {
  list.forEach(f => { if (!pickedFiles.some(p => p.name === f.name && p.size === f.size)) pickedFiles.push(f); });
  renderFileList();
}
function removeFile(i) { pickedFiles.splice(i, 1); renderFileList(); }
function renderFileList() {
  $('ruList').innerHTML = pickedFiles.map((f, i) =>
    `• ${esc(f.name)} (${(f.size / 1024).toFixed(0)}KB) <a href="#" onclick="repairsTab.removeFile(${i});return false" style="color:#ef4444;text-decoration:none">✕</a>`).join('<br>');
  renderPreview();
}
const SAFE = /[\\/:*?"<>|]+/g;
const extOf = name => (name.match(/\.[^.]+$/) || [''])[0];
/* 파일명/폴더명 = "YYYY-MM-DD 선박 시스템 장비 내용" */
function baseName() {
  const v = id => ($(id).value || '').trim();
  return [v('ruDate'), v('ruShip'), v('ruSys'), v('ruEquip'), v('ruDesc')].filter(Boolean).join(' ').replace(SAFE, '_');
}
function renderPreview() {
  if (uploadTarget || !$('ruPreview')) return;
  const b = baseName();
  const ext = pickedFiles[0] ? extOf(pickedFiles[0].name) : '';
  $('ruPreview').textContent = b ? `→ 폴더 "${b}" / 파일 "${b}${pickedFiles.length > 1 ? ' (1)' : ''}${ext}"` : '';
}

function openUpload(id) {
  ensureUploadModal();
  pickedFiles = []; $('ruList').innerHTML = ''; $('ruNote').value = ''; $('ruPreview').textContent = '';
  const r = id ? S.REPAIRS.find(x => x.id === id) : null;
  if (id && !r) return;
  uploadTarget = r;
  if (r) {
    // 기존 수리 건에 첨부
    $('ruMeta').style.display = 'none';
    $('ruHead').firstChild.textContent = '⬆ 파일 업로드 ';
    $('ruTitle').textContent = `— ${r.ship_code} ${r.system} ${r.date || ''} ${(r.symptom || r.email_subject || '').slice(0, 40)}`;
  } else {
    // 신규: 정보 한 줄 + 파일 → 폴더·파일명 자동, 수리이력 1건 자동 등록
    $('ruMeta').style.display = '';
    $('ruHead').firstChild.textContent = '📥 파일 저장 ';
    $('ruTitle').textContent = '— 날짜·선박·시스템·장비·내용으로 폴더/파일명 자동 생성';
    $('ruShip').innerHTML = getShipOrder().map(c => { const sh = shipByCode(c); return `<option value="${esc(c)}">${esc(c + (sh && sh.name ? ' — ' + sh.name : ''))}</option>`; }).join('');
    $('ruStage').innerHTML = STATUS_LIST.map(st => `<option${st === '완료' ? ' selected' : ''}>${st}</option>`).join('');
    $('ruDate').value = todayStr(); $('ruEquip').value = ''; $('ruDesc').value = '';
    if (F.ship) $('ruShip').value = F.ship;
    if (F.system) $('ruSys').value = F.system;
  }
  $('repairUpload').classList.add('open');
  if (!r) $('ruEquip').focus();
}
function closeUpload() { $('repairUpload').classList.remove('open'); uploadTarget = null; pickedFiles = []; }

async function submitUpload() {
  const files = pickedFiles.slice();
  const note = $('ruNote').value.trim();
  if (files.some(f => f.size > 50 * 1024 * 1024)) { toast('50MB 초과 파일이 있습니다'); return; }
  const who = S.USER && S.USER.email;
  let r = uploadTarget;
  let base = null;                       // 신규 모드: 파일명/폴더명 공통 앞머리
  if (!r) {
    const v = id => ($(id).value || '').trim();
    if (!v('ruShip') || !v('ruDate')) { toast('날짜·선박은 필수'); return; }
    if (!v('ruEquip') && !v('ruDesc')) { toast('장비 또는 내용을 적어주세요'); return; }
    if (!files.length) { toast('저장할 파일을 드래그하거나 선택하세요'); return; }
    base = baseName();
    const title = [v('ruShip'), v('ruSys'), v('ruEquip'), v('ruDesc')].filter(Boolean).join(' ');
    const rec = {
      id: 'FL_' + Date.now(), ship_code: v('ruShip'), system: v('ruSys'), date: v('ruDate'),
      equip: v('ruEquip'), stage: v('ruStage') || '완료', symptom: title, action: '',
      parts: '', cost: '', attachments: '[]', history: '[]', email_subject: '', email_link: '',
      needs_review: false, source_msg_id: '', origin: '파일',
    };
    const ins = await sb.from('repairs').insert(rec).select();
    if (ins.error) { toast('수리이력 등록 실패: ' + ins.error.message); return; }
    r = ins.data && ins.data[0] ? ins.data[0] : rec;
    S.REPAIRS.unshift(r);
  } else if (!files.length && !note) { toast('파일 또는 메모를 입력하세요'); return; }
  $('ruSave').disabled = true; $('ruSave').textContent = '업로드 중...';
  let okCount = 0;
  try {
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const safe = base
        ? `${base}${files.length > 1 ? ` (${i + 1})` : ''}${extOf(f.name)}`
        : f.name.replace(SAFE, '_');
      // Storage keys must be ASCII — Drive gets the real (Korean) name via file_name
      const path = `${r.id}/${Date.now()}_${i}${extOf(f.name).replace(/[^\w.]/g, '')}`;
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
    toast(okCount ? `${okCount}개 파일 업로드 — 5분 내 Drive "${base || ''}" 폴더로 이동` : (note ? '메모 저장됨' : '업로드된 파일 없음'));
    closeUpload();
    await loadPending();
    refresh();
  } finally {
    $('ruSave').disabled = false; $('ruSave').textContent = '업로드';
  }
}

window.repairsTab = { filterStage, editField, editFileUrl, updateField, deleteRepair, openUpload, removeFile };

export default { id: 'repairs', mount, refresh, setParams };
