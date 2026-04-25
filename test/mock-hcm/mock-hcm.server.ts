import express, { Express, Response } from 'express';
import { Server } from 'http';

export interface DeductionRecord {
  idempotencyKey: string;
  employeeId: string;
  locationId: string;
  delta: number;
  newBalance: number;
  appliedAt: string;
}

interface FailureConfig {
  /** Counter of upcoming calls that should fail with HTTP 5xx. */
  failNext5xx: number;
  /** Counter of upcoming calls that should fail with HTTP 4xx. */
  failNext4xx: number;
  /** Counter of upcoming calls that should be delayed by `delayMs`. */
  delayNext: number;
  /** How long delayed calls wait before responding. */
  delayMs: number;
  /**
   * Counter of upcoming calls where the deduction is reported as 200 OK
   * but is NOT stored — simulates HCM silently dropping a write.
   */
  silentAcceptNext: number;
  /**
   * Counter of upcoming GET /deductions/:idempotencyKey calls that
   * should fail with 503 (lookup endpoint unavailable).
   */
  lookupFailNext: number;
}

interface State {
  balances: Map<string, number>;
  deductions: Map<string, DeductionRecord>;
  failure: FailureConfig;
  /** Tracks total request counts per endpoint, useful for assertions. */
  hits: { deductions: number; balances: number; lookups: number };
}

const balanceKey = (e: string, l: string) => `${e}:${l}`;

export class MockHcmServer {
  private state: State = MockHcmServer.fresh();
  private server: Server | null = null;
  private actualPort = 0;
  public readonly app: Express;

  constructor() {
    this.app = express();
    this.app.use(express.json());
    this.attach();
  }

  private static fresh(): State {
    return {
      balances: new Map(),
      deductions: new Map(),
      failure: {
        failNext5xx: 0,
        failNext4xx: 0,
        delayNext: 0,
        delayMs: 0,
        silentAcceptNext: 0,
        lookupFailNext: 0,
      },
      hits: { deductions: 0, balances: 0, lookups: 0 },
    };
  }

  reset(): void {
    this.state = MockHcmServer.fresh();
  }

  seedBalance(employeeId: string, locationId: string, balance: number): void {
    this.state.balances.set(balanceKey(employeeId, locationId), balance);
  }

  configure(updates: Partial<FailureConfig>): void {
    this.state.failure = { ...this.state.failure, ...updates };
  }

  getDeductions(): DeductionRecord[] {
    return [...this.state.deductions.values()];
  }

  getBalance(employeeId: string, locationId: string): number {
    return this.state.balances.get(balanceKey(employeeId, locationId)) ?? 0;
  }

  getHits(): State['hits'] {
    return { ...this.state.hits };
  }

  async start(port = 0): Promise<number> {
    return new Promise((resolve) => {
      this.server = this.app.listen(port, () => {
        const address = this.server!.address();
        this.actualPort =
          typeof address === 'object' && address ? address.port : port;
        resolve(this.actualPort);
      });
    });
  }

  port(): number {
    return this.actualPort;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => {
      this.server!.close((err) => (err ? reject(err) : resolve()));
    });
    this.server = null;
  }

  private attach(): void {
    this.app.get('/balances/:employeeId/:locationId', async (req, res) => {
      this.state.hits.balances += 1;
      if (await this.applyTransientFailures(res)) return;
      const employeeId = req.params.employeeId;
      const locationId = req.params.locationId;
      const balance =
        this.state.balances.get(balanceKey(employeeId, locationId)) ?? 0;
      res.json({ employeeId, locationId, balance });
    });

    this.app.post('/deductions', async (req, res) => {
      this.state.hits.deductions += 1;
      if (await this.applyTransientFailures(res)) return;

      const idempotencyKey = req.header('Idempotency-Key');
      if (!idempotencyKey) {
        return res.status(400).json({
          code: 'MISSING_IDEMPOTENCY_KEY',
          message: 'Idempotency-Key header is required',
        });
      }

      // Idempotent replay: same key returns the cached result.
      const cached = this.state.deductions.get(idempotencyKey);
      if (cached) return res.json(cached);

      const body = req.body as {
        employeeId?: string;
        locationId?: string;
        delta?: number;
      };
      if (
        !body.employeeId ||
        !body.locationId ||
        typeof body.delta !== 'number'
      ) {
        return res.status(400).json({
          code: 'INVALID_BODY',
          message: 'employeeId, locationId, and numeric delta are required',
        });
      }

      // Silent accept: report success but DON'T persist.
      if (this.state.failure.silentAcceptNext > 0) {
        this.state.failure.silentAcceptNext -= 1;
        const synthetic: DeductionRecord = {
          idempotencyKey,
          employeeId: body.employeeId,
          locationId: body.locationId,
          delta: body.delta,
          newBalance: this.state.balances.get(
            balanceKey(body.employeeId, body.locationId),
          ) ?? 0,
          appliedAt: new Date().toISOString(),
        };
        return res.json(synthetic);
      }

      const key = balanceKey(body.employeeId, body.locationId);
      const current = this.state.balances.get(key) ?? 0;
      const newBalance = current + body.delta;
      this.state.balances.set(key, newBalance);

      const record: DeductionRecord = {
        idempotencyKey,
        employeeId: body.employeeId,
        locationId: body.locationId,
        delta: body.delta,
        newBalance,
        appliedAt: new Date().toISOString(),
      };
      this.state.deductions.set(idempotencyKey, record);
      res.json(record);
    });

    this.app.get('/deductions/:idempotencyKey', (req, res) => {
      this.state.hits.lookups += 1;
      if (this.state.failure.lookupFailNext > 0) {
        this.state.failure.lookupFailNext -= 1;
        return res.status(503).json({
          code: 'LOOKUP_UNAVAILABLE',
          message: 'Lookup service is temporarily unavailable',
        });
      }
      const record = this.state.deductions.get(req.params.idempotencyKey);
      if (!record) {
        return res.status(404).json({
          code: 'NOT_FOUND',
          message: `No deduction with idempotency key ${req.params.idempotencyKey}`,
        });
      }
      res.json(record);
    });
  }

  /**
   * Returns true if a transient failure mode triggered and a response has been
   * written. The caller must `return` after a true result to avoid double-write.
   */
  private async applyTransientFailures(res: Response): Promise<boolean> {
    const f = this.state.failure;
    if (f.failNext5xx > 0) {
      f.failNext5xx -= 1;
      res.status(503).json({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Simulated transient HCM failure',
      });
      return true;
    }
    if (f.failNext4xx > 0) {
      f.failNext4xx -= 1;
      res.status(422).json({
        code: 'INSUFFICIENT_BALANCE',
        message: 'Simulated business rejection',
      });
      return true;
    }
    if (f.delayNext > 0) {
      f.delayNext -= 1;
      await new Promise((r) => setTimeout(r, f.delayMs));
    }
    return false;
  }
}
