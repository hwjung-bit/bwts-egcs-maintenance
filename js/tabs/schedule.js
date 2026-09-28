// 🗓 선박스케줄 — KMTC 스케줄 웹앱(별도 리포 hwjung-bit/kmtc-schedule)을 iframe 으로 띄운다.
// 같은 origin(hwjung-bit.github.io)이라 스케줄 앱 로그인 세션을 그대로 쓴다.
// Supabase 프로젝트가 달라 auth 저장 키(sb-<ref>-auth-token)도 겹치지 않는다.
import { $ } from '../core/dom.js';

const URL = 'https://hwjung-bit.github.io/kmtc-schedule/';

function fit() {
  const f = $('schedFrame');
  if (!f) return;
  const top = f.getBoundingClientRect().top + window.scrollY;
  f.style.height = Math.max(480, window.innerHeight - top - 8) + 'px';
}

function mount(root) {
  root.innerHTML =
    '<div class="wrap" style="padding-bottom:0">' +
    `<div class="muted" style="font-size:11px;margin-bottom:4px;text-align:right">` +
    `<a href="${URL}" target="_blank" rel="noopener">↗ 새 창으로 열기</a></div>` +
    `<iframe id="schedFrame" src="${URL}" title="KMTC 선박스케줄" ` +
    'style="width:100%;border:1px solid #e2e8f0;border-radius:8px;display:block"></iframe></div>';
  window.addEventListener('resize', fit);
}

function refresh() { fit(); }

function destroy() { window.removeEventListener('resize', fit); }

export default { id: 'schedule', mount, refresh, destroy };
