import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Ledger } from './ledger.entity';
import { LedgerService } from './ledger.service';

@Module({
  imports: [TypeOrmModule.forFeature([Ledger])],
  providers: [LedgerService],
  exports: [LedgerService],
})
export class LedgerModule {}
