import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LedgerEventType } from './ledger-event-type.enum';
import { Ledger } from './ledger.entity';
import { LedgerService } from './ledger.service';

describe('LedgerService', () => {
  let moduleRef: TestingModule;
  let service: LedgerService;

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'sqlite',
          database: ':memory:',
          entities: [Ledger],
          synchronize: true,
          dropSchema: true,
        }),
        TypeOrmModule.forFeature([Ledger]),
      ],
      providers: [LedgerService],
    }).compile();

    await moduleRef.init();
    service = moduleRef.get(LedgerService);
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  it('starts with zero settled balance', async () => {
    const balance = await service.settledBalance('alice', 'NYC');
    expect(balance).toBe(0);
  });

  it('sums positive and negative deltas', async () => {
    await service.append({
      employeeId: 'alice',
      locationId: 'NYC',
      delta: 10,
      eventType: LedgerEventType.INITIAL_GRANT,
    });
    await service.append({
      employeeId: 'alice',
      locationId: 'NYC',
      delta: -2,
      eventType: LedgerEventType.TIME_OFF_DEDUCTION,
      requestId: 'req-1',
      idempotencyKey: 'hcm-idem-1',
    });

    expect(await service.settledBalance('alice', 'NYC')).toBe(8);
  });

  it('scopes balances by (employee, location)', async () => {
    await service.append({
      employeeId: 'alice',
      locationId: 'NYC',
      delta: 10,
      eventType: LedgerEventType.INITIAL_GRANT,
    });
    await service.append({
      employeeId: 'alice',
      locationId: 'LON',
      delta: 5,
      eventType: LedgerEventType.INITIAL_GRANT,
    });
    await service.append({
      employeeId: 'bob',
      locationId: 'NYC',
      delta: 7,
      eventType: LedgerEventType.INITIAL_GRANT,
    });

    expect(await service.settledBalance('alice', 'NYC')).toBe(10);
    expect(await service.settledBalance('alice', 'LON')).toBe(5);
    expect(await service.settledBalance('bob', 'NYC')).toBe(7);
  });

  it('returns rows linked to a request in order', async () => {
    await service.append({
      employeeId: 'alice',
      locationId: 'NYC',
      delta: -2,
      eventType: LedgerEventType.TIME_OFF_DEDUCTION,
      requestId: 'req-1',
      idempotencyKey: 'hcm-1',
    });
    await service.append({
      employeeId: 'alice',
      locationId: 'NYC',
      delta: 2,
      eventType: LedgerEventType.CANCELLATION_REFUND,
      requestId: 'req-1',
      idempotencyKey: 'hcm-1-refund',
    });
    await service.append({
      employeeId: 'alice',
      locationId: 'NYC',
      delta: -5,
      eventType: LedgerEventType.TIME_OFF_DEDUCTION,
      requestId: 'req-2',
    });

    const rows = await service.findByRequest('req-1');
    expect(rows).toHaveLength(2);
    expect(rows[0].eventType).toBe(LedgerEventType.TIME_OFF_DEDUCTION);
    expect(rows[1].eventType).toBe(LedgerEventType.CANCELLATION_REFUND);
    expect(rows.reduce((sum, r) => sum + r.delta, 0)).toBe(0);
  });

  it('ledger is append-only: two appends produce two rows (no overwrite)', async () => {
    await service.append({
      employeeId: 'alice',
      locationId: 'NYC',
      delta: 10,
      eventType: LedgerEventType.INITIAL_GRANT,
    });
    await service.append({
      employeeId: 'alice',
      locationId: 'NYC',
      delta: 3,
      eventType: LedgerEventType.ANNIVERSARY_BONUS,
    });

    const rows = await service.findByKey('alice', 'NYC');
    expect(rows).toHaveLength(2);
    expect(await service.settledBalance('alice', 'NYC')).toBe(13);
  });
});
