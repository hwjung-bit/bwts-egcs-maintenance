// 🏠 종합 — 환경파트 KPI. The card row reads the contract view (sql/020)
// that export_contract.py ships to the 공무팀 Dash, so it doubles as the live
// check that the contract numbers are right. The four panels below are the
// one-screen dashboard: 검교정 ×2 (tab judgment, js/shared/calSummary.js),
// BWTS 로그 (latest month, every grade shown), 진행 중 수리 (S.REPAIRS, like
// the 수리이력 tab). No tables — each panel click opens its tab.
import { sb } from '../core/supabase.js';
import { S } from '../core/state.js';
import { $, esc } from '../core/dom.js';
import { go } from '../core/router.js';
import { STATUS_LIST } from '../shared/constants.js';
import { panelHtml, calPanelsHtml } from '../shared/calSummary.js';
import { GRADES } from './bwtsLog.js';

const GRADE_DOT = { '운전양호': '#4CAF50', '점검필요': '#FF9800', '수리후정상': '#42A5F5', '미운전': '#9E9E9E', '미수신': '#F44336', '데이터불량': '#9C27B0', '판독실패': '#FDD835' };
const GOOD = ['운전양호', '수리후정상'];

function mount(root) {
  root.innerHTML = '<div class="wrap" id="homeRoot"><div class="loading"><span class="spin"></span> KPI 로딩...</div></div>';
}

function refresh() {
  load().catch(e => {
    $('homeRoot').innerHTML = `<div class="tab-error"><b>⚠ 종합 KPI 로드 실패</b>${/does not exist|relation|Could not find the table|schema cache/.test(e.message) ? 'sql/020_env_views.sql · 021 을 먼저 실행하세요.' : ''}<code>${esc(e.message)}</code></div>`;
  });
}

async function load() {
  const [s, l] = await Promise.all([
    sb.from('v_env_summary').select('*').maybeSingle(),
    sb.from('v_bwts_log_latest').select('*'),
  ]);
  for (const x of [s, l]) if (x.error) throw new Error(x.error.message);
  render(s.data || {}, l.data || []);
}

function card(n, label, cls, onclick) {
  return `<div class="card ${cls || ''}"${onclick ? ` onclick="${onclick}" style="cursor:pointer"` : ''}><div class="num">${n == null ? '—' : n}</div><div class="label">${label}</div></div>`;
}

/* 최신 월 등급 분포 — 7개 등급 전부 표시(0 포함). 칩은 양호가 아닌 배. */
function logPanel(k, log) {
  const period = k.bwts_log_latest_period || '';
  const rows = log.filter(x => x.period === period);
  const cnt = {};
  rows.forEach(x => { cnt[x.display_grade] = (cnt[x.display_grade] || 0) + 1; });
  const good = GOOD.reduce((a, g) => a + (cnt[g] || 0), 0);
  const bad = rows.filter(x => !GOOD.includes(x.display_grade))
    .sort((a, b) => GRADES.indexOf(a.display_grade) - GRADES.indexOf(b.display_grade) || a.ship_code.localeCompare(b.ship_code));
  return panelHtml({
    title: 'BWTS 로그', unit: period || '—', tab: 'bwtsLog',
    big: rows.length ? `${good}/${rows.length}` : '—', bigLabel: '양호',
    bigCls: rows.length && good === rows.length ? 'green' : (bad.some(x => x.display_grade !== '미운전') ? 'amber' : 'green'),
    bigTitle: '양호 = 운전양호 + 수리후정상',
    segs: GRADES.map(g => ({ n: cnt[g] || 0, label: g, color: GRADE_DOT[g] })),
    chips: bad.map(x => ({ text: x.ship_code, color: GRADE_DOT[x.display_grade], title: x.display_grade })),
    chipsEmpty: '전 선박 양호',
  });
}

/* 진행 중 수리 — 수리이력 탭의 「완료 숨기기」와 같은 집합(S.REPAIRS, stage≠완료) */
function repairPanel() {
  const open = S.REPAIRS.filter(r => (r.status || '') !== '완료');
  const cnt = {};
  open.forEach(r => { const st = STATUS_LIST.includes(r.status) ? r.status : '대기'; cnt[st] = (cnt[st] || 0) + 1; });
  const bwts = open.filter(r => (r.system || '').toUpperCase() === 'BWTS').length;
  // 미확인 건의 선박, 오래된 순 — 같은 배는 한 번만 (건수는 툴팁)
  const byShip = {};
  open.filter(r => r.status === '대기' || !r.status)
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')))
    .forEach(r => { const k = r.ship_code || '—'; (byShip[k] = byShip[k] || []).push(r); });
  return panelHtml({
    title: '진행 중 수리', unit: `BWTS ${bwts} · EGCS ${open.length - bwts}`, tab: 'repairs',
    big: String(open.length), bigLabel: '건', bigCls: cnt['미확인'] ? 'amber' : 'green',
    bigTitle: '완료 제외 전체',
    segs: STATUS_LIST.filter(s => s !== '완료').map(s => ({ n: cnt[s] || 0, label: s, cls: 'st-' + s })),
    chips: Object.keys(byShip).map(k => ({
      text: k, cls: 'st-미확인',
      title: '미확인 ' + byShip[k].length + '건 · ' + byShip[k].map(r => `${r.system || ''} ${r.date || ''}`).join(' / '),
    })),
    chipsEmpty: '미확인 없음',
  });
}

