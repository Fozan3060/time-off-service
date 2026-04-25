import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { BalanceService } from '../balances/balance.service';
import { MutexRegistry } from '../concurrency/mutex-registry';
import { HcmClient } from '../hcm/hcm-client';
import {
  HcmBusinessError,
  HcmTransientError,
  HcmVerificationError,
} from '../hcm/hcm.errors';
import { LedgerEventType } from '../ledger/ledger-event-type.enum';
import { LedgerService } from '../ledger/ledger.service';
import { RequestStatus } from '../requests/request-status.enum';
import { RequestsService } from '../requests/requests.service';
import { TimeOffRequest } from '../requests/time-off-request.entity';
import { LifecycleEvent } from './lifecycle-event.enum';
import { StateMachine } from './state-machine';
import { countWorkingDays } from './working-days';

export interface SubmitRequestInput {
  employeeId: string;
  locationId: string;
  startDate: string;
  endDate: string;
  clientIdempotencyKey?: string | null;
}

@Injectable()
export class RequestLifecycleService {
  private readonly logger = new Logger(RequestLifecycleService.name);

  constructor(
    private readonly requests: RequestsService,
    private readonly balances: BalanceService,
    private readonly ledger: LedgerService,
    private readonly stateMachine: StateMachine,
    private readonly mutex: MutexRegistry,
    private readonly hcm: HcmClient,
  ) {}

  async submit(input: SubmitRequestInput): Promise<TimeOffRequest> {
    if (input.clientIdempotencyKey) {
      const existing = await this.requests.findByClientIdempotencyKey(
        input.employeeId,
        input.clientIdempotencyKey,
      );
      if (existing) return existing;
    }

    const days = countWorkingDays(input.startDate, input.endDate);
    if (days <= 0) {
      throw new BadRequestException({
        code: 'INVALID_DATE_RANGE',
        message:
          'Request must span at least one working day (Mon–Fri, end on or after start).',
      });
    }

    if (!this.isFutureOrToday(input.startDate)) {
      throw new BadRequestException({
        code: 'START_DATE_IN_PAST',
        message: 'Start date must be today or later.',
      });
    }

    const key = this.mutex.keyFor(input.employeeId, input.locationId);
    return this.mutex.runExclusive(key, async () => {
      const snapshot = await this.balances.snapshot(
        input.employeeId,
        input.locationId,
      );
      if (snapshot.available < days) {
        throw new UnprocessableEntityException({
          code: 'INSUFFICIENT_BALANCE',
          message: `Available balance is ${snapshot.available} day(s), requested ${days}.`,
          details: { available: snapshot.available, requested: days },
        });
      }

      return this.requests.create({
        id: randomUUID(),
        employeeId: input.employeeId,
        locationId: input.locationId,
        startDate: input.startDate,
        endDate: input.endDate,
        days,
        clientIdempotencyKey: input.clientIdempotencyKey ?? null,
      });
    });
  }

  async approve(
    requestId: string,
    managerId: string,
  ): Promise<TimeOffRequest> {
    const req = await this.requests.findById(requestId);
    if (!req) throw new NotFoundException('Request not found');
    if (req.employeeId === managerId) {
      throw new ForbiddenException(
        'A manager cannot act on their own time-off request.',
      );
    }

    const key = this.mutex.keyFor(req.employeeId, req.locationId);

    // Phase 1: PENDING_APPROVAL -> APPROVED_SYNCING (under mutex), assign HCM key.
    const approved = await this.mutex.runExclusive(key, async () => {
      const fresh = await this.requests.findById(requestId);
      if (!fresh) throw new NotFoundException('Request not found');

      const transition = this.stateMachine.validate(
        fresh.status,
        LifecycleEvent.APPROVE,
      );
      if (!transition.ok) {
        throw new ConflictException({
          code: 'INVALID_TRANSITION',
          message: transition.reason,
        });
      }

      fresh.status = transition.nextState;
      fresh.managerId = managerId;
      fresh.hcmIdempotencyKey = `req-${fresh.id}`;
      return this.requests.save(fresh);
    });

    // Phase 2: HCM call (no mutex held).
    return this.syncToHcm(approved);
  }

