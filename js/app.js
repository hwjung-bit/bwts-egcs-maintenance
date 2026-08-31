// Boot: thresholds → auth → router → version watch.
// index.html loads this as  <script type="module" src="js/app.js?v=YYYYMMDDx">
// and version.json carries the same value; a mismatch means GitHub Pages
// (max-age=600) served a stale shell, so we show a reload banner instead of
// leaving the user on old code without knowing.
import { $, toast } from './core/dom.js';
import { loadThresholds } from './shared/thresholds.js';
import { initAuth } from './core/auth.js';
import { initRouter } from './core/router.js';

const V = new URL(import.meta.url).searchParams.get('v') || 'dev';
window.APP_VERSION = V;

function fatal(msg, e) {
  console.error(msg, e);
  $('view').innerHTML = `<div class="tab-error"><b>⚠ 앱 시작 실패</b>${msg}<code>${(e && (e.stack || e.message)) || ''}</code></div>`;
}

async function checkVersion() {
  try {
    const res = await fetch('version.json', { cache: 'no-store' });
    if (!res.ok) return;
    const { v } = await res.json();
    if (v && v !== V && !$('verBanner')) {
      const b = document.createElement('div');
      b.id = 'verBanner'; b.className = 'ver-banner';
      b.textContent = `새 버전(${v})이 배포됐습니다 — 클릭하여 새로고침 (현재 ${V})`;
      b.onclick = () => location.reload(true);
      document.body.prepend(b);
    }
  } catch (e) { /* offline — ignore */ }
}

(async () => {
  const meta = document.querySelector('.header .meta');
  if (meta) meta.textContent = `V3 — Supabase + GitHub Pages · ${V}`;
  try {
    await loadThresholds(V);
  } catch (e) {
    // Tabs that need thresholds will show their own error card; the rest work.
    toast('임계값 로드 실패 — 검교정 탭 판정 불가');
    console.error(e);
  }
  try {
    initAuth();
    initRouter(V);
  } catch (e) {
    fatal('core 모듈 초기화 중 오류', e);
    return;
  }
  checkVersion();
  setInterval(checkVersion, 10 * 60 * 1000);
})();
