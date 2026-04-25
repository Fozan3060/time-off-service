import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { RequestsModule } from '../requests/requests.module';
import { BalanceService } from './balance.service';

@Module({
  imports: [LedgerModule, RequestsModule],
  providers: [BalanceService],
  exports: [BalanceService],
})
export class BalancesModule {}
