// 📑 서비스 리포트 — maker service report ledger (service_reports, sql/035).
//
// Rows come from scripts/sr_import.py (Gmail → Supabase, daily 07:00):
// one row per (mail thread, ship). Visit dates / work type / summary are
// guesses from the subject and body (PDFs are not read); editing any of them
// sets edited=true so the importer leaves them alone afterwards.
//
// 선박별 집계: 수리 연결된 건의 정지 일수(수리 등록일 → 마지막 방선일,
// 없으면 리포트 메일일)를 겹침 없이 연도 안으로 잘라 합산 → 추정 가동률.
import { S } from '../core/state.js';
import { sb, dbSave } from '../core/supabase.js';
import { $, esc, toast, inlineEdit } from '../core/dom.js';
import { YEARS } from '../shared/constants.js';
import { matchQuery } from '../shared/search.js';
import { shipOptions, sortByShipOrder } from '../shared/ships.js';
import { go } from '../core/router.js';

const WORK_TYPES = ['수리', '검교정', '정기점검', '개조·설치', '기타'];
const F = { year: '', ship: '', system: '', type: '', q: '', showExcluded: false, view: 'list' };
const OPEN = new Set();   // expanded row ids

const kstDay = ts => ts ? new Date(ts).toLocaleDateString('sv', { timeZone: 'Asia/Seoul' }) : '';
const today = () => kstDay(new Date().toISOString());
const dayDiff = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const repairById = id => S.TASKS.find(t => t.id === id);
const repairLabel = r => r ? (r.title || r.symptom || r.equip || r.id) : '';

function opts(list, cur) {
  return list.map(v => `<option${v === cur ? ' selected' : ''}>${esc(v)}</option>`).join('');
}

function folderOf(r) {
  const day = kstDay(r.mail_at);
  return S.DRIVE_FOLDERS.find(f => f.ship_code === r.ship_code && f.system === r.system && f.folder_date === day);
}

function mount(root) {
  root.innerHTML = `
  <div class="stats" id="srStats"></div>
  <div class="filters">
    <select id="srView">${['list', 'ships'].map(v =>
      `<option value="${v}"${F.view === v ? ' selected' : ''}>${v === 'list' ? '📑 목록' : '🚢 선박별 집계'}</option>`).join('')}</select>
    <select id="srYear"><option value="">전체 년도</option>${opts(YEARS, F.year)}</select>
    <select id="srSys"><option value="">전체 장비</option>${opts(['BWTS', 'EGCS'], F.system)}</select>
    <select id="srShip"></select>
    <select id="srType"><option value="">전체 구분</option>${opts(WORK_TYPES, F.type)}</select>
    <input type="text" id="srSearch" placeholder="🔍 검색 — 제목·본문·첨부·업체" value="${esc(F.q)}">
    <label style="font-size:12px;color:#64748b;display:flex;align-items:center;gap:4px;cursor:pointer">
      <input type="checkbox" id="srExcl"${F.showExcluded ? ' checked' : ''}> 제외 건 보기</label>
    <span class="count" id="srCnt"></span>
  </div>
  <div class="wrap" id="srRoot"></div>
  <div class="muted" style="font-size:11px;padding:6px 24px 16px">
    메이커 메일(제목·본문)에서 매일 07:00 자동 수집 · 방선일·구분·내용은 추정값 — 셀 클릭으로 수정하면 이후 덮어쓰지 않음 ·
    같은 메일 스레드의 재첨부·인보이스는 한 줄로 묶임</div>`;
  const bind = (id, key) => { $(id).onchange = e => { F[key] = e.target.value; render(); }; };
  bind('srView', 'view'); bind('srYear', 'year'); bind('srSys', 'system'); bind('srShip', 'ship'); bind('srType', 'type');
  $('srSearch').oninput = e => { F.q = e.target.value; render(); };
  $('srExcl').onchange = e => { F.showExcluded = e.target.checked; render(); };
}

function refresh() {
  $('srShip').innerHTML = shipOptions(S.SR);
  $('srShip').value = F.ship;
  render();
}

