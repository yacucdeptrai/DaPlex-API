import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';

import { MediaSubtitlesService } from './media-subtitles.service';
import { StatusCode } from '../../enums';

/**
 * Characterization tests for the subtitle validation logic (Phase 7.1 step 1 —
 * MediaSubtitlesService extraction).
 *
 * validateSubtitle is the only branching, dependency-free piece of the subtitle
 * group; the rest are I/O-heavy methods moved verbatim. These pin its exact
 * current behavior against MediaService (capture), then `target` is repointed to
 * MediaSubtitlesService after the move with identical assertions, proving the
 * extracted validator behaves identically. DI of the new service is covered by
 * the smoke test + the full suite (controller/module compile).
 */
describe('MediaSubtitlesService (characterization)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let target: any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({ providers: [MediaSubtitlesService] })
      .useMocker(() => ({}))
      .compile();
    target = module.get<MediaSubtitlesService>(MediaSubtitlesService);
  });

  it('is defined', () => expect(target).toBeDefined());

  describe('validateSubtitle', () => {
    const fakeFile = (overrides: Record<string, unknown> = {}) =>
      ({ fields: { language: { value: 'en' } }, filename: 'subtitle.vtt', ...overrides }) as any;

    const expectCode = async (file: any, code: StatusCode) => {
      expect.assertions(2);
      try {
        await target.validateSubtitle(file);
      } catch (e) {
        expect(e).toBeInstanceOf(HttpException);
        expect((e as HttpException).getResponse()).toMatchObject({ code });
      }
    };

    it('throws IS_NOT_EMPTY when language field is missing', () =>
      expectCode(fakeFile({ fields: {} }), StatusCode.IS_NOT_EMPTY));

    it('throws IS_ISO6391 for a non-ISO-639-1 language', () =>
      expectCode(fakeFile({ fields: { language: { value: 'zzz' } } }), StatusCode.IS_ISO6391));

    it('throws INVALID_SUBTITLE for a disallowed extension', () =>
      expectCode(fakeFile({ filename: 'subtitle.txt' }), StatusCode.INVALID_SUBTITLE));

    it('returns the language for a valid .vtt subtitle', async () => {
      await expect(target.validateSubtitle(fakeFile())).resolves.toBe('en');
    });

    it('accepts compressed subtitle extensions (.srt.gz)', async () => {
      await expect(target.validateSubtitle(fakeFile({ filename: 'subtitle.srt.gz' }))).resolves.toBe('en');
    });
  });
});
