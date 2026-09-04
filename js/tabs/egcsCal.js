// EGCS 검교정 — WMS1/WMS2 sensor matrix. Cycles come from thresholds.json.
import { S } from '../core/state.js';
import { sb, dbSave } from '../core/supabase.js';
import { $, esc, placePopup, toast } from '../core/dom.js';
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
function fmtD(d) {
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function fmtMonths(m) {
  if (m == null) return '필요시';
  return m % 12 === 0 ? (m / 12) + '년' : m + '개월';
}
/* Sensor cycle rows for the reference table; months come from thresholds.json */
const CYCLE_ROWS = [
  { maker: 'TriOS', sensor: 'PAH', model: 'enviroFlu' },
  { maker: 'TriOS', sensor: '탁도', model: 'TTurb' },
  { maker: 'TriOS', sensor: 'pH', model: 'TpH-D' },
  { maker: 'GI', sensor: 'PAH', model: 'G6110' },
  { maker: 'GI', sensor: 'PAH', model: 'G6111' },
  { maker: 'GI', sensor: '탁도', model: 'G6120', note: '광원 수명' },
  { maker: 'GI', sensor: 'pH', model: 'G6130' },
];
function copyText(txt, msg) {
  navigator.clipboard.writeText(txt).then(() => toast(msg))
    .catch(() => toast('복사 실패 — 브라우저 권한 확인'));
}
/* Ordered equip keys shared by the matrix and copyShip */
function orderEquips(equipSet) {
  const out = [];
  ['WMS1', 'WMS2'].forEach(g => ['PH', 'TURB', 'PAH'].forEach(s => {
    const key = g + '/' + s;
    if (equipSet[key]) out.push({ group: g, sensor: s, key });
  }));
  Object.keys(equipSet).forEach(eq => {
    if (!out.some(o => o.key === eq)) out.push({ group: '기타', sensor: eq, key: eq });
  });
  return out;
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
  const orderedEquips = orderEquips(equipSet);

  const colg = '<colgroup><col style="width:52px"><col style="width:56px">' + ships.map(() => '<col style="width:110px">').join('') + '</colgroup>';
  const thead = '<tr><th colspan="2" style="text-align:center;background:#f8fafc">장비</th>' +
    ships.map(s => {
      const sh = shipByCode(s) || {};
      const gear = [sh.wms, sh.cems].filter(Boolean).join(' · ');
      return `<th style="text-align:center;cursor:pointer" onclick="egcsCalTab.copyShip('${esc(s)}')" title="클릭 → ${esc(s)} 검교정 이력 복사${gear ? '\nWMS·CEMS: ' + esc(gear) : ''}">${esc(s)} 📋` +
        (gear ? `<div style="font-size:9px;font-weight:400;color:#64748b;line-height:1.2">${esc(gear)}</div>` : '') + '</th>';
    }).join('') + '</tr>';
  let body = '';
  orderedEquips.forEach((o, idx) => {
    const groupTh = (idx === 0 || orderedEquips[idx - 1].group !== o.group)
      ? `<th rowspan="${orderedEquips.filter(x => x.group === o.group).length}" style="text-align:center;vertical-align:middle;background:#eef2ff;color:#1d4ed8;font-weight:800;font-size:12px">${esc(o.group)}</th>`
      : '';
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
    body += `<tr>${groupTh}<th style="text-align:center;background:#f8fafc;font-weight:700;font-size:12px">${esc(o.sensor)}</th>${tds}</tr>`;
  });
  $('egcsCalRoot').innerHTML =
    cycleBoxHtml(CYCLE, SOON) +
    '<div style="overflow-x:auto"><table class="cal-table" style="width:auto;table-layout:fixed">' + colg + '<thead>' + thead + '</thead><tbody>' + body + '</tbody></table></div>' +
    '<div style="margin-top:8px;color:#94a3b8;font-size:11px">셀 클릭 → 검교정일·모델·S/N·비고 수정 · 선박 코드 클릭 → 이력 복사</div>';
}

/* ===== cycle reference (collapsible, copyable) ===== */
function cycleCells(cyc) {
  if (!cyc) return ['?', '?'];
  const cal = cyc.cal == null ? '필요시' : fmtMonths(cyc.cal);
  const repl = cyc.cal != null && cyc.cal === cyc.repl
    ? fmtMonths(cyc.repl) + ' (검교정=교환)' : fmtMonths(cyc.repl);
  return [cal, repl];
}
function cycleBoxHtml(CYCLE, SOON) {
  const rows = CYCLE_ROWS.map(r => {
    const [cal, repl] = cycleCells(CYCLE[r.model]);
    return `<tr><td style="text-align:center;font-weight:700">${r.maker}</td>` +
      `<td style="text-align:center">${r.sensor}</td><td style="text-align:center">${r.model}</td>` +
      `<td style="text-align:center">${cal}</td><td style="text-align:center">${repl}</td>` +
      `<td style="text-align:center;color:#64748b">${r.note || ''}</td></tr>`;
  }).join('');
  return '<details style="margin-bottom:12px;border:1px solid #e2e8f0;border-radius:8px;padding:8px 12px;background:#f8fafc">' +
    `<summary style="cursor:pointer;font-weight:700;font-size:13px;color:#1d4ed8">📘 검교정 주기 <span style="font-weight:400;color:#64748b;font-size:11px">— 클릭하여 펼치기 · 임박 알림 D-${SOON}</span></summary>` +
    '<div style="margin-top:8px;overflow-x:auto"><table class="cal-table" style="width:auto">' +
    '<thead><tr><th>제조사</th><th>센서</th><th>모델</th><th>검교정</th><th>신품교환</th><th>비고</th></tr></thead>' +
    `<tbody>${rows}</tbody></table>` +
    '<button style="margin-top:8px" onclick="egcsCalTab.copyCycles()">📋 주기표 복사</button></div></details>';
}
function copyCycles() {
  const th = requireTH('egcs_calibration');
  const CYCLE = th.sensor_cycle_months;
  let txt = 'EGCS WMS 센서 검교정 주기 (매뉴얼 2026.06.18)\n';
  let lastMaker = null;
  CYCLE_ROWS.forEach(r => {
    if (r.maker !== lastMaker) { txt += `[${r.maker}]\n`; lastMaker = r.maker; }
    const [cal, repl] = cycleCells(CYCLE[r.model]);
    txt += `- ${r.sensor} (${r.model}): 검교정 ${cal} / 신품교환 ${repl}${r.note ? ' (' + r.note + ')' : ''}\n`;
  });
  txt += `※ 임박 알림: 만료 ${th.soon_days}일 전부터`;
  copyText(txt, '주기표 복사됨');
}

/* ===== per-ship expiry copy (text + HTML table on the same clipboard:
   pasting into Outlook/Excel gives a table, KakaoTalk gets the text) ===== */
async function copyRich(html, text, msg) {
  try {
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([text], { type: 'text/plain' }),
    })]);
    toast(msg);
  } catch (e) {
    copyText(text, msg);
  }
}
function copyShip(code) {
  const th = requireTH('egcs_calibration');
  const CYCLE = th.sensor_cycle_months;
  const SOON = th.soon_days;
  const recs = S.EGCS_CAL.filter(c => c.ship_code === code);
  if (!recs.length) { toast(code + ' 기록 없음'); return; }
  const equipSet = {}, map = {};
  recs.forEach(c => {
    const eq = (c.equip || '').replace('-', '/');
    equipSet[eq] = 1;
    map[eq] = c;
  });
  // one row per sensor: the earliest expiry (cal due; repl due when no cal cycle)
  const rows = [];
  orderEquips(equipSet).forEach(o => {
    const d = map[o.key];
    if (!d) return;
    const sm = sensorModel(code, o.key, d.model, CYCLE);
    const cyc = sm ? CYCLE[sm] : null;
    if (!d.last_date || !cyc) {
      rows.push({ equip: o.key, due: '-', st: d.note || '기록 없음' });
      return;
    }
    const kind = cyc.cal != null ? '검교정' : '신품교환';
    const months = cyc.cal != null ? cyc.cal : cyc.repl;
    const days = daysUntil(addMonths(d.last_date, months));
    const lv = level(days, SOON);
    rows.push({
      equip: o.key, due: fmtD(addMonths(d.last_date, months)),
      st: (lv === 'expired' ? '⚠ 만료 ' : lv === 'soon' ? '⚠ 임박 ' : '') + dLabel(days) +
        (kind === '신품교환' ? ' (신환)' : ''),
    });
  });
  const sh = shipByCode(code) || {};
  const gear = [sh.wms ? 'WMS ' + sh.wms : '', sh.cems ? 'CEMS ' + sh.cems : ''].filter(Boolean).join(' / ');
  const title = `${code} EGCS 검교정 만료일 (${fmtD(new Date())} 기준${gear ? ' / ' + gear : ''})`;
  const text = title + '\n' +
    rows.map(r => `- ${r.equip}: ${r.due} (${r.st})`).join('\n');
  const html = `<b>${esc(title)}</b>` +
    '<table border="1" style="border-collapse:collapse;font-size:13px">' +
    '<tr><th style="padding:3px 10px;background:#eef2ff">장비</th>' +
    '<th style="padding:3px 10px;background:#eef2ff">만료일</th>' +
    '<th style="padding:3px 10px;background:#eef2ff">상태</th></tr>' +
    rows.map(r => `<tr><td style="padding:3px 10px">${esc(r.equip)}</td>` +
      `<td style="padding:3px 10px;text-align:center">${esc(r.due)}</td>` +
      `<td style="padding:3px 10px">${esc(r.st)}</td></tr>`).join('') +
    '</table>';
  copyRich(html, text, code + ' 만료일 복사됨 (엑셀·메일 = 표)');
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

window.egcsCalTab = { edit, close, save, copyShip, copyCycles };

export default { id: 'egcsCal', mount, refresh, destroy: close };
