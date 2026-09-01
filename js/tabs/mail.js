// 📧 메일대장 — mail_log list with filters, inline note, status, mail→repair.
import { S, loadData } from '../core/state.js';
import { sb, dbSave } from '../core/supabase.js';
import { $, esc, toast, inlineEdit } from '../core/dom.js';
import { requireTH } from '../shared/thresholds.js';
import { STATUS_LIST, YEARS, MAIL_CATEGORIES, MAIL_SOURCES } from '../shared/constants.js';
import { shipOptions } from '../shared/ships.js';
import { requestDriveFolder } from '../shared/drive.js';
import { go } from '../core/router.js';

// Filter state survives tab switches (module scope)
const F = { year: '', sys: '', src: '', ship: '', status: '', cat: '', q: '' };
// Month groups: collapsed set persists per browser; default = everything but the
// two most recent months folded. A search/filter shows all matching rows expanded.
let COLLAPSED = null;
function loadCollapsed(months) {
  if (COLLAPSED) return;
  try {
    const v = localStorage.getItem('mail.collapsed');
    if (v) { COLLAPSED = new Set(JSON.parse(v)); return; }
  } catch (e) { /* ignore */ }
  COLLAPSED = new Set(months.slice(2));
}
function saveCollapsed() {
  try { localStorage.setItem('mail.collapsed', JSON.stringify([...COLLAPSED])); } catch (e) { /* ignore */ }
}

function opts(list, cur) {
  return list.map(v => `<option${v === cur ? ' selected' : ''}>${esc(v)}</option>`).join('');
}

function mount(root) {
  root.innerHTML = `
  <div class="filters">
    <select id="fYear"><option value="">전체 년도</option>${opts(YEARS, F.year)}</select>
    <select id="fSys"><option value="">전체 시스템</option>${opts(['BWTS', 'EGCS', '기타'], F.sys)}</select>
    <select id="fSrc"><option value="">전체 출처</option>${opts(MAIL_SOURCES, F.src)}</select>
    <select id="fShip"><option value="">전체 선박</option></select>
    <select id="fStatus"><option value="">전체 상태</option>${opts(STATUS_LIST, F.status)}</select>
    <select id="fCat"><option value="">전체 분류</option>${opts(MAIL_CATEGORIES, F.cat)}</select>
    <input type="text" id="search" placeholder="🔍 제목, 선박, 발신자..." value="${esc(F.q)}">
    <button class="refresh-btn" id="mailReload">🔄 새로고침</button>
    <span class="count" id="cnt"></span>
  </div>
  <div class="wrap"><table>
    <thead><tr>
      <th style="width:80px">날짜</th><th style="width:50px">시스템</th><th style="width:50px">출처</th>
      <th style="width:45px">선박</th><th style="width:55px">분류</th><th style="width:70px">키워드</th>
      <th>메일 제목</th><th style="width:120px">발신자</th><th style="width:40px;text-align:center">📎</th>
      <th style="width:90px">상태</th><th style="width:180px">비고</th><th style="width:30px"></th>
    </tr></thead>
    <tbody id="tbody"></tbody>
  </table></div>`;
  const bind = (id, key) => { $(id).onchange = e => { F[key] = e.target.value; renderRows(); }; };
  bind('fYear', 'year'); bind('fSys', 'sys'); bind('fSrc', 'src');
  bind('fShip', 'ship'); bind('fStatus', 'status'); bind('fCat', 'cat');
  $('search').oninput = e => { F.q = e.target.value; renderRows(); };
  $('mailReload').onclick = () => loadData();
}

function refresh() {
  $('fShip').innerHTML = shipOptions(S.MAIL);
  $('fShip').value = F.ship;
  renderRows();
}

