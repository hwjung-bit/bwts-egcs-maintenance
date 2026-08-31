// Single source of judgment thresholds: contracts/thresholds.json.
// The same file is read by scripts/weekly_cal_alert.py and pipelines/bwts_log.
// No embedded fallback on purpose — a silent default would let the screen and
// the weekly alert disagree, which is the bug this file exists to prevent.

export let TH = null;

export async function loadThresholds(version) {
  const res = await fetch(`contracts/thresholds.json?v=${version || 'dev'}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('contracts/thresholds.json 로드 실패 HTTP ' + res.status);
  TH = await res.json();
  return TH;
}

export function requireTH(section) {
  if (!TH || !TH[section]) {
    throw new Error(`임계값 없음: contracts/thresholds.json → "${section}"`);
  }
  return TH[section];
}
