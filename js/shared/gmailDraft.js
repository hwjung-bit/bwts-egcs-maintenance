// Gmail 임시보관 메일을 HTML 본문 그대로 만든다 (Gmail API drafts.create).
// 권한은 브라우저에서 Google 로그인 창으로 받는다 — gmail.compose 하나, 토큰은 메모리에만
// (약 1시간). 서버·상시 열린 입구 없음. OAuth 클라이언트 = etp-auto-reply 웹 클라이언트
// (JavaScript 원본에 https://hwjung-bit.github.io 등록돼 있어야 함).
import { toast } from '../core/dom.js';

const CLIENT_ID = '893810824035-lp9dfkq4a2onno6vnc94s29s0gehvo64.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/gmail.compose';
const OWNER = 'hwjung@ekmtc.com';

let token = null;      // { value, exp }
let gisLoading = null;

function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (!gisLoading) {
    gisLoading = new Promise((ok, fail) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.onload = ok;
      s.onerror = () => { gisLoading = null; fail(new Error('Google 로그인 스크립트 로드 실패')); };
      document.head.appendChild(s);
    });
  }
  return gisLoading;
}
// 탭을 열 때 미리 불러 둔다 — 클릭 순간엔 동기로 권한 창을 띄워야 팝업 차단을 안 맞는다
export function preloadGmail() { loadGis().catch(() => {}); }

const hasToken = () => token && token.exp > Date.now() + 60000;

function requestToken() {
  return new Promise((ok, fail) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      login_hint: OWNER,
      callback: r => {
        if (r.error) { fail(new Error(r.error)); return; }
        token = { value: r.access_token, exp: Date.now() + (r.expires_in || 3600) * 1000 };
        ok();
      },
      error_callback: e => fail(new Error(e.type || 'popup')),
    });
    client.requestAccessToken({ prompt: '' });
  });
}

// UTF-8 → base64 (헤더 RFC 2047 / 본문)
const b64 = s => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const b64url = s => b64(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function mime({ to, cc, subject, html }) {
  const body = b64(html).replace(/.{76}/g, '$&\r\n');
  return [
    `To: ${to}`,
    cc ? `Cc: ${cc}` : null,
    `Subject: =?UTF-8?B?${b64(subject)}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].filter(l => l !== null).join('\r\n');
}

async function createDraft(msg) {
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token.value}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { raw: b64url(mime(msg)) } }),
  });
  if (r.status === 401) { token = null; throw new Error('권한 만료 — 다시 눌러 주세요'); }
  if (!r.ok) throw new Error(`Gmail ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).message.id;
}

const draftUrl = id => `https://mail.google.com/mail/u/0/#drafts?compose=${id}`;

// 클릭 핸들러에서 동기로 호출할 것.
// 토큰이 있으면: 빈 탭을 먼저 열고(제스처 안) 초안이 생기면 그 탭을 초안으로 보낸다.
// 토큰이 없으면: 권한 창이 제스처를 쓰므로 초안 생성 뒤 탭 열기가 막힐 수 있다 → 링크 토스트.
export function gmailDraft(msg) {
  if (!window.google?.accounts?.oauth2) { toast('Google 로그인 준비 중 — 잠시 후 다시'); preloadGmail(); return; }
  if (hasToken()) {
    const w = window.open('about:blank', '_blank');
    createDraft(msg)
      .then(id => {
        if (w) w.location.href = draftUrl(id); else window.open(draftUrl(id), '_blank');
        toast('임시보관함에 저장됨 — 확인 후 보내기');
      })
      .catch(e => { if (w) w.close(); toast(String(e.message || e)); });
    return;
  }
  requestToken()
    .then(() => createDraft(msg))
    .then(id => {
      const w = window.open(draftUrl(id), '_blank');
      toast(w ? '임시보관함에 저장됨 — 확인 후 보내기'
        : '임시보관함에 저장됨 — Gmail 임시보관함에서 열어 주세요');
    })
    .catch(e => toast(String(e.message || e)));
}
