export interface HcmClientConfig {
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  maxRetries: number;
  /**
   * Returns the number of milliseconds to wait before retry attempt N
   * (0-indexed). Production default: 1000 * 2^attempt (1s, 2s, 4s).
   */
  backoffStrategy: (attempt: number) => number;
  /**
   * If true, every applyDeduction call follows the 2xx with a GET
   * /deductions/:idempotencyKey to confirm the write actually landed.
   */
  verifyAfterWrite: boolean;
}

export interface ApplyDeductionInput {
  employeeId: string;
  locationId: string;
  delta: number;
  idempotencyKey: string;
}

export interface DeductionRecord {
  idempotencyKey: string;
  employeeId: string;
  locationId: string;
  delta: number;
  newBalance: number;
  appliedAt: string;
}
