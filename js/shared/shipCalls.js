// 선박별 다음 입항 예정 — KMTC 스케줄 웹앱(hwjung-bit/kmtc-schedule)의 Supabase 를
// anon 키로 직접 읽는다 (스케줄 앱·kmtc-schedule MCP 와 같은 schedules 테이블).
// 메일 버튼은 클릭 순간 동기로 써야 하므로 탭을 열 때 미리 받아 둔다.
const URL = 'https://zfwdipsgdfrqkjjjajgz.supabase.co/rest/v1/schedules';
const KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inpmd2RpcHNnZGZycWtqamphamd6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQwMDY1MjgsImV4cCI6MjA5OTU4MjUyOH0.cznJchy7AQyF29jvfwIM0Ou-hA_0gM5Eosoc-AuLHDY';
const DAYS = 60;

let calls = null;      // code → [{ port, eta: Date }]
let loading = null;

export function loadShipCalls(codes) {
  if (calls || loading || !codes.length) return loading;
  const now = new Date();
  const end = new Date(now.getTime() + DAYS * 86400000);
  const q = new URLSearchParams({
    select: 'vessel_code,port_name,eta',
    vessel_code: `in.(${codes.join(',')})`,
    skip: 'eq.false',
    order: 'eta.asc',
    limit: '1000',
  });
  q.append('eta', 'gte.' + now.toISOString());
  q.append('eta', 'lte.' + end.toISOString());
  loading = fetch(`${URL}?${q}`, { headers: { apikey: KEY } })
    .then(r => (r.ok ? r.json() : []))
    .then(rows => {
      calls = {};
      rows.forEach(r => {
        const list = calls[r.vessel_code] || (calls[r.vessel_code] = []);
        const port = String(r.port_name || '').split(',')[0].replace(/\s+(NEW\s+)?(CONTAINER\s+)?(TMNL|TERMINAL)$/i, '').trim();
        if (list.length && list[list.length - 1].port === port) return;   // same port, next berth
        list.push({ port, eta: new Date(r.eta) });
      });
    })
    .catch(() => { calls = {}; })
    .finally(() => { loading = null; });
  return loading;
}

export const shipCallsReady = () => calls !== null;

// 다음 n개 기항 (KST 날짜)
export function nextCalls(code, n = 3) {
  return ((calls && calls[code]) || []).slice(0, n).map(c => {
    const k = new Date(c.eta.getTime() + 9 * 3600000);
    return { port: c.port, date: `${k.getUTCMonth() + 1}/${k.getUTCDate()}` };
  });
}
