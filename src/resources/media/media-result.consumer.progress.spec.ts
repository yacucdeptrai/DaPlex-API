import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';

import { MediaResultConsumer } from './media-result.consumer';
import { MediaStreamResultsService } from './media-stream-results.service';
import { RedisCacheService } from '../../common/modules/redis-cache/redis-cache.service';

/**
 * W1.2 TDD spec — the result-queue consumer's new `'progress'` branch + the
 * Redis snapshot store it writes.
 *
 * FORWARD feature: expected RED until the surgeon (a) adds `'progress'` to the
 * consumer's JobNameType union, (b) adds a `case 'progress'` that writes the
 * snapshot to Redis (reading job.data DIRECTLY — the progress body must NOT be
 * coerced through `plainToInstance(MediaQueueResultDto, ...)`, which already owns
 * a semantically-different `progress` field = AddMediaStreamDto stream metadata),
 * and (c) `del`s the snapshot on the terminal branches so the polled GET goes
 * idle the instant a job completes/cancels/fails, and (d) injects RedisCacheService.
 *
 * Key convention (brief §4b / §7, shared with the GET handler): `progress:<mediaId>`
 * for a movie, `progress:<mediaId>:<episodeId>` for an episode. TTL is short (~60s)
 * so a crashed job auto-expires to idle.
 */
describe('MediaResultConsumer progress relay (W1.2, TDD)', () => {
  let consumer: MediaResultConsumer;
  let redis: { set: jest.Mock; get: jest.Mock; del: jest.Mock };
  let streamResults: Record<string, jest.Mock>;

  beforeEach(async () => {
    redis = {
      set: jest.fn().mockResolvedValue(undefined),
      get: jest.fn(),
      del: jest.fn().mockResolvedValue(undefined)
    };
    streamResults = {
      updateMediaSourceData: jest.fn().mockResolvedValue(undefined),
      addMovieStream: jest.fn().mockResolvedValue(undefined),
      addTVEpisodeStream: jest.fn().mockResolvedValue(undefined),
      addMovieAudioStream: jest.fn().mockResolvedValue(undefined),
      addTVEpisodeAudioStream: jest.fn().mockResolvedValue(undefined),
      addMovieStreamManifest: jest.fn().mockResolvedValue(undefined),
      addTVEpisodeStreamManifest: jest.fn().mockResolvedValue(undefined),
      handleMovieStreamQueueDone: jest.fn().mockResolvedValue(undefined),
      handleTVEpisodeStreamQueueDone: jest.fn().mockResolvedValue(undefined),
      handleMovieStreamQueueCancel: jest.fn().mockResolvedValue(undefined),
      handleTVEpisodeStreamQueueCancel: jest.fn().mockResolvedValue(undefined),
      handleMovieStreamQueueRetry: jest.fn().mockResolvedValue(undefined),
      handleTVEpisodeStreamQueueRetry: jest.fn().mockResolvedValue(undefined),
      handleMovieStreamQueueError: jest.fn().mockResolvedValue(undefined),
      handleTVEpisodeStreamQueueError: jest.fn().mockResolvedValue(undefined)
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MediaResultConsumer,
        { provide: MediaStreamResultsService, useValue: streamResults },
        { provide: RedisCacheService, useValue: redis }
      ]
    }).compile();

    consumer = module.get<MediaResultConsumer>(MediaResultConsumer);
    jest
      .spyOn((consumer as unknown as { logger: { log: jest.Mock; error: jest.Mock } }).logger, 'log')
      .mockImplementation();
    jest
      .spyOn((consumer as unknown as { logger: { log: jest.Mock; error: jest.Mock } }).logger, 'error')
      .mockImplementation();
  });

  // Cast to `never` so the test compiles regardless of the exact JobNameType union
  // (the surgeon adds 'progress' to it; the consumer's process() param is strongly typed).
  const makeJob = (name: string, data: Record<string, unknown>): never =>
    ({ id: 'job-1', name, data }) as unknown as never;

  describe("case 'progress'", () => {
    it('writes a movie snapshot under progress:<mediaId> with the wire shape and a TTL', async () => {
      await consumer.process(makeJob('progress', { media: 101, status: 'PROCESSING', percent: 42 }));

      expect(redis.set).toHaveBeenCalledTimes(1);
      const [key, value, ttl] = redis.set.mock.calls[0];
      expect(key).toBe('progress:101');
      expect(value).toMatchObject({ mediaId: '101', status: 'PROCESSING', percent: 42 });
      // A bounded TTL must be set so a stalled/crashed job auto-expires to idle.
      expect(typeof ttl).toBe('number');
      expect(ttl).toBeGreaterThan(0);
    });

    it('writes an episode snapshot under progress:<mediaId>:<episodeId>', async () => {
      await consumer.process(makeJob('progress', { media: 101, episode: 7, status: 'PROCESSING', percent: 10 }));

      const [key, value] = redis.set.mock.calls[0];
      expect(key).toBe('progress:101:7');
      expect(value).toMatchObject({ mediaId: '101', episodeId: '7', status: 'PROCESSING', percent: 10 });
    });

    it('carries eta into the snapshot when the producer provided one (rclone upload phase)', async () => {
      await consumer.process(makeJob('progress', { media: 101, status: 'PROCESSING', percent: 88, eta: 30 }));
      const [, value] = redis.set.mock.calls[0];
      expect(value).toMatchObject({ percent: 88, eta: 30 });
    });

    it('does NOT route a progress message through any MediaStreamResultsService method', async () => {
      await consumer.process(makeJob('progress', { media: 101, status: 'PROCESSING', percent: 42 }));
      for (const fn of Object.values(streamResults)) {
        expect(fn).not.toHaveBeenCalled();
      }
    });

    it('never deletes the snapshot on a progress tick', async () => {
      await consumer.process(makeJob('progress', { media: 101, status: 'PROCESSING', percent: 42 }));
      expect(redis.del).not.toHaveBeenCalled();
    });
  });

  describe('terminal branches clear the snapshot (GET goes idle immediately)', () => {
    it('deletes progress:<mediaId> on finished-encoding for a movie', async () => {
      await consumer.process(makeJob('finished-encoding', { media: 101 }));
      expect(redis.del).toHaveBeenCalledWith('progress:101');
    });

    it('deletes progress:<mediaId>:<episodeId> on finished-encoding for an episode', async () => {
      await consumer.process(makeJob('finished-encoding', { media: 101, episode: 7 }));
      expect(redis.del).toHaveBeenCalledWith('progress:101:7');
    });

    it('deletes the snapshot on cancelled-encoding', async () => {
      await consumer.process(makeJob('cancelled-encoding', { media: 101 }));
      expect(redis.del).toHaveBeenCalledWith('progress:101');
    });

    it('deletes the snapshot on failed-encoding', async () => {
      await consumer.process(makeJob('failed-encoding', { media: 101 }));
      expect(redis.del).toHaveBeenCalledWith('progress:101');
    });
  });
});
