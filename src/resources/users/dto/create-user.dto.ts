import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsOptional, Length, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

import { UsernameExist } from '../../../decorators/username-exist.decorator';
import { EmailExist } from '../../../decorators/email-exist.decorator';
import { IsShortDate } from '../../../decorators/is-short-date.decorator';
import { MaxShortDate } from '../../../decorators/max-short-date.decorator';
import { ShortDate } from '../../../common/entities';
import { StatusCode } from '../../../enums';

/**
 * Admin create is invite-only: identity fields and nothing else. No password field is
 * declared, so `whitelist: true` strips one if it is ever sent and an admin can never
 * choose another person's credential. roles/owner/banned/verified are absent for the
 * same reason — declaring any of them turns this into a privilege-escalation primitive.
 */
export class CreateUserDto {
  @ApiProperty({
    type: String,
    description: 'An unique username',
    minLength: 3,
    maxLength: 32
  })
  @Type(() => String)
  @Length(3, 32, { context: { code: StatusCode.LENGTH } })
  @UsernameExist({ context: { code: StatusCode.USERNAME_EXIST } })
  username: string;

  @ApiProperty({
    type: String,
    description: 'A display name',
    minLength: 3,
    maxLength: 32,
    required: false
  })
  @Type(() => String)
  @IsOptional()
  @Length(3, 32, { context: { code: StatusCode.LENGTH } })
  nickname: string;

  @ApiProperty({
    type: String,
    description: 'A valid email'
  })
  @Type(() => String)
  @IsEmail(undefined, { context: { code: StatusCode.IS_EMAIL } })
  @EmailExist({ context: { code: StatusCode.EMAIL_EXIST } })
  email: string;

  @ApiProperty({
    type: ShortDate,
    description: 'Account birthdate'
  })
  @Type(() => ShortDate)
  @ValidateNested()
  @IsShortDate({ context: { code: StatusCode.IS_SHORT_DATE } })
  @MaxShortDate(new Date(), { context: { code: StatusCode.MAX_SHORT_DATE } })
  birthdate: ShortDate;
}
