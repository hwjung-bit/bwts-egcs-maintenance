// Supabase client + the single write gate.
// The anon key is public by design; RLS (sql/014) only lets authenticated
// @ekmtc.com users read or write.
import { toast } from './dom.js';

export const SUPA_URL = 'https://ivsjskywdtsnoxhnozcd.supabase.co';
export const SUPA_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml2c2pza3l3ZHRzbm94aG5vemNkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ2MDE4NjIsImV4cCI6MjEwMDE3Nzg2Mn0.5sF-TSA0WEeR5zj2gSJGuJPiCWWqke_SQB50Mt0Qvec';
export const PAGES_URL = 'https://hwjung-bit.github.io/bwts-egcs-maintenance/';

if (!window.supabase) {
  throw new Error('supabase-js CDN 로드 실패 — 네트워크/차단 확인');
}
export const sb = window.supabase.createClient(SUPA_URL, SUPA_ANON);

// Set by auth.js so dbSave can refuse writes before login without
// importing state.js (keeps this module free of import cycles).
let loggedIn = () => false;
export function setLoginCheck(fn) { loggedIn = fn; }

/* Every write passes through here.
   supabase-js resolves {error} instead of throwing, so try/catch never
   sees a failure. Check once, here. */
export async function dbSave(q, okMsg) {
  if (!loggedIn()) { toast('로그인 필요'); return false; }
  const res = await q;
  if (res.error) { toast('저장 실패: ' + res.error.message); return false; }
  if (okMsg) toast(okMsg);
  return true;
}
