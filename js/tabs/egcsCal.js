// EGCS 검교정 — WMS1/WMS2 sensor matrix. Cycles come from thresholds.json.
import { S } from '../core/state.js';
import { sb, dbSave } from '../core/supabase.js';
import { $, esc, placePopup } from '../core/dom.js';
import { requireTH } from '../shared/thresholds.js';
import { daysUntil, addMonths, dLabel } from '../shared/dates.js';
import { getShipOrder, shipByCode } from '../shared/ships.js';

function getShipWms(code) {
  const s = shipByCode(code);
  const w = String(s && s.wms || '').toUpperCase();
  if (w.indexOf('TRI') >= 0) return 'TRIOS';
  if (w.indexOf('GI') >= 0 || w.indexOf('GREEN') >= 0) return 'GI';
  return '';
}
/* Infer the sensor model from WMS maker + sensor kind; GI PAH needs the
   model column because several models exist. */
export function sensorModel(code, equip, model, CYCLE) {
  const maker = getShipWms(code);
  const kind = /PAH/.test(equip) ? 'PAH' : /TURB/.test(equip) ? 'TURB' : 'PH';
  if (maker === 'TRIOS') return kind === 'PAH' ? 'enviroFlu' : (kind === 'TURB' ? 'TTurb' : 'TpH-D');
  if (maker === 'GI') {
    if (kind === 'TURB') return 'G6120';
    if (kind === 'PH') return 'G6130';
    return (model && CYCLE[model]) ? model : null;
  }
  return null;
}
function level(days, soon) {
  return days <= 0 ? 'expired' : (days <= soon ? 'soon' : 'ok');
}

function mount(root) {
  root.innerHTML = '<div class="wrap" id="egcsCalRoot"></div>';
}

