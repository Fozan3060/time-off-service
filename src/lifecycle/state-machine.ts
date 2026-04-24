import { Injectable } from '@nestjs/common';
import { RequestStatus } from '../requests/request-status.enum';
import { LifecycleEvent } from './lifecycle-event.enum';

export type TransitionResult =
  | { ok: true; nextState: RequestStatus }
  | { ok: false; reason: string };

type TransitionTable = {
  [from in RequestStatus]?: {
    [event in LifecycleEvent]?: RequestStatus;
  };
};

@Injectable()
export class StateMachine {
  private readonly table: TransitionTable = {
    [RequestStatus.PENDING_APPROVAL]: {
      [LifecycleEvent.APPROVE]: RequestStatus.APPROVED_SYNCING,
      [LifecycleEvent.REJECT]: RequestStatus.REJECTED,
      [LifecycleEvent.CANCEL]: RequestStatus.CANCELLED,
    },
    [RequestStatus.APPROVED_SYNCING]: {
      [LifecycleEvent.HCM_CONFIRMED]: RequestStatus.SYNCED,
      [LifecycleEvent.HCM_BUSINESS_REJECTED]: RequestStatus.FAILED,
      [LifecycleEvent.HCM_TRANSIENT_FAILURE]: RequestStatus.SYNC_RETRY,
      [LifecycleEvent.CANCEL]: RequestStatus.CANCELLED,
    },
    [RequestStatus.SYNC_RETRY]: {
      [LifecycleEvent.HCM_RETRY]: RequestStatus.APPROVED_SYNCING,
      [LifecycleEvent.MAX_RETRIES_EXCEEDED]: RequestStatus.FAILED,
      [LifecycleEvent.CANCEL]: RequestStatus.CANCELLED,
    },
    [RequestStatus.SYNCED]: {
      [LifecycleEvent.CANCEL]: RequestStatus.CANCELLED,
      [LifecycleEvent.COMPLETE]: RequestStatus.COMPLETED,
    },
  };

  validate(from: RequestStatus, event: LifecycleEvent): TransitionResult {
    const next = this.table[from]?.[event];
    if (!next) {
      return {
        ok: false,
        reason: `Cannot apply ${event} from state ${from}`,
      };
    }
    return { ok: true, nextState: next };
  }
}
