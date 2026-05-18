import { IsOptional, IsString, MaxLength } from 'class-validator';

export class RejectTimeOffRequestDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
