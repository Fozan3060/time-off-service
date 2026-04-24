import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BalanceService } from '../balances/balance.service';
import { MutexRegistry } from '../concurrency/mutex-registry';
import { LedgerEventType } from '../ledger/ledger-event-type.enum';
import { Ledger } from '../ledger/ledger.entity';
import { LedgerService } from '../ledger/ledger.service';
import { RequestStatus } from '../requests/request-status.enum';
import { RequestsService } from '../requests/requests.service';
import { TimeOffRequest } from '../requests/time-off-request.entity';
import { RequestLifecycleService } from './request-lifecycle.service';
import { StateMachine } from './state-machine';

describe('RequestLifecycleService', () => {
  let moduleRef: TestingModule;
  let lifecycle: RequestLifecycleService;
  let ledger: LedgerService;
  let requests: RequestsService;

  // Dates in the near future to keep tests valid over time.
  const futureStart = '2099-05-04'; // Monday
  const futureEnd = '2099-05-05'; // Tuesday

  beforeEach(async () => {
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
      ],
    }).compile();

    await moduleRef.init();
    lifecycle = moduleRef.get(RequestLifecycleService);
    ledger = moduleRef.get(LedgerService);
    requests = moduleRef.get(RequestsService);
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  const seedBalance = (days: number) =>
    ledger.append({
      employeeId: 'alice',
      locationId: 'NYC',
      delta: days,
      eventType: LedgerEventType.INITIAL_GRANT,
    });

  describe('submit', () => {
    it('creates a PENDING_APPROVAL request for a valid input', async () => {
      await seedBalance(10);
      const created = await lifecycle.submit({
        employeeId: 'alice',
        locationId: 'NYC',
        startDate: futureStart,
        endDate: futureEnd,
      });

      expect(created.status).toBe(RequestStatus.PENDING_APPROVAL);
      expect(created.days).toBe(2);
      expect(created.id).toBeDefined();
    });

    it('rejects when available balance is insufficient', async () => {
      await seedBalance(1);
      await expect(
        lifecycle.submit({
          employeeId: 'alice',
          locationId: 'NYC',
          startDate: futureStart,
          endDate: futureEnd,
        }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it('rejects a start date in the past', async () => {
      await seedBalance(10);
      await expect(
        lifecycle.submit({
          employeeId: 'alice',
          locationId: 'NYC',
          startDate: '2020-01-01',
          endDate: '2020-01-02',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an all-weekend range (0 working days)', async () => {
      await seedBalance(10);
      await expect(
        lifecycle.submit({
          employeeId: 'alice',
          locationId: 'NYC',
          startDate: '2099-05-09', // Saturday
          endDate: '2099-05-10', // Sunday
        }),
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
      const all = await requests.listForEmployee('alice');
      expect(all).toHaveLength(1);
    });

    it('two parallel submits on the same balance — only one succeeds', async () => {
      await seedBalance(10);

      const [resA, resB] = await Promise.allSettled([
        lifecycle.submit({
          employeeId: 'alice',
          locationId: 'NYC',
          startDate: '2099-05-04',
          endDate: '2099-05-11', // 6 working days
        }),
        lifecycle.submit({
          employeeId: 'alice',
          locationId: 'NYC',
          startDate: '2099-05-18',
          endDate: '2099-05-25', // 6 working days
        }),
      ]);

      const fulfilled = [resA, resB].filter((r) => r.status === 'fulfilled');
      const rejected = [resA, resB].filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const rejection = rejected[0] as PromiseRejectedResult;
      expect(rejection.reason).toBeInstanceOf(UnprocessableEntityException);
    });
  });

  describe('approve', () => {
    it('transitions PENDING_APPROVAL -> APPROVED_SYNCING and sets manager', async () => {
      await seedBalance(10);
      const created = await lifecycle.submit({
        employeeId: 'alice',
        locationId: 'NYC',
        startDate: futureStart,
        endDate: futureEnd,
      });

      const approved = await lifecycle.approve(created.id, 'mgr-1');
      expect(approved.status).toBe(RequestStatus.APPROVED_SYNCING);
      expect(approved.managerId).toBe('mgr-1');
    });

    it('forbids manager approving their own request', async () => {
      await seedBalance(10);
      const created = await lifecycle.submit({
        employeeId: 'alice',
        locationId: 'NYC',
        startDate: futureStart,
        endDate: futureEnd,
      });

      await expect(lifecycle.approve(created.id, 'alice')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('returns 409 when approving a request that is already approved', async () => {
      await seedBalance(10);
      const created = await lifecycle.submit({
        employeeId: 'alice',
        locationId: 'NYC',
        startDate: futureStart,
        endDate: futureEnd,
      });
      await lifecycle.approve(created.id, 'mgr-1');

      await expect(lifecycle.approve(created.id, 'mgr-1')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('reject', () => {
    it('transitions PENDING_APPROVAL -> REJECTED with reason', async () => {
      await seedBalance(10);
      const created = await lifecycle.submit({
        employeeId: 'alice',
        locationId: 'NYC',
        startDate: futureStart,
        endDate: futureEnd,
      });
      const rejected = await lifecycle.reject(
        created.id,
        'mgr-1',
        'team coverage',
      );
      expect(rejected.status).toBe(RequestStatus.REJECTED);
      expect(rejected.rejectionReason).toBe('team coverage');
      expect(rejected.managerId).toBe('mgr-1');
    });
  });

  describe('cancel', () => {
    it('PENDING_APPROVAL cancel releases hold without HCM call', async () => {
      await seedBalance(10);
      const created = await lifecycle.submit({
        employeeId: 'alice',
        locationId: 'NYC',
        startDate: futureStart,
        endDate: futureEnd,
      });

      const cancelled = await lifecycle.cancel(created.id, 'alice');
      expect(cancelled.status).toBe(RequestStatus.CANCELLED);
      expect(cancelled.cancelledAt).not.toBeNull();

      const balances = moduleRef.get(BalanceService);
      const snap = await balances.snapshot('alice', 'NYC');
      expect(snap.available).toBe(10);
    });

    it('rejects cancellation from someone who is not the requester', async () => {
      await seedBalance(10);
      const created = await lifecycle.submit({
        employeeId: 'alice',
        locationId: 'NYC',
        startDate: futureStart,
        endDate: futureEnd,
      });
      await expect(lifecycle.cancel(created.id, 'someone-else')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('rejects cancellation when the status is already terminal', async () => {
      await seedBalance(10);
      const created = await lifecycle.submit({
        employeeId: 'alice',
        locationId: 'NYC',
        startDate: futureStart,
        endDate: futureEnd,
      });
      await lifecycle.reject(created.id, 'mgr-1', 'no');

      await expect(lifecycle.cancel(created.id, 'alice')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });
});
