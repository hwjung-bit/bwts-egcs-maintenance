// BWTS 검교정 — TRO sensor calibration, 12-month cycle (thresholds.json).
import { S } from '../core/state.js';
import { sb, dbSave } from '../core/supabase.js';
import { $, esc, fmtDate, inlineEdit, toast, todayStr } from '../core/dom.js';
import { requireTH } from '../shared/thresholds.js';
import { daysUntil, addMonths, dLabel } from '../shared/dates.js';
import { getShipOrder, shipByCode, ensureDatalists, normalizeShipCode } from '../shared/ships.js';

const SORT = { key: 'status', dir: 1 };   // key: ship|maker|status
const CERT_FOLDER = 'https://drive.google.com/drive/folders/18RwNxrsoGR4qGu1MKcHMeRFlFsCLAooA';
/* GAS CAL_UPLOAD_DIRS 와 짝: 종류 → (큐 target, 파일명 라벨) */
const KIND = {
  bwts_cal_cert: 'CERT',
  bwts_cal_report: 'SERVICE REPORT',
  bwts_cal_alarm: 'SAFETY ALARM TEST',
};

/* 만료일은 정렬과 표시가 같은 값을 쓰도록 여기서만 센다 */
export function bwtsDue(c) {
  if (!c.last_date) return null;
  return addMonths(c.last_date, requireTH('bwts_calibration').interval_months);
}
export function bwtsLevel(days) {
  const soon = requireTH('bwts_calibration').soon_days;
  if (days == null) return { lv: 'unknown', label: '미상' };
  if (days <= 0) return { lv: 'expired', label: '만료' };
  if (days <= soon) return { lv: 'soon', label: '임박' };
  return { lv: 'ok', label: '정상' };
}

function mount(root) {
  root.innerHTML = '<div class="wrap" id="bwtsCalRoot"></div>' +
    '<div id="bwtsCalUpload"><div class="box">' +
    '<h3>📥 검교정 파일 저장</h3>' +
    '<div class="row">' +
      `<label>날짜 *<input id="cuDate" type="date"></label>` +
      '<label>선박 *<input id="cuShip" list="dlShips" placeholder="입력 또는 선택" maxlength="3" style="text-transform:uppercase" autocomplete="off"></label></div>' +
    '<div id="cuPreview" style="font-size:11px;color:#2563eb;font-weight:600;margin-bottom:8px;min-height:14px"></div>' +
    '<div id="cuDrop" class="dropzone">파일을 여기로 드래그 (또는 클릭하여 선택) — 여러 개 가능, 파일마다 종류 지정' +
      '<input id="cuFiles" type="file" multiple style="display:none"></div>' +
    '<div id="cuList" style="font-size:11px;color:#334155;margin-top:6px"></div>' +
    '<div class="btns">' +
      '<button class="pri" id="cuSave" onclick="bwtsCalTab.submitUpload()">업로드</button>' +
      '<button onclick="bwtsCalTab.closeUpload()">취소</button></div>' +
    '</div></div>';
  const drop = $('cuDrop');
  drop.onclick = () => $('cuFiles').click();
  $('cuFiles').onchange = e => { addFiles(e.target.files); e.target.value = ''; };
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer.files); };
  ['cuDate', 'cuShip'].forEach(id => { $(id).onchange = renderPreview; $(id).oninput = renderPreview; });
}

/* ===== calibration file upload (queue target, no repair row) =====
   한 번에 여러 파일, 파일마다 종류 지정. 같은 날짜·선박이면 나중에 올려도
   GAS getOrCreateChild_ 가 기존 'YYYY-MM-DD SHIP' 폴더를 재사용한다. */
let pickedFiles = [];   // { file, kind }
const extOf = name => (name.match(/\.[^.]+$/) || [''])[0];

