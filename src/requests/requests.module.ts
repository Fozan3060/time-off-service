import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RequestsService } from './requests.service';
import { TimeOffRequest } from './time-off-request.entity';

@Module({
  imports: [TypeOrmModule.forFeature([TimeOffRequest])],
  providers: [RequestsService],
  exports: [RequestsService],
})
export class RequestsModule {}
