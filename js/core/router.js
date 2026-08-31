// Tab router. Each tab is an ES module loaded on demand; a broken tab shows
// its own error card and leaves the rest of the app working.
//
// Tab module contract (js/tabs/*.js default export):
//   { id,
//     mount(root)          build static DOM once (filters, table skeleton)
//     refresh()            fill from state S — after mount and on 'data:loaded'
//     setParams?(params)   optional, before refresh, for cross-tab navigation
//     destroy?()           optional cleanup }
import { $, esc } from './dom.js';
import { S } from './state.js';

// Tab bar order. Adding a tab = one line here + one file in js/tabs/.
export const TABS = [
  { id: 'home',    label: '🏠 종합' },
  { id: 'mail',    label: '📧 메일대장' },
  { id: 'repairs', label: '🔧 수리이력' },
  { id: 'status',  label: '📊 현황' },
  { id: 'bwtsLog', label: '🧪 BWTS 로그' },
  { id: 'bwtsCal', label: 'BWTS 검교정' },
  { id: 'egcsCal', label: 'EGCS 검교정' },
  { id: 'ships',   label: '🚢 선박관리' },
];

const mods = {};            // id → module default export, or Error
let active = null;          // { id, mod, root, mounted }
let V = 'dev';

export function initRouter(version) {
  V = version || 'dev';
  const bar = $('mainTabs');
  bar.innerHTML = TABS.map(t =>
    `<div class="tab" data-tab="${t.id}">${esc(t.label)}</div>`).join('');
  bar.querySelectorAll('.tab').forEach(el => {
    el.onclick = () => switchTab(el.dataset.tab);
  });
  document.addEventListener('data:loaded', () => refresh());
  const first = (location.hash || '').replace('#', '');
  switchTab(TABS.some(t => t.id === first) ? first : 'home');
}

async function loadModule(id) {
  if (mods[id]) return mods[id];
  try {
    const m = await import(`../tabs/${id}.js?v=${V}`);
    if (!m.default || typeof m.default.mount !== 'function' || typeof m.default.refresh !== 'function')
      throw new Error('모듈 형식 오류 — default export 에 mount/refresh 필요');
    mods[id] = m.default;
  } catch (e) {
    console.error('[router] tab load failed:', id, e);
    mods[id] = e;
  }
  return mods[id];
}

function errorCard(id, e) {
  return `<div class="tab-error"><b>⚠ "${esc(id)}" 탭 오류</b>
    이 탭만 문제이며 다른 탭은 정상 동작합니다. 새로고침 후에도 반복되면 관리자에게 알려주세요.
    <code>${esc(e && (e.stack || e.message || e))}</code></div>`;
}

export async function switchTab(id, params) {
  document.querySelectorAll('#mainTabs .tab').forEach(el =>
    el.classList.toggle('active', el.dataset.tab === id));
  if (location.hash !== '#' + id) history.replaceState(null, '', '#' + id);

  const root = $('view');
  if (active && active.mod && active.mod.destroy && active.id !== id) {
    try { active.mod.destroy(); } catch (e) { console.warn(e); }
  }
  const mod = await loadModule(id);
  if (mod instanceof Error) {
    root.innerHTML = errorCard(id, mod);
    active = { id, mod: null, root, mounted: false };
    return;
  }
  active = { id, mod, root, mounted: false };
  if (params && mod.setParams) mod.setParams(params);
  refresh();
}

/* Cross-tab navigation, e.g. mail → repairs filtered by ship */
export function go(id, params) { return switchTab(id, params); }

export function refresh() {
  if (!active || !active.mod) return;
  const { mod, root } = active;
  if (!S.loaded) {
    root.innerHTML = S.USER
      ? '<div class="loading"><span class="spin"></span> 로딩...</div>'
      : '<div class="loading">로그인이 필요합니다 — 우측 상단 [Google 로그인]</div>';
    active.mounted = false;
    return;
  }
  try {
    if (!active.mounted) {
      root.innerHTML = '';
      mod.mount(root);
      active.mounted = true;
    }
    mod.refresh();
  } catch (e) {
    console.error(e);
    root.innerHTML = errorCard(active.id, e);
    active.mounted = false;
    return;
  }
  setTimeout(fixStickyHeaders, 50);
}

export function currentTab() { return active ? active.id : null; }

/* Sticky header/filters/th stacking — measured, not hardcoded */
export function fixStickyHeaders() {
  const view = $('view');
  if (!view || !active) return;
  const header = document.querySelector('.header');
  const tabs = document.querySelector('.tabs');
  const headerH = header ? header.getBoundingClientRect().height : 0;
  const tabsH = tabs ? tabs.getBoundingClientRect().height : 0;
  if (tabs) tabs.style.top = headerH + 'px';
  let stickyTop = headerH + tabsH;
  const stats = view.querySelector('.stats');
  if (stats) {
    Object.assign(stats.style, { position: 'sticky', top: stickyTop + 'px', zIndex: '98', background: '#f1f5f9' });
    stickyTop += stats.getBoundingClientRect().height;
  }
  const filters = view.querySelector('.filters');
  if (filters) {
    Object.assign(filters.style, { position: 'sticky', top: stickyTop + 'px', zIndex: '97', background: '#fff' });
    stickyTop += filters.getBoundingClientRect().height;
  }
  if (active.id === 'egcsCal') return;   // needs overflow-x scroll
  view.querySelectorAll('div').forEach(el => {
    const ov = getComputedStyle(el).overflowX;
    if (ov === 'auto' || ov === 'scroll') el.style.overflowX = 'visible';
  });
  view.querySelectorAll('th').forEach(th => {
    Object.assign(th.style, { position: 'sticky', top: stickyTop + 'px', zIndex: '96', background: '#f8fafc', boxShadow: '0 1px 0 #e2e8f0' });
  });
}
