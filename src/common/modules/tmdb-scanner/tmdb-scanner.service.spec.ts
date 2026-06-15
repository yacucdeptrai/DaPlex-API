import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { TmdbScannerService } from './tmdb-scanner.service';

describe('TmdbScannerService', () => {
  let service: TmdbScannerService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TmdbScannerService]
    })
      // TmdbScannerService reads config in its constructor, so the ConfigService
      // mock must expose a callable get(); other deps can stay empty.
      .useMocker((token): any => (token === ConfigService ? { get: (): undefined => undefined } : {}))
      .compile();

    service = module.get<TmdbScannerService>(TmdbScannerService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
