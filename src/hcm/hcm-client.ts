import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosError, AxiosInstance } from 'axios';
import {
  HcmBusinessError,
  HcmTransientError,
  HcmVerificationError,
} from './hcm.errors';
import type {
  ApplyDeductionInput,
  DeductionRecord,
  HcmClientConfig,
} from './hcm.types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

@Injectable()
export class HcmClient {
  private readonly logger = new Logger(HcmClient.name);
  private readonly http: AxiosInstance;

  constructor(private readonly config: HcmClientConfig) {
    this.http = axios.create({
      baseURL: config.baseUrl,
      timeout: config.timeoutMs,
      headers: config.apiKey ? { 'X-Api-Key': config.apiKey } : {},
      validateStatus: () => true,
    });
  }

  async getBalance(employeeId: string, locationId: string): Promise<number> {
    return this.withRetry(async () => {
      const response = await this.http.get(
        `/balances/${encodeURIComponent(employeeId)}/${encodeURIComponent(
          locationId,
        )}`,
      );
      this.assertSuccess(response);
      const data = response.data as { balance?: number };
      return Number(data.balance ?? 0);
    });
  }

  async applyDeduction(input: ApplyDeductionInput): Promise<DeductionRecord> {
    return this.withRetry(async () => {
      const response = await this.http.post(
        '/deductions',
        {
          employeeId: input.employeeId,
          locationId: input.locationId,
          delta: input.delta,
        },
        { headers: { 'Idempotency-Key': input.idempotencyKey } },
      );
      this.assertSuccess(response);
      const record = response.data as DeductionRecord;

      if (this.config.verifyAfterWrite) {
        await this.verify(input.idempotencyKey);
      }
      return record;
    });
  }

  async lookupOperation(
    idempotencyKey: string,
  ): Promise<DeductionRecord | null> {
    const response = await this.http.get(
      `/deductions/${encodeURIComponent(idempotencyKey)}`,
    );
    if (response.status === 404) return null;
    this.assertSuccess(response);
    return response.data as DeductionRecord;
  }

  private async verify(idempotencyKey: string): Promise<void> {
    let record: DeductionRecord | null = null;
    try {
      record = await this.lookupOperation(idempotencyKey);
    } catch (err) {
      // Lookup endpoint itself is unavailable. Per TRD Section 7.5, log and
      // rely on the next batch reconciliation to catch any drift.
      this.logger.warn(
        `HCM lookup unavailable for ${idempotencyKey}; relying on batch reconciliation. ${
          err instanceof Error ? err.message : err
        }`,
      );
      return;
    }
    if (!record) {
      throw new HcmVerificationError(idempotencyKey);
    }
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    const totalAttempts = this.config.maxRetries + 1;
    let lastTransient: HcmTransientError | null = null;
    for (let attempt = 0; attempt < totalAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const classified = this.classify(err);
        if (classified instanceof HcmTransientError) {
          lastTransient = classified;
          if (attempt < totalAttempts - 1) {
            await sleep(this.config.backoffStrategy(attempt));
            continue;
          }
        }
        throw classified;
      }
    }
    throw lastTransient ?? new HcmTransientError();
  }

  private assertSuccess(response: { status: number; data: unknown }): void {
    if (response.status >= 200 && response.status < 300) return;
    if (response.status >= 400 && response.status < 500) {
      throw new HcmBusinessError(response.status, response.data);
    }
    throw new HcmTransientError(`HCM responded with status ${response.status}`);
  }

  private classify(err: unknown): Error {
    if (err instanceof HcmBusinessError) return err;
    if (err instanceof HcmVerificationError) return err;
    if (err instanceof HcmTransientError) return err;
    if (err instanceof AxiosError) {
      return new HcmTransientError(
        `Network/timeout: ${err.code ?? ''} ${err.message}`.trim(),
      );
    }
    if (err instanceof Error) return new HcmTransientError(err.message);
    return new HcmTransientError('Unknown error');
  }
}