function filtered() {
  return S.SR.filter(r =>
    (F.showExcluded || !r.excluded) &&
    (!F.year || kstDay(r.mail_at).startsWith(F.year)) &&
    (!F.ship || r.ship_code === F.ship) &&
    (!F.system || r.system === F.system) &&
    (!F.type || r.work_type === F.type) &&
    matchQuery(F.q, r.ship_code, r.system, r.subject, r.summary, r.body, r.vendor, r.sender,
      (r.attachments || []).map(a => a.name).join(' '), repairLabel(repairById(r.repair_id))));
}

function render() {
  const rows = filtered();
  const live = S.SR.filter(r => !r.excluded);
  const card = (n, label, cls) => `<div class="card ${cls}"><div class="num">${n}</div><div class="label">${label}</div></div>`;
  $('srStats').innerHTML =
    card(live.length, '전체 리포트', 'blue') +
    card(live.filter(r => r.system === 'BWTS').length, 'BWTS', 'teal') +
    card(live.filter(r => r.system === 'EGCS').length, 'EGCS', 'green') +
    card(live.filter(r => r.repair_id).length, '수리건 연결', 'purple') +
    card(live.filter(r => !r.visit_start).length, '방선일 미입력', 'amber');
  $('srCnt').textContent = rows.length + '건';
  $('srRoot').innerHTML = F.view === 'ships' ? shipSummary(rows) : listTable(rows);
}

/* ── 목록 ─────────────────────────────────────────── */
function listTable(rows) {
  if (!rows.length) return '<div class="muted" style="padding:24px">해당 건 없음</div>';
  const body = rows.map(r => {
    const id = esc(r.id);
    const rep = repairById(r.repair_id);
    const fold = folderOf(r);
    const atts = r.attachments || [];
    const cell = (f, v, extra) =>
      `<td class="edit-cell" style="${extra || 'white-space:nowrap'}" onclick="srTab.edit('${id}','${f}',this)">${esc(v || '')}</td>`;
    const tr = `<tr${r.excluded ? ' style="opacity:.45"' : ''}>` +
      `<td style="white-space:nowrap;cursor:pointer" onclick="srTab.toggle('${id}')">${OPEN.has(r.id) ? '▾' : '▸'} ${esc(kstDay(r.mail_at))}</td>` +
      `<td><b>${esc(r.ship_code)}</b></td>` +
      `<td><span class="pill pill-${r.system === 'BWTS' ? 'bwts' : 'egcs'}">${esc(r.system)}</span></td>` +
      `<td><select style="font-size:12px;border:1px solid #e2e8f0;border-radius:4px;padding:2px" onchange="srTab.set('${id}','work_type',this.value)">` +
        `<option value=""></option>${opts(WORK_TYPES, r.work_type)}</select></td>` +
      cell('visit_start', r.visit_start) + cell('visit_end', r.visit_end) +
      cell('summary', r.summary, 'white-space:normal;word-break:break-word') +
      `<td style="white-space:nowrap;font-size:11px;color:#64748b" title="${esc(r.sender || '')}">${esc(r.vendor || '')}</td>` +
      `<td style="text-align:center;white-space:nowrap">${atts.length}${r.mail_count > 1 ? `<span class="muted" style="font-size:10px" title="묶인 메일 수"> /✉${r.mail_count}</span>` : ''}</td>` +
      `<td class="edit-cell" style="font-size:12px;white-space:normal" onclick="srTab.pickRepair('${id}',this)">` +
        (rep ? `<span class="status-select st-${esc(rep.status)}" style="padding:1px 6px;background-image:none">${esc(rep.status || '')}</span> ${esc(repairLabel(rep))}` : '<span class="muted">＋ 연결</span>') + '</td>' +
      `<td style="white-space:nowrap">` +
        `<a href="https://mail.google.com/mail/u/0/#all/${esc(r.thread_id)}" target="_blank" rel="noopener" title="메일 스레드">✉</a> ` +
        (fold ? `<a href="${esc(fold.url)}" target="_blank" rel="noopener" title="${esc(fold.name)}">📁</a>` : '<span class="muted" title="Drive 폴더 색인 없음 (06:30 색인 후 표시)">·</span>') +
        ` <button onclick="srTab.set('${id}','excluded',${!r.excluded})" title="${r.excluded ? '제외 해제' : '서비스 리포트 아님 — 목록에서 제외'}" style="background:none;border:none;cursor:pointer;font-size:12px">${r.excluded ? '↩' : '✕'}</button></td>` +
      '</tr>';
    if (!OPEN.has(r.id)) return tr;
    return tr + `<tr><td colspan="11" style="background:#f8fafc;font-size:12px">` +
      `<div style="margin-bottom:6px"><b>${esc(r.subject)}</b> <span class="muted">— ${esc(r.sender || '')}</span></div>` +
      `<div style="white-space:pre-wrap;max-height:260px;overflow:auto;color:#334155">${esc((r.body || '').trim())}</div>` +
      `<div style="margin-top:6px">${atts.map(a => `📎 ${esc(a.name)}`).join(' &nbsp; ')}</div>` +
      (rep ? `<div style="margin-top:6px"><a href="javascript:void 0" onclick="srTab.openRepair('${esc(rep.id)}')">→ EGCS·BWTS 이력에서 수리건 보기</a></div>` : '') +
      '</td></tr>';
  }).join('');
  return '<table style="table-layout:fixed"><thead><tr>' +
    '<th style="width:104px">메일일</th><th style="width:52px">선박</th><th style="width:62px">장비</th><th style="width:96px">구분</th>' +
    '<th style="width:100px">방선 시작</th><th style="width:100px">방선 종료</th><th>내용</th><th style="width:120px">업체</th>' +
    '<th style="width:56px">첨부</th><th style="width:220px">수리건</th><th style="width:76px"></th>' +
    '</tr></thead><tbody>' + body + '</tbody></table>';
}

