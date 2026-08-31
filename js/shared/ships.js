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

/** <option> list for ship codes present in rows (rows[].ship_code) */
export function shipOptions(rows, allLabel) {
  const set = {};
  rows.forEach(r => { if (r.ship_code) set[r.ship_code] = 1; });
  return `<option value="">${esc(allLabel || '전체 선박')}</option>` +
    sortByShipOrder(Object.keys(set)).map(c => `<option>${esc(c)}</option>`).join('');
}
