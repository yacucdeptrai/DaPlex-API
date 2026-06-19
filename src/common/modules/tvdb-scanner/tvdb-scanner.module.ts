import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';

import { TvdbScannerService } from './tvdb-scanner.service';
import { TmdbScannerModule } from '../tmdb-scanner/tmdb-scanner.module';
import { buildScannerHttpModuleOptions } from '../scanner-http-module.factory';

@Module({
  imports: [
    HttpModule.registerAsync({
      useFactory: buildScannerHttpModuleOptions,
      inject: [ConfigService]
    }),
    TmdbScannerModule
  ],
  providers: [TvdbScannerService],
  exports: [TvdbScannerService]
})
export class TvdbScannerModule {}
