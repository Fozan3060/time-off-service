import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApiModule } from './api/api.module';
import { AuthModule } from './auth/auth.module';
import { BalancesModule } from './balances/balances.module';
import { ConcurrencyModule } from './concurrency/concurrency.module';
import configuration from './config/configuration';
import { EmployeesModule } from './employees/employees.module';
import { HcmModule } from './hcm/hcm.module';
import { HealthModule } from './health/health.module';
import { LedgerModule } from './ledger/ledger.module';
import { LifecycleModule } from './lifecycle/lifecycle.module';
import { ReconciliationModule } from './reconciliation/reconciliation.module';
import { RequestsModule } from './requests/requests.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      envFilePath: '.env',
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'sqlite',
        database:
          config.get<string>('database.path') ?? 'data/time-off.sqlite',
        entities: [__dirname + '/**/*.entity{.ts,.js}'],
        synchronize: config.get<boolean>('database.synchronize') ?? false,
        logging: config.get<boolean>('database.logging') ?? false,
      }),
    }),
    AuthModule,
    ConcurrencyModule,
    HealthModule,
    LedgerModule,
    RequestsModule,
    BalancesModule,
    HcmModule,
    LifecycleModule,
    ReconciliationModule,
    EmployeesModule,
    ApiModule,
  ],
})
export class AppModule {}
