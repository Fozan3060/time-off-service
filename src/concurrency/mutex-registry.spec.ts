import { MutexRegistry } from './mutex-registry';

describe('MutexRegistry', () => {
  it('keyFor combines employee and location deterministically', () => {
    const reg = new MutexRegistry();
    expect(reg.keyFor('alice', 'NYC')).toBe('alice:NYC');
    expect(reg.keyFor('alice', 'NYC')).toBe(reg.keyFor('alice', 'NYC'));
    expect(reg.keyFor('alice', 'NYC')).not.toBe(reg.keyFor('alice', 'LON'));
  });

  it('serialises concurrent invocations for the same key', async () => {
    const reg = new MutexRegistry();
    const log: string[] = [];

    const makeTask = (label: string, delayMs: number) => async () => {
      log.push(`enter-${label}`);
      await new Promise((r) => setTimeout(r, delayMs));
      log.push(`exit-${label}`);
      return label;
    };

    await Promise.all([
      reg.runExclusive('k', makeTask('A', 25)),
      reg.runExclusive('k', makeTask('B', 5)),
      reg.runExclusive('k', makeTask('C', 1)),
    ]);

    // With serialisation, we never interleave enter/exit pairs.
    expect(log).toEqual([
      'enter-A',
      'exit-A',
      'enter-B',
      'exit-B',
      'enter-C',
      'exit-C',
    ]);
  });

  it('allows concurrency across different keys', async () => {
    const reg = new MutexRegistry();
    const log: string[] = [];

    const makeTask = (label: string) => async () => {
      log.push(`enter-${label}`);
      await new Promise((r) => setTimeout(r, 10));
      log.push(`exit-${label}`);
    };

    await Promise.all([
      reg.runExclusive('key-1', makeTask('A')),
      reg.runExclusive('key-2', makeTask('B')),
    ]);

    // Both tasks enter before either exits because keys are distinct.
    const enters = log.slice(0, 2).sort();
    expect(enters).toEqual(['enter-A', 'enter-B']);
  });

  it('propagates rejections from the task', async () => {
    const reg = new MutexRegistry();
    await expect(
      reg.runExclusive('k', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // Lock is released after the rejection so subsequent tasks run fine.
    const result = await reg.runExclusive('k', async () => 'ok');
    expect(result).toBe('ok');
  });
});
