import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LedgerEventType } from '../ledger/ledger-event-type.enum';
import { Ledger } from '../ledger/ledger.entity';
import { LedgerService } from '../ledger/ledger.service';
import { RequestStatus } from '../requests/request-status.enum';
import { RequestsService } from '../requests/requests.service';
import { TimeOffRequest } from '../requests/time-off-request.entity';
import { BalanceService } from './balance.service';

describe('BalanceService', () => {
  let moduleRef: TestingModule;
  let balances: BalanceService;
  let ledger: LedgerService;
  let requests: RequestsService;

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
      providers: [LedgerService, RequestsService, BalanceService],
    }).compile();

    await moduleRef.init();
    balances = moduleRef.get(BalanceService);
    ledger = moduleRef.get(LedgerService);
    requests = moduleRef.get(RequestsService);
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  const createRequest = async (
    id: string,
    days: number,
    status: RequestStatus = RequestStatus.PENDING_APPROVAL,
  ) => {
    await requests.create({
      id,
      employeeId: 'alice',
      locationId: 'NYC',
      startDate: '2026-05-01',
      endDate: '2026-05-02',
      days,
    });
    if (status !== RequestStatus.PENDING_APPROVAL) {
      const row = (await requests.findById(id))!;
      row.status = status;
      await requests.save(row);
    }
  };

  it('snapshot with no activity is all zeros', async () => {
    const snap = await balances.snapshot('alice', 'NYC');
    expect(snap).toEqual({
      employeeId: 'alice',
      locationId: 'NYC',
      settled: 0,
      pendingHolds: 0,
      available: 0,
    });
  });

  it('available = settled when there are no pending holds', async () => {
    await ledger.append({
      employeeId: 'alice',
      locationId: 'NYC',
      delta: 10,
      eventType: LedgerEventType.INITIAL_GRANT,
    });
    const snap = await balances.snapshot('alice', 'NYC');
    expect(snap.settled).toBe(10);
    expect(snap.pendingHolds).toBe(0);
    expect(snap.available).toBe(10);
  });

  it('available drops by the pending hold immediately on submission', async () => {
    await ledger.append({
      employeeId: 'alice',
      locationId: 'NYC',
      delta: 10,
      eventType: LedgerEventType.INITIAL_GRANT,
    });
    await createRequest('req-1', 2);

    const snap = await balances.snapshot('alice', 'NYC');
    expect(snap.settled).toBe(10); // ledger unchanged
    expect(snap.pendingHolds).toBe(2);
    expect(snap.available).toBe(8);
  });

  it('transitioning PENDING_APPROVAL -> SYNCED + ledger deduction leaves available unchanged', async () => {
    await ledger.append({
      employeeId: 'alice',
      locationId: 'NYC',
      delta: 10,
      eventType: LedgerEventType.INITIAL_GRANT,
    });
    await createRequest('req-1', 2);

    // Simulate the successful sync: flip status, append ledger row.
    const row = (await requests.findById('req-1'))!;
    row.status = RequestStatus.SYNCED;
    row.syncedAt = new Date();
    await requests.save(row);
    await ledger.append({
      employeeId: 'alice',
      locationId: 'NYC',
      delta: -2,
      eventType: LedgerEventType.TIME_OFF_DEDUCTION,
      requestId: 'req-1',
      idempotencyKey: 'hcm-1',
    });

    const snap = await balances.snapshot('alice', 'NYC');
    expect(snap.settled).toBe(8);
    expect(snap.pendingHolds).toBe(0);
    expect(snap.available).toBe(8); // no jump
  });

  it('cancelling a non-synced pending request releases the hold', async () => {
    await ledger.append({
      employeeId: 'alice',
      locationId: 'NYC',
      delta: 10,
      eventType: LedgerEventType.INITIAL_GRANT,
    });
    await createRequest('req-1', 2);
    expect((await balances.snapshot('alice', 'NYC')).available).toBe(8);

    const row = (await requests.findById('req-1'))!;
    row.status = RequestStatus.CANCELLED;
    row.cancelledAt = new Date();
    await requests.save(row);

    const snap = await balances.snapshot('alice', 'NYC');
    expect(snap.pendingHolds).toBe(0);
    expect(snap.available).toBe(10);
  });

  it('multiple concurrent-pending holds all count together', async () => {
    await ledger.append({
      employeeId: 'alice',
      locationId: 'NYC',
      delta: 10,
      eventType: LedgerEventType.INITIAL_GRANT,
    });
    await createRequest('r1', 2);
    await createRequest('r2', 3, RequestStatus.APPROVED_SYNCING);
    await createRequest('r3', 1, RequestStatus.SYNC_RETRY);

    const snap = await balances.snapshot('alice', 'NYC');
    expect(snap.pendingHolds).toBe(6);
    expect(snap.available).toBe(4);
  });

  it('hasSufficientAvailable respects holds', async () => {
    await ledger.append({
      employeeId: 'alice',
      locationId: 'NYC',
      delta: 10,
      eventType: LedgerEventType.INITIAL_GRANT,
    });
    await createRequest('r1', 8);

    expect(await balances.hasSufficientAvailable('alice', 'NYC', 2)).toBe(true);
    expect(await balances.hasSufficientAvailable('alice', 'NYC', 3)).toBe(false);
  });

  it('ledger reconciliation correction is reflected in available', async () => {
    await ledger.append({
      employeeId: 'alice',
      locationId: 'NYC',
      delta: 10,
      eventType: LedgerEventType.INITIAL_GRANT,
    });
    // Simulate an anniversary bonus arriving via batch reconciliation.
    await ledger.append({
      employeeId: 'alice',
      locationId: 'NYC',
      delta: 3,
      eventType: LedgerEventType.ANNIVERSARY_BONUS,
      metadataJson: JSON.stringify({ batchId: 'batch-abc' }),
    });
    const snap = await balances.snapshot('alice', 'NYC');
    expect(snap.settled).toBe(13);
    expect(snap.available).toBe(13);
  });
});
