// 선박별 다음 입항 예정 — KMTC 스케줄 웹앱(hwjung-bit/kmtc-schedule)의 Supabase 를
// anon 키로 직접 읽는다 (스케줄 앱·kmtc-schedule MCP 와 같은 schedules 테이블).
// 메일 버튼은 클릭 순간 동기로 써야 하므로 탭을 열 때 미리 받아 둔다.
const URL = 'https://zfwdipsgdfrqkjjjajgz.supabase.co/rest/v1/schedules';
const KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inpmd2RpcHNnZGZycWtqamphamd6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQwMDY1MjgsImV4cCI6MjA5OTU4MjUyOH0.cznJchy7AQyF29jvfwIM0Ou-hA_0gM5Eosoc-AuLHDY';
const DAYS = 60;

let calls = null;      // code → [{ port, eta: Date }]
let loading = null;

// 검교정 방선 대상 항 = 한국 전 항 + 상해·칭따오 + 미주. 나머지 기항은 메일에 안 넣는다.
// 터미널 코드(PNC 등)는 부모 항으로 합친다 (스케줄 앱·MCP 의 PORT_CONSOLIDATE 와 같게).
const TARGET = {
  PUS: '부산', PNC: '부산', USN: '울산', KAN: '광양', INC: '인천', PTK: '평택',
  KPO: '포항', DSN: '대산', SHA: '상해', TAO: '칭따오',
  LGB: '롱비치', LAX: 'LA', OAK: '오클랜드', SEA: '시애틀', TIW: '타코마',
};
export const TARGET_LABEL = '한국·상해·칭따오·미주';

export function loadShipCalls(codes) {
  if (calls || loading || !codes.length) return loading;
  const now = new Date();
  const end = new Date(now.getTime() + DAYS * 86400000);
  const q = new URLSearchParams({
    select: 'vessel_code,port_code,eta',
    vessel_code: `in.(${codes.join(',')})`,
    port_code: `in.(${Object.keys(TARGET).join(',')})`,
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
        const port = TARGET[r.port_code] || r.port_code;
        if (list.length && list[list.length - 1].port === port) return;   // same port, next berth
        list.push({ port, eta: new Date(r.eta) });
      });
    })
    .catch(() => { calls = {}; })
    .finally(() => { loading = null; });
  return loading;
}

export const shipCallsReady = () => calls !== null;

// 대상 항 다음 n개 기항 (KST 날짜). 부산은 기간 안에 있으면 n개 밖이라도 붙인다.
export function nextCalls(code, n = 3) {
  const all = (calls && calls[code]) || [];
  const picked = all.slice(0, n);
  const pus = all.find(c => c.port === '부산');
  if (pus && !picked.includes(pus)) picked.push(pus);
  return picked.map(c => {
    const k = new Date(c.eta.getTime() + 9 * 3600000);
    return { port: c.port, date: `${k.getUTCMonth() + 1}/${k.getUTCDate()}` };
  });
}
