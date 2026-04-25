import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { RequestStatus } from './request-status.enum';

@Entity('requests')
@Index('idx_requests_employee_status', ['employeeId', 'status'])
@Index('idx_requests_manager_status', ['managerId', 'status'])
export class TimeOffRequest {
  @PrimaryColumn({ type: 'varchar' })
  id!: string;

  @Column({ name: 'employee_id', type: 'varchar' })
  employeeId!: string;

  @Column({ name: 'location_id', type: 'varchar' })
  locationId!: string;

  @Column({ name: 'start_date', type: 'date' })
  startDate!: string;

  @Column({ name: 'end_date', type: 'date' })
  endDate!: string;

  @Column({ type: 'integer' })
  days!: number;

  @Column({ type: 'varchar' })
  status!: RequestStatus;

  @Column({ name: 'manager_id', type: 'varchar', nullable: true })
  managerId!: string | null;

  @Column({ name: 'rejection_reason', type: 'text', nullable: true })
  rejectionReason!: string | null;

  @Column({
    name: 'client_idempotency_key',
    type: 'varchar',
    nullable: true,
    unique: true,
  })
  clientIdempotencyKey!: string | null;

  @Column({ name: 'hcm_idempotency_key', type: 'varchar', nullable: true })
  hcmIdempotencyKey!: string | null;

  @Column({ name: 'hcm_sync_attempts', type: 'integer', default: 0 })
  hcmSyncAttempts!: number;

  @Column({ name: 'hcm_last_error', type: 'text', nullable: true })
  hcmLastError!: string | null;

  @Column({ name: 'synced_at', type: 'datetime', nullable: true })
  syncedAt!: Date | null;

  @Column({ name: 'cancelled_at', type: 'datetime', nullable: true })
  cancelledAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime' })
  updatedAt!: Date;
}
