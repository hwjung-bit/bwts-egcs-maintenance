// BWTS 로그 월 분석 → 본선 점검 지침. 세션 판정(fleet_log_analyzer, warm-up 제외)을
// 패턴별로 세어 "무슨 일이 있었나 → 무엇을 점검하나"를 짧게 만든다.
//
// 룰은 여기 한 곳. 숫자 기준은 contracts/thresholds.json(bwts_log)을 그대로 쓴다.
// 진단은 '의심'까지만 — 원인 확정은 본선 회신으로.
import { TH } from './thresholds.js';

function bl() { return (TH && TH.bwts_log) || {}; }
const n1 = v => (v == null ? '—' : (+v).toFixed(1));

/** 세션 목록 → 패턴 집계 */
export function analyzeSessions(sessions) {
  const B = bl();
  const wm = B.warmup_minutes || 10;
  const min = B.tro_ballast_min_ppm ?? 5, max = B.tro_ballast_max_ppm ?? 10;
  const relaxedMax = B.tro_ballast_relaxed_max_ppm ?? 12;
  const dMax = B.tro_deballast_max_ppm ?? 0.1;
  const s = sessions || [];
  const bal = s.filter(x => x.mode === 'BALLAST'), deb = s.filter(x => x.mode === 'DEBALLAST');
  const out = {
    ballast: bal.length, deballast: deb.length,
    ok: bal.filter(x => x.in_range === true),
    noTro: bal.filter(x => x.in_range === false && !x.tro_appeared),
    // 저/과는 파이프라인 세션 판정(in_range=false)을 그대로 따른다 — 완화 정상(범위내 ≥50%·max ≤12)을
    // 여기서 다시 이탈로 세지 않게. 배출도 세션 판정만 (월 평균 0.2 기준은 파이프라인 몫).
    low: bal.filter(x => x.in_range === false && x.tro_appeared && x.stable_avg != null && x.stable_avg < min),
    high: bal.filter(x => x.in_range === false && x.tro_appeared && x.stable_avg != null && x.stable_avg >= min),
    short: bal.filter(x => x.in_range == null && (x.duration_min == null || x.duration_min < wm)),
    pending: bal.filter(x => x.in_range == null && x.duration_min != null && x.duration_min >= wm),
    debBad: deb.filter(x => x.in_range === false),
    debOk: deb.filter(x => x.in_range === true),
    limits: { min, max, relaxedMax, dMax, wm },
  };
  // 같은 날 짧은 기동이 몰린 날 (기동/정지 반복)
  const byDay = {};
  out.short.forEach(x => { byDay[x.date] = (byDay[x.date] || 0) + 1; });
  out.shortDays = Object.entries(byDay).filter(([, n]) => n >= 3).map(([d, n]) => ({ date: d, n }));
  return out;
}

/**
 * 지침 생성. r = bwts_log_analysis 행(등급·flags), sessions = summary.session_summaries.
 * 반환 { verdict, findings[], actions[], en:{verdict, findings[], actions[]} }
 */
