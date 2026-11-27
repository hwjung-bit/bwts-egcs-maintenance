// BWTS 로그 상세 하단 — 선박·월 로그 진단 (bwts_log_diag, pipelines/bwts_log/log_diag.py).
// 구성은 Techcross ECS Log Summary 와 같은 순서(종합 진단 → 운전 → Alarm·Trip → 장비별)에
// 세션별 TRO(주입·배출), 월별 추이, 추이 진단, 매뉴얼 조치를 더한다.
import { sb } from '../core/supabase.js';
import { esc } from '../core/dom.js';

const ST = { Normal: '#3aa76d', Warn: '#ef8a00', Alert: '#d9534f' };
const ST_MSG = {
  Normal: '반복되는 주요 이상 없음',
  Warn: '반복 발생한 이상이 있어 지속 점검 필요',
  Alert: '운전 성능에 직접 영향을 주는 이상이 있어 본선 조치 필요',
};
const LV = { '긴급': '#c62828', '주의': '#e08a00' };
const MODES = ['BALLAST', 'DEBALLAST', 'STRIPPING'];
const C = 'text-align:center;white-space:nowrap';
const BAD = 'background:#fde0dc;color:#b71c1c;font-weight:600;';
const n = (v, d = 2) => v == null ? '—' : (+v).toFixed(d);
const pct = v => v == null ? '—' : Math.round(v * 100) + '%';
const hm = m => `${Math.floor(m / 60)}시간 ${Math.round(m % 60)}분`;
const cap = s => s.charAt(0) + s.slice(1).toLowerCase();
const td = (v, bad, extra = '') => `<td style="${C};${bad ? BAD : ''}${extra}">${v}</td>`;
const h4 = (t, sub = '') => `<h4 style="margin-top:14px">${t}${sub ? ` <span style="font-weight:400;text-transform:none">· ${sub}</span>` : ''}</h4>`;
const pill = (v, bg) => `<span style="display:inline-block;min-width:22px;border-radius:10px;padding:0 7px;background:${bg}">${v}</span>`;

function opHtml(op) {
  const rows = MODES.map(m => {
    const [cnt, min, vol] = op[m] || [0, 0, 0];
    return `<tr><td><b>${cap(m)}</b></td>${td(cnt)}${td(hm(min))}${td(n(vol))}${td(min ? n(vol / (min / 60)) : '—')}</tr>`;
  }).join('');
  const all = Object.values(op);
  const sum = i => all.reduce((a, x) => a + x[i], 0);
  return `<table class="cal-table"><thead><tr><th>Operation</th><th>운전 횟수</th><th>총 누적운전시간</th><th>총 처리량 (m³)</th><th>평균 처리유량 (m³/h)</th></tr></thead>
    <tbody>${rows}<tr><td><b>전체 합계</b></td>${td('<b>' + sum(0) + '</b>')}${td('<b>' + hm(sum(1)) + '</b>')}${td('<b>' + n(sum(2)) + '</b>')}${td('—')}</tr></tbody></table>`;
}

