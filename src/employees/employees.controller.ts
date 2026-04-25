import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentActor } from '../auth/current-actor.decorator';
import { type Actor, Role } from '../auth/role.enum';
import { BalanceService } from '../balances/balance.service';
import { RequestStatus } from '../requests/request-status.enum';
import { RequestsService } from '../requests/requests.service';

@ApiTags('employees')
@Controller('employees')
@UseGuards(AuthGuard)
export class EmployeesController {
  constructor(
    private readonly balances: BalanceService,
    private readonly requests: RequestsService,
  ) {}

  @Get(':id/balances')
  @ApiOperation({ summary: 'Get available, settled, and pending balances.' })
  @ApiQuery({ name: 'locationId', required: true })
  async getBalance(
    @Param('id') id: string,
    @Query('locationId') locationId: string,
    @CurrentActor() actor: Actor,
  ) {
    if (!locationId) {
      throw new BadRequestException(
        'locationId query parameter is required.',
      );
    }
    if (actor.role === Role.EMPLOYEE && actor.id !== id) {
      throw new ForbiddenException(
        'Employees can only view their own balances.',
      );
    }
    return this.balances.snapshot(id, locationId);
  }

  @Get(':id/requests')
  @ApiOperation({ summary: 'List an employee’s time-off requests.' })
  @ApiQuery({ name: 'status', required: false })
  async listRequests(
    @Param('id') id: string,
    @Query('status') status: string | undefined,
    @CurrentActor() actor: Actor,
  ) {
    if (actor.role === Role.EMPLOYEE && actor.id !== id) {
      throw new ForbiddenException(
        'Employees can only view their own requests.',
      );
    }
    let parsedStatus: RequestStatus | undefined;
    if (status) {
      const upper = status.toUpperCase();
      if (!(Object.values(RequestStatus) as string[]).includes(upper)) {
        throw new BadRequestException(
          `Invalid status filter: ${status}.`,
        );
      }
      parsedStatus = upper as RequestStatus;
    }
    return this.requests.listForEmployee(id, parsedStatus);
  }
}
