// Drive folder matching + attachment popups, shared by mail and repairs.
//
// Indexed folders are named "YYYY-MM-DD <mail subject>" under the ship
// folder, so a repair matches on ship + system + date, and the subject
// settles ties when one day holds several folders.
import { S } from '../core/state.js';
import { sb, dbSave } from '../core/supabase.js';
import { $, esc, toast, placePopup } from '../core/dom.js';
import { dayGap } from './dates.js';

export function normTitle(s) {
  return String(s == null ? '' : s).toUpperCase()
    // Reply/forward markers and [KMTC SM][ETP] style tags are noise
    .replace(/\b(RE|FW|FWD)\s*:/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[^0-9A-Z가-힣]+/g, '');
}
function trigrams(s) {
  const out = {};
  for (let i = 0; i + 3 <= s.length; i++) out[s.slice(i, i + 3)] = 1;
  return out;
}
export function titleOverlap(a, b) {
  if (!a || !b) return 0;
  if (a.indexOf(b) >= 0 || b.indexOf(a) >= 0) return 1;
  const ta = trigrams(a), tb = trigrams(b);
  const ka = Object.keys(ta), kb = Object.keys(tb);
  if (!ka.length || !kb.length) return 0;
  let hit = 0;
  ka.forEach(k => { if (tb[k]) hit++; });
  // Shorter side as denominator — folder titles are truncated
  return hit / Math.min(ka.length, kb.length);
}

/* A wrong folder is worse than none, so a date this close is not
   enough on its own: the title has to agree, unless that day holds
   exactly one folder for the ship. */
export function findDriveFolder(r) {
  const want = normTitle(r.symptom || r.email_subject);
  const cand = S.DRIVE_FOLDERS.filter(f =>
    f.ship_code === r.ship_code && f.system === r.system && dayGap(f.folder_date, r.date) <= 3);
  if (!cand.length) return null;
  const sameDay = cand.filter(f => f.folder_date === r.date);
  let best = null, bestSim = -1;
  cand.forEach(f => {
    let sim = titleOverlap(want, normTitle(f.title));
    if (f.folder_date === r.date) sim += 0.15;   // same day wins ties
    if (sim > bestSim) { bestSim = sim; best = f; }
  });
  if (bestSim >= 0.35) return best;
  if (sameDay.length === 1) return sameDay[0];
  return null;
}

/* Ship folder for the fallback link. Rows copied from 메일대장 have no
   file_url, so derive it from the index — parent_id is the ship folder. */
export function shipFolderUrl(r) {
  if (r.file_url) return r.file_url;
  const f = S.DRIVE_FOLDERS.find(x => x.ship_code === r.ship_code && x.system === r.system);
  return f ? 'https://drive.google.com/drive/folders/' + f.parent_id : '';
}

/* The GAS side owns folder creation, so ask it for one instead of
   making it here. Skipped when the index already has a match, and
   repair_id is the primary key, so a row can only queue once. */
export async function requestDriveFolder(r) {
  if (!r.ship_code) return;
  const hit = findDriveFolder(r);
  if (hit) {
    // 색인에 이미 있는 폴더면 큐에 넣을 필요는 없다. 다만 그 id 를 이 건에
    // 남겨 둬야 한다 — 안 남기면 knownFolderId 가 찾을 곳이 없다.
    if (hit.id && !r.file_url) {
      const url = 'https://drive.google.com/drive/folders/' + hit.id;
      const saved = await dbSave(sb.from('repairs').update({ file_url: url }).eq('id', r.id));
      if (saved) r.file_url = url;
    }
    return;
  }
  const res = await sb.from('folder_requests').upsert({
    repair_id: r.id,
    ship_code: r.ship_code,
    system: r.system || 'BWTS',
    req_date: r.date || null,
    title: r.symptom || r.email_subject || '',
    status: 'pending',
    msg_id: r.source_msg_id || null,
  }, { onConflict: 'repair_id', ignoreDuplicates: true });
  if (res.error) toast('폴더 요청 실패: ' + res.error.message);
}

/* 확실히 이 건의 것이라고 말할 수 있는 폴더 id 만 돌려준다.
   findDriveFolder 는 근사매칭이라 휴지통 경로에는 쓰지 않는다. */
export async function knownFolderId(r) {
  const m = /\/folders\/([A-Za-z0-9_-]+)/.exec(r.file_url || '');
  if (m) return m[1];
  const q = await sb.from('folder_requests').select('folder_id').eq('repair_id', r.id).maybeSingle();
  if (q.error || !q.data) return null;
  return q.data.folder_id || null;
}

/* ===== Repair attachments (Drive links kept on the row) ===== */
export function repairAtts(r) {
  let a = r.attachments;
  if (!a) return [];
  if (typeof a === 'string') {
    try { a = JSON.parse(a); } catch (e) { return []; }
  }
  if (!Array.isArray(a)) return [];
  return a.filter(x => x && x.name);
}

export function showAtts(id, ev) {
  ev.stopPropagation();
  const r = S.REPAIRS.find(x => x.id === id);
  if (!r) return;
  const pop = $('attPop');
  pop.innerHTML = repairAtts(r).map(x => x.url
    ? `<a href="${esc(x.url)}" target="_blank">📄 ${esc(x.name)}</a>`
    : `<div style="padding:4px 6px;color:#64748b">📄 ${esc(x.name)}</div>`
  ).join('') || '<div style="padding:4px 6px;color:#64748b">첨부 없음</div>';
  pop.style.display = 'block';
  const top = Math.min(ev.clientY + 12, window.innerHeight - pop.offsetHeight - 12);
  const left = Math.min(ev.clientX - 300, window.innerWidth - 356);
  pop.style.top = Math.max(12, top) + 'px';
  pop.style.left = Math.max(12, left) + 'px';
}

window.driveUi = { showAtts };
