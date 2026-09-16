// 요약판(패널) — 종합·현황 탭 공용.
// panelHtml() 은 제목·큰 숫자·구간 막대·칩 한 줄로 된 클릭형 카드 하나를 그린다.
// 검교정 두 패널은 여기서 만들고, 종합 탭은 같은 틀로 로그·수리 패널을 만든다.
//
// 검교정 판정은 검교정 탭이 쓰는 함수(bwtsDue/bwtsLevel, egcsCellStatus)를 그대로
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

export const CHIP_MAX = 8;   // 칩 상한 — 표 대신 한 줄로 끝내기 위함

/* 패널 하나 — 모든 패널이 같은 4줄: 제목+큰숫자 / 막대 / 숫자 필 / 칩.
   칩은 선박 코드처럼 짧게, 상세는 title(툴팁)로.
   o = { title, unit, big, bigCls(green|amber|rose), bigLabel, bigTitle?, tab,
         segs: [{ n, label, cls?, color?, title? }]   막대 구간이자 숫자 필 (0 도 회색 필로)
         chips: [{ text, cls?, color?, title? }], chipsEmpty } */
export function panelHtml(o) {
  const total = o.segs.reduce((a, s) => a + s.n, 0);
  const bar = total ? '<div class="cal-bar">' + o.segs.filter(s => s.n).map(s =>
    `<span class="${s.cls || ''}" style="flex:${s.n}${s.color ? ';background:' + s.color : ''}" title="${esc(s.label)} ${s.n}"></span>`).join('') + '</div>' : '';
  const pills = o.segs.map(s => s.n
    ? `<span class="pill ${s.cls || ''}"${s.color ? ` style="background:${s.color}22;color:${s.color}"` : ''}${s.title ? ` title="${esc(s.title)}"` : ''}>${esc(s.label)} ${s.n}</span>`
    : `<span class="pill lv-unknown" style="opacity:.6">${esc(s.label)} 0</span>`).join('');
  const chips = o.chips.slice(0, CHIP_MAX).map(c =>
    `<span class="pill ${c.cls || ''}"${c.color ? ` style="background:${c.color}22;color:${c.color}"` : ''}${c.title ? ` title="${esc(c.title)}"` : ''}>${esc(c.text)}</span>`).join('') +
    (o.chips.length > CHIP_MAX ? `<span class="muted">+${o.chips.length - CHIP_MAX}</span>` : '');
  return `<div class="cal-panel" onclick="calDash.go('${o.tab}')" title="클릭 → ${esc(o.title)} 탭 열기">` +
    `<div class="cal-head"><b>${esc(o.title)}</b><span class="muted cal-unit">${esc(o.unit)}</span>` +
      `<span class="cal-rate ${o.bigCls || ''}"${o.bigTitle ? ` title="${esc(o.bigTitle)}"` : ''}>${esc(o.big)}<small>${esc(o.bigLabel)}</small></span></div>` +
    (bar || '<div class="cal-bar"></div>') +
    `<div class="cal-nums">${pills}</div>` +
    `<div class="cal-urgent">${chips || `<span class="muted">${esc(o.chipsEmpty || '—')}</span>`}</div>` +
    '</div>';
}

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
    // 'WMS1/TURB' → 'TURB': 요약판에선 센서 종류만. WMS1·2 는 같은 칩으로 합쳐진다
    const sensor = (c.equip || '').replace('-', '/').split('/').pop();
    return { label: c.ship_code + ' ' + sensor, days: st.days, lv: st.lv };
  });
}

/* 관리율 = 유효(정상+임박) / 전체. 미상(날짜·모델 미기재)도 분모에 넣는다 —
   기록이 없으면 관리되고 있다고 볼 수 없으므로. */
function calPanel(title, unit, items, staleDays, tab) {
  const n = { ok: 0, soon: 0, expired: 0, unknown: 0, stale: 0 };
  items.forEach(i => {
    n[i.lv] = (n[i.lv] || 0) + 1;
    if (i.lv === 'expired' && -i.days > staleDays) n.stale++;
  });
  const total = items.length;
  // 같은 라벨(예: KCB TURB 가 WMS1·WMS2 둘 다)은 더 급한 쪽 하나만
  const seen = {};
  const urgent = items.filter(i => i.lv === 'expired' || i.lv === 'soon')
    .sort((a, b) => a.days - b.days)
    .filter(i => !seen[i.label] && (seen[i.label] = 1));
  return panelHtml({
    title, unit: `${unit} · ${total}`, tab,
    big: total ? Math.round((n.ok + n.soon) / total * 100) + '%' : '—', bigLabel: '관리율',
    bigCls: n.expired ? 'rose' : (n.soon ? 'amber' : 'green'), bigTitle: '관리율 = (정상+임박) ÷ 전체',
    segs: [
      { n: n.ok, label: '정상', cls: 'lv-ok' }, { n: n.soon, label: '임박', cls: 'lv-soon' },
      { n: n.expired, label: '만료', cls: 'lv-expired',
        title: n.stale ? `이 중 ${n.stale}건은 만료 후 ${staleDays}일 넘음 — 기록 미갱신일 수 있음` : '' },
      { n: n.unknown, label: '미상', cls: 'lv-unknown', title: '검교정일·모델 미기재' },
    ],
    chips: urgent.map(u => ({ text: u.label, cls: 'lv-' + u.lv, title: (u.lv === 'expired' ? '만료 ' : '임박 ') + dLabel(u.days) })),
    chipsEmpty: '만료·임박 없음',
  });
}

export function calSummaryHtml() {
  try {
    const bth = requireTH('bwts_calibration');
    const eth = requireTH('egcs_calibration');
    return '<div class="cal-dash">' +
      calPanel('BWTS 검교정', `TRO 센서 · 주기 ${bth.interval_months}개월 · 임박 ${bth.soon_days}일 전`, bwtsItems(), bth.stale_after_days, 'bwtsCal') +
      calPanel('EGCS 검교정', `WMS 센서별 · 임박 ${Math.round(eth.warn_days / 30)}개월 전`, egcsItems(), eth.stale_after_days, 'egcsCal') +
      '</div>';
  } catch (e) {
    return `<div class="cal-dash muted" style="font-size:12px">검교정 요약 불가 — ${esc(e.message)}</div>`;
  }
}

/* 종합 탭용: 검교정 두 패널만 (감싸는 grid 없이) — 로그·수리 패널과 한 줄에 놓는다 */
export function calPanelsHtml() {
  const bth = requireTH('bwts_calibration');
  const eth = requireTH('egcs_calibration');
  return calPanel('BWTS 검교정', 'TRO 센서', bwtsItems(), bth.stale_after_days, 'bwtsCal') +
    calPanel('EGCS 검교정', 'WMS 센서', egcsItems(), eth.stale_after_days, 'egcsCal');
}

window.calDash = { go };
