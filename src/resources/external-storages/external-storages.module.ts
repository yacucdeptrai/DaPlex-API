import { forwardRef, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { ExternalStoragesService } from './external-storages.service';
import { ExternalStoragesController } from './external-storages.controller';
import { AuthModule } from '../auth/auth.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { SettingsModule } from '../settings/settings.module';
import { ExternalStorage, ExternalStorageSchema } from '../../schemas';
import { OnedriveModule } from '../../common/modules/onedrive/onedrive.module';
import { ExtStorageNameExistConstraint } from '../../decorators/extstorage-name-exist.decorator';
import { MongooseConnection } from '../../enums';
import { FilerModule } from '../../common/modules/filer/filer.module';
import { S3Module } from '../../common/modules/s3/s3.module';

@Module({
  imports: [
    forwardRef(() => AuthModule),
    forwardRef(() => SettingsModule),
    forwardRef(() => OnedriveModule),
    forwardRef(() => FilerModule),
    forwardRef(() => S3Module),
    AuditLogModule,
    MongooseModule.forFeature([{ name: ExternalStorage.name, schema: ExternalStorageSchema }], MongooseConnection.DATABASE_A)
  ],
  controllers: [ExternalStoragesController],
  providers: [ExternalStoragesService, ExtStorageNameExistConstraint],
  exports: [ExternalStoragesService]
})
export class ExternalStoragesModule {}
