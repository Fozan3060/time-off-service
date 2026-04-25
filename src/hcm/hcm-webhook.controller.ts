import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { Role } from '../auth/role.enum';
import { Roles } from '../auth/roles.decorator';
import { ReconciliationService } from '../reconciliation/reconciliation.service';
import { BatchSyncDto } from './dto/batch-sync.dto';

@ApiTags('hcm')
@Controller('hcm')
@UseGuards(AuthGuard)
@Roles(Role.HCM)
export class HcmWebhookController {
  constructor(private readonly reconciliation: ReconciliationService) {}

  @Post('batch-sync')
  @ApiOperation({ summary: 'HCM pushes its full balance corpus for reconciliation.' })
  async batchSync(@Body() dto: BatchSyncDto) {
    return this.reconciliation.processBatch({
      batchId: dto.batchId,
      generatedAt: dto.generatedAt,
      balances: dto.balances,
    });
  }
}
