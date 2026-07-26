import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { AuthModule } from '../auth/auth.module';
import { HttpEmailModule } from '../../common/modules/http-email/http-email.module';
import { CloudflareR2Module } from '../../common/modules/cloudflare-r2';
import {
  DriveSession,
  DriveSessionSchema,
  History,
  HistorySchema,
  Notification,
  NotificationSchema,
  Playlist,
  PlaylistSchema,
  Rating,
  RatingSchema,
  Role,
  RoleSchema
} from '../../schemas';
import { MongooseConnection } from '../../enums';

@Module({
  imports: [
    AuthModule,
    AuditLogModule,
    CloudflareR2Module,
    HttpEmailModule,
    // The delete cascade reaches five other collections. They are registered as models
    // rather than pulled in as modules: DriveSession belongs to the heavy MediaModule and
    // Role to RolesModule, which already imports this one.
    MongooseModule.forFeature(
      [
        { name: History.name, schema: HistorySchema },
        { name: Rating.name, schema: RatingSchema },
        { name: Playlist.name, schema: PlaylistSchema },
        { name: DriveSession.name, schema: DriveSessionSchema },
        { name: Role.name, schema: RoleSchema }
      ],
      MongooseConnection.DATABASE_A
    ),
    MongooseModule.forFeature([{ name: Notification.name, schema: NotificationSchema }], MongooseConnection.DATABASE_B)
  ],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService]
})
export class UsersModule {}
