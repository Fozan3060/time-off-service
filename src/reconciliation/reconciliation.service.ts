import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MutexRegistry } from '../concurrency/mutex-registry';
import { LedgerEventType } from '../ledger/ledger-event-type.enum';
import { LedgerService } from '../ledger/ledger.service';
import { RequestsService } from '../requests/requests.service';
import { ProcessedBatch } from './processed-batch.entity';

export interface BatchEntry {
  employeeId: string;
  locationId: string;
  balance: number;
}

export interface BatchSyncInput {
  batchId: string;
  generatedAt: string;
  balances: BatchEntry[];
}

export interface BatchSyncResult {
  batchId: string;
  alreadyProcessed: boolean;
  corrected: number;
  skippedInFlight: number;
  newGrants: number;
  unchanged: number;
}

type EntryOutcome = 'corrected' | 'skipped' | 'new_grant' | 'unchanged';

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);
  private readonly graceMs: number;

  constructor(
    @InjectRepository(ProcessedBatch)
    private readonly batchRepo: Repository<ProcessedBatch>,
    private readonly ledger: LedgerService,
    private readonly requests: RequestsService,
    private readonly mutex: MutexRegistry,
    private readonly config: ConfigService,
  ) {
    this.graceMs =
      this.config.get<number>('reconciliation.syncedGraceMs') ?? 30000;
  }

  async processBatch(input: BatchSyncInput): Promise<BatchSyncResult> {
    const existing = await this.batchRepo.findOne({
      where: { batchId: input.batchId },
    });
    if (existing) {
      return {
        batchId: input.batchId,
        alreadyProcessed: true,
        corrected: 0,
        skippedInFlight: 0,
        newGrants: 0,
        unchanged: 0,
      };
    }

    const generatedAt = new Date(input.generatedAt);
    const cutoff = new Date(generatedAt.getTime() - this.graceMs);

    const counts = {
      corrected: 0,
      skippedInFlight: 0,
      newGrants: 0,
      unchanged: 0,
    };

    for (const entry of input.balances) {
      const outcome = await this.reconcileEntry(
        entry,
        cutoff,
        input.batchId,
        input.generatedAt,
      );
      switch (outcome) {
        case 'corrected':
          counts.corrected += 1;
          break;
        case 'skipped':
          counts.skippedInFlight += 1;
          break;
        case 'new_grant':
          counts.newGrants += 1;
          break;
        case 'unchanged':
          counts.unchanged += 1;
          break;
      }
    }

    await this.batchRepo.insert({
      batchId: input.batchId,
      generatedAt,
      balancesCount: input.balances.length,
    });

    this.logger.log(
      `Batch ${input.batchId}: ${counts.corrected} corrected, ${counts.newGrants} new, ${counts.skippedInFlight} skipped (in-flight), ${counts.unchanged} unchanged`,
    );

    return {
      batchId: input.batchId,
      alreadyProcessed: false,
      ...counts,
    };
  }

  private async reconcileEntry(
    entry: BatchEntry,
    cutoff: Date,
    batchId: string,
    generatedAt: string,
  ): Promise<EntryOutcome> {
    const key = this.mutex.keyFor(entry.employeeId, entry.locationId);
    return this.mutex.runExclusive(key, async () => {
      const expected = await this.ledger.settledBalance(
        entry.employeeId,
        entry.locationId,
      );
      const delta = entry.balance - expected;

      if (delta === 0) return 'unchanged';

      // First time we're seeing this (employee, location) — treat the whole
      // balance as an INITIAL_GRANT rather than a correction.
      const existing = await this.ledger.findByKey(
        entry.employeeId,
        entry.locationId,
      );
      if (existing.length === 0) {
        await this.ledger.append({
          employeeId: entry.employeeId,
          locationId: entry.locationId,
          delta: entry.balance,
          eventType: LedgerEventType.INITIAL_GRANT,
          metadataJson: JSON.stringify({ batchId, generatedAt }),
        });
        return 'new_grant';
      }

      // In-flight grace window: if any SYNCED transition happened after the
      // batch was generated (minus a small clock-skew grace), the batch reflects
      // pre-sync HCM state. Skip and let the next batch confirm.
      const recentSynced = await this.requests.findSyncedAfter(
        entry.employeeId,
        entry.locationId,
        cutoff,
      );
      if (recentSynced) {
        this.logger.warn(
          `Skipping reconciliation for ${entry.employeeId}:${entry.locationId} — recent sync at ${recentSynced.syncedAt?.toISOString()} after batch cutoff ${cutoff.toISOString()}`,
        );
        return 'skipped';
      }

      await this.ledger.append({
        employeeId: entry.employeeId,
        locationId: entry.locationId,
        delta,
        eventType: LedgerEventType.RECONCILIATION_CORRECTION,
        metadataJson: JSON.stringify({
          batchId,
          generatedAt,
          expected,
          hcmReported: entry.balance,
        }),
      });
      return 'corrected';
    });
  }
}