  async reject(
    requestId: string,
    managerId: string,
    reason: string | null = null,
  ): Promise<TimeOffRequest> {
    const req = await this.requests.findById(requestId);
    if (!req) throw new NotFoundException('Request not found');
    if (req.employeeId === managerId) {
      throw new ForbiddenException(
        'A manager cannot act on their own time-off request.',
      );
    }

    const key = this.mutex.keyFor(req.employeeId, req.locationId);
    return this.mutex.runExclusive(key, async () => {
      const fresh = await this.requests.findById(requestId);
      if (!fresh) throw new NotFoundException('Request not found');

      const transition = this.stateMachine.validate(
        fresh.status,
        LifecycleEvent.REJECT,
      );
      if (!transition.ok) {
        throw new ConflictException({
          code: 'INVALID_TRANSITION',
          message: transition.reason,
        });
      }

      fresh.status = transition.nextState;
      fresh.managerId = managerId;
      fresh.rejectionReason = reason;
      return this.requests.save(fresh);
    });
  }

  async cancel(requestId: string, actorId: string): Promise<TimeOffRequest> {
    const req = await this.requests.findById(requestId);
    if (!req) throw new NotFoundException('Request not found');
    if (req.employeeId !== actorId) {
      throw new ForbiddenException('Only the requesting employee can cancel.');
    }
    if (!this.isFutureOrToday(req.startDate)) {
      throw new UnprocessableEntityException({
        code: 'CANCEL_AFTER_START',
        message: 'Cannot cancel a request whose leave has already started.',
      });
    }

    if (req.status === RequestStatus.SYNCED) {
      return this.cancelSynced(req);
    }

    const key = this.mutex.keyFor(req.employeeId, req.locationId);
    return this.mutex.runExclusive(key, async () => {
      const fresh = await this.requests.findById(requestId);
      if (!fresh) throw new NotFoundException('Request not found');

      const transition = this.stateMachine.validate(
        fresh.status,
        LifecycleEvent.CANCEL,
      );
      if (!transition.ok) {
        throw new ConflictException({
          code: 'INVALID_TRANSITION',
          message: transition.reason,
        });
      }

      fresh.status = transition.nextState;
      fresh.cancelledAt = new Date();
      return this.requests.save(fresh);
    });
  }

  /**
   * Cancellation of a synced request. Issues a compensating HCM call
   * (refund the days), then transitions to CANCELLED and writes a
   * CANCELLATION_REFUND ledger row.
   */
  private async cancelSynced(req: TimeOffRequest): Promise<TimeOffRequest> {
    const compensationKey = `req-${req.id}-cancel`;
    try {
      await this.hcm.applyDeduction({
        employeeId: req.employeeId,
        locationId: req.locationId,
        delta: req.days, // positive = refund
        idempotencyKey: compensationKey,
      });
    } catch (err) {
      // Surface HCM problems to the caller; the request stays SYNCED so
      // the user can try again. Production would also send to a retry queue.
      this.logger.warn(
        `Compensation failed for request ${req.id}: ${
          err instanceof Error ? err.message : err
        }`,
      );
      if (err instanceof HcmBusinessError) {
        throw new ConflictException({
          code: 'COMPENSATION_REJECTED_BY_HCM',
          message: 'HCM rejected the cancellation refund.',
        });
      }
      throw new ConflictException({
        code: 'COMPENSATION_FAILED',
        message:
          'Cancellation refund did not complete; the request is still SYNCED.',
      });
    }

    const key = this.mutex.keyFor(req.employeeId, req.locationId);
    return this.mutex.runExclusive(key, async () => {
      const fresh = await this.requests.findById(req.id);
      if (!fresh) throw new NotFoundException('Request not found');

      const transition = this.stateMachine.validate(
        fresh.status,
        LifecycleEvent.CANCEL,
      );
      if (!transition.ok) {
        throw new ConflictException({
          code: 'INVALID_TRANSITION',
          message: transition.reason,
        });
      }

      fresh.status = transition.nextState;
      fresh.cancelledAt = new Date();
      const saved = await this.requests.save(fresh);

      await this.ledger.append({
        employeeId: fresh.employeeId,
        locationId: fresh.locationId,
        delta: fresh.days,
        eventType: LedgerEventType.CANCELLATION_REFUND,
        requestId: fresh.id,
        idempotencyKey: compensationKey,
      });
      return saved;
    });
  }

