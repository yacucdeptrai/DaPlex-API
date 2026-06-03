import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { HttpException } from '@nestjs/common';

import { MediaVideosService } from './media-videos.service';
import { Media } from '../../schemas';
import { MongooseConnection, StatusCode } from '../../enums';

/**
 * Characterization tests for the dependency-light branch of the video group:
 * addMediaVideo's YouTube-url validation, which runs before any DB access. The
 * remaining add/list/update/delete bodies are I/O-heavy and were moved verbatim
 * from MediaService; DI of the full service is covered by the smoke test plus
 * the controller and module specs that compile against the real wiring.
 */
describe('MediaVideosService (characterization)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let target: any;
  let mediaModel: { findOne: jest.Mock };

  beforeEach(async () => {
    mediaModel = { findOne: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MediaVideosService,
        { provide: getModelToken(Media.name, MongooseConnection.DATABASE_A), useValue: mediaModel }
      ]
    })
      .useMocker(() => ({}))
      .compile();
    target = module.get<MediaVideosService>(MediaVideosService);
  });

  it('is defined', () => expect(target).toBeDefined());

  describe('addMediaVideo (YouTube url validation)', () => {
    const expectInvalid = async (url: string) => {
      expect.assertions(3);
      try {
        await target.addMediaVideo(BigInt(1), { url }, {}, { _id: BigInt(2) });
      } catch (e) {
        expect(e).toBeInstanceOf(HttpException);
        expect((e as HttpException).getResponse()).toEqual(
          expect.objectContaining({ code: StatusCode.INVALID_YOUTUBE_URL })
        );
      }
      // Validation must fail fast, before touching the media collection.
      expect(mediaModel.findOne).not.toHaveBeenCalled();
    };

    it('rejects a non-YouTube url before any DB access', () => expectInvalid('https://example.com/foo'));

    it('rejects a YouTube url whose id is not 11 chars', () => expectInvalid('https://youtu.be/abc'));
  });
});
