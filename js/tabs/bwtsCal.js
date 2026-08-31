// BWTS 검교정 — TRO sensor calibration, 12-month cycle (thresholds.json).
import { S } from '../core/state.js';
import { sb, dbSave } from '../core/supabase.js';
import { $, esc, fmtDate, inlineEdit } from '../core/dom.js';
import { requireTH } from '../shared/thresholds.js';
import { daysUntil, addMonths, dLabel } from '../shared/dates.js';
import { getShipOrder, shipByCode } from '../shared/ships.js';

const SORT = { key: 'status', dir: 1 };   // key: ship|maker|status
const CERT_FOLDER = 'https://drive.google.com/drive/folders/18RwNxrsoGR4qGu1MKcHMeRFlFsCLAooA';

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
  root.innerHTML = '<div class="wrap" id="bwtsCalRoot"></div>';
}

function toggleSort(key) {
  if (SORT.key === key) SORT.dir *= -1; else { SORT.key = key; SORT.dir = 1; }
  refresh();
}

function refresh() {
  const th = requireTH('bwts_calibration');
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
      `<td><b>${esc(c.ship_code)}</b>${shipName ? `<div style="font-size:10px;color:#94a3b8">${esc(shipName)}</div>` : ''}</td>` +
      `<td style="font-size:11px;color:#64748b">${esc(makerTxt)}</td>` +
      `<td class="edit-cell" onclick="bwtsCalTab.editDate('${eid}',this)" title="클릭하여 수정" style="cursor:pointer;font-weight:600">${esc(c.last_date || '—')}</td>` +
      `<td>${fmtDate(due)}</td>` +
      `<td style="padding:4px 10px"><span class="pill lv-${lv}" style="margin-right:6px">${label}</span>` +
        (days != null ? `<span style="color:#64748b;font-size:11px">${dLabel(days)}</span>` : '') + '</td>' +
      '<td style="white-space:nowrap">' +
        (/^https?:/.test(c.cert_url || '')
          ? `<a href="${esc(c.cert_url)}" target="_blank" style="text-decoration:none;border:1px solid #c7d2fe;border-radius:6px;padding:3px 8px;font-size:11px;color:#4f46e5;cursor:pointer">📄 CERT</a>`
          : '<span style="font-size:11px;color:#cbd5e1">링크없음</span>') +
        `<button onclick="bwtsCalTab.editCertUrl('${eid}')" style="background:none;border:none;cursor:pointer;font-size:11px;color:#94a3b8;margin-left:4px" title="Drive URL 지정/변경">🔗</button>` +
      '</td>' +
      `<td><span style="font-size:11px;color:#94a3b8" class="edit-cell" onclick="bwtsCalTab.editNote('${eid}',this)" title="클릭하여 비고 수정">${esc(c.note || '')}</span></td></tr>`;
  }).join('');
  const arrow = k => SORT.key === k ? (SORT.dir > 0 ? ' ▲' : ' ▼') : '';
  $('bwtsCalRoot').innerHTML =
    '<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap">' +
      `<div style="font-size:12px;color:#64748b">검교정 주기 ${th.interval_months}개월 · 임박 ${th.soon_days}일 · 날짜 클릭하여 수정</div>` +
      `<a href="${CERT_FOLDER}" target="_blank" style="text-decoration:none;background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:5px 14px;font-size:12px;font-weight:600;color:#15803d;margin-left:8px" title="Google Drive CERT 폴더 열기">📁 CERT 폴더</a>` +
      '<div style="margin-left:auto;display:flex;gap:6px">' +
        `<span class="pill lv-expired" style="font-size:11px;padding:3px 8px">만료 ${expCnt}</span>` +
        `<span class="pill lv-soon" style="font-size:11px;padding:3px 8px">임박 ${soonCnt}</span>` +
        `<span class="pill lv-ok" style="font-size:11px;padding:3px 8px">정상 ${okCnt}</span>` +
      '</div></div>' +
    '<table class="cal-table"><thead><tr>' +
      `<th style="cursor:pointer" onclick="bwtsCalTab.sort('ship')">선박${arrow('ship')}</th>` +
      `<th style="cursor:pointer" onclick="bwtsCalTab.sort('maker')">메이커${arrow('maker')}</th>` +
      '<th>최근 검교정</th><th>다음 만료</th>' +
      `<th style="cursor:pointer" onclick="bwtsCalTab.sort('status')">상태${arrow('status')}</th>` +
      '<th>CERT</th><th>비고</th>' +
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

function editCertUrl(id) {
  const c = find(id); if (!c) return;
  let val = prompt(c.ship_code + ' CERT 링크 지정 — Drive 파일 우클릭 > 링크복사 > 붙여넣기 (비우면 삭제)', c.cert_url || '');
  if (val === null) return;
  val = val.trim();
  c.cert_url = val || null;
  dbSave(sb.from('calibrations').update({ cert_url: val || null }).eq('id', c.id), c.ship_code + (val ? ' CERT 링크 저장' : ' CERT 링크 삭제'))
    .then(ok => { if (ok) refresh(); });
}

window.bwtsCalTab = { sort: toggleSort, editDate, editNote, editCertUrl };

export default { id: 'bwtsCal', mount, refresh };
