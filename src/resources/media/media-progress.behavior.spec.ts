import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';

import { MediaVideoController } from './media-video.controller';
import { RedisCacheService } from '../../common/modules/redis-cache/redis-cache.service';

/**
 * W1.2 TDD spec — behavioral contract of `GET media/:id/progress`.
 *
 * FORWARD feature: expected RED until the surgeon adds `getTranscodeProgress`.
 * The handler reads the per-job snapshot the result-queue consumer wrote to Redis
 * (RedisCacheService.get) and returns it. The brief's resolved design (§4c, leader
 * decision in the task brief) is: return the snapshot while a job is in flight, and
 * a **200-empty** body when idle (no key) — NOT a 404 — so the FE chip can fall back
 * to the coarse status without tripping the global http-error toast interceptor.
 *
 * Snapshot wire shape (brief §7): { mediaId, episodeId?, status, percent, eta? }.
 * bigint ids serialize as strings on the wire, so the snapshot stores strings.
 */
describe('MediaVideoController.getTranscodeProgress (W1.2, TDD)', () => {
  let controller: MediaVideoController;
  let redisGet: jest.Mock;

  const SNAPSHOT = {
    mediaId: '101',
    episodeId: undefined as string | undefined,
    status: 'PROCESSING',
    percent: 42,
    eta: undefined as number | undefined
  };

  beforeEach(async () => {
    redisGet = jest.fn();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MediaVideoController],
      providers: [{ provide: RedisCacheService, useValue: { get: redisGet, set: jest.fn(), del: jest.fn() } }]
    })
      // Any other constructor dependency the controller declares is auto-mocked.
      .useMocker(() => ({}))
      .compile();

    controller = module.get<MediaVideoController>(MediaVideoController);
  });

  const authUser = { _id: BigInt(1) } as never;
  // Handler signature is untyped here (it does not exist yet); cast through `any`
  // so these calls compile against the future MediaVideoController.getTranscodeProgress.
  const call = (id: bigint, episode?: bigint): Promise<Record<string, unknown> | undefined> =>
    (
      controller as unknown as {
        getTranscodeProgress: (u: never, id: bigint, ep?: bigint) => Promise<Record<string, unknown> | undefined>;
      }
    ).getTranscodeProgress(authUser, id, episode);

  it('returns the Redis snapshot while a job is in flight (movie, no episode)', async () => {
    redisGet.mockResolvedValue({ ...SNAPSHOT });
    const result = await call(BigInt(101));
    expect(result).toMatchObject({ mediaId: '101', status: 'PROCESSING', percent: 42 });
  });

  it('reads the per-episode snapshot key when an episode id is supplied', async () => {
    const episodeSnap = { ...SNAPSHOT, episodeId: '7', percent: 10 };
    redisGet.mockResolvedValue(episodeSnap);
    const result = await call(BigInt(101), BigInt(7));
    expect(redisGet).toHaveBeenCalledTimes(1);
    // The episode id must take part in the lookup key so movie vs episode don't collide.
    expect(String(redisGet.mock.calls[0][0])).toContain('7');
    expect(result).toMatchObject({ episodeId: '7', status: 'PROCESSING', percent: 10 });
  });

  it('uses a mediaId-scoped lookup key for a movie', async () => {
    redisGet.mockResolvedValue({ ...SNAPSHOT });
    await call(BigInt(101));
    expect(String(redisGet.mock.calls[0][0])).toContain('101');
  });

  it('returns an empty/idle body (NOT a 404 throw) when no snapshot exists', async () => {
    redisGet.mockResolvedValue(undefined);
    // Must resolve, not reject — a 200-empty response, not a NotFoundException.
    const result = await call(BigInt(999));
    expect(result == null || Object.keys(result).length === 0).toBe(true);
  });
});
