import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsNotEmpty, IsOptional } from 'class-validator';

import { StatusCode } from '../../../enums';
import { transformBigInt } from '../../../utils';

export class MarkWatchedDto {
  @ApiProperty({
    type: String,
    description: 'Episode id (mark at media level when omitted)',
    required: false
  })
  @Transform(({ value }) => transformBigInt(value), { toClassOnly: true })
  @IsOptional()
  episode: bigint;

  @ApiProperty({
    type: Number,
    description: 'Mark the media/episode as watched (1) or unwatched (0)'
  })
  @IsNotEmpty({ context: { code: StatusCode.IS_NOT_EMPTY } })
  @Type(() => Number)
  @IsIn([0, 1])
  watched: number;
}
