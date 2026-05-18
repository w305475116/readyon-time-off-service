import { IsNumber, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateTimeOffRequestDto {
  @IsString()
  employeeId!: string;

  @IsString()
  locationId!: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0.5)
  requestedDays!: number;
}

