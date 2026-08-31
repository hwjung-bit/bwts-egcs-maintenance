// 🚢 선박관리 — ship master: info edit, order, hide/restore, add.
import { S, isLoggedIn } from '../core/state.js';
import { sb, dbSave } from '../core/supabase.js';
import { $, esc, toast, inlineEdit } from '../core/dom.js';

let SUB = 'active';   // active | order | hidden

function mount(root) {
  root.innerHTML = '<div class="wrap" id="shipsRoot"></div>';
}

function refresh() {
  const active = S.SHIPS.filter(s => !s.hidden).sort((a, b) => (a.sort_order || 999) - (b.sort_order || 999));
  const hidden = S.SHIPS.filter(s => s.hidden);
  const tab = (id, label) => `<div class="tab${SUB === id ? ' active' : ''}" onclick="shipsTab.sub('${id}')">${label}</div>`;
  const tabs = '<div style="display:flex;gap:4px;margin-bottom:12px">' +
    tab('active', `선박 정보 (${active.length})`) + tab('order', '순서 설정') + tab('hidden', `숨김 (${hidden.length})`) + '</div>';
  const head = (extra) =>
    '<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px"><h3 style="margin:0">선박 관리</h3>' +
    (extra || '') + '<div style="flex:1"></div>' +
    (SUB !== 'order' ? '<button class="login-btn" onclick="shipsTab.add()" style="font-size:12px;padding:5px 12px">+ 선박 추가</button>' : '') +
    '</div>';

  if (SUB === 'order') {
    const rows = active.map((s, idx) => '<tr>' +
      `<td style="width:60px;text-align:center"><input type="number" min="1" value="${idx + 1}" data-ship-order="${esc(s.code)}" style="width:50px;text-align:center;padding:4px;border:1px solid #d1d5db;border-radius:4px;font-size:13px"></td>` +
      `<td><b>${esc(s.code)}</b></td><td style="color:#64748b;font-size:12px">${esc(s.name || '')}</td></tr>`).join('');
    $('shipsRoot').innerHTML = head() + tabs +
      '<div style="margin-bottom:12px;display:flex;align-items:center;gap:12px">' +
        '<span style="font-size:12px;color:#64748b">순번을 수정한 후 [순서 저장] 클릭</span>' +
        '<button class="login-btn" onclick="shipsTab.saveOrder()" style="font-size:13px;padding:6px 20px">순서 저장</button></div>' +
      '<table style="width:auto"><thead><tr><th style="width:60px">순번</th><th style="width:60px">코드</th><th style="width:180px">선명</th></tr></thead><tbody>' + rows + '</tbody></table>';
    return;
  }
  const list = SUB === 'active' ? active : hidden;
  const rows = list.map((s, idx) => {
    const c = esc(s.code);
    const cell = f => `<td class="edit-cell" onclick="shipsTab.edit('${c}','${f}',this)">${esc(s[f] || '')}</td>`;
    return '<tr>' +
      `<td style="text-align:center;color:#94a3b8;font-size:11px">${idx + 1}</td>` +
      `<td title="코드는 기본키 — mail_log·repairs·calibrations 가 참조하므로 수정 불가"><b>${c}</b></td>` +
      cell('name') + cell('teu') + cell('bwts_maker') + cell('egcs_maker') + cell('wms') + cell('cems') +
      `<td style="text-align:center"><button onclick="shipsTab.toggleHidden('${c}')" style="background:none;border:none;cursor:pointer;font-size:14px" title="${s.hidden ? '복원' : '숨김'}">${s.hidden ? '👁️' : '🙈'}</button></td></tr>`;
  }).join('');
  $('shipsRoot').innerHTML = head('<span style="font-size:12px;color:#64748b">셀 클릭 수정</span>') + tabs +
    '<table><thead><tr><th style="width:40px">#</th><th style="width:50px">코드</th><th style="width:150px">선명</th><th style="width:80px">TEU</th>' +
    '<th style="width:80px">BWTS</th><th style="width:80px">EGCS</th><th style="width:70px">WMS</th><th style="width:70px">CEMS</th><th style="width:40px"></th></tr></thead><tbody>' + rows + '</tbody></table>';
}

function sub(id) { SUB = id; refresh(); }

async function saveOrder() {
  if (!isLoggedIn()) { toast('로그인 필요 — 순서 저장 불가'); return; }
  const items = [];
  document.querySelectorAll('[data-ship-order]').forEach(inp => {
    const v = parseInt(inp.value);
    items.push({ code: inp.dataset.shipOrder, num: isNaN(v) ? 999 : v });
  });
  items.sort((a, b) => a.num - b.num);
  let failCount = 0;
  for (let i = 0; i < items.length; i++) {
    const s = S.SHIPS.find(x => x.code === items[i].code);
    if (s) s.sort_order = i + 1;
    const res = await sb.from('ships').update({ sort_order: i + 1 }).eq('code', items[i].code);
    if (res.error) failCount++;
  }
  toast(failCount ? '저장 실패 ' + failCount + '건 — sql/017 실행·권한 확인' : '순서 저장 완료 (' + items.length + '척)');
  refresh();
}

function edit(code, field, el) {
  const s = S.SHIPS.find(x => x.code === code);
  if (!s) return;
  inlineEdit(el, s[field] || '', v => {
    s[field] = v; el.textContent = v || '';
    const patch = {}; patch[field] = v;
    dbSave(sb.from('ships').update(patch).eq('code', code), code + ' 저장됨');
  });
}

async function toggleHidden(code) {
  const s = S.SHIPS.find(x => x.code === code);
  if (!s) return;
  const newVal = !s.hidden;
  const ok = await dbSave(sb.from('ships').update({ hidden: newVal }).eq('code', code), code + (newVal ? ' 숨김' : ' 복원'));
  if (!ok) return;
  s.hidden = newVal;
  refresh();
}

async function add() {
  let code = prompt('선박 코드 (예: KXX):');
  if (!code) return;
  code = code.toUpperCase().trim();
  if (S.SHIPS.some(s => s.code === code)) { toast('이미 존재하는 코드'); return; }
  const name = prompt('선명 (예: KMTC NEW VESSEL):') || '';
  const maxOrder = S.SHIPS.reduce((m, s) => Math.max(m, s.sort_order || 0), 0);
  const newShip = { code, name: name.trim(), teu: '', bwts_maker: '', egcs_maker: '', wms: '', cems: '', hidden: false, sort_order: maxOrder + 1 };
  const ok = await dbSave(sb.from('ships').insert(newShip).select(), code + ' 추가됨');
  if (!ok) return;
  S.SHIPS.push(newShip);
  refresh();
}

window.shipsTab = { sub, saveOrder, edit, toggleHidden, add };

export default { id: 'ships', mount, refresh };
