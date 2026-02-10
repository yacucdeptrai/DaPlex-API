import { HttpModule } from '@nestjs/axios';
import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';

import { FilerService } from './filer.service';
import { SettingsModule } from '../../../resources/settings/settings.module';
import { ExternalStoragesModule } from '../../../resources/external-storages/external-storages.module';

@Module({
  imports: [
    HttpModule,
    ConfigModule,
    JwtModule.register({}),
    forwardRef(() => SettingsModule),
    forwardRef(() => ExternalStoragesModule)
  ],
  providers: [FilerService],
  exports: [FilerService]
})
export class FilerModule { }