/* 파일명에서 종류 추정 — 못 맞히면 CERT */
function guessKind(name) {
  const n = name.toLowerCase();
  if (/alarm|safety|알람/.test(n)) return 'bwts_cal_alarm';
  if (/report|service|레포트|리포트/.test(n)) return 'bwts_cal_report';
  return 'bwts_cal_cert';
}
function renderPreview() {
  const d = $('cuDate').value, s = $('cuShip').value;
  $('cuPreview').textContent = d && s
    ? `CERT 폴더 › ${d.slice(0, 4)}년 › "${d} ${s}" 로 저장 (SERVICE REPORT·SAFETY ALARM TEST 포함) · 파일명 "${d} ${s} BWTS <종류>"` : '';
}
function renderFileList() {
  $('cuList').innerHTML = pickedFiles.map((p, i) =>
    '<div style="display:flex;align-items:center;gap:6px;margin-bottom:3px">' +
    `<select style="width:150px;margin:0;padding:2px 4px;font-size:11px" onchange="bwtsCalTab.setKind(${i},this.value)">` +
      Object.keys(KIND).map(k => `<option value="${k}"${p.kind === k ? ' selected' : ''}>${KIND[k]}</option>`).join('') +
    '</select>' +
    `<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">📎 ${esc(p.file.name)}</span>` +
    `<span style="color:#94a3b8">(${(p.file.size / 1024 / 1024).toFixed(1)}MB)</span>` +
    `<span style="color:#be185d;cursor:pointer" onclick="bwtsCalTab.removeFile(${i})">✕</span></div>`).join('');
}
function addFiles(list) {
  [...list].forEach(f => {
    if (!pickedFiles.some(p => p.file.name === f.name && p.file.size === f.size))
      pickedFiles.push({ file: f, kind: guessKind(f.name) });
  });
  renderFileList();
}
function removeFile(i) { pickedFiles.splice(i, 1); renderFileList(); }
function setKind(i, k) { if (pickedFiles[i]) pickedFiles[i].kind = k; }

function openUpload() {
  if (!S.USER) { toast('로그인 후 사용할 수 있습니다'); return; }
  pickedFiles = [];
  renderFileList();
  ensureDatalists();
  $('cuShip').value = '';
  $('cuDate').value = todayStr();
  renderPreview();
  $('bwtsCalUpload').classList.add('open');
}
function closeUpload() { $('bwtsCalUpload').classList.remove('open'); pickedFiles = []; }

async function submitUpload() {
  const picked = pickedFiles.slice();
  const date = $('cuDate').value;
  const ship = normalizeShipCode($('cuShip').value);
  if (!date || !$('cuShip').value.trim()) { toast('날짜·선박은 필수'); return; }
  if (!ship) { toast('선박 코드 확인: "' + $('cuShip').value + '" — 미등록 코드 (선박관리에서 추가)'); return; }
  $('cuShip').value = ship;
  if (!picked.length) { toast('저장할 파일을 드래그하거나 선택하세요'); return; }
  if (picked.some(p => p.file.size > 50 * 1024 * 1024)) { toast('50MB 초과 파일이 있습니다'); return; }
  $('cuSave').disabled = true; $('cuSave').textContent = '업로드 중...';
  let okCount = 0;
  const kindCount = {}, kindSeq = {};
  picked.forEach(p => { kindCount[p.kind] = (kindCount[p.kind] || 0) + 1; });
  try {
    for (let i = 0; i < picked.length; i++) {
      const { file: f, kind } = picked[i];
      const seq = kindSeq[kind] = (kindSeq[kind] || 0) + 1;
      const name = `${date} ${ship} BWTS ${KIND[kind]}` +
        `${kindCount[kind] > 1 ? ` (${seq})` : ''}${extOf(f.name)}`;
      // Storage keys must be ASCII — Drive gets the real name via file_name
      const path = `cal/${Date.now()}_${i}${extOf(f.name).replace(/[^\w.]/g, '')}`;
      const up = await sb.storage.from('repair_uploads').upload(path, f, { upsert: false, contentType: f.type || 'application/octet-stream' });
      if (up.error) { toast(`업로드 실패 (${f.name}): ${up.error.message}`); continue; }
      const ins = await sb.from('upload_requests').insert({
        repair_id: null, target: kind, ship_code: ship, system: 'BWTS', req_date: date,
        title: `${date} ${ship} BWTS ${KIND[kind]}`, object_path: path, file_name: name,
        file_size: f.size, requested_by: S.USER && S.USER.email, status: 'pending',
      });
      if (ins.error) {
        toast(/target|null value/.test(ins.error.message)
          ? '큐 등록 실패 — sql/024 실행 필요' : `큐 등록 실패: ${ins.error.message}`);
        continue;
      }
      okCount++;
    }
    if (okCount) {
      toast(`${okCount}개 파일 업로드 — 5분 내 Drive CERT › ${date} ${ship} 폴더로 이동`);
      closeUpload();
    }
  } finally {
    $('cuSave').disabled = false; $('cuSave').textContent = '업로드';
  }
}

