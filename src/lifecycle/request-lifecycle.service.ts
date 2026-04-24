import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { BalanceService } from '../balances/balance.service';
import { MutexRegistry } from '../concurrency/mutex-registry';
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
  constructor(
    private readonly requests: RequestsService,
    private readonly balances: BalanceService,
    private readonly stateMachine: StateMachine,
    private readonly mutex: MutexRegistry,
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
    return this.applyManagerDecision(
      requestId,
      managerId,
      LifecycleEvent.APPROVE,
    );
  }

  async reject(
    requestId: string,
    managerId: string,
    reason: string | null = null,
  ): Promise<TimeOffRequest> {
    return this.applyManagerDecision(
      requestId,
      managerId,
      LifecycleEvent.REJECT,
      reason,
    );
  }

  async cancel(
    requestId: string,
    actorId: string,
  ): Promise<TimeOffRequest> {
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

      // Note: cancellation after HCM sync requires a compensating HCM call.
      // That is handled by the HCM integration branch; for now this path
      // only supports cancelling from non-synced states.
      if (fresh.status === RequestStatus.SYNCED) {
        throw new ConflictException({
          code: 'COMPENSATION_NOT_IMPLEMENTED',
          message:
            'Cancellation of a synced request requires HCM compensation. ' +
            'This flow is implemented in a follow-up branch.',
        });
      }

      fresh.status = transition.nextState;
      fresh.cancelledAt = new Date();
      return this.requests.save(fresh);
    });
  }

  private async applyManagerDecision(
    requestId: string,
    managerId: string,
    event: LifecycleEvent.APPROVE | LifecycleEvent.REJECT,
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

      const transition = this.stateMachine.validate(fresh.status, event);
      if (!transition.ok) {
        throw new ConflictException({
          code: 'INVALID_TRANSITION',
          message: transition.reason,
        });
      }

      fresh.status = transition.nextState;
      fresh.managerId = managerId;
      if (event === LifecycleEvent.REJECT) {
        fresh.rejectionReason = reason;
      }
      return this.requests.save(fresh);
    });
  }

  private isFutureOrToday(dateString: string): boolean {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const start = new Date(dateString);
    start.setUTCHours(0, 0, 0, 0);
    return start.getTime() >= today.getTime();
  }
}
