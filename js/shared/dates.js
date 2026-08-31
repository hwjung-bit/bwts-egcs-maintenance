/* 남은 일수 — 양쪽을 자정으로 맞춰 온전한 하루 단위로 센다.
   시각까지 빼면 만료 전날 오후에 이미 0 이 되어 하루 일찍 만료로 보인다. */
export function daysUntil(due) {
  if (!due) return null;
  const a = new Date(); a.setHours(0, 0, 0, 0);
  const b = new Date(due); b.setHours(0, 0, 0, 0);
  return Math.round((b - a) / 86400000);
}

/* 'YYYY-MM-DD' + n개월 → Date (자정). JS setMonth 는 말일 넘침을 다음 달로
   미는데, 기존 프론트와 동일하게 그 동작을 유지한다. */
export function addMonths(dateStr, months) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setMonth(d.getMonth() + months);
  return d;
}

export function dayGap(a, b) {
  if (!a || !b) return 999;
  return Math.abs((new Date(a) - new Date(b)) / 86400000);
}

/* 'D-12' / '5일 경과' */
export function dLabel(days) {
  if (days == null) return '';
  return days <= 0 ? Math.abs(days) + '일 경과' : 'D-' + days;
}