function toggleSort(key) {
  if (SORT.key === key) SORT.dir *= -1; else { SORT.key = key; SORT.dir = 1; }
  refresh();
}

function refresh() {
  const th = requireTH('bwts_calibration');
  initPick();
  const order = getShipOrder();
  const enriched = S.BWTS_CAL.map(c => {
    const s = shipByCode(c.ship_code);
    const due = bwtsDue(c);
    return { c, maker: s ? (s.bwts_maker || '') : '', days: due ? daysUntil(due) : 9999, shipIdx: order.indexOf(c.ship_code) };
  });
  enriched.sort((a, b) => {
    let v = 0;
    if (SORT.key === 'ship') v = (a.shipIdx < 0 ? 99 : a.shipIdx) - (b.shipIdx < 0 ? 99 : b.shipIdx);
    else if (SORT.key === 'maker') v = a.maker.localeCompare(b.maker);
    else v = a.days - b.days;
    return v * SORT.dir;
  });
  let expCnt = 0, soonCnt = 0, okCnt = 0;
  const rows = enriched.map(({ c }) => {
    const due = bwtsDue(c);
    const days = due ? daysUntil(due) : null;
    const { lv, label } = bwtsLevel(days);
    if (lv === 'expired') expCnt++; else if (lv === 'soon') soonCnt++; else if (lv === 'ok') okCnt++;
    const eid = esc(c.id || c.ship_code);
    const s = shipByCode(c.ship_code);
    const shipName = s ? (s.name || '') : '';
    const makerTxt = s ? (s.bwts_maker || '') : '';
    return '<tr>' +
      `<td style="text-align:center"><input type="checkbox" ${PICK.has(c.ship_code) ? 'checked' : ''} onchange="bwtsCalTab.pick('${esc(c.ship_code)}',this.checked)"></td>` +
      `<td><b>${esc(c.ship_code)}</b>${shipName ? `<div style="font-size:10px;color:#94a3b8">${esc(shipName)}</div>` : ''}</td>` +
      `<td style="font-size:11px;color:#64748b">${esc(makerTxt)}</td>` +
      `<td class="edit-cell" onclick="bwtsCalTab.editDate('${eid}',this)" title="클릭하여 수정" style="cursor:pointer;font-weight:600">${esc(c.last_date || '—')}</td>` +
      `<td>${fmtDate(due)}</td>` +
      `<td style="padding:4px 10px"><span class="pill lv-${lv}" style="margin-right:6px">${label}</span>` +
        (days != null ? `<span style="color:#64748b;font-size:11px">${dLabel(days)}</span>` : '') + '</td>' +
      '<td style="white-space:nowrap">' + docLink(c.cert_url, '📄 CERT') + ' ' +
        docLink(c.report_url, '📋 REPORT') + '</td>' +
      `<td><span style="font-size:11px;color:#94a3b8" class="edit-cell" onclick="bwtsCalTab.editNote('${eid}',this)" title="클릭하여 비고 수정">${esc(c.note || '')}</span></td></tr>`;
  }).join('');
  const arrow = k => SORT.key === k ? (SORT.dir > 0 ? ' ▲' : ' ▼') : '';
  $('bwtsCalRoot').innerHTML =
    '<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap">' +
      `<div style="font-size:12px;color:#64748b">검교정 주기 ${th.interval_months}개월 · 임박 ${th.soon_days}일 · 날짜 클릭하여 수정</div>` +
      `<a href="${CERT_FOLDER}" target="_blank" style="text-decoration:none;background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:5px 14px;font-size:12px;font-weight:600;color:#15803d;margin-left:8px" title="Google Drive CERT 폴더 열기">📁 CERT 폴더</a>` +
      '<button onclick="bwtsCalTab.openUpload()" style="background:#ecfdf5;border:1px solid #6ee7b7;border-radius:8px;padding:5px 14px;font-size:12px;font-weight:600;color:#047857;cursor:pointer" title="CERT·서비스레포트·SAFETY ALARM TEST 파일을 Drive 에 자동 저장">📥 파일 저장</button>' +
      `<button onclick="bwtsCalTab.techcrossMail()" style="background:#eff6ff;border:1px solid #93c5fd;border-radius:8px;padding:5px 12px;font-size:12px;font-weight:600;color:#1d4ed8;cursor:pointer" title="체크한 선박으로 테크로스 검교정 요청 메일 — Gmail 작성창이 열리면 본문에 Ctrl+V">✉ 테크로스 요청 <span id="tcCnt">(${PICK.size}척)</span></button>` +
      '<div style="margin-left:auto;display:flex;gap:6px">' +
        `<span class="pill lv-expired" style="font-size:11px;padding:3px 8px">만료 ${expCnt}</span>` +
        `<span class="pill lv-soon" style="font-size:11px;padding:3px 8px">임박 ${soonCnt}</span>` +
        `<span class="pill lv-ok" style="font-size:11px;padding:3px 8px">정상 ${okCnt}</span>` +
      '</div></div>' +
    '<table class="cal-table"><thead><tr>' +
      '<th style="width:34px;text-align:center"><input type="checkbox" title="전체 선택/해제" onchange="bwtsCalTab.pickAll(this.checked)"></th>' +
      `<th style="cursor:pointer" onclick="bwtsCalTab.sort('ship')">선박${arrow('ship')}</th>` +
      `<th style="cursor:pointer" onclick="bwtsCalTab.sort('maker')">메이커${arrow('maker')}</th>` +
      '<th>최근 검교정</th><th>다음 만료</th>' +
      `<th style="cursor:pointer" onclick="bwtsCalTab.sort('status')">상태${arrow('status')}</th>` +
      '<th>CERT · SERVICE REPORT</th><th>비고</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table>';
}

