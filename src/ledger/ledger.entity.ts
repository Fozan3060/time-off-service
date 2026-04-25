import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { LedgerEventType } from './ledger-event-type.enum';

@Entity('ledger')
@Index('idx_ledger_employee_location_created', [
  'employeeId',
  'locationId',
  'createdAt',
])
@Index('idx_ledger_request', ['requestId'])
export class Ledger {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'employee_id', type: 'varchar' })
  employeeId!: string;

  @Column({ name: 'location_id', type: 'varchar' })
  locationId!: string;

  @Column({ type: 'integer' })
  delta!: number;

  @Column({ name: 'event_type', type: 'varchar' })
  eventType!: LedgerEventType;

  @Column({ name: 'request_id', type: 'varchar', nullable: true })
  requestId!: string | null;

  @Column({ name: 'idempotency_key', type: 'varchar', nullable: true })
  idempotencyKey!: string | null;

  @Column({ name: 'metadata_json', type: 'text', nullable: true })
  metadataJson!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt!: Date;
}