export function buildGuidance(r, sessions) {
  const a = analyzeSessions(sessions);
  const L = a.limits;
  const f = [], act = [], fe = [], ae = [];
  const judged = a.ok.length + a.noTro.length + a.low.length + a.high.length;
  const avgOf = arr => arr.length ? arr.reduce((s, x) => s + (+x.stable_avg || 0), 0) / arr.length : null;

  if (a.noTro.length) {
    f.push(`TRO 미생성 ${a.noTro.length}회 — ${L.wm}분 넘게 운전했는데 TRO가 전혀 안 나옴 (${a.noTro.map(x => x.date.slice(5)).join(', ')})`);
    fe.push(`No TRO generated in ${a.noTro.length} run(s) — over ${L.wm} min of operation with zero TRO (${a.noTro.map(x => x.date.slice(5)).join(', ')})`);
  }
  if (a.low.length) {
    f.push(`주입 TRO 저농도 ${a.low.length}회 — 정상운전 구간 평균 ${n1(avgOf(a.low))}ppm (기준 ${L.min}~${L.max}ppm), 최저 ${n1(Math.min(...a.low.map(x => +x.stable_min || 0)))}ppm`);
    fe.push(`Low injection TRO in ${a.low.length} run(s) — steady-state average ${n1(avgOf(a.low))} ppm (required ${L.min}–${L.max} ppm)`);
  }
  if (a.high.length) {
    f.push(`주입 TRO 과다 ${a.high.length}회 — 평균 ${n1(avgOf(a.high))}ppm, 최대 ${n1(Math.max(...a.high.map(x => +x.stable_max || 0)))}ppm (기준 ${L.max}, 완화 ${L.relaxedMax})`);
    fe.push(`High injection TRO in ${a.high.length} run(s) — average ${n1(avgOf(a.high))} ppm (limit ${L.max} ppm)`);
  }
  if (a.shortDays.length) {
    f.push(`짧은 기동 반복 — ${a.shortDays.map(d => `${d.date.slice(5)} ${d.n}회`).join(', ')} (${L.wm}분 미만 운전은 판정 보류)`);
    fe.push(`Repeated short starts — ${a.shortDays.map(d => `${d.date.slice(5)} ×${d.n}`).join(', ')} (runs under ${L.wm} min are not assessed)`);
  }
  if (a.ok.length) {
    f.push(`정상 세션 ${a.ok.length}회 (${a.ok.map(x => x.date.slice(5)).join(', ')}) — 설비는 정상 출력을 낼 수 있는 상태`);
    fe.push(`${a.ok.length} run(s) were normal (${a.ok.map(x => x.date.slice(5)).join(', ')}) — the unit can still reach the required dose`);
  }
  if (a.debBad.length) {
    f.push(`배출 TRO 초과 ${a.debBad.length}회 — 최대 ${n1(Math.max(...a.debBad.map(x => +x.stable_max || 0)))}ppm (기준 ${L.dMax})`);
    fe.push(`Discharge TRO above ${L.dMax} ppm in ${a.debBad.length} run(s)`);
  } else if (a.deballast) {
    f.push(`배출 TRO 정상 (${a.deballast}회, 최대 ${n1(Math.max(...a.debOk.map(x => +x.stable_max || 0)))}ppm) — 중화 계통 이상 없음`);
    fe.push(`Discharge TRO normal in all ${a.deballast} run(s) — neutralisation OK`);
  }

  // ── 점검 지침 (원인 후보 순) ──
  const ecuSuspect = a.noTro.length + a.low.length >= Math.max(2, judged * 0.5);
  if (a.noTro.length || a.low.length) {
    if (ecuSuspect) {
      act.push('ECU(전해조) 전극 소제 — 전극 표면 스케일·오염 제거 후 시운전. 출력 저하의 가장 흔한 원인');
      ae.push('Clean the ECU (electrolyser) electrodes — remove scale/fouling, then test run. Most common cause of low output');
    }
    act.push('운전 중 정류기 전류·전압 표시값을 정격과 비교해 기록 (전류가 낮으면 전극·정류기, 정상인데 TRO 낮으면 센서 쪽)');
    ae.push('Record rectifier current/voltage during operation vs rated (low current → electrodes/rectifier; normal current but low TRO → sensor side)');
    act.push('TRO 센서 시약(DPD) 잔량·샘플 라인·셀 오염 점검, 필요 시 시약 교체·셀 청소');
    ae.push('Check TRO sensor reagent (DPD) level, sample line and cell fouling; replace reagent / clean cell if needed');
    act.push('운전 해역 확인 — 담수·기수역(낮은 전도도)이면 출력 저하가 정상일 수 있음. 운전 시각·위치를 회신에 포함');
    ae.push('Confirm operating waters — fresh/brackish water (low conductivity) reduces output; include time and position in the reply');
    if (a.noTro.length) {
      act.push('TRO 미생성 운전 시각의 알람·이벤트 로그 확인 (ECU 전원, 유량 부족, 인터록)');
      ae.push('Check alarm/event log at the times of zero-TRO runs (ECU power, low flow, interlocks)');
    }
  }
  if (a.high.length) {
    act.push('과다 주입 — 유량계 지시값과 실제 유량, 정류기 전류 세팅, TRO 센서 오염 여부 확인');
    ae.push('Over-dosing — verify flow meter reading vs actual flow, rectifier current setting and TRO sensor fouling');
  }
  if (a.shortDays.length) {
    act.push(`기동 후 최소 ${L.wm}분 이상 연속 운전 — 짧은 기동/정지 반복 원인(알람·트립·수동 정지) 확인`);
    ae.push(`Run at least ${L.wm} min continuously after start — check why runs stop early (alarm, trip, manual stop)`);
  }
  if (a.debBad.length) {
    act.push('배출 TRO 초과 — 중화제 잔량·중화 펌프 토출·중화 후 TRO 센서 확인');
    ae.push('Discharge TRO high — check neutraliser stock, dosing pump and post-neutralisation TRO sensor');
  }
  // 등급 사유에만 있는 항목 — Trip·알람 Shutdown·E-stop (세션 TRO 와 무관하게 점검필요를 만든다)
  (r && r.grade_reasons || []).forEach(x => {
    let m;
    if ((m = /^Trip (\d+)건/.exec(x))) {
      f.push(`Trip ${m[1]}건 — 운전 중 정지 반복`); fe.push(`${m[1]} trip(s) — repeated stops during operation`);
      act.push('Trip 발생 시각의 알람 코드·원인(유량 저하, 압력, 전원, 인터록) 확인 후 회신'); ae.push('Report the alarm code and cause at each trip (low flow, pressure, power, interlock)');
    } else if ((m = /알람 Shutdown (\d+)회/.exec(x))) {
      f.push(`알람 Shutdown ${m[1]}회`); fe.push(`${m[1]} alarm shutdown(s)`);
      act.push('Shutdown 알람 이력(코드·시각) 목록과 조치 내역 회신'); ae.push('Reply with the shutdown alarm list (code, time) and the action taken');
    } else if ((m = /E-stop (\d+)회/.exec(x))) {
      f.push(`E-stop ${m[1]}회`); fe.push(`${m[1]} emergency stop(s)`);
      act.push('E-stop 사용 사유 확인 — 비상 정지 대신 정상 정지 절차 사용'); ae.push('Confirm why E-stop was used — use the normal stop procedure instead');
    }
  });
  (r && r.flags || []).forEach(x => {
    if (/채터링/.test(x)) { act.push('밸브 개폐 신호 반복(채터링) — 해당 밸브 리미트 스위치·액추에이터 점검'); ae.push('Valve signal chattering — check the limit switch and actuator of the valve concerned'); }
  });

  let verdict, verdictEn;
  if (ecuSuspect) {
    verdict = `주입 TRO가 반복해서 기준에 못 미침 → ECU 출력 저하(전극 오염) 의심. 배출은 정상`;
    verdictEn = `Injection TRO repeatedly below the required range → suspected low ECU output (electrode fouling). Discharge is normal`;
    if (a.debBad.length) { verdict = verdict.replace('배출은 정상', '배출 TRO도 초과'); verdictEn = verdictEn.replace('Discharge is normal', 'discharge TRO also high'); }
  } else if (a.high.length && !a.low.length) {
    verdict = '주입 TRO 과다 — 유량·전류 세팅 확인 필요'; verdictEn = 'Injection TRO too high — check flow and current setting';
  } else if (a.debBad.length) {
    verdict = '배출 TRO 초과 — 중화 계통 점검 필요'; verdictEn = 'Discharge TRO above limit — check neutralisation';
  } else if (judged && !a.noTro.length && !a.low.length && !a.high.length) {
    verdict = '주입·배출 모두 정상 범위'; verdictEn = 'Injection and discharge both within range';
  } else {
    verdict = '판정 가능한 세션이 적음 — 운전 시 10분 이상 연속 운전 권장'; verdictEn = 'Too few assessable runs — run at least 10 min continuously';
  }
  return { verdict, findings: f, actions: act, stats: a, en: { verdict: verdictEn, findings: fe, actions: ae } };
}

