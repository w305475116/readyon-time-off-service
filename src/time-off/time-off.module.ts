import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditEventEntity } from './entities/audit-event.entity';
import { BalanceProjectionEntity } from './entities/balance-projection.entity';
import { TimeOffRequestEntity } from './entities/time-off-request.entity';
import { HcmClient } from './hcm/hcm-client';
import { TimeOffController } from './time-off.controller';
import { TimeOffService } from './time-off.service';

@Module({
  imports: [TypeOrmModule.forFeature([TimeOffRequestEntity, BalanceProjectionEntity, AuditEventEntity])],
  controllers: [TimeOffController],
  providers: [TimeOffService, HcmClient]
})
export class TimeOffModule {}

