import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { LifecycleModule } from '../lifecycle/lifecycle.module';
import { RequestsController } from '../requests/requests.controller';
import { RequestsModule } from '../requests/requests.module';

@Module({
  imports: [LifecycleModule, RequestsModule, LedgerModule],
  controllers: [RequestsController],
})
export class ApiModule {}
