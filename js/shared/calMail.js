// ✉ 리포트 메일 — 지금 화면의 검교정 판정(만료·임박)으로 메일 본문을 만들어
// 내 Gmail 임시보관함에 넣는다 (gmailDraft, gmail.compose 권한). 보내기는 사람이.
// 매주 월요일 08:00 자동 메일(scripts/weekly_cal_alert.py)은 그대로 따로 돈다.
// (예전엔 GitHub Actions 페이지를 열어 수동 실행하게 했는데, 눌렀을 때 GitHub 가 떠서 혼란 → 교체)
import { S } from '../core/state.js';
import { esc, toast } from '../core/dom.js';
import { requireTH } from './thresholds.js';
import { daysUntil, dLabel } from './dates.js';
import { gmailDraft, preloadGmail } from './gmailDraft.js';
import { bwtsDue, bwtsLevel } from '../tabs/bwtsCal.js';
import { egcsCellStatus } from '../tabs/egcsCal.js';

const TO = 'hwjung@ekmtc.com';
const TITLE = '지금 화면 기준 검교정 만료·임박 리포트를 내 Gmail 임시보관함에 만듦 → 확인 후 보내기';
const LV = { expired: ['만료', '#b91c1c', '#fee2e2'], soon: ['임박', '#c2410c', '#ffedd5'] };

function ymd(d) {
  return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}
function dueFromDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return ymd(d);
}

function bwtsRows() {
  return S.BWTS_CAL.map(c => {
    const due = bwtsDue(c);
    const days = due ? daysUntil(due) : null;
    return { ship: c.ship_code, item: 'TRO 센서', due: due ? ymd(new Date(due)) : '', days, lv: bwtsLevel(days).lv };
  });
}
function egcsRows() {
  const th = requireTH('egcs_calibration');
  return S.EGCS_CAL.map(c => {
    const st = egcsCellStatus(c, th.sensor_cycle_months, th.warn_days);
    return { ship: c.ship_code, item: (c.equip || '').replace('-', '/'),
             due: st.days == null ? '' : dueFromDays(st.days), days: st.days, lv: st.lv };
  });
}

function table(title, rows) {
  const urgent = rows.filter(r => r.lv === 'expired' || r.lv === 'soon').sort((a, b) => a.days - b.days);
  const head = `<h3 style="margin:18px 0 6px;font-size:15px">${esc(title)} — 만료 ${urgent.filter(r => r.lv === 'expired').length} · 임박 ${urgent.filter(r => r.lv === 'soon').length}</h3>`;
  if (!urgent.length) return head + '<div style="font-size:13px;color:#15803d">만료·임박 없음</div>';
  const th = 'style="border:1px solid #cbd5e1;padding:4px 8px;background:#f1f5f9;font-size:12px"';
  const body = urgent.map(r => {
    const [ko, fg, bg] = LV[r.lv];
    const td = `style="border:1px solid #cbd5e1;padding:4px 8px;font-size:12px;background:${bg}"`;
    return `<tr><td ${td}><b>${esc(r.ship)}</b></td><td ${td}>${esc(r.item)}</td><td ${td}>${esc(r.due)}</td>` +
      `<td ${td}><b style="color:${fg}">${ko}</b> ${esc(dLabel(r.days))}</td></tr>`;
  }).join('');
  return head + `<table style="border-collapse:collapse"><tr><th ${th}>선박</th><th ${th}>항목</th>` +
    `<th ${th}>다음 만료</th><th ${th}>상태</th></tr>${body}</table>`;
}

function draft(ev) {
  ev.preventDefault();
  ev.stopPropagation();
  let html;
  try {
    const today = ymd(new Date());
    html = `<div style="font-family:'Malgun Gothic',sans-serif">` +
      `<div style="font-size:13px">환경기술파트 관리대장 기준 검교정 만료·임박 현황 (${today})</div>` +
      table('BWTS 검교정', bwtsRows()) + table('EGCS WMS 검교정 · 센서 신환', egcsRows()) +
      `<div style="margin-top:14px;font-size:11px;color:#64748b">관리대장: https://hwjung-bit.github.io/bwts-egcs-maintenance/</div></div>`;
  } catch (e) {
    toast('리포트 만들기 실패: ' + (e.message || e));
    return;
  }
  gmailDraft({ to: TO, subject: `[환경기술파트] 검교정 만료·임박 리포트 (${ymd(new Date())})`, html });
}

export function calMailLink(style) {
  preloadGmail();
  return `<a href="#" onclick="calMail.draft(event)" title="${esc(TITLE)}" ` +
    `style="${style || 'text-decoration:none;background:#eff6ff;border:1px solid #93c5fd;border-radius:8px;padding:5px 12px;font-size:12px;font-weight:600;color:#1d4ed8'}">✉ 리포트 메일</a>`;
}

window.calMail = { draft };
