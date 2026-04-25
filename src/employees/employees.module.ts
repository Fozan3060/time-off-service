import { Module } from '@nestjs/common';
import { BalancesModule } from '../balances/balances.module';
import { RequestsModule } from '../requests/requests.module';
import { EmployeesController } from './employees.controller';

@Module({
  imports: [BalancesModule, RequestsModule],
  controllers: [EmployeesController],
})
export class EmployeesModule {}
