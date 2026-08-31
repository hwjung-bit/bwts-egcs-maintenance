// 🏠 종합 — 환경파트 KPI. Reads the same contract views (sql/020) that
// export_contract.py ships to the 공무팀 Dash, so this tab doubles as the
// live check that the contract numbers are right.
import { sb } from '../core/supabase.js';
import { $, esc } from '../core/dom.js';
import { go } from '../core/router.js';
import { GRADES } from './bwtsLog.js';

const GRADE_DOT = { '운전양호': '#4CAF50', '점검필요': '#FF9800', '수리후정상': '#42A5F5', '미운전': '#9E9E9E', '미수신': '#F44336', '데이터불량': '#9C27B0', '판독실패': '#FDD835' };

function mount(root) {
  root.innerHTML = '<div class="wrap" id="homeRoot"><div class="loading"><span class="spin"></span> KPI 로딩...</div></div>';
}

function refresh() {
  load().catch(e => {
    $('homeRoot').innerHTML = `<div class="tab-error"><b>⚠ 종합 KPI 로드 실패</b>${/does not exist|relation|Could not find the table|schema cache/.test(e.message) ? 'sql/020_env_views.sql · 021 을 먼저 실행하세요.' : ''}<code>${esc(e.message)}</code></div>`;
  });
}

async function load() {
  const [s, c, r, l] = await Promise.all([
    sb.from('v_env_summary').select('*').maybeSingle(),
    sb.from('v_calibration_status').select('*').in('level', ['expired', 'soon']).order('days_left').limit(12),
    sb.from('v_repairs_open').select('*').limit(12),
    sb.from('v_bwts_log_latest').select('*'),
  ]);
  for (const x of [s, c, r, l]) if (x.error) throw new Error(x.error.message);
  render(s.data || {}, c.data || [], r.data || [], l.data || []);
}

function card(n, label, cls, onclick) {
  return `<div class="card ${cls || ''}"${onclick ? ` onclick="${onclick}" style="cursor:pointer"` : ''}><div class="num">${n == null ? '—' : n}</div><div class="label">${label}</div></div>`;
}

function render(k, cal, rep, log) {
  const grades = k.bwts_log_latest_grades || {};
  const gradeBar = GRADES.filter(g => grades[g]).map(g =>
    `<span class="chip" onclick="homeTab.goLog()"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${GRADE_DOT[g]};margin-right:3px"></span>${g} ${grades[g]}</span>`).join('') || '<span class="muted">분석 데이터 없음</span>';
  const calRows = cal.map(x =>
    `<tr><td><b>${esc(x.ship_code)}</b></td><td>${esc(x.system)}</td><td>${esc(x.equip || '')}${x.kind === 'repl' ? ' <span class="muted">신환</span>' : ''}</td><td>${esc(x.due_date || '—')}</td>` +
    `<td><span class="pill lv-${x.level}">${x.level === 'expired' ? '만료' : '임박'} ${x.days_left <= 0 ? Math.abs(x.days_left) + '일 경과' : 'D-' + x.days_left}</span></td></tr>`).join('');
  const repRows = rep.map(x =>
    `<tr><td><b>${esc(x.ship_code)}</b></td><td><span class="pill pill-${(x.system || '').toLowerCase() === 'bwts' ? 'bwts' : 'egcs'}">${esc(x.system)}</span></td><td>${esc(x.equip || '')}</td>` +
    `<td><span class="status-select st-${esc(x.stage)}" style="padding:2px 8px">${esc(x.stage)}</span></td><td style="max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(x.symptom || '')}</td><td>${esc(x.date || '')}</td></tr>`).join('');
  const byShip = {};
  log.forEach(x => { (byShip[x.ship_code] = byShip[x.ship_code] || []).push(x); });
  const periods = [...new Set(log.map(x => x.period))].sort();
  const logRows = Object.keys(byShip).sort().map(code =>
    `<tr><td><b>${esc(code)}</b></td>` + periods.map(p => {
      const x = byShip[code].find(y => y.period === p);
      if (!x) return '<td class="muted">—</td>';
      return `<td><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${GRADE_DOT[x.display_grade] || '#ccc'};margin-right:4px"></span>${esc(x.display_grade)}</td>`;
    }).join('') + '</tr>').join('');

  $('homeRoot').innerHTML = `
  <div style="display:flex;align-items:baseline;gap:12px;margin-bottom:8px">
    <h3 style="margin:0">환경파트 종합</h3>
    <span class="muted" style="font-size:11px">계약 뷰 v_env_summary · ${esc((k.generated_at || '').slice(0, 16).replace('T', ' '))} · 공무팀 대시보드와 같은 숫자</span>
  </div>
  <div class="stats" style="padding:0 0 12px">
    ${card(k.bwts_target, 'BWTS 대상', 'blue', "homeTab.go('ships')")}
    ${card(k.egcs_target, 'EGCS 대상', 'green', "homeTab.go('ships')")}
    ${card(k.status_ok, '정상', 'green', "homeTab.go('status')")}
    ${card(k.status_repairing, '수리중', 'amber', "homeTab.go('status')")}
    ${card(k.status_issue, '문제(보류)', 'rose', "homeTab.go('status')")}
    ${card(k.repairs_open, '진행 중 수리', 'purple', "homeTab.go('repairs')")}
    ${card(k.cal_expired, '검교정 만료', 'rose', "homeTab.go('bwtsCal')")}
    ${card(k.cal_soon, '검교정 임박', 'amber', "homeTab.go('bwtsCal')")}
    ${card(k.bwts_log_review_pending, '로그 재검토 대기', 'teal', 'homeTab.goLog()')}
  </div>
  <div class="bl-grid" style="grid-template-columns:repeat(auto-fit,minmax(420px,1fr))">
    <div class="bl-sec"><h4>BWTS 로그 분석 — ${esc(k.bwts_log_latest_period || '—')}</h4><div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px">${gradeBar}</div>
      ${logRows ? `<table class="cal-table"><thead><tr><th>선박</th>${periods.map(p => `<th>${esc(p)}</th>`).join('')}</tr></thead><tbody>${logRows}</tbody></table>` : ''}</div>
    <div class="bl-sec"><h4>가장 시급한 검교정 (만료·임박 ${cal.length}${cal.length >= 12 ? '+' : ''})</h4>
      <table class="cal-table"><thead><tr><th>선박</th><th>시스템</th><th>장비</th><th>만료일</th><th>상태</th></tr></thead><tbody>${calRows || '<tr><td colspan="5" class="muted">없음</td></tr>'}</tbody></table></div>
    <div class="bl-sec" style="grid-column:1/-1"><h4>진행 중 수리 (${k.repairs_open || 0})</h4>
      <table><thead><tr><th>선박</th><th>시스템</th><th>장비</th><th>단계</th><th>증상</th><th>일자</th></tr></thead><tbody>${repRows || '<tr><td colspan="6" class="muted">없음</td></tr>'}</tbody></table></div>
  </div>`;
}

window.homeTab = { go, goLog: () => go('bwtsLog') };

export default { id: 'home', mount, refresh };
