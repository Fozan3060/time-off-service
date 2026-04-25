import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentActor } from '../auth/current-actor.decorator';
import { type Actor, Role } from '../auth/role.enum';
import { Roles } from '../auth/roles.decorator';
import { LedgerService } from '../ledger/ledger.service';
import { RequestLifecycleService } from '../lifecycle/request-lifecycle.service';
import { RejectRequestDto } from './dto/reject-request.dto';
import { SubmitRequestDto } from './dto/submit-request.dto';
import { RequestsService } from './requests.service';

@ApiTags('requests')
@Controller('requests')
@UseGuards(AuthGuard)
export class RequestsController {
  constructor(
    private readonly lifecycle: RequestLifecycleService,
    private readonly requests: RequestsService,
    private readonly ledger: LedgerService,
  ) {}

  @Post()
  @Roles(Role.EMPLOYEE)
  @ApiOperation({ summary: 'Submit a new time-off request.' })
  async submit(
    @Body() dto: SubmitRequestDto,
    @CurrentActor() actor: Actor,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    if (actor.id !== dto.employeeId) {
      throw new ForbiddenException(
        'Employees can only submit requests for themselves.',
      );
    }
    return this.lifecycle.submit({
      employeeId: dto.employeeId,
      locationId: dto.locationId,
      startDate: dto.startDate,
      endDate: dto.endDate,
      clientIdempotencyKey: idempotencyKey ?? null,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a request by id.' })
  async getById(@Param('id') id: string, @CurrentActor() actor: Actor) {
    const req = await this.requests.findById(id);
    if (!req) throw new NotFoundException('Request not found');
    if (actor.role === Role.EMPLOYEE && req.employeeId !== actor.id) {
      throw new ForbiddenException(
        'You can only view your own requests.',
      );
    }
    return req;
  }

  @Get(':id/ledger')
  @Roles(Role.MANAGER, Role.ADMIN)
  @ApiOperation({ summary: 'Get all ledger entries linked to a request.' })
  async ledgerForRequest(@Param('id') id: string) {
    return this.ledger.findByRequest(id);
  }

  @Post(':id/approve')
  @Roles(Role.MANAGER, Role.ADMIN)
  @ApiOperation({ summary: 'Approve a pending request.' })
  async approve(@Param('id') id: string, @CurrentActor() actor: Actor) {
    if (!actor.id) {
      throw new BadRequestException('X-Actor-Id header is required for approve.');
    }
    return this.lifecycle.approve(id, actor.id);
  }

  @Post(':id/reject')
  @Roles(Role.MANAGER, Role.ADMIN)
  @ApiOperation({ summary: 'Reject a pending request.' })
  async reject(
    @Param('id') id: string,
    @Body() dto: RejectRequestDto,
    @CurrentActor() actor: Actor,
  ) {
    if (!actor.id) {
      throw new BadRequestException('X-Actor-Id header is required for reject.');
    }
    return this.lifecycle.reject(id, actor.id, dto.reason ?? null);
  }

  @Post(':id/cancel')
  @Roles(Role.EMPLOYEE)
  @ApiOperation({ summary: 'Cancel a request as the requesting employee.' })
  async cancel(@Param('id') id: string, @CurrentActor() actor: Actor) {
    if (!actor.id) {
      throw new BadRequestException('X-Actor-Id header is required for cancel.');
    }
    return this.lifecycle.cancel(id, actor.id);
  }
}