/* 현황 탭의 선박별 상태 — 같은 규칙(문제 > 수리중 > 정상), 칩은 정상이 아닌 배 */
const SYS = { bwts: 'BWTS', egcs_wms: 'WMS', egcs_cems: 'CEMS', egcs_body: 'BODY' };
const ST_COLOR = { '정상': '#16a34a', '수리중': '#d97706', '문제': '#e11d48' };
function statusPanel() {
  const ships = S.SHIPS.filter(s => !s.hidden);
  const cnt = { '정상': 0, '수리중': 0, '문제': 0 };
  const chips = [];
  ships.forEach(s => {
    const by = { '문제': [], '수리중': [] };
    Object.keys(SYS).forEach(f => { const v = s[f + '_status']; if (by[v]) by[v].push(SYS[f]); });
    const worst = by['문제'].length ? '문제' : (by['수리중'].length ? '수리중' : '정상');
    cnt[worst]++;
    ['문제', '수리중'].forEach(st => {
      if (by[st].length) chips.push({
        text: `${s.code} ${by[st].join('·')}`, color: ST_COLOR[st],
        title: st + ' — ' + by[st].map(sys => (s[Object.keys(SYS).find(f => SYS[f] === sys) + '_memo'] || '').trim()).filter(Boolean).join(' / '),
      });
    });
  });
  return panelHtml({
    title: '장비 현황', unit: `${ships.length}척`, tab: 'status',
    big: `${cnt['정상']}/${ships.length}`, bigLabel: '정상', bigCls: cnt['문제'] ? 'rose' : (cnt['수리중'] ? 'amber' : 'green'),
    bigTitle: '선박 기준 — 문제 > 수리중 > 정상',
    segs: ['정상', '수리중', '문제'].map(st => ({ n: cnt[st], label: st, color: ST_COLOR[st] })),
    chips, chipsEmpty: '전 선박 정상',
  });
}

/* 긴급도 '상' 인 미완료 수리 — 업무대장 긴급도 칸 또는 수리이력 🔥 토글. 클릭 → 그 행으로 */
function urgentListHtml() {
  // 긴급 상 = 시스템 구분 없이 전체 업무(S.TASKS). 수리이력만 보던 S.REPAIRS 는 BWTS/EGCS 뿐이라
  // Hi-NAS·CII 같은 업무의 긴급건이 빠졌다.
  const list = S.TASKS.filter(r => r.urgency === '상' && (r.status || '') !== '완료')
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  const rows = list.map(r => {
    const up = (r.system || '').toUpperCase();
    const repair = up === 'BWTS' || up === 'EGCS';
    const pill = repair
      ? `<span class="pill pill-${up === 'BWTS' ? 'bwts' : 'egcs'}">${esc(r.system)}</span>`
      : `<span class="pill" style="background:#e2e8f0;color:#334155">${esc(r.system || '업무')}</span>`;
    // BWTS/EGCS 는 수리이력 행으로, 그 외 업무는 📋 업무 탭으로
    const click = repair ? `homeTab.focusRepair('${esc(r.id)}')` : `homeTab.go('work')`;
    return `<div class="urg-row" onclick="${click}" title="클릭 → ${repair ? '수리이력' : '업무 탭'}에서 보기">` +
      pill + `<b>${esc(r.ship_code || '—')}</b>` +
      `<span class="urg-txt">${esc(r.title || r.symptom || r.email_subject || '')}</span>` +
      `<span class="status-select st-${esc(r.status)}" style="padding:2px 8px">${esc(r.status || '')}</span>` +
      `<span class="muted" style="white-space:nowrap">${esc(r.date || '')}</span></div>`;
  }).join('');
  return `<div class="urg-box"><h4>🔥 긴급 (상) <span class="muted" style="font-weight:400">${list.length}건 · 📋 업무 탭 긴급 배지 또는 수리이력 🔥 로 지정</span></h4>` +
    (rows || '<div class="muted" style="font-size:12px;padding:4px 0">긴급 상 없음</div>') + '</div>';
}

function render(k, log) {
  let cal = '';
  try { cal = calPanelsHtml(); } catch (e) { cal = `<div class="cal-panel muted">검교정 요약 불가 — ${esc(e.message)}</div>`; }
  $('homeRoot').innerHTML = `
  <div style="display:flex;align-items:baseline;gap:12px;margin-bottom:8px">
    <h3 style="margin:0">환경파트 종합</h3>
    <span class="muted" style="font-size:11px">계약 뷰 v_env_summary · ${esc((k.generated_at || '').slice(0, 16).replace('T', ' '))} · 공무팀 대시보드와 같은 숫자 · 패널 클릭 → 해당 탭</span>
  </div>
  <div class="stats" style="padding:0 0 12px">
    ${card(k.bwts_target, 'BWTS 대상', 'blue', "homeTab.go('ships')")}
    ${card(k.egcs_target, 'EGCS 대상', 'green', "homeTab.go('ships')")}
    ${card(k.status_ok, '정상', 'green', "homeTab.go('status')")}
    ${card(k.status_repairing, '수리중', 'amber', "homeTab.go('status')")}
    ${card(k.status_issue, '문제(보류)', 'rose', "homeTab.go('status')")}
    ${card(k.repairs_open, '진행 중 수리', 'purple', "homeTab.go('repairs')")}
    ${card(k.bwts_log_review_pending, '로그 재검토 대기', 'teal', 'homeTab.goLog()')}
  </div>
  <div class="cal-dash home-dash">${statusPanel()}${cal}${logPanel(k, log)}${repairPanel()}</div>
  ${urgentListHtml()}`;
}

window.homeTab = { go, goLog: () => go('bwtsLog'), focusRepair: id => go('repairs', { focus: id }) };

export default { id: 'home', mount, refresh };
