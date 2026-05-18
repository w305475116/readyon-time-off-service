import { Body, Controller, Get, Headers, Param, Post, Query } from '@nestjs/common';
import { BalanceQueryDto } from './dto/balance-query.dto';
import { BatchBalanceSyncDto } from './dto/batch-balance-sync.dto';
import { CreateTimeOffRequestDto } from './dto/create-time-off-request.dto';
import { RejectTimeOffRequestDto } from './dto/reject-time-off-request.dto';
import { SyncBalanceDto } from './dto/sync-balance.dto';
import { TimeOffService } from './time-off.service';

@Controller()
export class TimeOffController {
  constructor(private readonly timeOffService: TimeOffService) {}

  @Get('balances')
  getBalance(@Query() query: BalanceQueryDto) {
    return this.timeOffService.getBalance(query.employeeId, query.locationId);
  }

  @Post('balances/sync')
  syncBalance(@Body() body: SyncBalanceDto) {
    return this.timeOffService.syncBalance(body);
  }

  @Post('hcm-sync/balances')
  batchSync(@Body() body: BatchBalanceSyncDto) {
    return this.timeOffService.batchSync(body);
  }

  @Post('time-off-requests')
  createRequest(
    @Body() body: CreateTimeOffRequestDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined
  ) {
    return this.timeOffService.createRequest(body, idempotencyKey);
  }

  @Get('time-off-requests/:requestId')
  getRequest(@Param('requestId') requestId: string) {
    return this.timeOffService.getRequest(requestId);
  }

  @Post('time-off-requests/:requestId/approve')
  approveRequest(@Param('requestId') requestId: string) {
    return this.timeOffService.approveRequest(requestId);
  }

  @Post('time-off-requests/:requestId/reject')
  rejectRequest(@Param('requestId') requestId: string, @Body() body: RejectTimeOffRequestDto) {
    return this.timeOffService.rejectRequest(requestId, body.reason);
  }

  @Post('time-off-requests/:requestId/reconcile')
  reconcileRequest(@Param('requestId') requestId: string) {
    return this.timeOffService.reconcileRequest(requestId);
  }
}
