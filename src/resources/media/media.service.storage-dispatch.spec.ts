import { Test, TestingModule } from '@nestjs/testing';
import { MediaService } from './media.service';
import { CloudStorage } from '../../enums';

/**
 * Characterization tests for resolveStorageService (Phase 6.2).
 *
 * Every source/stream storage operation duplicated the same dispatch:
 *   if (kind === CloudStorage.FILER)      -> this.filerService.<op>(...)
 *   else if (kind === CloudStorage.S3)    -> this.s3Service.<op>(...)
 *   else                                  -> this.onedriveService.<op>(...)
 *
 * These tests pin the kind -> service mapping (including the catch-all `else`
 * branch that routes every non-FILER, non-S3 kind to onedrive) before the
 * 13 dispatch sites are collapsed onto this single resolver. The resolved
 * service's own method is invoked at each call site, so per-service retry
 * defaults are unchanged by the extraction.
 */
describe('MediaService.resolveStorageService (characterization)', () => {
  let service: MediaService;
  const filerService = { tag: 'filer' };
  const s3Service = { tag: 's3' };
  const onedriveService = { tag: 'onedrive' };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [MediaService]
    })
      .useMocker(() => ({}))
      .compile();

    service = module.get<MediaService>(MediaService);
    (service as any).filerService = filerService;
    (service as any).s3Service = s3Service;
    (service as any).onedriveService = onedriveService;
  });

  const resolve = (kind: number) => (service as any).resolveStorageService(kind);

  it('routes FILER to the filer service', () => {
    expect(resolve(CloudStorage.FILER)).toBe(filerService);
  });

  it('routes S3 to the s3 service', () => {
    expect(resolve(CloudStorage.S3)).toBe(s3Service);
  });

  it('routes ONEDRIVE to the onedrive service', () => {
    expect(resolve(CloudStorage.ONEDRIVE)).toBe(onedriveService);
  });

  it('routes any other kind to onedrive (preserves the original else branch)', () => {
    // The original dispatch had no explicit ONEDRIVE check — anything that is
    // neither FILER nor S3 fell through to onedrive. Pin that catch-all here.
    expect(resolve(CloudStorage.DROPBOX)).toBe(onedriveService);
    expect(resolve(CloudStorage.GOOGLE_DRIVE)).toBe(onedriveService);
    expect(resolve(-1 as unknown as number)).toBe(onedriveService);
  });
});
