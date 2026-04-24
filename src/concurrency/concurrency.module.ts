import { Global, Module } from '@nestjs/common';
import { MutexRegistry } from './mutex-registry';

@Global()
@Module({
  providers: [MutexRegistry],
  exports: [MutexRegistry],
})
export class ConcurrencyModule {}
