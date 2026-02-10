import { HttpModule } from '@nestjs/axios';
import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { S3Service } from './s3.service';
import { SettingsModule } from '../../../resources/settings/settings.module';
import { ExternalStoragesModule } from '../../../resources/external-storages/external-storages.module';

@Module({
  imports: [
    HttpModule,
    ConfigModule,
    forwardRef(() => SettingsModule),
    forwardRef(() => ExternalStoragesModule)
  ],
  providers: [S3Service],
  exports: [S3Service]
})
export class S3Module { }