function find(id) { return S.BWTS_CAL.find(x => (x.id || x.ship_code) === id); }

function editDate(id, el) {
  const c = find(id); if (!c) return;
  inlineEdit(el, c.last_date || '', v => {
    c.last_date = v || null;
    el.textContent = v || '—';
    dbSave(sb.from('calibrations').update({ last_date: v || null }).eq('id', c.id), c.ship_code + ' 검교정일 저장')
      .then(ok => { if (ok) refresh(); });
  }, { type: 'date', css: 'font-size:12px;padding:3px 6px;border:1px solid #3b82f6;border-radius:4px;outline:none', restore: () => { el.textContent = c.last_date || '—'; } });
}

function editNote(id, el) {
  const c = find(id); if (!c) return;
  inlineEdit(el, c.note || '', v => {
    c.note = v; el.textContent = v;
    dbSave(sb.from('calibrations').update({ note: v }).eq('id', c.id), '비고 저장');
  }, { placeholder: '비고...', css: 'width:120px;font-size:11px;padding:2px 4px;border:1px solid #3b82f6;border-radius:4px;outline:none' });
}

// Links are filled by the 📥 파일 저장 queue (GAS syncCalRecord_), not by hand.
function docLink(url, label) {
  return /^https?:/.test(url || '')
    ? `<a href="${esc(url)}" target="_blank" style="text-decoration:none;border:1px solid #c7d2fe;border-radius:6px;padding:3px 8px;font-size:11px;color:#4f46e5;cursor:pointer">${label}</a>`
    : `<span style="font-size:11px;color:#cbd5e1">${label.replace(/^\S+\s/, '')} 없음</span>`;
}

