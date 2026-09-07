// 📊 현황 — ship × (BWTS / EGCS WMS / CEMS / BODY) status matrix with memos.
// Column naming rule (sql/016): <계통>_status ↔ <계통>_memo
import { S } from '../core/state.js';
import { sb, dbSave } from '../core/supabase.js';
import { $, esc, toast, placePopup } from '../core/dom.js';
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

/* Snapshot one system's status+memo into status_history. `over` overrides
   the values written (used for 수리완료, which never lands in ships).
   Fire-and-forget: a missing table must not break the status save itself. */
async function logHistory(code, sys, over) {
  const s = S.SHIPS.find(x => x.code === code);
  if (!s) return;
  const row = {
    status: (over && over.status) || s[sys + '_status'] || '정상',
    memo: over && over.memo != null ? over.memo : (s[sys + '_memo'] || ''),
    changed_by: (S.USER && S.USER.email) || null,
    updated_at: new Date().toISOString(),
  };
  try {
    const last = await sb.from('status_history').select('id,updated_at')
      .eq('ship_code', code).eq('system', sys)
      .order('id', { ascending: false }).limit(1);
    if (last.error) throw last.error;
    const l = last.data && last.data[0];
    if (!(over && over.noMerge) && l && Date.now() - new Date(l.updated_at).getTime() < MERGE_MS) {
      await sb.from('status_history').update(row).eq('id', l.id);
    } else {
      await sb.from('status_history').insert({ ship_code: code, system: sys, ...row });
    }
  } catch (e) {
    toast(/status_history/.test(e.message || '') || e.code === '42P01'
      ? '이력 테이블 없음 — sql/022 실행 필요' : '이력 저장 실패: ' + (e.message || e));
  }
}

