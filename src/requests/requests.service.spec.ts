import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RequestStatus } from './request-status.enum';
import { RequestsService } from './requests.service';
import { TimeOffRequest } from './time-off-request.entity';

describe('RequestsService', () => {
  let moduleRef: TestingModule;
  let service: RequestsService;

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'sqlite',
          database: ':memory:',
          entities: [TimeOffRequest],
          synchronize: true,
          dropSchema: true,
        }),
        TypeOrmModule.forFeature([TimeOffRequest]),
      ],
      providers: [RequestsService],
    }).compile();

    await moduleRef.init();
    service = moduleRef.get(RequestsService);
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  const baseInput = (overrides: Partial<Parameters<RequestsService['create']>[0]> = {}) => ({
    id: overrides.id ?? 'req-1',
    employeeId: overrides.employeeId ?? 'alice',
    locationId: overrides.locationId ?? 'NYC',
    startDate: overrides.startDate ?? '2026-05-01',
    endDate: overrides.endDate ?? '2026-05-02',
    days: overrides.days ?? 2,
    clientIdempotencyKey: overrides.clientIdempotencyKey ?? null,
  });

  it('creates a request in PENDING_APPROVAL', async () => {
    const created = await service.create(baseInput());
    expect(created.status).toBe(RequestStatus.PENDING_APPROVAL);
    expect(created.hcmSyncAttempts).toBe(0);
    expect(created.syncedAt).toBeNull();
  });

  it('finds an existing request by id', async () => {
    await service.create(baseInput({ id: 'req-x' }));
    const found = await service.findById('req-x');
    expect(found).not.toBeNull();
    expect(found?.id).toBe('req-x');
  });

  it('pendingHolds sums only active-lifecycle statuses for the key', async () => {
    await service.create(baseInput({ id: 'req-1', days: 2 }));
    await service.create(baseInput({ id: 'req-2', days: 3 }));

    // Move req-2 into a terminal status; it must drop out of pending_holds.
    const req2 = (await service.findById('req-2'))!;
    req2.status = RequestStatus.REJECTED;
    await service.save(req2);

    expect(await service.pendingHolds('alice', 'NYC')).toBe(2);
  });

  it('pendingHolds includes APPROVED_SYNCING and SYNC_RETRY rows', async () => {
    await service.create(baseInput({ id: 'req-1', days: 2 }));
    await service.create(baseInput({ id: 'req-2', days: 3 }));
    await service.create(baseInput({ id: 'req-3', days: 4 }));

    const r2 = (await service.findById('req-2'))!;
    r2.status = RequestStatus.APPROVED_SYNCING;
    await service.save(r2);
    const r3 = (await service.findById('req-3'))!;
    r3.status = RequestStatus.SYNC_RETRY;
    await service.save(r3);

    expect(await service.pendingHolds('alice', 'NYC')).toBe(2 + 3 + 4);
  });

  it('pendingHolds excludes SYNCED, CANCELLED, FAILED, COMPLETED', async () => {
    const statuses = [
      { id: 'req-s', status: RequestStatus.SYNCED, days: 2 },
      { id: 'req-c', status: RequestStatus.CANCELLED, days: 3 },
      { id: 'req-f', status: RequestStatus.FAILED, days: 4 },
      { id: 'req-k', status: RequestStatus.COMPLETED, days: 5 },
    ];
    for (const s of statuses) {
      await service.create(baseInput({ id: s.id, days: s.days }));
      const row = (await service.findById(s.id))!;
      row.status = s.status;
      await service.save(row);
    }
    expect(await service.pendingHolds('alice', 'NYC')).toBe(0);
  });

  it('pendingHolds is scoped by (employee, location)', async () => {
    await service.create(baseInput({ id: 'r1', employeeId: 'alice', locationId: 'NYC', days: 2 }));
    await service.create(baseInput({ id: 'r2', employeeId: 'alice', locationId: 'LON', days: 3 }));
    await service.create(baseInput({ id: 'r3', employeeId: 'bob', locationId: 'NYC', days: 4 }));

    expect(await service.pendingHolds('alice', 'NYC')).toBe(2);
    expect(await service.pendingHolds('alice', 'LON')).toBe(3);
    expect(await service.pendingHolds('bob', 'NYC')).toBe(4);
  });

  it('findByClientIdempotencyKey returns a prior submission by the same employee', async () => {
    await service.create(
      baseInput({ id: 'req-k', clientIdempotencyKey: 'client-abc' }),
    );
    const found = await service.findByClientIdempotencyKey('alice', 'client-abc');
    expect(found?.id).toBe('req-k');
  });

  it('findByClientIdempotencyKey does NOT match a key belonging to another employee', async () => {
    await service.create(
      baseInput({ id: 'req-k', employeeId: 'alice', clientIdempotencyKey: 'shared-key' }),
    );
    const found = await service.findByClientIdempotencyKey('bob', 'shared-key');
    expect(found).toBeNull();
  });
});
