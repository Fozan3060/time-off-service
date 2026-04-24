import { RequestStatus } from '../requests/request-status.enum';
import { LifecycleEvent } from './lifecycle-event.enum';
import { StateMachine } from './state-machine';

describe('StateMachine', () => {
  const sm = new StateMachine();

  describe('allowed transitions', () => {
    const allowed: Array<[RequestStatus, LifecycleEvent, RequestStatus]> = [
      [
        RequestStatus.PENDING_APPROVAL,
        LifecycleEvent.APPROVE,
        RequestStatus.APPROVED_SYNCING,
      ],
      [
        RequestStatus.PENDING_APPROVAL,
        LifecycleEvent.REJECT,
        RequestStatus.REJECTED,
      ],
      [
        RequestStatus.PENDING_APPROVAL,
        LifecycleEvent.CANCEL,
        RequestStatus.CANCELLED,
      ],
      [
        RequestStatus.APPROVED_SYNCING,
        LifecycleEvent.HCM_CONFIRMED,
        RequestStatus.SYNCED,
      ],
      [
        RequestStatus.APPROVED_SYNCING,
        LifecycleEvent.HCM_BUSINESS_REJECTED,
        RequestStatus.FAILED,
      ],
      [
        RequestStatus.APPROVED_SYNCING,
        LifecycleEvent.HCM_TRANSIENT_FAILURE,
        RequestStatus.SYNC_RETRY,
      ],
      [
        RequestStatus.APPROVED_SYNCING,
        LifecycleEvent.CANCEL,
        RequestStatus.CANCELLED,
      ],
      [
        RequestStatus.SYNC_RETRY,
        LifecycleEvent.HCM_RETRY,
        RequestStatus.APPROVED_SYNCING,
      ],
      [
        RequestStatus.SYNC_RETRY,
        LifecycleEvent.MAX_RETRIES_EXCEEDED,
        RequestStatus.FAILED,
      ],
      [
        RequestStatus.SYNC_RETRY,
        LifecycleEvent.CANCEL,
        RequestStatus.CANCELLED,
      ],
      [RequestStatus.SYNCED, LifecycleEvent.CANCEL, RequestStatus.CANCELLED],
      [RequestStatus.SYNCED, LifecycleEvent.COMPLETE, RequestStatus.COMPLETED],
    ];

    it.each(allowed)('%s + %s -> %s', (from, event, to) => {
      const result = sm.validate(from, event);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.nextState).toBe(to);
    });
  });

  describe('forbidden transitions', () => {
    it('rejects APPROVE on SYNCED', () => {
      const result = sm.validate(RequestStatus.SYNCED, LifecycleEvent.APPROVE);
      expect(result.ok).toBe(false);
    });

    it('rejects APPROVE on REJECTED', () => {
      const result = sm.validate(
        RequestStatus.REJECTED,
        LifecycleEvent.APPROVE,
      );
      expect(result.ok).toBe(false);
    });

    it('rejects any event on terminal states', () => {
      const terminals = [
        RequestStatus.REJECTED,
        RequestStatus.CANCELLED,
        RequestStatus.FAILED,
        RequestStatus.COMPLETED,
      ];
      const events = Object.values(LifecycleEvent);
      for (const from of terminals) {
        for (const event of events) {
          const result = sm.validate(from, event);
          expect(result.ok).toBe(false);
        }
      }
    });

    it('rejects CANCEL on already-terminal CANCELLED', () => {
      const result = sm.validate(
        RequestStatus.CANCELLED,
        LifecycleEvent.CANCEL,
      );
      expect(result.ok).toBe(false);
    });

    it('rejects HCM_CONFIRMED on PENDING_APPROVAL (must be approved first)', () => {
      const result = sm.validate(
        RequestStatus.PENDING_APPROVAL,
        LifecycleEvent.HCM_CONFIRMED,
      );
      expect(result.ok).toBe(false);
    });
  });
});
