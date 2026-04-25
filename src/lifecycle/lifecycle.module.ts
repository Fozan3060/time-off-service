import { Module } from '@nestjs/common';
import { BalancesModule } from '../balances/balances.module';
import { HcmModule } from '../hcm/hcm.module';
import { LedgerModule } from '../ledger/ledger.module';
import { RequestsModule } from '../requests/requests.module';
import { RequestLifecycleService } from './request-lifecycle.service';
import { StateMachine } from './state-machine';

@Module({
  imports: [RequestsModule, BalancesModule, LedgerModule, HcmModule],
  providers: [StateMachine, RequestLifecycleService],
  exports: [StateMachine, RequestLifecycleService],
})
export class LifecycleModule {}
