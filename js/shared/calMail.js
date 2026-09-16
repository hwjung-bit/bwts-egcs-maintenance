// 검교정 만료·임박 리포트 메일 = scripts/weekly_cal_alert.py (매주 월요일 08:00 자동).
// Actions 페이지의 "Run workflow" 로 지금 바로 보낼 수 있다 (1분 내 내 메일함).
// 프론트에 토큰을 두지 않으므로 메일 수집 버튼과 같은 방식 — 링크만 연다.
import { esc } from '../core/dom.js';

export const CAL_MAIL_URL = 'https://github.com/hwjung-bit/bwts-egcs-maintenance/actions/workflows/weekly-cal-alert.yml';
const TITLE = '검교정 만료·임박 리포트를 지금 메일로 — GitHub Actions 열림 → 「Run workflow」 클릭 → 1분 내 내 메일함';

export function calMailLink(style) {
  return `<a href="${CAL_MAIL_URL}" target="_blank" onclick="event.stopPropagation()" title="${esc(TITLE)}" ` +
    `style="${style || 'text-decoration:none;background:#eff6ff;border:1px solid #93c5fd;border-radius:8px;padding:5px 12px;font-size:12px;font-weight:600;color:#1d4ed8'}">✉ 리포트 메일</a>`;
}
