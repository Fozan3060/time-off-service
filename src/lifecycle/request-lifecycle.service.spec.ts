import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MockHcmServer } from '../../test/mock-hcm/mock-hcm.server';
import { BalanceService } from '../balances/balance.service';
import { MutexRegistry } from '../concurrency/mutex-registry';
import { HcmClient } from '../hcm/hcm-client';
import { LedgerEventType } from '../ledger/ledger-event-type.enum';
import { Ledger } from '../ledger/ledger.entity';
import { LedgerService } from '../ledger/ledger.service';
import { RequestStatus } from '../requests/request-status.enum';
import { RequestsService } from '../requests/requests.service';
import { TimeOffRequest } from '../requests/time-off-request.entity';
import { RequestLifecycleService } from './request-lifecycle.service';
import { StateMachine } from './state-machine';

describe('RequestLifecycleService', () => {
  let mockHcm: MockHcmServer;
  let mockHcmUrl: string;
  let moduleRef: TestingModule;
  let lifecycle: RequestLifecycleService;
  let ledger: LedgerService;
  let requests: RequestsService;
  let balances: BalanceService;

  const futureStart = '2099-05-04'; // Monday
  const futureEnd = '2099-05-05'; // Tuesday

  beforeAll(async () => {
    mockHcm = new MockHcmServer();
    const port = await mockHcm.start(0);
    mockHcmUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await mockHcm.stop();
  });

  beforeEach(async () => {
    mockHcm.reset();

    const hcm = new HcmClient({
      baseUrl: mockHcmUrl,
      timeoutMs: 200,
      maxRetries: 1, // small retry count for fast tests
      backoffStrategy: () => 1,
      verifyAfterWrite: true,
    });

    moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'sqlite',
          database: ':memory:',
          entities: [Ledger, TimeOffRequest],
          synchronize: true,
          dropSchema: true,
        }),
        TypeOrmModule.forFeature([Ledger, TimeOffRequest]),
      ],
      providers: [
        LedgerService,
        RequestsService,
        BalanceService,
        StateMachine,
        MutexRegistry,
        RequestLifecycleService,
        { provide: HcmClient, useValue: hcm },
      ],
    }).compile();

    await moduleRef.init();
    lifecycle = moduleRef.get(RequestLifecycleService);
    ledger = moduleRef.get(LedgerService);
    requests = moduleRef.get(RequestsService);
    balances = moduleRef.get(BalanceService);
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  const seedBalance = async (days: number) => {
    await ledger.append({
      employeeId: 'alice',
      locationId: 'NYC',
      delta: days,
      eventType: LedgerEventType.INITIAL_GRANT,
    });
    mockHcm.seedBalance('alice', 'NYC', days);
  };

  const submit = (overrides: Record<string, string> = {}) =>
    lifecycle.submit({
      employeeId: 'alice',
      locationId: 'NYC',
      startDate: overrides.startDate ?? futureStart,
      endDate: overrides.endDate ?? futureEnd,
    });

  describe('submit', () => {
    it('creates a PENDING_APPROVAL request for valid input', async () => {
      await seedBalance(10);
      const created = await submit();
      expect(created.status).toBe(RequestStatus.PENDING_APPROVAL);
      expect(created.days).toBe(2);
    });

    it('rejects insufficient balance', async () => {
      await seedBalance(1);
      await expect(submit()).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    });

    it('rejects past start date', async () => {
      await seedBalance(10);
      await expect(
        submit({ startDate: '2020-01-01', endDate: '2020-01-02' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an all-weekend range', async () => {
      await seedBalance(10);
      await expect(
        submit({ startDate: '2099-05-09', endDate: '2099-05-10' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('is idempotent on the client idempotency key', async () => {
      await seedBalance(10);
      const a = await lifecycle.submit({
        employeeId: 'alice',
        locationId: 'NYC',
        startDate: futureStart,
        endDate: futureEnd,
        clientIdempotencyKey: 'client-abc',
      });
      const b = await lifecycle.submit({
        employeeId: 'alice',
        locationId: 'NYC',
        startDate: futureStart,
        endDate: futureEnd,
        clientIdempotencyKey: 'client-abc',
      });
      expect(a.id).toBe(b.id);
      expect(await requests.listForEmployee('alice')).toHaveLength(1);
    });

    it('two parallel submits — exactly one succeeds', async () => {
      await seedBalance(10);
      const [resA, resB] = await Promise.allSettled([
        lifecycle.submit({
          employeeId: 'alice',
          locationId: 'NYC',
          startDate: '2099-05-04',
          endDate: '2099-05-11',
        }),
        lifecycle.submit({
          employeeId: 'alice',
          locationId: 'NYC',
          startDate: '2099-05-18',
          endDate: '2099-05-25',
        }),
      ]);
      const fulfilled = [resA, resB].filter((r) => r.status === 'fulfilled');
      const rejected = [resA, resB].filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
    });
  });

  describe('approve — happy path', () => {
    it('PENDING_APPROVAL -> SYNCED with ledger row and HCM deduction', async () => {
      await seedBalance(10);
      const created = await submit();
      const approved = await lifecycle.approve(created.id, 'mgr-1');

      expect(approved.status).toBe(RequestStatus.SYNCED);
      expect(approved.managerId).toBe('mgr-1');
      expect(approved.syncedAt).not.toBeNull();
      expect(approved.hcmIdempotencyKey).toBeTruthy();

      const rows = await ledger.findByRequest(created.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].delta).toBe(-2);
      expect(rows[0].eventType).toBe(LedgerEventType.TIME_OFF_DEDUCTION);

      // HCM also has exactly one deduction.
      expect(mockHcm.getDeductions()).toHaveLength(1);
      expect(mockHcm.getBalance('alice', 'NYC')).toBe(8);

      // Available balance is unchanged from before submit (no UI jump).
      const snap = await balances.snapshot('alice', 'NYC');
      expect(snap.available).toBe(8);
    });

    it('forbids manager approving their own request', async () => {
      await seedBalance(10);
      const created = await submit();
      await expect(lifecycle.approve(created.id, 'alice')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('returns 409 when approving an already-synced request', async () => {
      await seedBalance(10);
      const created = await submit();
      await lifecycle.approve(created.id, 'mgr-1');
      await expect(lifecycle.approve(created.id, 'mgr-1')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('survives a transient HCM 5xx and ends in SYNCED on retry', async () => {
      await seedBalance(10);
      mockHcm.configure({ failNext5xx: 1 });
      const created = await submit();
      const approved = await lifecycle.approve(created.id, 'mgr-1');
      expect(approved.status).toBe(RequestStatus.SYNCED);
      expect(mockHcm.getDeductions()).toHaveLength(1);
      const rows = await ledger.findByRequest(created.id);
      expect(rows).toHaveLength(1);
    });
  });

  describe('approve — HCM failures', () => {
    it('HCM 4xx ends as FAILED with no ledger row', async () => {
      await seedBalance(10);
      mockHcm.configure({ failNext4xx: 1 });
      const created = await submit();
      const approved = await lifecycle.approve(created.id, 'mgr-1');
      expect(approved.status).toBe(RequestStatus.FAILED);
      expect(approved.hcmLastError).toBeTruthy();
      expect(await ledger.findByRequest(created.id)).toHaveLength(0);
    });

    it('HCM 5xx exhausted ends as FAILED, no ledger row, no HCM deduction', async () => {
      await seedBalance(10);
      mockHcm.configure({ failNext5xx: 10 });
      const created = await submit();
      const approved = await lifecycle.approve(created.id, 'mgr-1');
      expect(approved.status).toBe(RequestStatus.FAILED);
      expect(await ledger.findByRequest(created.id)).toHaveLength(0);
      expect(mockHcm.getDeductions()).toHaveLength(0);
    });

    it('HCM silent-accept caught by verification ends as FAILED', async () => {
      await seedBalance(10);
      mockHcm.configure({ silentAcceptNext: 1 });
      const created = await submit();
      const approved = await lifecycle.approve(created.id, 'mgr-1');
      expect(approved.status).toBe(RequestStatus.FAILED);
      expect(await ledger.findByRequest(created.id)).toHaveLength(0);
      // Mock balance untouched because the silent-accept path doesn't persist.
      expect(mockHcm.getBalance('alice', 'NYC')).toBe(10);
    });
  });

  describe('reject', () => {
    it('PENDING_APPROVAL -> REJECTED with reason', async () => {
      await seedBalance(10);
      const created = await submit();
      const rejected = await lifecycle.reject(
        created.id,
        'mgr-1',
        'team coverage',
      );
      expect(rejected.status).toBe(RequestStatus.REJECTED);
      expect(rejected.rejectionReason).toBe('team coverage');
      expect(mockHcm.getDeductions()).toHaveLength(0);
    });
  });

  describe('cancel — non-synced', () => {
    it('PENDING_APPROVAL cancel releases hold without HCM call', async () => {
      await seedBalance(10);
      const created = await submit();
      const cancelled = await lifecycle.cancel(created.id, 'alice');
      expect(cancelled.status).toBe(RequestStatus.CANCELLED);
      expect(mockHcm.getDeductions()).toHaveLength(0);
      const snap = await balances.snapshot('alice', 'NYC');
      expect(snap.available).toBe(10);
    });

    it('rejects cancellation from a non-requester', async () => {
      await seedBalance(10);
      const created = await submit();
      await expect(
        lifecycle.cancel(created.id, 'someone-else'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects cancellation from a terminal state', async () => {
      await seedBalance(10);
      const created = await submit();
      await lifecycle.reject(created.id, 'mgr-1', 'no');
      await expect(lifecycle.cancel(created.id, 'alice')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('cancel — SYNCED with HCM compensation', () => {
    it('issues a refund deduction, transitions to CANCELLED, and writes a refund ledger row', async () => {
      await seedBalance(10);
      const created = await submit();
      await lifecycle.approve(created.id, 'mgr-1');

      const cancelled = await lifecycle.cancel(created.id, 'alice');
      expect(cancelled.status).toBe(RequestStatus.CANCELLED);
      expect(cancelled.cancelledAt).not.toBeNull();

      const rows = await ledger.findByRequest(created.id);
      // One TIME_OFF_DEDUCTION (-2) and one CANCELLATION_REFUND (+2).
      expect(rows).toHaveLength(2);
      const refund = rows.find(
        (r) => r.eventType === LedgerEventType.CANCELLATION_REFUND,
      );
      expect(refund?.delta).toBe(2);

      // HCM has both the deduction and the refund (two deductions tracked,
      // each with their own idempotency key).
      const hcmDeductions = mockHcm.getDeductions();
      expect(hcmDeductions).toHaveLength(2);
      expect(mockHcm.getBalance('alice', 'NYC')).toBe(10);

      // Available balance is back to the original.
      const snap = await balances.snapshot('alice', 'NYC');
      expect(snap.available).toBe(10);
    });

    it('compensation rejected by HCM (4xx) leaves the request SYNCED', async () => {
      await seedBalance(10);
      const created = await submit();
      await lifecycle.approve(created.id, 'mgr-1');

      // Stage the failure for the compensating call.
      mockHcm.configure({ failNext4xx: 1 });

      await expect(lifecycle.cancel(created.id, 'alice')).rejects.toBeInstanceOf(
        ConflictException,
      );
      const fresh = await requests.findById(created.id);
      expect(fresh?.status).toBe(RequestStatus.SYNCED);
      // No refund ledger row was written.
      const rows = await ledger.findByRequest(created.id);
      const refund = rows.find(
        (r) => r.eventType === LedgerEventType.CANCELLATION_REFUND,
      );
      expect(refund).toBeUndefined();
    });
  });
});
