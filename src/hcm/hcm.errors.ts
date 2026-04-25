/**
 * Business rejection by HCM (4xx). Not retried — the request is invalid in
 * HCM's view (e.g. insufficient balance, invalid employee/location combination).
 */
export class HcmBusinessError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly body: unknown,
  ) {
    super(`HCM business rejection: HTTP ${httpStatus}`);
    this.name = 'HcmBusinessError';
  }
}

/**
 * Transient failure: network timeout, dropped connection, 5xx, or any other
 * recoverable problem. Retried inside HcmClient until maxRetries is reached.
 */
export class HcmTransientError extends Error {
  constructor(message = 'HCM transient failure') {
    super(message);
    this.name = 'HcmTransientError';
  }
}

/**
 * HCM returned a 2xx for a write but the follow-up lookup did not find the
 * idempotency key on file. Indicates HCM may have silently dropped the write,
 * or that there was a propagation delay. Caller decides whether to retry.
 */
export class HcmVerificationError extends Error {
  constructor(public readonly idempotencyKey: string) {
    super(
      `HCM verification failed: idempotency key ${idempotencyKey} not found after a 2xx`,
    );
    this.name = 'HcmVerificationError';
  }
}
