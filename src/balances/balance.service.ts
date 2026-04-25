import { Injectable } from '@nestjs/common';
import { LedgerService } from '../ledger/ledger.service';
import { RequestsService } from '../requests/requests.service';

export interface BalanceSnapshot {
  employeeId: string;
  locationId: string;
  settled: number;
  pendingHolds: number;
  available: number;
}

@Injectable()
export class BalanceService {
  constructor(
    private readonly ledger: LedgerService,
    private readonly requests: RequestsService,
  ) {}

  async snapshot(
    employeeId: string,
    locationId: string,
  ): Promise<BalanceSnapshot> {
    const [settled, pendingHolds] = await Promise.all([
      this.ledger.settledBalance(employeeId, locationId),
      this.requests.pendingHolds(employeeId, locationId),
    ]);
    return {
      employeeId,
      locationId,
      settled,
      pendingHolds,
      available: settled - pendingHolds,
    };
  }

  async hasSufficientAvailable(
    employeeId: string,
    locationId: string,
    days: number,
  ): Promise<boolean> {
    const snapshot = await this.snapshot(employeeId, locationId);
    return snapshot.available >= days;
  }
}
