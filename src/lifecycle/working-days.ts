/**
 * Count working days between two inclusive dates, excluding Saturday and Sunday.
 * Public-holiday calendars are intentionally out of scope for this exercise.
 * Returns 0 if end precedes start or the range lands entirely on a weekend.
 */
export function countWorkingDays(
  startDate: string,
  endDate: string,
): number {
  const start = parseIsoDate(startDate);
  const end = parseIsoDate(endDate);
  if (!start || !end || end < start) return 0;

  let count = 0;
  const cursor = new Date(start);
  while (cursor <= end) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) count += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

function parseIsoDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [, yearStr, monthStr, dayStr] = match;
  const d = new Date(
    Date.UTC(Number(yearStr), Number(monthStr) - 1, Number(dayStr)),
  );
  if (Number.isNaN(d.getTime())) return null;
  return d;
}
