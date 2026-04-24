export enum RequestStatus {
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  APPROVED_SYNCING = 'APPROVED_SYNCING',
  SYNC_RETRY = 'SYNC_RETRY',
  SYNCED = 'SYNCED',
  COMPLETED = 'COMPLETED',
  REJECTED = 'REJECTED',
  CANCELLED = 'CANCELLED',
  FAILED = 'FAILED',
}

export const PENDING_HOLD_STATUSES: readonly RequestStatus[] = [
  RequestStatus.PENDING_APPROVAL,
  RequestStatus.APPROVED_SYNCING,
  RequestStatus.SYNC_RETRY,
] as const;

export const TERMINAL_STATUSES: readonly RequestStatus[] = [
  RequestStatus.SYNCED,
  RequestStatus.COMPLETED,
  RequestStatus.REJECTED,
  RequestStatus.CANCELLED,
  RequestStatus.FAILED,
] as const;

export function isPendingHold(status: RequestStatus): boolean {
  return PENDING_HOLD_STATUSES.includes(status);
}

export function isTerminal(status: RequestStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