function renderRows() {
  const MAIL = S.MAIL;
  const q = F.q.toLowerCase();
  const filtered = MAIL.filter(m => {
    if (F.year && !(m.date || '').startsWith(F.year)) return false;
    if (F.sys && m.system !== F.sys) return false;
    if (F.src && (m.source || '기타') !== F.src) return false;
    if (F.ship && m.ship_code !== F.ship) return false;
    if (F.status && m.status !== F.status) return false;
    if (F.cat && m.category !== F.cat) return false;
    if (q) {
      const txt = ((m.subject || '') + (m.ship_code || '') + (m.sender || '') + (m.keyword || '') +
        (m.note || '') + (m.category || '') + (m.body_preview || '')).toLowerCase();
      if (txt.indexOf(q) < 0) return false;
    }
    return true;
  });
  const now = new Date();
  const mailTH = requireTH('mail');
  const STALE_DAYS = mailTH.stale_days;
  const isStale = m => m.status === '미확인' && m.date &&
    (now - new Date(m.date + 'T00:00:00')) / 86400000 >= STALE_DAYS;

  const rows = filtered.map(m => {
    const sysCls = m.system === 'BWTS' ? 'pill-bwts' : m.system === 'EGCS' ? 'pill-egcs' : 'pill-etc';
    let fromShort = (m.sender || '').replace(/<[^>]+>/g, '').replace(/"/g, '').trim();
    if (fromShort.length > 20) fromShort = fromShort.slice(0, 18) + '…';
    const stale = isStale(m);
    const isRepairCandidate = (m.category === '수리요청');
    const subjText = esc((m.subject || '').slice(0, 55)) + (m.subject && m.subject.length > 55 ? '…' : '');
    // 링크는 http(s) 일 때만 — 데이터에서 온 값이라 javascript: 등은 거른다
    const subjWrap = /^https?:/.test(m.mail_link || '')
      ? `<a href="${esc(m.mail_link)}" target="_blank" title="${esc(m.subject)}">${subjText}</a>`
      : subjText;
    const thread = m.thread_body || [];
    let tipText = '';
    if (thread.length > 1) {
      tipText = thread.slice(0, 5).map(x => {
        const who = (x.f || '').replace(/<[^>]+>/g, '').replace(/"/g, '').trim();
        return '● ' + (x.d || '') + ' · ' + who + '\n' + (x.p || '');
      }).join('\n\n');
      if (thread.length > 5) tipText += '\n\n… 외 ' + (thread.length - 5) + '건';
    } else {
      tipText = m.body_preview || '';
    }
    const subj = tipText
      ? `<span class="preview-tip" data-preview="${esc(tipText)}" onmouseenter="ui.showPreview(event)" onmouseleave="ui.hidePreview()">${subjWrap}</span>`
      : subjWrap;
    const reply = (m.reply_count && m.reply_count > 0) ? `<span class="reply-badge">↩${m.reply_count}</span>` : '';
    const stOpts = STATUS_LIST.map(s => `<option value="${s}"${m.status === s ? ' selected' : ''}>${s}</option>`).join('');
    const eid = esc(m.id);
    const shipClick = m.ship_code ? ` onclick="mailTab.goRepairs('${esc(m.ship_code)}')" style="cursor:pointer" title="수리이력 보기"` : '';
    const catHtml = m.category ? `<span class="cat-badge cat-${esc(m.category)}">${esc(m.category)}</span>` : '';
    const srcVal = m.source || '기타';
    const srcHtml = `<span class="src-badge src-${esc(srcVal)}">${esc(srcVal)}</span>`;
    const dateHtml = (stale ? '<span class="stale-dot"></span>' : '') + esc(m.date || '—');
    const repairBtnCls = isRepairCandidate ? ' class="repair-suggest"' : '';
    return `<tr${stale ? ' class="stale"' : ''}>` +
      `<td style="white-space:nowrap">${dateHtml}</td>` +
      `<td><span class="pill ${sysCls}">${esc(m.system)}</span></td>` +
      `<td>${srcHtml}</td>` +
      `<td${shipClick}><b>${esc(m.ship_code || '—')}</b></td>` +
      `<td>${catHtml}</td>` +
      `<td style="font-size:11px">${esc(m.keyword || '')}</td>` +
      `<td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${subj}${reply}</td>` +
      `<td style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:#64748b" title="${esc(m.sender)}">${esc(fromShort)}</td>` +
      `<td style="text-align:center">${m.attachments ? '📎' : ''}</td>` +
      `<td style="padding:4px 6px"><select class="status-select st-${esc(m.status)}" style="padding:3px 18px 3px 6px" onchange="mailTab.updateStatus('${eid}',this.value)">${stOpts}</select></td>` +
      `<td class="note-cell"><div class="note-text" onclick="mailTab.editNote(this,'${eid}')">${esc(m.note || '')}</div></td>` +
      `<td style="text-align:center;white-space:nowrap">` +
        `<button onclick="mailTab.mailToRepair('${eid}')"${repairBtnCls} style="background:none;border:none;color:#2563eb;cursor:pointer;font-size:13px;margin-right:4px" title="${isRepairCandidate ? '⚡ 수리요청 메일 — 수리이력 전환 추천' : '수리이력으로 복사'}">🔧</button>` +
        `<button onclick="mailTab.deleteMail('${eid}')" style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:14px" title="삭제">✕</button></td>` +
      `</tr>`;
  });
  // ── 월별 그룹 (년-월 내림차순, 접기/펼치기) ──
  const filtering = !!(F.year || F.sys || F.src || F.ship || F.status || F.cat || q);
  const months = [...new Set(filtered.map(m => (m.date || '').slice(0, 7) || '날짜없음'))];
  loadCollapsed(months);
  const rowList = filtered.map((m, i) => ({ ym: (m.date || '').slice(0, 7) || '날짜없음', html: rows[i], stale: isStale(m) }));
  let out = '';
  months.forEach(ym => {
    const grp = rowList.filter(x => x.ym === ym);
    const isCollapsed = !filtering && COLLAPSED.has(ym);
    const staleN = grp.filter(x => x.stale).length;
    out += `<tr class="mail-grp" onclick="mailTab.toggleMonth('${esc(ym)}')"><td colspan="12">` +
      `<span class="mail-grp-arrow">${isCollapsed ? '▶' : '▼'}</span> <b>${esc(ym)}</b> · ${grp.length}건` +
      (staleN ? ` · <span style="color:#b45309">미확인 3일+ ${staleN}</span>` : '') +
      (isCollapsed ? ' <span class="muted" style="font-size:11px">— 클릭하여 펼치기</span>' : '') + '</td></tr>';
    if (!isCollapsed) out += grp.map(x => x.html).join('');
  });
  $('tbody').innerHTML = out || '<tr><td colspan="12" class="loading">데이터 없음</td></tr>';

  const staleCnt = filtered.filter(isStale).length;
  let cntText = filtered.length + ' / ' + MAIL.length + '건';
  if (MAIL.length >= mailTH.load_limit) cntText += ' (최근 ' + mailTH.load_limit + '건만 로드)';
  if (staleCnt > 0) cntText += ' · ⚠️ 미확인 ' + staleCnt + '건 (' + STALE_DAYS + '일+)';
  $('cnt').textContent = cntText;
}

/* ===== handlers (called from row HTML via window.mailTab) ===== */
async function updateStatus(id, newStatus) {
  const item = S.MAIL.find(m => m.id === id);
  if (item) item.status = newStatus;
  await dbSave(sb.from('mail_log').update({ status: newStatus }).eq('id', id), newStatus + ' 저장됨');
}

async function deleteMail(id) {
  if (!confirm('이 메일을 삭제할까요?')) return;
  const ok = await dbSave(sb.from('mail_log').delete().eq('id', id), '삭제됨');
  if (!ok) return;
  S.MAIL = S.MAIL.filter(x => x.id !== id);
  renderRows();
}

function editNote(el, id) {
  const item = S.MAIL.find(m => m.id === id);
  if (!item) return;
  inlineEdit(el, item.note || '', val => {
    item.note = val;
    el.textContent = val;
    dbSave(sb.from('mail_log').update({ note: val }).eq('id', id), '메모 저장됨');
  }, { hide: true, css: 'width:100%;border:1px solid #3b82f6;border-radius:4px;padding:4px 6px;font-size:12px;outline:none;display:block' });
}

async function mailToRepair(mailId) {
  const m = S.MAIL.find(x => x.id === mailId);
  if (!m) return;
  const repairId = 'ML_' + mailId;
  if (S.REPAIRS.some(r => r.id === repairId)) {
    const okDup = await dbSave(sb.from('mail_log').delete().eq('id', mailId), '이미 수리이력에 있음 — 메일 제거');
    if (!okDup) return;
    S.MAIL = S.MAIL.filter(x => x.id !== mailId);
    renderRows();
    return;
  }
  const newR = {
    id: repairId,
    ship_code: m.ship_code || '',
    system: m.system || '기타',
    date: m.date || null,
    equip: m.keyword || '',
    stage: '미확인',
    symptom: m.subject || '',
    action: '', parts: '', cost: '',
    // Gmail gives names only — Drive links come from the folder index
    attachments: JSON.stringify(String(m.attachments || '').split(',')
      .map(n => n.trim()).filter(Boolean).map(n => ({ name: n }))),
    history: '[]',
    email_subject: m.subject || '',
    email_link: m.mail_link || '',
    needs_review: false,
    source_msg_id: mailId,
  };
  const ok = await dbSave(sb.from('repairs').upsert(newR).select());
  if (!ok) return;
  if (!S.REPAIRS.some(r => r.id === repairId)) S.REPAIRS.unshift(newR);
  await requestDriveFolder(newR);
  // 수리이력이 실제로 저장된 뒤에만 메일을 지운다
  const okDel = await dbSave(sb.from('mail_log').delete().eq('id', mailId), m.ship_code + ' 수리이력 추가 + 메일 제거');
  if (!okDel) return;
  S.MAIL = S.MAIL.filter(x => x.id !== mailId);
  renderRows();
}

function goRepairs(shipCode) { go('repairs', { ship: shipCode || '' }); }

function toggleMonth(ym) {
  if (COLLAPSED.has(ym)) COLLAPSED.delete(ym); else COLLAPSED.add(ym);
  saveCollapsed();
  renderRows();
}

window.mailTab = { updateStatus, deleteMail, editNote, mailToRepair, goRepairs, toggleMonth };

export default { id: 'mail', mount, refresh };
