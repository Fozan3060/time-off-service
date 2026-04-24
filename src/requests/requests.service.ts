import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  PENDING_HOLD_STATUSES,
  RequestStatus,
} from './request-status.enum';
import { TimeOffRequest } from './time-off-request.entity';

export interface CreateRequestInput {
  id: string;
  employeeId: string;
  locationId: string;
  startDate: string;
  endDate: string;
  days: number;
  clientIdempotencyKey?: string | null;
}

@Injectable()
export class RequestsService {
  constructor(
    @InjectRepository(TimeOffRequest)
    private readonly repo: Repository<TimeOffRequest>,
  ) {}

  async create(input: CreateRequestInput): Promise<TimeOffRequest> {
    const row = this.repo.create({
      id: input.id,
      employeeId: input.employeeId,
      locationId: input.locationId,
      startDate: input.startDate,
      endDate: input.endDate,
      days: input.days,
      status: RequestStatus.PENDING_APPROVAL,
      managerId: null,
      rejectionReason: null,
      clientIdempotencyKey: input.clientIdempotencyKey ?? null,
      hcmIdempotencyKey: null,
      hcmSyncAttempts: 0,
      hcmLastError: null,
      syncedAt: null,
      cancelledAt: null,
    });
    return this.repo.save(row);
  }

  async findById(id: string): Promise<TimeOffRequest | null> {
    return this.repo.findOne({ where: { id } });
  }

  async findByClientIdempotencyKey(
    employeeId: string,
    key: string,
  ): Promise<TimeOffRequest | null> {
    return this.repo.findOne({
      where: { employeeId, clientIdempotencyKey: key },
    });
  }

  async pendingHolds(
    employeeId: string,
    locationId: string,
  ): Promise<number> {
    const result = await this.repo
      .createQueryBuilder('r')
      .select('COALESCE(SUM(r.days), 0)', 'total')
      .where('r.employee_id = :employeeId', { employeeId })
      .andWhere('r.location_id = :locationId', { locationId })
      .andWhere('r.status IN (:...statuses)', {
        statuses: PENDING_HOLD_STATUSES,
      })
      .getRawOne<{ total: string | number }>();
    return Number(result?.total ?? 0);
  }

  async listForEmployee(
    employeeId: string,
    status?: RequestStatus,
  ): Promise<TimeOffRequest[]> {
    return this.repo.find({
      where: status ? { employeeId, status } : { employeeId },
      order: { createdAt: 'DESC' },
    });
  }

  async save(row: TimeOffRequest): Promise<TimeOffRequest> {
    return this.repo.save(row);
  }
}
