import { countWorkingDays } from './working-days';

describe('countWorkingDays', () => {
  it('single Monday counts as 1', () => {
    // 2026-05-04 is a Monday
    expect(countWorkingDays('2026-05-04', '2026-05-04')).toBe(1);
  });

  it('full Mon-Fri week counts as 5', () => {
    expect(countWorkingDays('2026-05-04', '2026-05-08')).toBe(5);
  });

  it('Friday to Monday skips the weekend and counts 2', () => {
    // 2026-05-08 Fri, 2026-05-11 Mon
    expect(countWorkingDays('2026-05-08', '2026-05-11')).toBe(2);
  });

  it('Saturday to Sunday is 0', () => {
    // 2026-05-09 Sat, 2026-05-10 Sun
    expect(countWorkingDays('2026-05-09', '2026-05-10')).toBe(0);
  });

  it('Monday to Sunday counts 5', () => {
    expect(countWorkingDays('2026-05-04', '2026-05-10')).toBe(5);
  });

  it('end before start returns 0', () => {
    expect(countWorkingDays('2026-05-10', '2026-05-04')).toBe(0);
  });

  it('spans a month boundary', () => {
    // 2026-04-27 (Mon) to 2026-05-01 (Fri) = 5 days
    expect(countWorkingDays('2026-04-27', '2026-05-01')).toBe(5);
  });

  it('malformed date returns 0', () => {
    expect(countWorkingDays('not-a-date', '2026-05-04')).toBe(0);
    expect(countWorkingDays('2026-05-04', 'not-a-date')).toBe(0);
  });
});
