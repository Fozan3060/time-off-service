import { MockHcmServer } from '../../test/mock-hcm/mock-hcm.server';
import { HcmClient } from './hcm-client';
import {
  HcmBusinessError,
  HcmTransientError,
  HcmVerificationError,
} from './hcm.errors';

describe('HcmClient (against real Express mock)', () => {
  let mock: MockHcmServer;
  let baseUrl: string;
  let client: HcmClient;

  beforeAll(async () => {
    mock = new MockHcmServer();
    const port = await mock.start(0);
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await mock.stop();
  });

  beforeEach(() => {
    mock.reset();
    client = new HcmClient({
      baseUrl,
      timeoutMs: 200,
      maxRetries: 3,
      backoffStrategy: () => 1, // 1 ms backoff for fast tests
      verifyAfterWrite: true,
    });
  });

  describe('getBalance', () => {
    it('returns the seeded balance', async () => {
      mock.seedBalance('alice', 'NYC', 10);
      expect(await client.getBalance('alice', 'NYC')).toBe(10);
    });

    it('returns 0 for an unseeded key', async () => {
      expect(await client.getBalance('unknown', 'X')).toBe(0);
    });
  });

  describe('applyDeduction — happy path', () => {
    it('applies a deduction and verification passes', async () => {
      mock.seedBalance('alice', 'NYC', 10);
      const result = await client.applyDeduction({
        employeeId: 'alice',
        locationId: 'NYC',
        delta: -2,
        idempotencyKey: 'idem-1',
      });
      expect(result.newBalance).toBe(8);
      expect(mock.getDeductions()).toHaveLength(1);
      expect(mock.getBalance('alice', 'NYC')).toBe(8);
    });
  });

  describe('applyDeduction — 4xx (business rejection)', () => {
    it('throws HcmBusinessError', async () => {
      mock.configure({ failNext4xx: 1 });
      await expect(
        client.applyDeduction({
          employeeId: 'alice',
          locationId: 'NYC',
          delta: -2,
          idempotencyKey: 'idem-2',
        }),
      ).rejects.toBeInstanceOf(HcmBusinessError);
    });

    it('does not retry on 4xx (single deduction attempt visible)', async () => {
      mock.configure({ failNext4xx: 1 });
      await expect(
        client.applyDeduction({
          employeeId: 'alice',
          locationId: 'NYC',
          delta: -2,
          idempotencyKey: 'idem-3',
        }),
      ).rejects.toBeInstanceOf(HcmBusinessError);
      expect(mock.getDeductions()).toHaveLength(0);
      // The mock counts every inbound POST to /deductions, retried or not.
      expect(mock.getHits().deductions).toBe(1);
    });
  });

  describe('applyDeduction — 5xx (transient)', () => {
    it('retries and eventually succeeds', async () => {
      mock.seedBalance('alice', 'NYC', 10);
      mock.configure({ failNext5xx: 2 });
      const result = await client.applyDeduction({
        employeeId: 'alice',
        locationId: 'NYC',
        delta: -2,
        idempotencyKey: 'idem-4',
      });
      expect(result.newBalance).toBe(8);
      // 2 transient failures + 1 success = 3 deduction attempts visible.
      expect(mock.getHits().deductions).toBe(3);
      // Only one deduction is recorded — the successful one.
      expect(mock.getDeductions()).toHaveLength(1);
    });

    it('throws HcmTransientError when retries are exhausted', async () => {
      mock.configure({ failNext5xx: 10 });
      await expect(
        client.applyDeduction({
          employeeId: 'alice',
          locationId: 'NYC',
          delta: -2,
          idempotencyKey: 'idem-5',
        }),
      ).rejects.toBeInstanceOf(HcmTransientError);
      // 4 attempts total: 1 initial + 3 retries.
      expect(mock.getHits().deductions).toBe(4);
    });
  });

  describe('applyDeduction — lost response (timeout)', () => {
    it('retries with the same idempotency key, no double-deduction', async () => {
      mock.seedBalance('alice', 'NYC', 10);
      // First call: delayed past the client timeout (200 ms).
      // Second call: returns immediately. By the time the second call's
      // idempotency check runs, the first call's deduction has been recorded,
      // so the second call returns the cached result.
      mock.configure({ delayNext: 1, delayMs: 350 });

      const result = await client.applyDeduction({
        employeeId: 'alice',
        locationId: 'NYC',
        delta: -2,
        idempotencyKey: 'idem-lost',
      });

      expect(result.newBalance).toBe(8);
      // Exactly one deduction stored, despite two POST attempts.
      expect(mock.getDeductions()).toHaveLength(1);
      expect(mock.getBalance('alice', 'NYC')).toBe(8);
    });
  });

  describe('applyDeduction — verification', () => {
    it('throws HcmVerificationError when HCM silently drops the write', async () => {
      mock.seedBalance('alice', 'NYC', 10);
      mock.configure({ silentAcceptNext: 1 });
      await expect(
        client.applyDeduction({
          employeeId: 'alice',
          locationId: 'NYC',
          delta: -2,
          idempotencyKey: 'idem-silent',
        }),
      ).rejects.toBeInstanceOf(HcmVerificationError);
      // Balance was untouched because the silent-accept path doesn't persist.
      expect(mock.getBalance('alice', 'NYC')).toBe(10);
    });

    it('logs and continues when the lookup endpoint itself is unavailable', async () => {
      mock.seedBalance('alice', 'NYC', 10);
      mock.configure({ lookupFailNext: 1 });
      // Even though verification can't confirm, the deduction did succeed
      // and the client returns the result. Batch reconciliation will catch
      // any drift in the unhappy case.
      const result = await client.applyDeduction({
        employeeId: 'alice',
        locationId: 'NYC',
        delta: -2,
        idempotencyKey: 'idem-lookupdown',
      });
      expect(result.newBalance).toBe(8);
    });

    it('skips verification when verifyAfterWrite is false', async () => {
      const noVerify = new HcmClient({
        baseUrl,
        timeoutMs: 200,
        maxRetries: 0,
        backoffStrategy: () => 1,
        verifyAfterWrite: false,
      });
      mock.seedBalance('alice', 'NYC', 10);
      mock.configure({ silentAcceptNext: 1 });

      // With verification off, a silent-accept goes undetected at this layer.
      const result = await noVerify.applyDeduction({
        employeeId: 'alice',
        locationId: 'NYC',
        delta: -2,
        idempotencyKey: 'idem-noverify',
      });
      expect(result.idempotencyKey).toBe('idem-noverify');
      // No lookup hit recorded — verification was skipped.
      expect(mock.getHits().lookups).toBe(0);
    });
  });

  describe('lookupOperation', () => {
    it('returns null on 404', async () => {
      const result = await client.lookupOperation('does-not-exist');
      expect(result).toBeNull();
    });

    it('returns the record after a deduction', async () => {
      mock.seedBalance('alice', 'NYC', 10);
      await client.applyDeduction({
        employeeId: 'alice',
        locationId: 'NYC',
        delta: -2,
        idempotencyKey: 'idem-look',
      });
      const result = await client.lookupOperation('idem-look');
      expect(result?.idempotencyKey).toBe('idem-look');
      expect(result?.delta).toBe(-2);
    });
  });
});
