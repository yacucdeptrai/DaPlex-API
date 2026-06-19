import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';

import { TmdbScannerService } from './tmdb-scanner.service';
import { buildScannerHttpModuleOptions } from '../scanner-http-module.factory';

@Module({
  imports: [
    HttpModule.registerAsync({
      useFactory: buildScannerHttpModuleOptions,
      inject: [ConfigService]
    })
  ],
  providers: [TmdbScannerService],
  exports: [TmdbScannerService]
})
export class TmdbScannerModule {}
