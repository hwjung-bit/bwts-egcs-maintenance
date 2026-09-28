// 🗓 선박스케줄 사이드 패널 — KMTC 스케줄 웹앱(별도 리포 hwjung-bit/kmtc-schedule)을
// 오른쪽 패널 iframe 으로 띄운다. 탭이 아니라 패널이라 다른 탭을 보면서 같이 쓰고,
// 닫아도 iframe 을 숨기기만 해서 다시 열 때 재로딩하지 않는다.
// 같은 origin(hwjung-bit.github.io)이라 스케줄 앱 로그인 세션을 그대로 쓴다.
// Supabase 프로젝트가 달라 auth 저장 키(sb-<ref>-auth-token)도 겹치지 않는다.
import { $ } from '../core/dom.js';

const URL = 'https://hwjung-bit.github.io/kmtc-schedule/';

function toggle(open) {
  const p = $('schedPanel');
  const on = open ?? !p.classList.contains('open');
  if (on && !$('schedFrame').src) $('schedFrame').src = URL;   // lazy — first open only
  p.classList.toggle('open', on);
  $('schedBtn').classList.toggle('active', on);
}

export function initSchedPanel() {
  const p = document.createElement('aside');
  p.id = 'schedPanel';
  p.innerHTML =
    '<div class="sp-head"><b>🗓 선박스케줄</b><span class="spacer"></span>' +
    `<a href="${URL}" target="_blank" rel="noopener" title="새 창으로 열기">↗</a>` +
    '<button id="schedClose" title="닫기 (Esc)">✕</button></div>' +
    '<iframe id="schedFrame" title="KMTC 선박스케줄"></iframe>';
  document.body.appendChild(p);
  $('schedBtn').onclick = () => toggle();
  $('schedClose').onclick = () => toggle(false);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') toggle(false); });
}
