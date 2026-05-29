import { ApiProperty } from '@nestjs/swagger';
import { Exclude, Expose } from 'class-transformer';

import { BaseUser } from './base-user.entity';
import { UserFile } from './user-file.entity';
// Import Role from its source file rather than the roles barrel: the barrel also
// re-exports RoleUsers (which extends User), so importing it here created a
// users<->roles circular dependency that left User undefined at class-extension time.
import { Role } from '../../roles/entities/role.entity';
import { createCloudflareR2Url, createCloudflareR2ProxyUrl } from '../../../utils';
import { CloudflareR2Container } from '../../../enums';

export class User extends BaseUser {
  @ApiProperty()
  roles: Role[];

  @Exclude({ toPlainOnly: true })
  password: string;

  @Exclude({ toPlainOnly: true })
  activationCode: string;

  @Exclude({ toPlainOnly: true })
  recoveryCode: string;

  @Exclude({ toPlainOnly: true })
  avatar: UserFile;

  @ApiProperty()
  @Expose({ toPlainOnly: true })
  get avatarUrl(): string {
    if (this.avatar)
      return createCloudflareR2ProxyUrl(
        CloudflareR2Container.AVATARS,
        `${this.avatar._id}/${this.avatar.name}`,
        450,
        this.avatar.mimeType
      );
  }

  @ApiProperty()
  @Expose({ toPlainOnly: true })
  get thumbnailAvatarUrl(): string {
    if (this.avatar)
      return createCloudflareR2ProxyUrl(
        CloudflareR2Container.AVATARS,
        `${this.avatar._id}/${this.avatar.name}`,
        250,
        this.avatar.mimeType
      );
  }

  @ApiProperty()
  @Expose({ toPlainOnly: true })
  get smallAvatarUrl(): string {
    if (this.avatar)
      return createCloudflareR2ProxyUrl(
        CloudflareR2Container.AVATARS,
        `${this.avatar._id}/${this.avatar.name}`,
        120,
        this.avatar.mimeType
      );
  }

  @ApiProperty()
  @Expose({ toPlainOnly: true })
  get fullAvatarUrl(): string {
    if (this.avatar)
      return createCloudflareR2Url(CloudflareR2Container.AVATARS, `${this.avatar._id}/${this.avatar.name}`);
  }

  @ApiProperty()
  @Expose({ toPlainOnly: true })
  get avatarColor(): number {
    if (this.avatar) return this.avatar.color;
  }

  @ApiProperty()
  @Expose({ toPlainOnly: true })
  get avatarPlaceholder(): string {
    if (this.avatar) return this.avatar.placeholder;
  }
}
