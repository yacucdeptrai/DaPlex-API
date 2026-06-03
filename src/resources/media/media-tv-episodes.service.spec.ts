import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';

import { MediaTVEpisodesService } from './media-tv-episodes.service';
import { StatusCode } from '../../enums';

/**
 * Characterization tests for the dependency-light branching pieces of the
 * TV-episode read/add group: addTVEpisode's duplicate episode-number guard
 * (which throws before opening a transaction) and findOneTVEpisode's not-found
 * guard. The remaining bodies are I/O-heavy and were moved verbatim from
 * MediaService; DI of the full service is covered by the smoke test plus the
 * controller and module specs that compile against the real wiring.
 *
 * This file first pins the behaviour against MediaService (capture), then the
 * same assertions are repointed to MediaTVEpisodesService after the move.
 */
describe('MediaTVEpisodesService (characterization)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let target: any;
  let tvEpisodeModel: { findOne: jest.Mock };
  let mongooseConnection: { startSession: jest.Mock };

  beforeEach(async () => {
    tvEpisodeModel = { findOne: jest.fn() };
    mongooseConnection = { startSession: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({ providers: [MediaTVEpisodesService] })
      .useMocker(() => ({}))
      .compile();
    target = module.get<MediaTVEpisodesService>(MediaTVEpisodesService);
    target.tvEpisodeModel = tvEpisodeModel;
    target.mongooseConnection = mongooseConnection;
  });

  it('is defined', () => expect(target).toBeDefined());

  describe('addTVEpisode (duplicate episode-number guard)', () => {
    it('throws EPISODE_NUMBER_EXIST before opening a transaction', async () => {
      expect.assertions(3);
      tvEpisodeModel.findOne.mockReturnValue({ lean: () => ({ exec: () => Promise.resolve({ _id: BigInt(99) }) }) });
      try {
        await target.addTVEpisode(BigInt(1), { epNumber: 1 }, {}, { _id: BigInt(2) });
      } catch (e) {
        expect(e).toBeInstanceOf(HttpException);
        expect((e as HttpException).getResponse()).toEqual(
          expect.objectContaining({ code: StatusCode.EPISODE_NUMBER_EXIST })
        );
      }
      // Guard must fail fast, before starting the write transaction.
      expect(mongooseConnection.startSession).not.toHaveBeenCalled();
    });
  });

  describe('findOneTVEpisode (not-found guard)', () => {
    it('throws MEDIA_NOT_FOUND when the episode does not exist', async () => {
      expect.assertions(2);
      tvEpisodeModel.findOne.mockReturnValue({ lean: () => ({ exec: () => Promise.resolve(null) }) });
      try {
        await target.findOneTVEpisode(BigInt(1), BigInt(2), {}, { hasPermission: false });
      } catch (e) {
        expect(e).toBeInstanceOf(HttpException);
        expect((e as HttpException).getResponse()).toEqual(
          expect.objectContaining({ code: StatusCode.MEDIA_NOT_FOUND })
        );
      }
    });
  });
});
