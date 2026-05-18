import { Type } from 'class-transformer';
import { ArrayNotEmpty, IsArray, ValidateNested } from 'class-validator';
import { BatchBalanceItemDto } from './sync-balance.dto';

export class BatchBalanceSyncDto {
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => BatchBalanceItemDto)
  balances!: BatchBalanceItemDto[];
}

