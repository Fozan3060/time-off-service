import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsInt,
  IsString,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class BatchEntryDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  employeeId!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  locationId!: string;

  @ApiProperty({ type: 'integer' })
  @IsInt()
  balance!: number;
}

export class BatchSyncDto {
  @ApiProperty({ description: 'Unique identifier for this batch.' })
  @IsString()
  @MinLength(1)
  batchId!: string;

  @ApiProperty({
    format: 'date-time',
    description: 'When HCM generated this corpus.',
  })
  @IsDateString()
  generatedAt!: string;

  @ApiProperty({ type: [BatchEntryDto] })
  @IsArray()
  @ArrayMinSize(0)
  @ValidateNested({ each: true })
  @Type(() => BatchEntryDto)
  balances!: BatchEntryDto[];
}
