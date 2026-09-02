// 📊 현황 — ship × (BWTS / EGCS WMS / CEMS / BODY) status matrix with memos.
// Column naming rule (sql/016): <계통>_status ↔ <계통>_memo
import { S } from '../core/state.js';
import { sb, dbSave } from '../core/supabase.js';
import { $, esc, toast, inlineEdit, placePopup } from '../core/dom.js';
import { STATUS_OPTS } from '../shared/constants.js';
import { getShipOrder } from '../shared/ships.js';

/* History snapshots merge into the last row when it is younger than this,
   so a save followed by quick corrections stays one history entry. */
const MERGE_MS = 5 * 60 * 1000;

function kst(ts) {
  return new Date(ts).toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul', year: '2-digit', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

/* Snapshot current status+memo of one system into status_history.
   Fire-and-forget: a missing table must not break the status save itself. */
async function logHistory(code, sys) {
  const s = S.SHIPS.find(x => x.code === code);
  if (!s) return;
  const row = {
    status: s[sys + '_status'] || '정상',
    memo: s[sys + '_memo'] || '',
    changed_by: (S.USER && S.USER.email) || null,
    updated_at: new Date().toISOString(),
  };
  try {
    const last = await sb.from('status_history').select('id,updated_at')
      .eq('ship_code', code).eq('system', sys)
      .order('id', { ascending: false }).limit(1);
    if (last.error) throw last.error;
    const l = last.data && last.data[0];
    if (l && Date.now() - new Date(l.updated_at).getTime() < MERGE_MS) {
      await sb.from('status_history').update(row).eq('id', l.id);
    } else {
      await sb.from('status_history').insert({ ship_code: code, system: sys, ...row });
    }
  } catch (e) {
    toast(/status_history/.test(e.message || '') || e.code === '42P01'
      ? '이력 테이블 없음 — sql/022 실행 필요' : '이력 저장 실패: ' + (e.message || e));
  }
}

async function history(code, sys, ev) {
  ev.stopPropagation();
  const pop = $('calEdit');
  pop.innerHTML = '<div class="loading">이력 로딩...</div>';
  placePopup(pop, ev, 320);
  const res = await sb.from('status_history').select('*')
    .eq('ship_code', code).eq('system', sys)
    .order('id', { ascending: false }).limit(30);
  if (res.error) {
    pop.innerHTML = `<div style="font-size:12px;color:#be185d">이력 조회 실패 — sql/022 실행 필요<br><code style="font-size:10px">${esc(res.error.message)}</code></div>` +
      '<button style="margin-top:8px" onclick="statusTab.closeHistory()">닫기</button>';
    return;
  }
  const rows = (res.data || []).map(h =>
    `<tr><td style="white-space:nowrap;color:#64748b">${kst(h.updated_at)}</td>` +
    `<td style="text-align:center;font-weight:700">${esc(h.status || '')}</td>` +
    `<td>${esc(h.memo || '')}</td></tr>`).join('');
  pop.innerHTML =
    `<div style="font-weight:700;font-size:12px;margin-bottom:8px;color:#1e293b">${esc(code)} · ${esc(sys.toUpperCase())} 이력</div>` +
    (rows
      ? `<div style="max-height:280px;overflow-y:auto"><table class="cal-table" style="font-size:11px"><thead><tr><th>저장일시</th><th>상태</th><th>메모</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<div style="font-size:12px;color:#94a3b8">이력 없음 — 다음 저장부터 쌓입니다</div>') +
    '<div style="margin-top:8px;display:flex;justify-content:space-between;align-items:center">' +
    '<span style="font-size:10px;color:#94a3b8">5분 내 재수정은 한 건으로 합쳐짐 · 한국시간</span>' +
    '<button onclick="statusTab.closeHistory()">닫기</button></div>';
  placePopup(pop, ev, 320);
}
function closeHistory() { $('calEdit').style.display = 'none'; }

function stColor(st) {
  if (st === '정상') return 'background:#d1fae5;color:#065f46';
  if (st === '수리중') return 'background:#fff7ed;color:#c2410c';
  if (st === '문제') return 'background:#fce7f3;color:#be185d';
  return 'background:#f8fafc;color:#cbd5e1';
}

function stCell(code, field, val, memo, disabled) {
  if (disabled) return '<td style="padding:4px 6px;background:#f8fafc;color:#cbd5e1;text-align:center;font-size:11px">—</td>';
  const opts = STATUS_OPTS.map(s => `<option value="${s}"${val === s ? ' selected' : ''}>${s}</option>`).join('');
  const sys = field.replace('_status', '');
  const memoField = sys + '_memo';
  const memoHtml = `<span class="note-text" onclick="statusTab.editMemo(this,'${esc(code)}','${memoField}')" style="font-size:10px;color:#64748b;cursor:pointer;margin-left:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0">${esc(memo || '')}</span>`;
  const histBtn = `<span onclick="statusTab.history('${esc(code)}','${sys}',event)" title="이전 이력 보기" style="cursor:pointer;font-size:10px;flex-shrink:0;opacity:.55">🕘</span>`;
  return `<td style="padding:2px 4px;${stColor(val)};overflow:hidden">` +
    '<div style="display:flex;align-items:center;gap:2px">' +
    `<select class="status-select" style="${stColor(val)};padding:1px 14px 1px 4px;font-size:11px;font-weight:600;flex-shrink:0" onchange="statusTab.update('${esc(code)}','${field}',this.value)">${opts}</select>` +
    memoHtml + histBtn + '</div></td>';
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
  if (ok) { logHistory(code, field.replace('_status', '')); refresh(); }
}

function editMemo(el, code, field) {
  const s = S.SHIPS.find(x => x.code === code);
  if (!s) return;
  inlineEdit(el, s[field] || '', async v => {
    s[field] = v;
    el.textContent = v;
    const patch = {}; patch[field] = v;
    const ok = await dbSave(sb.from('ships').update(patch).eq('code', code), '메모 저장');
    if (ok) logHistory(code, field.replace('_memo', ''));
  }, { hide: true, placeholder: '메모...', css: 'width:90px;font-size:10px;padding:2px 4px;border:1px solid #3b82f6;border-radius:3px;outline:none' });
}

window.statusTab = { update, editMemo, history, closeHistory };

export default { id: 'status', mount, refresh };
