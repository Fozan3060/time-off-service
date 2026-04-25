import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MutexRegistry } from '../concurrency/mutex-registry';
import { LedgerEventType } from '../ledger/ledger-event-type.enum';
import { Ledger } from '../ledger/ledger.entity';
import { LedgerService } from '../ledger/ledger.service';
import { RequestStatus } from '../requests/request-status.enum';
import { RequestsService } from '../requests/requests.service';
import { TimeOffRequest } from '../requests/time-off-request.entity';
import { ProcessedBatch } from './processed-batch.entity';
import { ReconciliationService } from './reconciliation.service';

describe('ReconciliationService', () => {
  let moduleRef: TestingModule;
  let service: ReconciliationService;
  let ledger: LedgerService;
  let requests: RequestsService;

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [
            () => ({
              reconciliation: { syncedGraceMs: 30000 },
            }),
          ],
        }),
        TypeOrmModule.forRoot({
          type: 'sqlite',
          database: ':memory:',
          entities: [Ledger, TimeOffRequest, ProcessedBatch],
          synchronize: true,
          dropSchema: true,
        }),
        TypeOrmModule.forFeature([Ledger, TimeOffRequest, ProcessedBatch]),
      ],
      providers: [
        LedgerService,
        RequestsService,
        MutexRegistry,
        ReconciliationService,
      ],
    }).compile();

    await moduleRef.init();
    service = moduleRef.get(ReconciliationService);
    ledger = moduleRef.get(LedgerService);
    requests = moduleRef.get(RequestsService);
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  const nowIso = () => new Date().toISOString();

  it('inserts INITIAL_GRANT for a brand-new (employee, location)', async () => {
    const result = await service.processBatch({
      batchId: 'b-1',
      generatedAt: nowIso(),
      balances: [{ employeeId: 'alice', locationId: 'NYC', balance: 10 }],
    });

    expect(result.newGrants).toBe(1);
    expect(result.corrected).toBe(0);
    expect(await ledger.settledBalance('alice', 'NYC')).toBe(10);

    const rows = await ledger.findByKey('alice', 'NYC');
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe(LedgerEventType.INITIAL_GRANT);
  });

  it('inserts RECONCILIATION_CORRECTION when HCM > local (e.g. anniversary bonus)', async () => {
    await ledger.append({
      employeeId: 'alice',
      locationId: 'NYC',
      delta: 10,
      eventType: LedgerEventType.INITIAL_GRANT,
    });

    const result = await service.processBatch({
      batchId: 'b-2',
      generatedAt: nowIso(),
      balances: [{ employeeId: 'alice', locationId: 'NYC', balance: 13 }],
    });

    expect(result.corrected).toBe(1);
    expect(await ledger.settledBalance('alice', 'NYC')).toBe(13);

    const rows = await ledger.findByKey('alice', 'NYC');
    const correction = rows.find(
      (r) => r.eventType === LedgerEventType.RECONCILIATION_CORRECTION,
    );
    expect(correction?.delta).toBe(3);
    expect(correction?.metadataJson).toContain('"batchId":"b-2"');
  });

  it('inserts RECONCILIATION_CORRECTION when HCM < local (drift the other way)', async () => {
    await ledger.append({
      employeeId: 'alice',
      locationId: 'NYC',
      delta: 10,
      eventType: LedgerEventType.INITIAL_GRANT,
    });

    const result = await service.processBatch({
      batchId: 'b-3',
      generatedAt: nowIso(),
      balances: [{ employeeId: 'alice', locationId: 'NYC', balance: 7 }],
    });

    expect(result.corrected).toBe(1);
    expect(await ledger.settledBalance('alice', 'NYC')).toBe(7);
  });

  it('does nothing when HCM agrees with local', async () => {
    await ledger.append({
      employeeId: 'alice',
      locationId: 'NYC',
      delta: 10,
      eventType: LedgerEventType.INITIAL_GRANT,
    });

    const result = await service.processBatch({
      batchId: 'b-4',
      generatedAt: nowIso(),
      balances: [{ employeeId: 'alice', locationId: 'NYC', balance: 10 }],
    });

    expect(result.unchanged).toBe(1);
    expect(result.corrected).toBe(0);
    expect((await ledger.findByKey('alice', 'NYC')).length).toBe(1);
  });

  it('is idempotent on batchId — repeated batch is a no-op', async () => {
    const payload = {
      batchId: 'b-5',
      generatedAt: nowIso(),
      balances: [{ employeeId: 'alice', locationId: 'NYC', balance: 10 }],
    };
    const first = await service.processBatch(payload);
    expect(first.alreadyProcessed).toBe(false);

    const second = await service.processBatch(payload);
    expect(second.alreadyProcessed).toBe(true);
    expect(second.corrected).toBe(0);
    expect(second.newGrants).toBe(0);

    // Only one ledger row was added.
    expect(await ledger.findByKey('alice', 'NYC')).toHaveLength(1);
  });

  it('skips reconciliation when a SYNCED happened after batch generation (grace window)', async () => {
    // Initial state: 10 days
    await ledger.append({
      employeeId: 'alice',
      locationId: 'NYC',
      delta: 10,
      eventType: LedgerEventType.INITIAL_GRANT,
    });

    // Simulate a request that synced just now.
    const syncedAt = new Date();
    await requests.create({
      id: 'req-recent',
      employeeId: 'alice',
      locationId: 'NYC',
      startDate: '2099-05-04',
      endDate: '2099-05-05',
      days: 2,
    });
    const r = (await requests.findById('req-recent'))!;
    r.status = RequestStatus.SYNCED;
    r.syncedAt = syncedAt;
    await requests.save(r);

    await ledger.append({
      employeeId: 'alice',
      locationId: 'NYC',
      delta: -2,
      eventType: LedgerEventType.TIME_OFF_DEDUCTION,
      requestId: 'req-recent',
      idempotencyKey: 'idem-recent',
    });

    // Local now = 8. HCM batch generated 5 minutes ago says 10 (pre-sync).
    const fiveMinAgo = new Date(syncedAt.getTime() - 5 * 60 * 1000).toISOString();

    const result = await service.processBatch({
      batchId: 'b-grace',
      generatedAt: fiveMinAgo,
      balances: [{ employeeId: 'alice', locationId: 'NYC', balance: 10 }],
    });

    expect(result.skippedInFlight).toBe(1);
    expect(result.corrected).toBe(0);
    expect(await ledger.settledBalance('alice', 'NYC')).toBe(8);
  });

  it('still corrects when the SYNCED is older than the batch (post-sync drift)', async () => {
    // Sync happened a long time ago, batch is fresh, drift exists.
    await ledger.append({
      employeeId: 'alice',
      locationId: 'NYC',
      delta: 10,
      eventType: LedgerEventType.INITIAL_GRANT,
    });

    const oldSyncedAt = new Date(Date.now() - 24 * 60 * 60 * 1000); // 1 day ago
    await requests.create({
      id: 'req-old',
      employeeId: 'alice',
      locationId: 'NYC',
      startDate: '2099-05-04',
      endDate: '2099-05-05',
      days: 2,
    });
    const r = (await requests.findById('req-old'))!;
    r.status = RequestStatus.SYNCED;
    r.syncedAt = oldSyncedAt;
    await requests.save(r);

    await ledger.append({
      employeeId: 'alice',
      locationId: 'NYC',
      delta: -2,
      eventType: LedgerEventType.TIME_OFF_DEDUCTION,
      requestId: 'req-old',
    });

    // Now we receive a fresh batch saying 11 (an HR adjustment of +3 happened).
    // Local computes: 10 - 2 = 8. Gap = 3.
    const result = await service.processBatch({
      batchId: 'b-drift',
      generatedAt: new Date().toISOString(),
      balances: [{ employeeId: 'alice', locationId: 'NYC', balance: 11 }],
    });

    expect(result.corrected).toBe(1);
    expect(await ledger.settledBalance('alice', 'NYC')).toBe(11);
  });

  it('processes multiple entries in a single batch with mixed outcomes', async () => {
    // Alice already has a balance; bob is new; carol matches.
    await ledger.append({
      employeeId: 'alice',
      locationId: 'NYC',
      delta: 10,
      eventType: LedgerEventType.INITIAL_GRANT,
    });
    await ledger.append({
      employeeId: 'carol',
      locationId: 'NYC',
      delta: 5,
      eventType: LedgerEventType.INITIAL_GRANT,
    });

    const result = await service.processBatch({
      batchId: 'b-multi',
      generatedAt: nowIso(),
      balances: [
        { employeeId: 'alice', locationId: 'NYC', balance: 12 }, // corrected
        { employeeId: 'bob', locationId: 'NYC', balance: 7 }, // new grant
        { employeeId: 'carol', locationId: 'NYC', balance: 5 }, // unchanged
      ],
    });

    expect(result.corrected).toBe(1);
    expect(result.newGrants).toBe(1);
    expect(result.unchanged).toBe(1);
    expect(result.skippedInFlight).toBe(0);

    expect(await ledger.settledBalance('alice', 'NYC')).toBe(12);
    expect(await ledger.settledBalance('bob', 'NYC')).toBe(7);
    expect(await ledger.settledBalance('carol', 'NYC')).toBe(5);
  });
});
