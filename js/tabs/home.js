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
const CHIP_MAX = 6;

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
    title: 'BWTS 로그 분석', unit: `${period || '—'} · ${rows.length}척`, tab: 'bwtsLog',
    big: rows.length ? `${good}/${rows.length}` : '—', bigLabel: '양호',
    bigCls: rows.length && good === rows.length ? 'green' : (bad.some(x => x.display_grade !== '미운전') ? 'amber' : 'green'),
    bigTitle: '양호 = 운전양호 + 수리후정상',
    segs: GRADES.map(g => ({ n: cnt[g] || 0, label: g, color: GRADE_DOT[g] })),
    chips: bad.slice(0, CHIP_MAX).map(x => ({ text: `${x.ship_code} ${x.display_grade}`, color: GRADE_DOT[x.display_grade] })),
    chipsLead: bad.length > CHIP_MAX ? `확인 ${bad.length}척 중` : '확인', chipsEmpty: '전 선박 양호',
  });
}

/* 진행 중 수리 — 수리이력 탭의 「완료 숨기기」와 같은 집합(S.REPAIRS, stage≠완료) */
function repairPanel() {
  const open = S.REPAIRS.filter(r => (r.stage || '') !== '완료');
  const cnt = {};
  open.forEach(r => { const st = STATUS_LIST.includes(r.stage) ? r.stage : '미확인'; cnt[st] = (cnt[st] || 0) + 1; });
  const bwts = open.filter(r => (r.system || '').toUpperCase() === 'BWTS').length;
  const oldest = open.filter(r => r.stage === '미확인' || !r.stage)
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || ''))).slice(0, CHIP_MAX);
  return panelHtml({
    title: '진행 중 수리', unit: `BWTS ${bwts} · EGCS ${open.length - bwts}`, tab: 'repairs',
    big: String(open.length), bigLabel: '건', bigCls: cnt['미확인'] ? 'amber' : 'green',
    bigTitle: '완료 제외 전체',
    segs: STATUS_LIST.filter(s => s !== '완료').map(s => ({ n: cnt[s] || 0, label: s, cls: 'st-' + s })),
    chips: oldest.map(r => ({ text: `${r.ship_code || '—'} ${r.system || ''} ${String(r.date || '').slice(5)}`, cls: 'st-미확인' })),
    chipsLead: '미확인 오래된 순', chipsEmpty: '미확인 없음',
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
      if (by[st].length) chips.push({ text: `${s.code} ${st} ${by[st].join('·')}`, color: ST_COLOR[st] });
    });
  });
  return panelHtml({
    title: '장비 현황', unit: `${ships.length}척`, tab: 'status',
    big: `${cnt['정상']}/${ships.length}`, bigLabel: '정상', bigCls: cnt['문제'] ? 'rose' : (cnt['수리중'] ? 'amber' : 'green'),
    bigTitle: '선박 기준 — 문제 > 수리중 > 정상',
    segs: ['정상', '수리중', '문제'].map(st => ({ n: cnt[st], label: st, color: ST_COLOR[st] })),
    chips, chipsLead: '', chipsEmpty: '전 선박 정상',
  });
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
  <div class="cal-dash home-dash">${statusPanel()}${cal}${logPanel(k, log)}${repairPanel()}</div>`;
}

window.homeTab = { go, goLog: () => go('bwtsLog') };

export default { id: 'home', mount, refresh };