/** 메일용 간결 세션 표 (plain text, 한 줄 = 세션). 짧은 기동은 날짜별로 묶는다. */
export function sessionTableText(sessions, lang) {
  const en = lang === 'en';
  const B = bl(); const wm = B.warmup_minutes || 10;
  const rows = [];
  const shortByDay = {};
  (sessions || []).forEach(x => {
    if (x.mode === 'BALLAST' && x.in_range == null && (x.duration_min == null || x.duration_min < wm)) {
      shortByDay[x.date] = (shortByDay[x.date] || 0) + 1; return;
    }
    const mode = x.mode === 'BALLAST' ? (en ? 'BAL' : '주입') : (en ? 'DEB' : '배출');
    const min = x.duration_min != null ? Math.round(x.duration_min) : '—';
    const tro = x.stable_avg != null ? (+x.stable_avg).toFixed(2) : '—';
    let judge, note = '';
    if (x.in_range === true) judge = 'OK';
    else if (x.in_range === false) {
      judge = en ? 'OUT' : '이탈';
      note = !x.tro_appeared ? (en ? 'no TRO' : '미생성')
        : (x.stable_avg != null && x.stable_avg < (B.tro_ballast_min_ppm ?? 5)) ? (en ? 'low' : '저농도')
        : (x.mode === 'DEBALLAST' ? (en ? 'high' : '초과') : (en ? 'high' : '과다'));
    } else { judge = en ? 'n/a' : '보류'; note = en ? 'short' : '짧은 운전'; }
    rows.push(`${x.date.slice(5)}  ${mode}  ${String(min).padStart(3)}${en ? 'min' : '분'}  TRO ${tro.padStart(5)}  ${judge}${note ? '  ' + note : ''}`);
  });
  Object.entries(shortByDay).forEach(([d, n]) => rows.push(`${d.slice(5)}  ${en ? 'BAL' : '주입'}  ${en ? `short starts ×${n} (not assessed)` : `짧은 기동 ${n}회 (판정 보류)`}`));
  rows.sort();
  const head = en ? 'Date   Mode  Min   TRO avg  Result' : '일자   모드  분    TRO평균  판정';
  return [head, ...rows].join('\n');
}