/* ── 선박별 집계 ──────────────────────────────────── */
function shipSummary(rows) {
  const year = F.year || today().slice(0, 4);
  const yStart = year + '-01-01';
  const yEnd = year === today().slice(0, 4) ? today() : year + '-12-31';
  const span = dayDiff(yStart, yEnd) + 1;
  const keys = {};
  rows.forEach(r => { (keys[r.ship_code + '|' + r.system] = keys[r.ship_code + '|' + r.system] || []).push(r); });
  const ordered = sortByShipOrder([...new Set(rows.map(r => r.ship_code))]);
  const out = [];
  ordered.forEach(code => ['BWTS', 'EGCS'].forEach(sys => {
    const list = keys[code + '|' + sys];
    if (!list) return;
    const n = t => list.filter(r => r.work_type === t).length;
    const lastVisit = list.map(r => r.visit_end || r.visit_start || '').filter(Boolean).sort().pop() || '';
    // Downtime per linked repair: registered → last visit end (else completed / today)
    const byRepair = {};
    S.SR.filter(r => !r.excluded && r.ship_code === code && r.system === sys && r.repair_id)
      .forEach(r => { (byRepair[r.repair_id] = byRepair[r.repair_id] || []).push(r); });
    // A report mail means the visit is over, so the stop ends at the latest
    // visit date or report mail of that repair. Overlaps count once.
    const spans = [];
    Object.keys(byRepair).forEach(rid => {
      const rep = repairById(rid);
      if (!rep || !rep.date) return;
      const end = byRepair[rid].map(r => r.visit_end || r.visit_start || kstDay(r.mail_at)).sort().pop();
      const a = rep.date > yStart ? rep.date : yStart;
      const b = end < yEnd ? end : yEnd;
      if (b >= a) spans.push([a, b]);
    });
    let down = 0, curA = null, curB = null;
    spans.sort((x, y) => x[0] < y[0] ? -1 : 1).forEach(([a, b]) => {
      if (curB && a <= curB) { if (b > curB) curB = b; return; }
      if (curB) down += dayDiff(curA, curB) + 1;
      curA = a; curB = b;
    });
    if (curB) down += dayDiff(curA, curB) + 1;
    const avail = Math.max(0, 100 * (1 - down / span));
    out.push('<tr>' +
      `<td><b>${esc(code)}</b></td><td><span class="pill pill-${sys === 'BWTS' ? 'bwts' : 'egcs'}">${sys}</span></td>` +
      `<td style="text-align:center">${list.length}</td><td style="text-align:center">${n('수리')}</td>` +
      `<td style="text-align:center">${n('검교정')}</td><td style="text-align:center">${n('정기점검')}</td>` +
      `<td style="text-align:center">${n('개조·설치') + n('기타')}</td>` +
      `<td style="text-align:center">${esc(lastVisit)}</td>` +
      `<td style="text-align:center">${Object.keys(byRepair).length}</td>` +
      `<td style="text-align:center">${down || ''}</td>` +
      `<td style="text-align:center;font-weight:600;color:${avail < 95 ? '#dc2626' : '#16a34a'}">${avail.toFixed(1)}%</td>` +
      '</tr>');
  }));
  if (!out.length) return '<div class="muted" style="padding:24px">해당 건 없음</div>';
  return `<div class="muted" style="font-size:12px;margin-bottom:8px">${esc(year)}년 기준 (${span}일) · 정지 일수 = 연결된 수리건의 등록일 → 마지막 방선일
    (없으면 리포트 메일일), 겹치는 기간은 한 번만, 연도 안으로 잘라 합산 · 가동률 = 1 − 정지/기간 (추정)</div>` +
    '<table style="width:auto"><thead><tr><th>선박</th><th>장비</th><th>리포트</th><th>수리</th><th>검교정</th><th>정기점검</th>' +
    '<th>기타</th><th>마지막 방선</th><th>수리건</th><th>정지 일수</th><th>추정 가동률</th></tr></thead><tbody>' +
    out.join('') + '</tbody></table>';
}

