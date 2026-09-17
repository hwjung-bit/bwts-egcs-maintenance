// Google OAuth via Supabase. Data is only loaded after login because RLS
// returns HTTP 200 + [] to anon — an empty screen that looks healthy.
import { sb, PAGES_URL, setLoginCheck } from './supabase.js';
import { S, isLoggedIn, loadData } from './state.js';
import { $ } from './dom.js';

setLoginCheck(isLoggedIn);

export function login() {
  sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: PAGES_URL },
  });
}
export function logout() { sb.auth.signOut(); }

function onLogin(session) {
  const user = session.user || session;
  S.USER = user;
  $('userInfo').textContent = user.email;
  $('userInfo').style.display = '';
  $('loginBtn').style.display = 'none';
  $('logoutBtn').style.display = '';
  // 📧 메일 수집 버튼은 메일대장 탭과 함께 제거됨(2026-09-18). 남아 있으면 보여주고, 없으면 무시.
  const collectBtn = $('collectBtn'); if (collectBtn) collectBtn.style.display = '';
  loadData();
}

export function showLoginRequired() {
  $('userInfo').textContent = '로그인이 필요합니다';
  $('userInfo').style.display = '';
  const v = $('view');
  if (v) v.innerHTML = '<div class="loading">로그인이 필요합니다 — 우측 상단 [Google 로그인]</div>';
}

export function initAuth() {
  $('loginBtn').onclick = login;
  $('logoutBtn').onclick = logout;
  sb.auth.getSession().then(res => {
    if (res.data.session) onLogin(res.data.session);
    else showLoginRequired();
  });
  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_IN' && session && !S.USER) onLogin(session);
    if (event === 'SIGNED_OUT') location.reload();
  });
}
