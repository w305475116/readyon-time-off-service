import { IsString } from 'class-validator';

export class BalanceQueryDto {
  @IsString()
  employeeId!: string;

  @IsString()
  locationId!: string;
}