function alarmHtml(alarms) {
  if (!alarms.length) return '<div class="muted">알람 없음</div>';
  const rows = alarms.slice(0, 7).map((a, i) =>
    `<tr>${td(i + 1)}${td('<b>' + esc(a.code || '—') + '</b>')}<td>${esc(a.desc)}</td>${td(pill(a.A, '#fde7c2'))}${td(pill(a.T, '#f8c9c6'))}${td('<b>' + (a.A + a.T) + '</b>')}`
    + td(`<span class="pill" style="background:${a.major ? '#dbe9f7' : '#eee'};color:#1d2733">${a.major ? 'Major' : 'Minor'}</span>`) + '</tr>').join('');
  return `<table class="cal-table"><thead><tr><th>순위</th><th>Code</th><th>이벤트</th><th>Alarm</th><th>Trip</th><th>합계</th><th>중요도</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function deviceHtml(devs) {
  if (!devs.length) return '<div class="muted">알람 없음</div>';
  const tot = devs.reduce((a, d) => a + d.A + d.T, 0) || 1;
  const rows = devs.slice(0, 5).map((d, i) => {
    const s = d.A + d.T;
    return `<tr>${td(i + 1)}${td('<b>' + esc(d.dev) + '</b>')}${td(pill(d.A, '#fde7c2'))}${td(pill(d.T, '#f8c9c6'))}${td('<b>' + s + '</b>')}`
      + `<td style="white-space:nowrap"><span style="display:inline-block;height:8px;width:${Math.round(s / tot * 90)}px;background:#3d8fa6;border-radius:4px;vertical-align:middle"></span> ${(s / tot * 100).toFixed(1)}%</td><td>${esc(d.top)}</td></tr>`;
  }).join('');
  return `<table class="cal-table"><thead><tr><th>순위</th><th>장비명</th><th>Alarm</th><th>Trip</th><th>합계</th><th>발생 비중</th><th>대표 이벤트</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function sessionHtml(ss) {
  const hold = (x, cols) => `<tr>${td(esc(x.start))}${td(Math.round(x.min))}${'<td style="' + C + '">—</td>'.repeat(cols)}${td('판정 보류', false, 'color:#94a3b8')}</tr>`;
  const b = ss.filter(x => x.mode === 'BALLAST').map(x => x.ok == null ? hold(x, 6) :
    `<tr>${td(esc(x.start))}${td(Math.round(x.min))}${td(n(x.amp, 0))}${td(n(x.tro), !x.ok)}${td(n(x.tmin))}${td(n(x.tmax))}${td(pct(x.inr))}${td(pct(x.zero), x.zero >= 0.5)}`
    + td(x.ok ? '정상' : x.tro < 5 ? '미달' : '과다', !x.ok) + '</tr>').join('');
  const d = ss.filter(x => x.mode === 'DEBALLAST').map(x => x.ok == null ? hold(x, 3) :
    `<tr>${td(esc(x.start))}${td(Math.round(x.min))}${td(n(x.davg))}${td(n(x.dmax), !x.ok)}${td(x.dover, !x.ok)}${td(x.ok ? '정상' : '초과', !x.ok)}</tr>`).join('');
  return `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:12px">
    <div><div style="margin-bottom:4px"><b>주입 (밸러스팅)</b> <span class="muted">기준 5~10 ppm</span></div>${b
    ? `<table class="cal-table"><thead><tr><th>시작</th><th>분</th><th>전류 A</th><th>TRO 평균</th><th>최저</th><th>최고</th><th>범위 내</th><th>0.00</th><th>판정</th></tr></thead><tbody>${b}</tbody></table>`
    : '<div class="muted">밸러스팅 없음</div>'}</div>
    <div><div style="margin-bottom:4px"><b>배출 (디밸러스팅)</b> <span class="muted">기준 0.1 ppm 이하 · 참고용</span></div>${d
    ? `<table class="cal-table"><thead><tr><th>시작</th><th>분</th><th>TRO 평균</th><th>최대</th><th>초과 행</th><th>판정</th></tr></thead><tbody>${d}</tbody></table>`
    : '<div class="muted">디밸러스팅 없음</div>'}</div></div>
    <div class="muted" style="font-size:11px;margin-top:4px">세션 시작 후 warm-up 구간 제외, 주입은 정류기 가동 행 기준. 배출 판정은 위 「TRO」 칸의 월 분석 값이 기준.</div>`;
}

function trendHtml(rows, period) {
  if (!rows.length) return '';
  const body = rows.map(r => {
    const k = r.kpi || {};
    const cur = r.period === period ? 'font-weight:700;' : '';
    return `<tr>${td(r.period.slice(5) + '월', false, cur)}`
      + td(`<span style="color:${ST[r.status] || '#64748b'};font-weight:600">${esc(r.status || '—')}</span>`)
      + td(k.inj_n ? `${k.inj_ok}/${k.inj_n}` : '—', k.inj_n >= 2 && k.inj_ok * 2 < k.inj_n)
      + td(n(k.tro_avg), k.tro_avg != null && (k.tro_avg < 5 || k.tro_avg > 10))
      + td(pct(k.tro_zero), k.tro_zero >= 0.5) + td(pct(k.tro_in))
      + td(n(k.amp, 0)) + td(n(k.volt)) + td(n(k.csu, 1)) + td(n(k.fmu, 0))
      + td(k.dis_n ? `${k.dis_over}/${k.dis_n}` : '—') + td(k.alarm ?? '—') + td(k.trip ?? '—', k.trip >= 5) + '</tr>';
  }).join('');
  return `<table class="cal-table"><thead><tr><th>월</th><th>진단</th><th>주입 정상 세션</th><th>주입 TRO 평균</th><th>TRO 0.00</th><th>5~10 ppm</th>
    <th>전류 A</th><th>전압 V</th><th>염분</th><th>유량</th><th>배출 초과 세션</th><th>Alarm</th><th>Trip</th></tr></thead><tbody>${body}</tbody></table>`;
}

function findingHtml(fs) {
  if (!fs.length) return '<div class="muted">추이에서 검출된 문제 없음</div>';
  return fs.map(f => `<div style="margin:0 0 8px"><span class="pill" style="background:${LV[f.lv] || '#607d8b'};color:#fff">${esc(f.lv)}</span> <b>${esc(f.title)}</b>
    <ul>${f.evidence.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
    ${f.actions.length ? `<ol style="margin:2px 0 0 16px;color:#1a4f9c">${f.actions.map(x => `<li>${esc(x)}</li>`).join('')}</ol>` : ''}
    ${f.ref ? `<div class="muted" style="font-size:11px">근거: ${esc(f.ref)}</div>` : ''}</div>`).join('');
}

function actionHtml(alarms) {
  const need = alarms.filter(a => a.actions && a.actions.length);
  if (!need.length) return '<div class="muted">조치 대상 알람 없음 (Trip 1회 또는 합계 3회 이상 기준)</div>';
  const rows = need.map(a => `<tr>${td('<b>' + esc(a.code) + '</b>')}<td>${esc(a.name)}<div class="muted" style="font-size:11px">${esc(a.desc)}</div></td>${td(a.A + ' / ' + a.T)}${td(a.days)}
    <td>${a.actions.map((x, i) => `${i + 1}) ${esc(x)}`).join('<br>')}</td><td style="font-size:11px;${a.manual ? '' : 'color:#94a3b8'}">${esc(a.ref)}</td></tr>`).join('');
  return `<table class="cal-table"><thead><tr><th>Code</th><th>내용</th><th>Alarm / Trip</th><th>발생일수</th><th>본선 조치</th><th>근거</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export async function renderDiag(box, ship, period, stillSelected) {
  box.innerHTML = '<span class="spin"></span> 로그 진단 로딩...';
  const year = period.slice(0, 4);
  const [one, tr] = await Promise.all([
    sb.from('bwts_log_diag').select('payload,updated_at').eq('ship_code', ship).eq('period', period).maybeSingle(),
    sb.from('bwts_log_diag').select('period,kpi:payload->kpi,status:payload->>status').eq('ship_code', ship)
      .gte('period', year + '-01').lte('period', year + '-12').order('period'),
  ]);
  if (!stillSelected()) return;
  if (one.error || tr.error) {
    box.innerHTML = `<div class="muted">로그 진단을 불러오지 못했습니다 — ${esc((one.error || tr.error).message)}</div>`;
    return;
  }
  const p = one.data && one.data.payload;
  if (!p) {
    box.innerHTML = '<h4 style="margin-top:14px">로그 진단</h4><div class="muted">이 달 진단 자료 없음 (CSV 미수신 또는 알파라발 로그)</div>';
    return;
  }
  const files = Object.values(p.files || {}).join(', ');
  box.innerHTML = `<div style="border-top:2px solid #17405e;margin-top:14px;padding-top:10px">
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><b style="font-size:13px">로그 진단</b>
      <span class="pill" style="background:${ST[p.status]};color:#fff;font-weight:700">${esc(p.status)}</span>
      <span>${ST_MSG[p.status] || ''}</span><div class="spacer"></div>
      <span class="muted" style="font-size:11px">${esc(files)} · 갱신 ${esc((one.data.updated_at || '').slice(0, 10))}</span></div>
    ${h4('추이 진단', '최근 4개월')}${findingHtml(p.findings || [])}
    ${h4('Operation 운전 정보')}${opHtml(p.op || {})}
    ${h4('TRO 세션별')}${sessionHtml(p.sessions || [])}
    ${h4('Alarm·Trip TOP 7', '시뮬레이션 시험 제외')}${alarmHtml(p.alarms || [])}
    ${h4('장비별 Alarm·Trip TOP 5')}${deviceHtml(p.devices || [])}
    ${h4('알람별 본선 조치', 'Techcross ECS OMSM TC1710-001 Rev0.7')}${actionHtml(p.alarms || [])}
    ${h4('월별 추이', year + '년')}${trendHtml(tr.data || [], period)}
    <div class="muted" style="font-size:11px;margin-top:6px">시험 판정 단계 — 본선 발송 전 원본 로그 대조 필요.</div></div>`;
}
