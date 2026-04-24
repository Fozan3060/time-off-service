import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LedgerEventType } from './ledger-event-type.enum';
import { Ledger } from './ledger.entity';

export interface AppendLedgerEntry {
  employeeId: string;
  locationId: string;
  delta: number;
  eventType: LedgerEventType;
  requestId?: string | null;
  idempotencyKey?: string | null;
  metadataJson?: string | null;
}

@Injectable()
export class LedgerService {
  constructor(
    @InjectRepository(Ledger)
    private readonly repo: Repository<Ledger>,
  ) {}

  async append(entry: AppendLedgerEntry): Promise<Ledger> {
    const row = this.repo.create({
      employeeId: entry.employeeId,
      locationId: entry.locationId,
      delta: entry.delta,
      eventType: entry.eventType,
      requestId: entry.requestId ?? null,
      idempotencyKey: entry.idempotencyKey ?? null,
      metadataJson: entry.metadataJson ?? null,
    });
    return this.repo.save(row);
  }

  async settledBalance(
    employeeId: string,
    locationId: string,
  ): Promise<number> {
    const result = await this.repo
      .createQueryBuilder('l')
      .select('COALESCE(SUM(l.delta), 0)', 'total')
      .where('l.employee_id = :employeeId', { employeeId })
      .andWhere('l.location_id = :locationId', { locationId })
      .getRawOne<{ total: string | number }>();
    return Number(result?.total ?? 0);
  }

  async findByRequest(requestId: string): Promise<Ledger[]> {
    return this.repo.find({
      where: { requestId },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
  }

  async findByKey(
    employeeId: string,
    locationId: string,
  ): Promise<Ledger[]> {
    return this.repo.find({
      where: { employeeId, locationId },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
  }
}
