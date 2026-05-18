import { Type } from 'class-transformer';
import { IsNumber, IsString, Min } from 'class-validator';

export class SyncBalanceDto {
  @IsString()
  employeeId!: string;

  @IsString()
  locationId!: string;
}

export class BatchBalanceItemDto {
  @IsString()
  employeeId!: string;

  @IsString()
  locationId!: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  availableDays!: number;
}

