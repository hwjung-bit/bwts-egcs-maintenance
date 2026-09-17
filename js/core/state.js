// Shared in-memory state. Every tab reads from S and never keeps its own copy
// of table data, so a reload refreshes all tabs at once.
import { sb } from './supabase.js';
import { toast } from './dom.js';
import { TH } from '../shared/thresholds.js';

export const S = {
  USER: null,
  MAIL: [], REPAIRS: [], BWTS_CAL: [], EGCS_CAL: [], SHIPS: [], DRIVE_FOLDERS: [],
  TASKS: [], ACTIONS: [],   // 📋 업무: repairs 전체 + work_actions (sql/027)
  loaded: false,
  loading: false,
};

export function isLoggedIn() {
  return !!(S.USER && S.USER.email !== 'guest');
}

/* All six tables in parallel. A failed query keeps the previous value
   instead of wiping it with an empty array. Listeners re-render on
   'data:loaded' — the router uses it to refresh the active tab. */
export async function loadData() {
  if (!isLoggedIn()) { toast('로그인 필요'); return false; }
  if (S.loading) return false;
  S.loading = true;
  document.dispatchEvent(new CustomEvent('data:loading'));
  const limit = (TH && TH.mail && TH.mail.load_limit) || 2000;
  try {
    const [m, r, bc, ec, s, df, t, wa] = await Promise.all([
      sb.from('mail_log').select('*').order('date', { ascending: false }).limit(limit),
      // repairs 는 업무 테이블을 겸한다(sql/027). 이 앱의 수리이력·종합·메일
      // 전환은 BWTS/EGCS 건만 다루므로 여기서 한 번 걸러 S.REPAIRS 에 담는다.
      sb.from('repairs').select('*').in('system', ['BWTS', 'EGCS'])
        .order('date', { ascending: false }),
      sb.from('calibrations').select('*').eq('system', 'BWTS'),
      sb.from('calibrations').select('*').eq('system', 'EGCS'),
      sb.from('ships').select('*'),
      sb.from('drive_folders').select('*'),
      // 📋 업무 탭은 시스템 구분 없이 전체 (수리이력과 같은 행, 다른 필터)
      sb.from('repairs').select('*').order('date', { ascending: false }),
      sb.from('work_actions').select('*').order('date', { ascending: false }),
    ]);
    const failed = [];
    if (m.error) failed.push('메일대장'); else S.MAIL = m.data || [];
    if (r.error) failed.push('수리이력'); else S.REPAIRS = r.data || [];
    if (t.error) failed.push('업무'); else S.TASKS = t.data || [];
    if (wa.error) failed.push('조치이력'); else S.ACTIONS = wa.data || [];
    if (bc.error) failed.push('BWTS 검교정'); else S.BWTS_CAL = bc.data || [];
    if (ec.error) failed.push('EGCS 검교정'); else S.EGCS_CAL = ec.data || [];
    if (s.error) failed.push('선박'); else S.SHIPS = s.data || [];
    if (df.error) failed.push('Drive 폴더'); else S.DRIVE_FOLDERS = df.data || [];
    S.loaded = true;
    document.dispatchEvent(new CustomEvent('data:loaded', { detail: { failed } }));
    if (failed.length) toast('로드 실패: ' + failed.join(', '));
    else toast('데이터 로드 완료 (' + S.MAIL.length + '건)');
    return failed.length === 0;
  } catch (e) {
    toast('로드 실패: ' + e.message);
    document.dispatchEvent(new CustomEvent('data:loaded', { detail: { failed: ['all'], error: e } }));
    return false;
  } finally {
    S.loading = false;
  }
}