function refresh() {
  const th = requireTH('egcs_calibration');
  const CYCLE = th.sensor_cycle_months;
  const SOON = th.soon_days;
  if (!S.EGCS_CAL.length) {
    $('egcsCalRoot').innerHTML = '<div class="loading">EGCS 검교정 없음</div>';
    return;
  }
  const shipSet = {}, equipSet = {}, map = {};
  S.EGCS_CAL.forEach(c => {
    shipSet[c.ship_code] = 1;
    const eq = (c.equip || '').replace('-', '/');   // WMS1-PH → WMS1/PH
    equipSet[eq] = 1;
    map[c.ship_code + '|' + eq] = c;
  });
  const ORDER = getShipOrder();
  const ships = Object.keys(shipSet).sort((a, b) => {
    const ia = ORDER.indexOf(a), ib = ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const orderedEquips = [];
  ['WMS1', 'WMS2'].forEach(g => ['PH', 'TURB', 'PAH'].forEach(s => {
    const key = g + '/' + s;
    if (equipSet[key]) orderedEquips.push({ group: g, sensor: s, key });
  }));
  Object.keys(equipSet).forEach(eq => {
    if (!orderedEquips.some(o => o.key === eq)) orderedEquips.push({ group: '기타', sensor: eq, key: eq });
  });

  const colg = '<colgroup><col style="width:72px">' + ships.map(() => '<col style="width:110px">').join('') + '</colgroup>';
  const thead = '<tr><th style="text-align:left;background:#f8fafc">장비</th>' + ships.map(s => `<th>${esc(s)}</th>`).join('') + '</tr>';
  let body = '', lastGroup = null;
  orderedEquips.forEach(o => {
    if (o.group !== lastGroup) {
      body += `<tr><th colspan="${ships.length + 1}" style="text-align:left;background:#eef2ff;color:#1d4ed8;font-weight:800;font-size:12px;padding:6px 10px">${esc(o.group)}</th></tr>`;
      lastGroup = o.group;
    }
    const tds = ships.map(s => {
      const d = map[s + '|' + o.key];
      if (!d) return '<td style="text-align:center;font-size:12px;color:#cbd5e1">—</td>';
      const sn = d.serial ? `<div style="font-size:10px;color:#64748b;margin-top:2px">S/N ${esc(d.serial)}</div>` : '';
      const mdl = d.model ? `<div style="font-size:10px;color:#64748b">${esc(d.model)}</div>` : '';
      const ed = ` onclick="egcsCalTab.edit('${esc(d.id)}',event)" title="클릭하여 수정"`;
      if (!d.last_date) {
        return `<td${ed} style="text-align:center;font-size:12px;cursor:pointer"><span style="color:#94a3b8">${esc(d.note || '—')}</span>${mdl}${sn}</td>`;
      }
      const sm = sensorModel(s, o.key, d.model, CYCLE);
      const cyc = sm ? CYCLE[sm] : null;
      if (!cyc) {
        return `<td${ed} style="text-align:center;font-size:12px;cursor:pointer"><div style="font-weight:700">${esc(d.last_date)}</div>${mdl}${sn}</td>`;
      }
      let calDays = null, calLv = 'unknown';
      if (cyc.cal != null) {
        calDays = daysUntil(addMonths(d.last_date, cyc.cal));
        calLv = level(calDays, SOON);
      }
      const replDays = daysUntil(addMonths(d.last_date, cyc.repl));
      const replLv = level(replDays, SOON);
      const replTag = (replLv === 'expired' || replLv === 'soon')
        ? `<div style="font-size:10px;font-weight:700;margin-top:2px" class="lv-${replLv}">신환 ${dLabel(replDays)}</div>` : '';
      const bgCls = cyc.cal != null ? calLv : replLv;
      const calTxt = cyc.cal != null ? `<div style="font-size:10px;opacity:.8">검 ${dLabel(calDays)}</div>` : '';
      return `<td class="lv-${bgCls}"${ed} style="text-align:center;font-size:12px;padding:4px 6px;cursor:pointer">` +
        `<div style="font-weight:700">${esc(d.last_date)}</div>${calTxt}${replTag}${mdl}${sn}</td>`;
    }).join('');
    body += `<tr><th style="text-align:left;background:#f8fafc;font-weight:700;font-size:12px">${esc(o.sensor)}</th>${tds}</tr>`;
  });
  $('egcsCalRoot').innerHTML =
    '<div style="margin-bottom:12px;color:#64748b;font-size:12px">TriOS: PAH·탁도 검4년·신환8년 / pH 2년 · GI: PAH 모델별 · 탁도 광원5년 · pH 1년 · 임박 ' + SOON + '일</div>' +
    '<div style="overflow-x:auto"><table class="cal-table" style="width:auto;table-layout:fixed">' + colg + '<thead>' + thead + '</thead><tbody>' + body + '</tbody></table></div>' +
    '<div style="margin-top:8px;color:#94a3b8;font-size:11px">셀 클릭 → 검교정일·모델·S/N·비고 수정</div>';
}

/* ===== cell edit popup ===== */
function edit(id, ev) {
  ev.stopPropagation();
  const c = S.EGCS_CAL.find(x => x.id === id);
  if (!c) return;
  const pop = $('calEdit');
  pop.innerHTML =
    `<div style="font-weight:700;font-size:12px;margin-bottom:8px;color:#1e293b">${esc(c.ship_code)} · ${esc(c.equip)}</div>` +
    `<label>검교정일<input id="ceDate" type="date" value="${esc(c.last_date || '')}"></label>` +
    `<label>모델<input id="ceModel" value="${esc(c.model || '')}"></label>` +
    `<label>S/N<input id="ceSerial" value="${esc(c.serial || '')}"></label>` +
    `<label>비고<input id="ceNote" value="${esc(c.note || '')}"></label>` +
    '<div style="display:flex;gap:6px;margin-top:10px">' +
      `<button class="pri" onclick="egcsCalTab.save('${esc(id)}')">저장</button>` +
      '<button onclick="egcsCalTab.close()">취소</button></div>';
  placePopup(pop, ev, 260);
  $('ceDate').focus();
}
function close() { $('calEdit').style.display = 'none'; }

async function save(id) {
  const c = S.EGCS_CAL.find(x => x.id === id);
  if (!c) return;
  const vals = {
    last_date: $('ceDate').value || null,
    model: $('ceModel').value.trim(),
    serial: $('ceSerial').value.trim(),
    note: $('ceNote').value.trim(),
  };
  // 실제로 바뀐 칸만 보낸다 — 폼을 연 시점의 값을 통째로 쓰면
  // 그 사이 남이 고친 칸을 되돌려 버린다
  const patch = {};
  Object.keys(vals).forEach(k => {
    const cur = c[k] == null ? '' : String(c[k]);
    const nv = vals[k] == null ? '' : String(vals[k]);
    if (cur !== nv) patch[k] = vals[k];
  });
  if (!Object.keys(patch).length) { close(); return; }
  const ok = await dbSave(sb.from('calibrations').update(patch).eq('id', id), c.ship_code + ' ' + c.equip + ' 저장');
  if (!ok) return;
  Object.assign(c, patch);
  close();
  refresh();
}

window.egcsCalTab = { edit, close, save };

export default { id: 'egcsCal', mount, refresh, destroy: close };
