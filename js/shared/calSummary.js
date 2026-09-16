// 검교정 관리 현황 요약판 — 종합·현황 탭 공용.
// 판정은 검교정 탭이 쓰는 함수(bwtsDue/bwtsLevel, egcsCellStatus)를 그대로
// 호출하므로 여기 숫자는 각 탭의 만료·임박 표시와 항상 같다. 예전 홈 카드는
// v_calibration_status 뷰를 읽었는데, 그 뷰는 EGCS 임박 기준이 soon_days(30일,
// 메일 알림용)이고 센서당 검교정+신환 2행을 세어 표(warn_days 183일, 센서당
// 1칸)와 숫자가 어긋났다. 뷰는 공무팀 Dash 계약이라 손대지 않는다.
import { S } from '../core/state.js';
import { esc } from '../core/dom.js';
import { go } from '../core/router.js';
import { requireTH } from './thresholds.js';
import { daysUntil, dLabel } from './dates.js';
import { bwtsDue, bwtsLevel } from '../tabs/bwtsCal.js';
import { egcsCellStatus } from '../tabs/egcsCal.js';

const URGENT_MAX = 4;   // 시급 칩 상한 — 표 대신 한 줄로 끝내기 위함

function bwtsItems() {
  return S.BWTS_CAL.map(c => {
    const due = bwtsDue(c);
    const days = due ? daysUntil(due) : null;
    return { label: c.ship_code, days, lv: bwtsLevel(days).lv };
  });
}

function egcsItems() {
  const th = requireTH('egcs_calibration');
  return S.EGCS_CAL.map(c => {
    const st = egcsCellStatus(c, th.sensor_cycle_months, th.warn_days);
    return { label: c.ship_code + ' ' + (c.equip || '').replace('-', '/'), days: st.days, lv: st.lv };
  });
}

/* 관리율 = 유효(정상+임박) / 전체. 미상(날짜·모델 미기재)도 분모에 넣는다 —
   기록이 없으면 관리되고 있다고 볼 수 없으므로. */
function summarize(items, staleDays) {
  const n = { ok: 0, soon: 0, expired: 0, unknown: 0, stale: 0 };
  items.forEach(i => {
    n[i.lv] = (n[i.lv] || 0) + 1;
    if (i.lv === 'expired' && -i.days > staleDays) n.stale++;
  });
  const total = items.length;
  const urgent = items.filter(i => i.lv === 'expired' || i.lv === 'soon')
    .sort((a, b) => a.days - b.days).slice(0, URGENT_MAX);
  return { ...n, total, urgent, rate: total ? Math.round((n.ok + n.soon) / total * 100) : null };
}

function bar(s) {
  if (!s.total) return '';
  const seg = (k, cls) => s[k] ? `<span class="${cls}" style="flex:${s[k]}"></span>` : '';
  return `<div class="cal-bar">${seg('ok', 'lv-ok')}${seg('soon', 'lv-soon')}${seg('expired', 'lv-expired')}${seg('unknown', 'lv-unknown')}</div>`;
}

function panel(title, unit, s, tab) {
  const rateCls = s.expired ? 'rose' : (s.soon ? 'amber' : 'green');
  const chips = s.urgent.map(u => `<span class="pill lv-${u.lv}">${esc(u.label)} ${dLabel(u.days)}</span>`).join('');
  return `<div class="cal-panel" onclick="calDash.go('${tab}')" title="클릭 → ${esc(title)} 탭 열기">` +
    `<div class="cal-head"><b>${esc(title)}</b><span class="muted">${esc(unit)} · 총 ${s.total}</span>` +
      `<span class="cal-rate ${rateCls}" title="관리율 = (정상+임박) ÷ 전체">${s.rate == null ? '—' : s.rate + '%'}<small>관리율</small></span></div>` +
    bar(s) +
    '<div class="cal-nums">' +
      `<span class="pill lv-ok">정상 ${s.ok}</span><span class="pill lv-soon">임박 ${s.soon}</span>` +
      `<span class="pill lv-expired">만료 ${s.expired}</span>` +
      (s.stale ? `<span class="muted" title="만료 후 ${esc(s.staleDays)}일 넘음 — 검교정을 안 한 게 아니라 기록이 안 올라온 건일 수 있음">(기록 미갱신 ${s.stale})</span>` : '') +
      `<span class="pill lv-unknown">미상 ${s.unknown}</span></div>` +
    `<div class="cal-urgent">${chips ? '시급 ' + chips : '<span class="muted">만료·임박 없음</span>'}</div>` +
    '</div>';
}

export function calSummaryHtml() {
  try {
    const bth = requireTH('bwts_calibration');
    const eth = requireTH('egcs_calibration');
    const b = { ...summarize(bwtsItems(), bth.stale_after_days), staleDays: bth.stale_after_days };
    const e = { ...summarize(egcsItems(), eth.stale_after_days), staleDays: eth.stale_after_days };
    return '<div class="cal-dash">' +
      panel('BWTS 검교정', `TRO 센서 · 주기 ${bth.interval_months}개월 · 임박 ${bth.soon_days}일 전`, b, 'bwtsCal') +
      panel('EGCS 검교정', `WMS 센서별 · 임박 ${Math.round(eth.warn_days / 30)}개월 전`, e, 'egcsCal') +
      '</div>';
  } catch (e) {
    return `<div class="cal-dash muted" style="font-size:12px">검교정 요약 불가 — ${esc(e.message)}</div>`;
  }
}

window.calDash = { go };
