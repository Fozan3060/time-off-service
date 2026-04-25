import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HcmClient } from './hcm-client';
import { HcmClientConfig } from './hcm.types';

@Module({
  providers: [
    {
      provide: HcmClient,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const cfg: HcmClientConfig = {
          baseUrl:
            config.get<string>('hcm.baseUrl') ?? 'http://localhost:4000',
          apiKey: config.get<string>('hcm.apiKey'),
          timeoutMs: config.get<number>('hcm.timeoutMs') ?? 5000,
          maxRetries: config.get<number>('hcm.maxRetries') ?? 3,
          backoffStrategy: (attempt: number) =>
            1000 * Math.pow(2, attempt),
          verifyAfterWrite:
            config.get<boolean>('hcm.verifyAfterWrite') ?? true,
        };
        return new HcmClient(cfg);
      },
    },
  ],
  exports: [HcmClient],
})
export class HcmModule {}