/* ===== 테크로스 검교정 요청 =====
   2026-09-16 사용자가 직접 보낸 메일 양식(주간 리포트 표를 붙여넣은 것) 그대로.
   대상 = 체크한 선박. 처음엔 만료·임박(메이커 테크로스 또는 공란)이 체크돼 있다.
   Gmail 작성 URL 은 HTML 을 못 싣는다 → 요청 문장+표를 HTML 로 클립보드에 넣고
   작성창은 받는 사람·제목만 채워 연다. 사용자는 본문에 Ctrl+V. */
const PICK = new Set();
let pickInit = false;
const isTechcross = code => {
  const m = (shipByCode(code) || {}).bwts_maker || '';
  return !m || /techcross|테크로스/i.test(m);
};
function initPick() {
  if (pickInit || !S.BWTS_CAL.length) return;
  pickInit = true;
  S.BWTS_CAL.forEach(c => {
    const due = bwtsDue(c);
    const lv = bwtsLevel(due ? daysUntil(due) : null).lv;
    if ((lv === 'expired' || lv === 'soon') && isTechcross(c.ship_code)) PICK.add(c.ship_code);
  });
}
function pickCount() { const el = $('tcCnt'); if (el) el.textContent = `(${PICK.size}척)`; }
function pick(code, on) { if (on) PICK.add(code); else PICK.delete(code); pickCount(); }
function pickAll(on) {
  S.BWTS_CAL.forEach(c => { if (on) PICK.add(c.ship_code); else PICK.delete(c.ship_code); });
  refresh();
}

const TC_TO = 'as.managers@techcross.com,david@techcross.com,thduss@lastech.kr,wbjeong@lastech.kr';
const TC_CC = 'etp@ekmtc.com,as@lastech.kr,young1106@techcross.com';
const TC_SUBJECT = '[KMTC SM][ETP] BWTS 검교정 진행 여부 및 예정 여부 확인 요청의 건';
// 작성창엔 Gmail 서명 템플릿(TO/FR·수신/발신·인사·서명)이 자동으로 들어간다 →
// 붙여넣을 건 요청 문장과 표만. '업무에 수고가 많으십니다.' 아래 빈 줄에 Ctrl+V.
const TC_INTRO = [
  'KMTC 호선중 BWTS 검교정 예정되어있는 선박들 확인요청드립니다.',
  '아래 내용 중 진행 예정인 선박만 일정 재확인, 회신 부탁드립니다.',
];
// 주간 리포트 메일(weekly_cal_alert.py) 표 색과 같게
const TC_LV = {
  expired: { bg: '#fef2f2', fg: '#b91c1c', txt: d => `${dLabel(d)}(만료)` },
  soon: { bg: '#fffbeb', fg: '#b45309', txt: d => `${dLabel(d)} 임박` },
  ok: { bg: '#ffffff', fg: '#15803d', txt: d => `${dLabel(d)} 정상` },
  unknown: { bg: '#ffffff', fg: '#64748b', txt: () => '이력 없음' },
};
const TD = 'border:1px solid #e2e8f0;padding:7px 10px';