/* 이력은 팝업 대신 현황표 아래 전체 폭 패널로 — 잘림·내부 스크롤 없이 전부 표시 */
async function history(code, sys, ev) {
  ev.stopPropagation();
  const box = $('statusHist');
  box.style.display = '';
  box.innerHTML = '<div class="loading"><span class="spin"></span> 이력 로딩...</div>';
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  const res = await sb.from('status_history').select('*')
    .eq('ship_code', code).eq('system', sys)
    .order('id', { ascending: false }).limit(100);
  if (res.error) {
    box.innerHTML = `<div style="font-size:12px;color:#be185d">이력 조회 실패 — sql/023 실행 필요 <code style="font-size:10px">${esc(res.error.message)}</code></div>`;
    return;
  }
  const list = res.data || [];
  // 클리어 = 수리완료 행, 또는 수리중/문제 다음에 정상으로 저장된 행
  const rows = list.map((h, i) => {
    const prev = list[i + 1];
    const cleared = h.status === '수리완료' ||
      (h.status === '정상' && prev && prev.status && prev.status !== '정상' && prev.status !== '수리완료');
    return `<tr><td style="white-space:nowrap;color:#64748b">${kst(h.updated_at)}</td>` +
      `<td style="text-align:center;font-weight:700;white-space:nowrap">${esc(h.status || '')}` +
      (cleared ? ' <span style="color:#059669;font-size:11px;font-weight:700">✅ 클리어</span>' : '') + '</td>' +
      `<td style="white-space:pre-wrap;word-break:break-word">${esc(h.memo || '')}</td></tr>`;
  }).join('');
  box.innerHTML =
    '<div style="display:flex;align-items:center;gap:10px;margin:4px 0 10px">' +
      `<h3 style="margin:0;font-size:14px">🕘 ${esc(code)} · ${esc(sys.toUpperCase())} 이력</h3>` +
      '<span style="font-size:11px;color:#94a3b8">✅ 클리어 = 수리중·문제 → 정상 전환일 · 5분 내 재수정은 한 건으로 합쳐짐 · 한국시간</span>' +
      '<div style="flex:1"></div><button onclick="statusTab.hideHist()">✕ 닫기</button></div>' +
    (rows
      ? `<table class="cal-table" style="width:100%;font-size:13px"><thead><tr><th style="width:150px">저장일시</th><th style="width:110px">상태</th><th>메모</th></tr></thead><tbody>${rows}</tbody></table>`
      : '<div style="font-size:12px;color:#94a3b8">이력 없음 — 다음 저장부터 쌓입니다</div>');
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function hideHist() { const b = $('statusHist'); if (b) { b.style.display = 'none'; b.innerHTML = ''; } }
function closeHistory() { $('calEdit').style.display = 'none'; }

function stColor(st) {
  if (st === '정상') return 'background:#d1fae5;color:#065f46';
  if (st === '수리중') return 'background:#fff7ed;color:#c2410c';
  if (st === '문제') return 'background:#fce7f3;color:#be185d';
  return 'background:#f8fafc;color:#cbd5e1';
}

function stCell(code, field, val, memo, disabled) {
  if (disabled) return '<td style="padding:4px 6px;background:#f8fafc;color:#cbd5e1;text-align:center;font-size:11px">—</td>';
  const sys = field.replace('_status', '');
  const histBtn = `<span onclick="statusTab.history('${esc(code)}','${sys}',event)" title="이전 이력 보기" style="cursor:pointer;font-size:10px;flex-shrink:0;opacity:.55">🕘</span>`;
  return `<td style="padding:2px 4px;${stColor(val)};overflow:hidden;cursor:pointer" onclick="statusTab.editCell('${esc(code)}','${sys}',event)" title="클릭 → 상태·메모 수정">` +
    '<div style="display:flex;align-items:center;gap:4px">' +
    `<span style="font-size:11px;font-weight:700;flex-shrink:0">${esc(val)}</span>` +
    `<span style="font-size:10px;color:#64748b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0" title="${esc(memo || '')}">${esc(memo || '')}</span>` +
    histBtn + '</div></td>';
}

function mount(root) {
  root.innerHTML = '<div class="wrap" id="statusRoot"></div>' +
    '<div class="wrap" id="statusHist" style="display:none"></div>';
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

/* 상태+메모 통합 편집 팝업. 수리완료는 이력에만 남기고 현재값은 정상+메모 삭제. */
function editCell(code, sys, ev) {
  ev.stopPropagation();
  const s = S.SHIPS.find(x => x.code === code);
  if (!s) return;
  const cur = s[sys + '_status'] || '정상';
  const pop = $('calEdit');
  const opts = STATUS_OPTS.map(o => `<option value="${o}"${cur === o ? ' selected' : ''}>${o}</option>`).join('') +
    '<option value="수리완료">✅ 수리완료 (클리어 — 이력에 남고 정상으로 복귀)</option>';
  pop.innerHTML =
    `<div style="font-weight:700;font-size:12px;margin-bottom:8px;color:#1e293b">${esc(code)} · ${esc(sys.toUpperCase())}</div>` +
    `<label>상태<select id="scStatus">${opts}</select></label>` +
    `<label>메모<input id="scMemo" value="${esc(s[sys + '_memo'] || '')}" placeholder="현상/조치 내용"></label>` +
    '<div style="font-size:10px;color:#94a3b8;margin-top:4px">상태와 메모가 함께 저장되고 이력 한 건으로 남습니다</div>' +
    '<div style="display:flex;gap:6px;margin-top:10px">' +
      `<button class="pri" onclick="statusTab.saveCell('${esc(code)}','${esc(sys)}')">저장</button>` +
      '<button onclick="statusTab.closeHistory()">취소</button></div>';
  placePopup(pop, ev, 300);
  $('scMemo').focus();
}

async function saveCell(code, sys) {
  const s = S.SHIPS.find(x => x.code === code);
  if (!s) return;
  const st = $('scStatus').value;
  const memo = $('scMemo').value.trim();
  const patch = {};
  if (st === '수리완료') {
    // 클리어: 이력에 수리완료(+메모)로 기록하고, 현황판은 정상·메모 비움
    await logHistory(code, sys, { status: '수리완료', memo, noMerge: true });
    patch[sys + '_status'] = '정상';
    patch[sys + '_memo'] = '';
    const ok = await dbSave(sb.from('ships').update(patch).eq('code', code), code + ' 수리완료 — 정상 복귀');
    if (!ok) return;
    s[sys + '_status'] = '정상'; s[sys + '_memo'] = '';
  } else {
    patch[sys + '_status'] = st;
    patch[sys + '_memo'] = memo;
    const ok = await dbSave(sb.from('ships').update(patch).eq('code', code), code + ' ' + st + ' 저장');
    if (!ok) return;
    s[sys + '_status'] = st; s[sys + '_memo'] = memo;
    logHistory(code, sys);
  }
  closeHistory();
  refresh();
}

window.statusTab = { editCell, saveCell, history, hideHist, closeHistory };

export default { id: 'status', mount, refresh };