  private async syncToHcm(req: TimeOffRequest): Promise<TimeOffRequest> {
    const key = this.mutex.keyFor(req.employeeId, req.locationId);

    try {
      await this.hcm.applyDeduction({
        employeeId: req.employeeId,
        locationId: req.locationId,
        delta: -req.days,
        idempotencyKey: req.hcmIdempotencyKey!,
      });

      // Phase 3: APPROVED_SYNCING -> SYNCED, append ledger row.
      return this.mutex.runExclusive(key, async () => {
        const fresh = await this.requests.findById(req.id);
        if (!fresh) throw new NotFoundException('Request not found');

        const transition = this.stateMachine.validate(
          fresh.status,
          LifecycleEvent.HCM_CONFIRMED,
        );
        if (!transition.ok) {
          // The state moved underneath us (e.g. concurrent cancel).
          // Don't force the transition; log for visibility.
          this.logger.warn(
            `Skipping HCM_CONFIRMED transition on request ${fresh.id}: ${transition.reason}`,
          );
          return fresh;
        }

        fresh.status = transition.nextState;
        fresh.syncedAt = new Date();
        const saved = await this.requests.save(fresh);

        await this.ledger.append({
          employeeId: fresh.employeeId,
          locationId: fresh.locationId,
          delta: -fresh.days,
          eventType: LedgerEventType.TIME_OFF_DEDUCTION,
          requestId: fresh.id,
          idempotencyKey: fresh.hcmIdempotencyKey,
        });
        return saved;
      });
    } catch (err) {
      // Retries are handled internally by HcmClient; reaching this catch
      // means the operation has terminally failed for this attempt.
      const event = this.classifyHcmError(err);
      const errorMessage = err instanceof Error ? err.message : String(err);

      return this.mutex.runExclusive(key, async () => {
        const fresh = await this.requests.findById(req.id);
        if (!fresh) throw err;

        const transition = this.stateMachine.validate(fresh.status, event);
        if (!transition.ok) {
          this.logger.warn(
            `Skipping ${event} transition on request ${fresh.id}: ${transition.reason}`,
          );
          return fresh;
        }

        fresh.status = transition.nextState;
        fresh.hcmLastError = errorMessage;
        fresh.hcmSyncAttempts += 1;
        return this.requests.save(fresh);
      });
    }
  }

  private classifyHcmError(err: unknown): LifecycleEvent {
    if (err instanceof HcmBusinessError) {
      return LifecycleEvent.HCM_BUSINESS_REJECTED;
    }
    if (err instanceof HcmTransientError || err instanceof HcmVerificationError) {
      // After HcmClient has exhausted its internal retries, treat as terminal
      // for this exercise. A future branch would route to SYNC_RETRY and a
      // background sweeper would re-attempt with longer backoff.
      return LifecycleEvent.HCM_BUSINESS_REJECTED;
    }
    return LifecycleEvent.HCM_BUSINESS_REJECTED;
  }

  private isFutureOrToday(dateString: string): boolean {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const start = new Date(dateString);
    start.setUTCHours(0, 0, 0, 0);
    return start.getTime() >= today.getTime();
  }
}