/* ── edits ───────────────────────────────────────── */
async function set(id, field, val) {
  const r = S.SR.find(x => x.id === id);
  if (!r) return;
  const patch = { [field]: val === '' ? null : val, edited: true, updated_at: new Date().toISOString() };
  if (field === 'work_type' || field === 'summary') patch[field] = val || '';
  const ok = await dbSave(sb.from('service_reports').update(patch).eq('id', id), '저장됨');
  if (!ok) return;
  Object.assign(r, patch);
  render();
}

function edit(id, field, el) {
  const r = S.SR.find(x => x.id === id);
  if (!r) return;
  const isDate = field === 'visit_start' || field === 'visit_end';
  inlineEdit(el, r[field] || '', v => {
    if ((v || '') === (r[field] || '')) { el.textContent = r[field] || ''; return; }
    set(id, field, v);
  }, isDate ? { type: 'date' } : {});
}

// Candidate repairs: same ship + system, nearest to the mail date first
function pickRepair(id, el) {
  const r = S.SR.find(x => x.id === id);
  if (!r || el.querySelector('select')) return;
  const day = kstDay(r.mail_at);
  const cands = S.TASKS.filter(t => t.ship_code === r.ship_code && t.system === r.system && t.date)
    .sort((a, b) => Math.abs(dayDiff(a.date, day)) - Math.abs(dayDiff(b.date, day))).slice(0, 20);
  const sel = document.createElement('select');
  sel.style.cssText = 'width:100%;font-size:12px';
  sel.innerHTML = '<option value="">— 선택 —</option>' +
    (r.repair_id ? '<option value="__none">✕ 연결 해제</option>' : '') +
    cands.map(t => `<option value="${esc(t.id)}"${t.id === r.repair_id ? ' selected' : ''}>${esc(t.date)} [${esc(t.status || '')}] ${esc(repairLabel(t).slice(0, 60))}</option>`).join('');
  el.innerHTML = '';
  el.appendChild(sel);
  sel.focus();
  sel.onchange = () => set(id, 'repair_id', sel.value === '__none' ? '' : sel.value);
  sel.onblur = () => setTimeout(render, 150);
  if (!cands.length) toast('같은 선박·장비의 업무(수리) 건 없음 — 업무 탭에서 먼저 등록');
}

function toggle(id) { OPEN.has(id) ? OPEN.delete(id) : OPEN.add(id); render(); }
function openRepair(rid) { go('repairs', { focus: rid }); }

window.srTab = { set, edit, pickRepair, toggle, openRepair };

export default { id: 'reports', mount, refresh };
