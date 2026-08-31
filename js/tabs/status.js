// 📊 현황 — ship × (BWTS / EGCS WMS / CEMS / BODY) status matrix with memos.
// Column naming rule (sql/016): <계통>_status ↔ <계통>_memo
import { S } from '../core/state.js';
import { sb, dbSave } from '../core/supabase.js';
import { $, esc, toast, inlineEdit } from '../core/dom.js';
import { STATUS_OPTS } from '../shared/constants.js';
import { getShipOrder } from '../shared/ships.js';

function stColor(st) {
  if (st === '정상') return 'background:#d1fae5;color:#065f46';
  if (st === '수리중') return 'background:#fff7ed;color:#c2410c';
  if (st === '문제') return 'background:#fce7f3;color:#be185d';
  return 'background:#f8fafc;color:#cbd5e1';
}

function stCell(code, field, val, memo, disabled) {
  if (disabled) return '<td style="padding:4px 6px;background:#f8fafc;color:#cbd5e1;text-align:center;font-size:11px">—</td>';
  const opts = STATUS_OPTS.map(s => `<option value="${s}"${val === s ? ' selected' : ''}>${s}</option>`).join('');
  const memoField = field.replace('_status', '') + '_memo';
  const memoHtml = `<span class="note-text" onclick="statusTab.editMemo(this,'${esc(code)}','${memoField}')" style="font-size:10px;color:#64748b;cursor:pointer;margin-left:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0">${esc(memo || '')}</span>`;
  return `<td style="padding:2px 4px;${stColor(val)};overflow:hidden">` +
    '<div style="display:flex;align-items:center;gap:2px">' +
    `<select class="status-select" style="${stColor(val)};padding:1px 14px 1px 4px;font-size:11px;font-weight:600;flex-shrink:0" onchange="statusTab.update('${esc(code)}','${field}',this.value)">${opts}</select>` +
    memoHtml + '</div></td>';
}

function mount(root) {
  root.innerHTML = '<div class="wrap" id="statusRoot"></div>';
}

function refresh() {
  if (!S.SHIPS.length) {
    $('statusRoot').innerHTML = '<div class="loading">선박 데이터 없음</div>';
    return;
  }
  const order = getShipOrder();
  const ships = S.SHIPS.filter(s => !s.hidden).sort((a, b) => {
    const ia = order.indexOf(a.code), ib = order.indexOf(b.code);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  let okCnt = 0, repairCnt = 0, issueCnt = 0;
  ships.forEach(s => {
    const fields = [s.bwts_status, s.egcs_wms_status, s.egcs_cems_status, s.egcs_body_status].filter(f => f && f !== '-');
    if (fields.some(f => f === '문제')) issueCnt++;
    else if (fields.some(f => f === '수리중')) repairCnt++;
    else okCnt++;
  });
  const rows = ships.map(s => {
    const hasEgcs = !!(s.egcs_maker);
    return '<tr>' +
      `<td><b>${esc(s.code)}</b></td>` +
      stCell(s.code, 'bwts_status', s.bwts_status || '정상', s.bwts_memo) +
      stCell(s.code, 'egcs_wms_status', s.egcs_wms_status || '정상', s.egcs_wms_memo, !hasEgcs) +
      stCell(s.code, 'egcs_cems_status', s.egcs_cems_status || '정상', s.egcs_cems_memo, !hasEgcs) +
      stCell(s.code, 'egcs_body_status', s.egcs_body_status || '정상', s.egcs_body_memo, !hasEgcs) +
      '</tr>';
  }).join('');
  $('statusRoot').innerHTML =
    '<div style="margin-bottom:16px"><h3 style="margin:0 0 12px">BWTS · EGCS 현황</h3>' +
    '<div class="stats" style="padding:0;margin-bottom:16px">' +
      `<div class="card"><div class="num">${ships.length}</div><div class="label">전체</div></div>` +
      `<div class="card green"><div class="num">${okCnt}</div><div class="label">정상</div></div>` +
      `<div class="card amber"><div class="num">${repairCnt}</div><div class="label">수리중</div></div>` +
      `<div class="card rose"><div class="num">${issueCnt}</div><div class="label">문제</div></div>` +
    '</div></div>' +
    '<table style="table-layout:fixed;width:100%"><thead><tr>' +
      '<th style="width:36px">코드</th><th style="width:24%">BWTS</th><th style="width:24%">EGCS WMS</th>' +
      '<th style="width:24%">EGCS CEMS</th><th style="width:24%">EGCS BODY</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table>';
}

async function update(code, field, val) {
  const s = S.SHIPS.find(x => x.code === code);
  if (s) s[field] = val;
  const patch = {}; patch[field] = val;
  const ok = await dbSave(sb.from('ships').update(patch).eq('code', code), code + ' ' + val);
  if (ok) refresh();
}

function editMemo(el, code, field) {
  const s = S.SHIPS.find(x => x.code === code);
  if (!s) return;
  inlineEdit(el, s[field] || '', v => {
    s[field] = v;
    el.textContent = v;
    const patch = {}; patch[field] = v;
    dbSave(sb.from('ships').update(patch).eq('code', code), '메모 저장');
  }, { hide: true, placeholder: '메모...', css: 'width:90px;font-size:10px;padding:2px 4px;border:1px solid #3b82f6;border-radius:3px;outline:none' });
}

window.statusTab = { update, editMemo };

export default { id: 'status', mount, refresh };
