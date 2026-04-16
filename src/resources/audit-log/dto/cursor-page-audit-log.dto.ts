import { ApiProperty, OmitType } from '@nestjs/swagger';
import { Type, Transform } from 'class-transformer';
import { IsDate, IsInt, IsOptional } from 'class-validator';

import { CursorPaginateDto } from '../../../common/dto';
import { StatusCode } from '../../../enums';
import { transformBigInt } from '../../../utils';

export class CursorPageAuditLogDto extends OmitType(CursorPaginateDto, ['search'] as const) {
  @ApiProperty({
    type: Number,
    description: 'Filter by audit log type',
    required: false
  })
  @Type(() => Number)
  @IsOptional()
  @IsInt({ context: { code: StatusCode.IS_INT } })
  type: number;

  @ApiProperty({
    type: String,
    description: 'Filter by target reference',
    required: false
  })
  @Type(() => String)
  @IsOptional()
  targetRef: string;

  @ApiProperty({
    type: String,
    description: 'Filter by target id',
    required: false
  })
  @Transform(({ value }) => transformBigInt(value), { toClassOnly: true })
  @IsOptional()
  target: bigint;

  @ApiProperty({
    type: String,
    description: 'Filter by user id',
    required: false
  })
  @Transform(({ value }) => transformBigInt(value), { toClassOnly: true })
  @IsOptional()
  user: bigint;

  @ApiProperty({
    type: Date,
    description: 'Filter by start date',
    required: false
  })
  @Type(() => Date)
  @IsOptional()
  @IsDate({ context: { code: StatusCode.IS_DATE } })
  startDate: Date;

  @ApiProperty({
    type: Date,
    description: 'Filter by end date',
    required: false
  })
  @Type(() => Date)
  @IsOptional()
  @IsDate({ context: { code: StatusCode.IS_DATE } })
  endDate: Date;
}
