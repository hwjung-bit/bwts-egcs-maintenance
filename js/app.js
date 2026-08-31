// Boot: module-cache check → thresholds → auth → router → version watch.
//
// index.html loads this as <script type="module" src="js/app.js?v=BUILD">.
// The ?v= keeps app.js itself fresh, but the modules it imports have no query
// and GitHub Pages caches them for 10 minutes. js/version.js carries the
// BUILD the modules were deployed with: if it differs from our ?v we are
// running a fresh shell on stale modules — re-fetch them bypassing the cache
// and reload once. version.json (fetched no-store) additionally tells a tab
// that has been open for a while that a newer build exists.
import { BUILD, FILES } from './version.js';
import { $, toast } from './core/dom.js';
import { loadThresholds } from './shared/thresholds.js';
import { initAuth } from './core/auth.js';
import { initRouter, ROUTER_BUILD } from './core/router.js';

const V = new URL(import.meta.url).searchParams.get('v') || 'dev';
window.APP_VERSION = V;
const RELOAD_KEY = 'bwts_cache_reload_for';

function fatal(msg, e) {
  console.error(msg, e);
  $('view').innerHTML = `<div class="tab-error"><b>⚠ 앱 시작 실패</b>${msg}<code>${(e && (e.stack || e.message)) || ''}</code></div>`;
}

/* Fresh shell, stale modules → refresh the HTTP cache for every module and
   reload. Guarded by sessionStorage so a broken deploy cannot loop. */
async function healModuleCache() {
  // ROUTER_BUILD is undefined when the cached router.js predates this check.
  const stale = BUILD !== V || ROUTER_BUILD !== V;
  if (V === 'dev' || !stale) return false;
  let last = null;
  try { last = sessionStorage.getItem(RELOAD_KEY); } catch (e) { /* ignore */ }
  if (last === V) {
    console.warn(`[app] module BUILD ${BUILD} ≠ shell ${V} after reload — giving up, showing banner`);
    showBanner(`모듈 캐시가 오래됐습니다 (version ${BUILD} / router ${ROUTER_BUILD || '구버전'} / 셸 ${V}) — Ctrl+Shift+R 로 강력 새로고침`);
    return false;
  }
  $('view').innerHTML = '<div class="loading"><span class="spin"></span> 새 버전 적용 중 (모듈 캐시 갱신)...</div>';
  await Promise.all(FILES.map(f => fetch(f, { cache: 'reload' }).catch(() => null)));
  try { sessionStorage.setItem(RELOAD_KEY, V); } catch (e) { /* ignore */ }
  location.reload();
  return true;
}

function showBanner(text) {
  if ($('verBanner')) return;
  const b = document.createElement('div');
  b.id = 'verBanner'; b.className = 'ver-banner';
  b.textContent = text;
  b.onclick = () => location.reload();
  document.body.prepend(b);
}

async function checkVersion() {
  try {
    const res = await fetch('version.json', { cache: 'no-store' });
    if (!res.ok) return;
    const { v } = await res.json();
    if (v && v !== V) {
      // Pull the new shell too, then let healModuleCache handle the modules
      await fetch('index.html', { cache: 'reload' }).catch(() => null);
      showBanner(`새 버전(${v})이 배포됐습니다 — 클릭하여 새로고침 (현재 ${V})`);
    }
  } catch (e) { /* offline — ignore */ }
}

(async () => {
  if (await healModuleCache()) return;
  try { sessionStorage.removeItem(RELOAD_KEY); } catch (e) { /* ignore */ }
  const meta = document.querySelector('.header .meta');
  if (meta) meta.textContent = `V3 — Supabase + GitHub Pages · ${V}`;
  try {
    await loadThresholds(V);
  } catch (e) {
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
