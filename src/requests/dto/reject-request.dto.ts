import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class RejectRequestDto {
  @ApiPropertyOptional({ description: 'Free-text reason given by the manager.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