function techcrossHtml(items, sub) {
  const div = t => `<div>${t ? esc(t) : '<br>'}</div>`;
  const rows = items.map(({ c, due, days, lv }) => {
    const L = TC_LV[lv];
    return `<tr style="background:${L.bg}">` +
      `<td style="${TD};font-weight:600">${esc(c.ship_code)}</td>` +
      `<td style="${TD}">BWTS 연간</td><td style="${TD}">검교정</td>` +
      `<td style="${TD}">${fmtDate(due)}</td>` +
      `<td style="${TD}"><span style="color:${L.fg};font-weight:600">${esc(L.txt(days))}</span></td></tr>`;
  }).join('');
  return '<div style="font-family:\'Malgun Gothic\',sans-serif;color:#222">' +
    TC_INTRO.map(div).join('') + div('') +
    `<h3 style="font-family:'Malgun Gothic',sans-serif;color:#1e40af;margin:0 0 6px;font-size:15px">⚓ BWTS ` +
      `<span style="font-weight:400;font-size:13px;color:#64748b">${sub}</span></h3>` +
    `<table style="color:#1f2426;font-family:'Malgun Gothic',sans-serif;border-collapse:collapse;font-size:12.5px;width:670px">` +
    '<thead><tr style="background:#1e40af;color:#ffffff">' +
      ['선박', '장비', '구분', '만료일', '상태'].map(h => `<th style="${TD};text-align:left">${h}</th>`).join('') +
    '</tr></thead><tbody>' + rows + '</tbody></table>' + div('') +
    '</div>';
}

function techcrossMail() {
  const items = S.BWTS_CAL.filter(c => PICK.has(c.ship_code)).map(c => {
    const due = bwtsDue(c);
    const days = due ? daysUntil(due) : null;
    return { c, due, days, lv: bwtsLevel(days).lv };
  }).sort((a, b) => (a.days ?? 9999) - (b.days ?? 9999));
  if (!items.length) { toast('메일 보낼 선박을 체크해 주세요'); return; }
  const exp = items.filter(x => x.lv === 'expired').length;
  const soon = items.filter(x => x.lv === 'soon').length;
  const sub = `(${items.length}건 · 만료 ${exp} · 임박 ${soon})`;
  const text = [...TC_INTRO, '', `⚓ BWTS ${sub}`, '선박\t장비\t구분\t만료일\t상태',
    ...items.map(({ c, due, days, lv }) =>
      [c.ship_code, 'BWTS 연간', '검교정', fmtDate(due), TC_LV[lv].txt(days)].join('\t')),
    ''].join('\n');

  // 복사는 작성창을 열기 전에 동기로 끝낸다. navigator.clipboard.write 는 비동기라
  // window.open 으로 포커스가 넘어가면 "Document is not focused" 로 조용히 실패했다.
  let ok = false;
  const onCopy = e => {
    e.clipboardData.setData('text/html', techcrossHtml(items, sub));
    e.clipboardData.setData('text/plain', text);
    e.preventDefault();
    ok = true;
  };
  document.addEventListener('copy', onCopy);
  try { document.execCommand('copy'); } finally { document.removeEventListener('copy', onCopy); }
  if (!ok) { toast('클립보드 복사 실패 — 다시 눌러 주세요'); return; }
  const url = 'https://mail.google.com/mail/?view=cm&fs=1'
    + '&to=' + encodeURIComponent(TC_TO)
    + '&cc=' + encodeURIComponent(TC_CC)
    + '&su=' + encodeURIComponent(TC_SUBJECT);
  const w = window.open(url, '_blank');
  toast(w ? `${items.length}척 표 복사됨 — 작성창 '업무에 수고가 많으십니다.' 아래 클릭 후 Ctrl+V`
    : '표 복사됨 — 팝업이 차단됨, 허용 후 다시');
}

window.bwtsCalTab = { sort: toggleSort, editDate, editNote, openUpload, closeUpload, submitUpload, removeFile, setKind, techcrossMail, pick, pickAll };

export default { id: 'bwtsCal', mount, refresh };
