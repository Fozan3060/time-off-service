import { Injectable } from '@nestjs/common';
import { Mutex } from 'async-mutex';

@Injectable()
export class MutexRegistry {
  private readonly locks = new Map<string, Mutex>();

  keyFor(employeeId: string, locationId: string): string {
    return `${employeeId}:${locationId}`;
  }

  async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let mutex = this.locks.get(key);
    if (!mutex) {
      mutex = new Mutex();
      this.locks.set(key, mutex);
    }
    return mutex.runExclusive(fn);
  }

  /**
   * Test-only visibility into how many keys are currently tracked.
   * Useful to ensure keys don't leak under load.
   */
  size(): number {
    return this.locks.size;
  }
}
