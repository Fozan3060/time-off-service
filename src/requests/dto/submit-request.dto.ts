import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsString, MinLength } from 'class-validator';

export class SubmitRequestDto {
  @ApiProperty({ description: 'Employee submitting the request.' })
  @IsString()
  @MinLength(1)
  employeeId!: string;

  @ApiProperty({ description: 'Location whose balance is being deducted.' })
  @IsString()
  @MinLength(1)
  locationId!: string;

  @ApiProperty({ format: 'date', example: '2099-05-04' })
  @IsDateString()
  startDate!: string;

  @ApiProperty({ format: 'date', example: '2099-05-08' })
  @IsDateString()
  endDate!: string;
}
