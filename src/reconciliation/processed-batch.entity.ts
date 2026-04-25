import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

@Entity('processed_batches')
export class ProcessedBatch {
  @PrimaryColumn({ name: 'batch_id', type: 'varchar' })
  batchId!: string;

  @Column({ name: 'generated_at', type: 'datetime' })
  generatedAt!: Date;

  @Column({ name: 'balances_count', type: 'integer' })
  balancesCount!: number;

  @CreateDateColumn({ name: 'processed_at', type: 'datetime' })
  processedAt!: Date;
}
