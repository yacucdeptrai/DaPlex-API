import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';

import { MediaChaptersService } from './media-chapters.service';
import { ChapterTypeService } from '../chapter-type/chapter-type.service';
import { StatusCode } from '../../enums';

/**
 * Characterization tests for the dependency-light branching pieces of the
 * chapter group: addMediaChapter's duplicate start+length guard (which throws
 * before any chapter-type lookup) and validateChapterType (the one method that
 * touches chapterTypeService). The add/find/update/delete movie and TV-episode
 * chapter routes are I/O-heavy and were moved verbatim from MediaService; DI of
 * the full service is covered by the smoke test plus the controller and module
 * specs that compile against the real wiring.
 */
describe('MediaChaptersService (characterization)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let target: any;
  let chapterTypeService: { findById: jest.Mock };

  beforeEach(async () => {
    chapterTypeService = { findById: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({ providers: [MediaChaptersService] })
      .useMocker((token) => {
        if (token === ChapterTypeService) return chapterTypeService;
        return {};
      })
      .compile();
    target = module.get<MediaChaptersService>(MediaChaptersService);
  });

  it('is defined', () => expect(target).toBeDefined());

  describe('addMediaChapter (duplicate start+length guard)', () => {
    it('throws CHAPTER_TIME_DUPLICATED before any chapter-type lookup', async () => {
      expect.assertions(3);
      const chapters = [{ start: 10, length: 5 }];
      try {
        await target.addMediaChapter(chapters, { start: 10, length: 5, type: BigInt(7) });
      } catch (e) {
        expect(e).toBeInstanceOf(HttpException);
        expect((e as HttpException).getResponse()).toEqual(
          expect.objectContaining({ code: StatusCode.CHAPTER_TIME_DUPLICATED })
        );
      }
      // Guard must fail fast, before validating the chapter type.
      expect(chapterTypeService.findById).not.toHaveBeenCalled();
    });
  });

  describe('validateChapterType', () => {
    it('throws CHAPTER_TYPE_NOT_FOUND when the type does not exist', async () => {
      expect.assertions(2);
      chapterTypeService.findById.mockResolvedValue(null);
      try {
        await target.validateChapterType(BigInt(7));
      } catch (e) {
        expect(e).toBeInstanceOf(HttpException);
        expect((e as HttpException).getResponse()).toEqual(
          expect.objectContaining({ code: StatusCode.CHAPTER_TYPE_NOT_FOUND })
        );
      }
    });

    it('returns the chapter type when it exists', async () => {
      const chapterType = { _id: BigInt(7), name: 'Intro' };
      chapterTypeService.findById.mockResolvedValue(chapterType);
      await expect(target.validateChapterType(BigInt(7))).resolves.toBe(chapterType);
    });
  });
});
