// Ship master helpers over S.SHIPS (Supabase ships table).
import { S } from '../core/state.js';
import { esc } from '../core/dom.js';

/** Visible ships in configured order → codes. Used by every tab. */
export function getShipOrder() {
  return S.SHIPS.filter(s => !s.hidden)
    .sort((a, b) => (a.sort_order || 999) - (b.sort_order || 999))
    .map(s => s.code);
}

export function shipByCode(code) {
  return S.SHIPS.find(s => s.code === code) || null;
}

/** Sort ship codes by master order; unknown codes go last */
export function sortByShipOrder(codes) {
  const order = getShipOrder();
  return codes.slice().sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
}

/* Combo(수기+선택) 입력용 공유 datalist. 등록 폼의 선박/시스템 select 를
   <input list="dlShips"> 로 바꿔 타이핑 자동완성과 목록 선택을 둘 다 지원한다.
   모달 열 때마다 호출해 최신 선박 목록으로 갱신. */
export function ensureDatalists() {
  let dl = document.getElementById('dlShips');
  if (!dl) { dl = document.createElement('datalist'); dl.id = 'dlShips'; document.body.appendChild(dl); }
  dl.innerHTML = getShipOrder().map(c => {
    const s = shipByCode(c);
    return `<option value="${esc(c)}">${esc(s && s.name ? s.name : '')}</option>`;
  }).join('');
  let ds = document.getElementById('dlSystems');
  if (!ds) {
    ds = document.createElement('datalist');
    ds.id = 'dlSystems';
    ds.innerHTML = '<option value="BWTS"></option><option value="EGCS"></option>';
    document.body.appendChild(ds);
  }
}

/** 대문자 보정 + 등록 여부 확인. 미등록 코드면 null (등록은 선박관리에서). */
export function normalizeShipCode(raw) {
  const code = String(raw || '').trim().toUpperCase();
  return getShipOrder().includes(code) ? code : null;
}

/** <option> list for ship codes present in rows (rows[].ship_code) */
export function shipOptions(rows, allLabel) {
  const set = {};
  rows.forEach(r => { if (r.ship_code) set[r.ship_code] = 1; });
  return `<option value="">${esc(allLabel || '전체 선박')}</option>` +
    sortByShipOrder(Object.keys(set)).map(c => `<option>${esc(c)}</option>`).join('');
}
