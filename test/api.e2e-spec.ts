import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { MockHcmServer } from './mock-hcm/mock-hcm.server';

describe('API (e2e)', () => {
  let app: INestApplication<App>;
  let moduleRef: TestingModule;
  let mockHcm: MockHcmServer;

  beforeAll(async () => {
    mockHcm = new MockHcmServer();
    const port = await mockHcm.start();

    process.env.HCM_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.HCM_TIMEOUT_MS = '500';
    process.env.HCM_MAX_RETRIES = '1';
    process.env.HCM_VERIFY_AFTER_WRITE = 'true';
    process.env.DATABASE_PATH = ':memory:';
    process.env.DB_SYNCHRONIZE = 'true';
    process.env.RECONCILIATION_GRACE_MS = '30000';

    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await mockHcm?.stop();
  });

  beforeEach(() => {
    mockHcm.reset();
  });

  /**
   * Each test uses unique employee IDs so the persistent in-memory DB
   * doesn't leak state across tests. The mock HCM is reset every test.
   */

  describe('auth', () => {
    it('GET /health is public (no role required)', async () => {
      const res = await request(app.getHttpServer()).get('/health').expect(200);
      expect(res.body.status).toBe('ok');
    });

    it('protected routes return 401 without an X-Role header', async () => {
      await request(app.getHttpServer()).get('/employees/x/balances').expect(401);
    });

    it('protected routes return 401 for an unknown role', async () => {
      await request(app.getHttpServer())
        .get('/employees/x/balances?locationId=NYC')
        .set('X-Role', 'banana')
        .expect(401);
    });

    it('insufficient role returns 403', async () => {
      // Employee tries to call HCM batch-sync (HCM-only).
      await request(app.getHttpServer())
        .post('/hcm/batch-sync')
        .set('X-Role', 'employee')
        .set('X-Actor-Id', 'alice')
        .send({
          batchId: 'batch-1',
          generatedAt: new Date().toISOString(),
          balances: [],
        })
        .expect(403);
    });
  });

  describe('balance + lifecycle happy path', () => {
    it('seed balance via batch sync, submit, approve, then balance reflects deduction', async () => {
      const employeeId = `alice-happy-${Date.now()}`;
      const locationId = 'NYC';

      // 1. HCM seeds the initial balance via batch-sync.
      mockHcm.seedBalance(employeeId, locationId, 10);
      const seedRes = await request(app.getHttpServer())
        .post('/hcm/batch-sync')
        .set('X-Role', 'hcm')
        .send({
          batchId: `seed-${employeeId}`,
          generatedAt: new Date().toISOString(),
          balances: [{ employeeId, locationId, balance: 10 }],
        })
        .expect(201);
      expect(seedRes.body.newGrants).toBe(1);

      // 2. Employee reads their balance.
      const balanceBefore = await request(app.getHttpServer())
        .get(`/employees/${employeeId}/balances`)
        .query({ locationId })
        .set('X-Role', 'employee')
        .set('X-Actor-Id', employeeId)
        .expect(200);
      expect(balanceBefore.body.available).toBe(10);

      // 3. Employee submits a 2-day request.
      const submitRes = await request(app.getHttpServer())
        .post('/requests')
        .set('X-Role', 'employee')
        .set('X-Actor-Id', employeeId)
        .send({
          employeeId,
          locationId,
          startDate: '2099-05-04',
          endDate: '2099-05-05',
        })
        .expect(201);
      const requestId = submitRes.body.id;
      expect(submitRes.body.status).toBe('PENDING_APPROVAL');
      expect(submitRes.body.days).toBe(2);

      // Available balance shows the hold.
      const balanceMid = await request(app.getHttpServer())
        .get(`/employees/${employeeId}/balances`)
        .query({ locationId })
        .set('X-Role', 'employee')
        .set('X-Actor-Id', employeeId)
        .expect(200);
      expect(balanceMid.body.settled).toBe(10);
      expect(balanceMid.body.pendingHolds).toBe(2);
      expect(balanceMid.body.available).toBe(8);

      // 4. Manager approves -> HCM is called -> SYNCED.
      const approveRes = await request(app.getHttpServer())
        .post(`/requests/${requestId}/approve`)
        .set('X-Role', 'manager')
        .set('X-Actor-Id', 'mgr-1')
        .expect(201);
      expect(approveRes.body.status).toBe('SYNCED');
      expect(approveRes.body.managerId).toBe('mgr-1');

      // 5. Available balance is unchanged (no UI jump). Settled dropped, holds gone.
      const balanceAfter = await request(app.getHttpServer())
        .get(`/employees/${employeeId}/balances`)
        .query({ locationId })
        .set('X-Role', 'employee')
        .set('X-Actor-Id', employeeId)
        .expect(200);
      expect(balanceAfter.body.settled).toBe(8);
      expect(balanceAfter.body.pendingHolds).toBe(0);
      expect(balanceAfter.body.available).toBe(8);

      // 6. HCM has exactly one deduction recorded.
      expect(mockHcm.getBalance(employeeId, locationId)).toBe(8);

      // 7. Ledger trail is visible to managers.
      const ledger = await request(app.getHttpServer())
        .get(`/requests/${requestId}/ledger`)
        .set('X-Role', 'manager')
        .set('X-Actor-Id', 'mgr-1')
        .expect(200);
      expect(ledger.body).toHaveLength(1);
      expect(ledger.body[0].delta).toBe(-2);
      expect(ledger.body[0].eventType).toBe('TIME_OFF_DEDUCTION');
    });
  });

  describe('reject and cancel flows', () => {
    it('manager rejects a pending request -> REJECTED', async () => {
      const employeeId = `alice-rej-${Date.now()}`;
      const locationId = 'NYC';

      mockHcm.seedBalance(employeeId, locationId, 5);
      await request(app.getHttpServer())
        .post('/hcm/batch-sync')
        .set('X-Role', 'hcm')
        .send({
          batchId: `seed-${employeeId}`,
          generatedAt: new Date().toISOString(),
          balances: [{ employeeId, locationId, balance: 5 }],
        })
        .expect(201);

      const submitRes = await request(app.getHttpServer())
        .post('/requests')
        .set('X-Role', 'employee')
        .set('X-Actor-Id', employeeId)
        .send({
          employeeId,
          locationId,
          startDate: '2099-05-04',
          endDate: '2099-05-05',
        })
        .expect(201);

      const reject = await request(app.getHttpServer())
        .post(`/requests/${submitRes.body.id}/reject`)
        .set('X-Role', 'manager')
        .set('X-Actor-Id', 'mgr-1')
        .send({ reason: 'team coverage' })
        .expect(201);
      expect(reject.body.status).toBe('REJECTED');
      expect(reject.body.rejectionReason).toBe('team coverage');
    });

    it('employee cancels a pending request before HCM is called', async () => {
      const employeeId = `alice-cancel-${Date.now()}`;
      const locationId = 'NYC';

      mockHcm.seedBalance(employeeId, locationId, 5);
      await request(app.getHttpServer())
        .post('/hcm/batch-sync')
        .set('X-Role', 'hcm')
        .send({
          batchId: `seed-${employeeId}`,
          generatedAt: new Date().toISOString(),
          balances: [{ employeeId, locationId, balance: 5 }],
        })
        .expect(201);

      const submitRes = await request(app.getHttpServer())
        .post('/requests')
        .set('X-Role', 'employee')
        .set('X-Actor-Id', employeeId)
        .send({
          employeeId,
          locationId,
          startDate: '2099-05-04',
          endDate: '2099-05-05',
        })
        .expect(201);

      const cancel = await request(app.getHttpServer())
        .post(`/requests/${submitRes.body.id}/cancel`)
        .set('X-Role', 'employee')
        .set('X-Actor-Id', employeeId)
        .expect(201);
      expect(cancel.body.status).toBe('CANCELLED');
      expect(mockHcm.getDeductions().length).toBe(0);
    });
  });

  describe('authorisation guards', () => {
    it('employee cannot submit on behalf of another employee', async () => {
      await request(app.getHttpServer())
        .post('/requests')
        .set('X-Role', 'employee')
        .set('X-Actor-Id', 'alice')
        .send({
          employeeId: 'bob',
          locationId: 'NYC',
          startDate: '2099-05-04',
          endDate: '2099-05-05',
        })
        .expect(403);
    });

    it('manager cannot approve their own request', async () => {
      const employeeId = `mgr-approves-self-${Date.now()}`;
      const locationId = 'NYC';

      mockHcm.seedBalance(employeeId, locationId, 5);
      await request(app.getHttpServer())
        .post('/hcm/batch-sync')
        .set('X-Role', 'hcm')
        .send({
          batchId: `seed-${employeeId}`,
          generatedAt: new Date().toISOString(),
          balances: [{ employeeId, locationId, balance: 5 }],
        })
        .expect(201);

      const submitRes = await request(app.getHttpServer())
        .post('/requests')
        .set('X-Role', 'employee')
        .set('X-Actor-Id', employeeId)
        .send({
          employeeId,
          locationId,
          startDate: '2099-05-04',
          endDate: '2099-05-05',
        })
        .expect(201);

      // The same employeeId attempts to approve themselves while wearing the manager hat.
      await request(app.getHttpServer())
        .post(`/requests/${submitRes.body.id}/approve`)
        .set('X-Role', 'manager')
        .set('X-Actor-Id', employeeId)
        .expect(403);
    });

    it('employee cannot read another employee’s balance', async () => {
      await request(app.getHttpServer())
        .get('/employees/bob/balances')
        .query({ locationId: 'NYC' })
        .set('X-Role', 'employee')
        .set('X-Actor-Id', 'alice')
        .expect(403);
    });
  });

  describe('idempotency on submit', () => {
    it('same Idempotency-Key returns the same request', async () => {
      const employeeId = `alice-idem-${Date.now()}`;
      const locationId = 'NYC';

      mockHcm.seedBalance(employeeId, locationId, 5);
      await request(app.getHttpServer())
        .post('/hcm/batch-sync')
        .set('X-Role', 'hcm')
        .send({
          batchId: `seed-${employeeId}`,
          generatedAt: new Date().toISOString(),
          balances: [{ employeeId, locationId, balance: 5 }],
        })
        .expect(201);

      const key = `client-${employeeId}`;
      const r1 = await request(app.getHttpServer())
        .post('/requests')
        .set('X-Role', 'employee')
        .set('X-Actor-Id', employeeId)
        .set('Idempotency-Key', key)
        .send({
          employeeId,
          locationId,
          startDate: '2099-05-04',
          endDate: '2099-05-05',
        })
        .expect(201);

      const r2 = await request(app.getHttpServer())
        .post('/requests')
        .set('X-Role', 'employee')
        .set('X-Actor-Id', employeeId)
        .set('Idempotency-Key', key)
        .send({
          employeeId,
          locationId,
          startDate: '2099-05-04',
          endDate: '2099-05-05',
        })
        .expect(201);

      expect(r2.body.id).toBe(r1.body.id);

      // Listing only shows one request.
      const list = await request(app.getHttpServer())
        .get(`/employees/${employeeId}/requests`)
        .set('X-Role', 'employee')
        .set('X-Actor-Id', employeeId)
        .expect(200);
      expect(list.body).toHaveLength(1);
    });
  });

  describe('insufficient balance', () => {
    it('rejects submission with available=0', async () => {
      const employeeId = `alice-broke-${Date.now()}`;
      const locationId = 'NYC';

      // No seed; default balance is 0.
      await request(app.getHttpServer())
        .post('/requests')
        .set('X-Role', 'employee')
        .set('X-Actor-Id', employeeId)
        .send({
          employeeId,
          locationId,
          startDate: '2099-05-04',
          endDate: '2099-05-05',
        })
        .expect(422);
    });

    it('rejects payload with extra unknown fields (whitelist)', async () => {
      await request(app.getHttpServer())
        .post('/requests')
        .set('X-Role', 'employee')
        .set('X-Actor-Id', 'alice')
        .send({
          employeeId: 'alice',
          locationId: 'NYC',
          startDate: '2099-05-04',
          endDate: '2099-05-05',
          maliciousField: 'should be rejected',
        })
        .expect(400);
    });
  });

  describe('batch reconciliation via HTTP', () => {
    it('repeated batchId is a no-op', async () => {
      const employeeId = `alice-batch-${Date.now()}`;
      const locationId = 'NYC';
      const payload = {
        batchId: `dup-${employeeId}`,
        generatedAt: new Date().toISOString(),
        balances: [{ employeeId, locationId, balance: 7 }],
      };

      const first = await request(app.getHttpServer())
        .post('/hcm/batch-sync')
        .set('X-Role', 'hcm')
        .send(payload)
        .expect(201);
      expect(first.body.alreadyProcessed).toBe(false);
      expect(first.body.newGrants).toBe(1);

      const second = await request(app.getHttpServer())
        .post('/hcm/batch-sync')
        .set('X-Role', 'hcm')
        .send(payload)
        .expect(201);
      expect(second.body.alreadyProcessed).toBe(true);
      expect(second.body.newGrants).toBe(0);
    });
  });
});
