import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';

import { MediaVideoController } from './media-video.controller';
import { MediaResultConsumer } from './media-result.consumer';
import { MediaStreamResultsService } from './media-stream-results.service';
import { RedisCacheService } from '../../common/modules/redis-cache/redis-cache.service';

/**
 * W1.2 TDD spec — snapshot store round-trip: the consumer WRITES a snapshot and the
 * GET handler READS it back through the SAME key. This is the load-bearing contract:
 * if the writer and the reader build their Redis key differently (the brief warns to
 * use one shared builder), the writer-side consumer spec and the reader-side handler
 * spec could each pass in isolation while the live endpoint always returns idle.
 *
 * Here both sides share ONE fake in-memory cache, so the round-trip only succeeds when
 * the two key builders agree. Expected RED until the surgeon implements both sides.
 */
describe('Media transcode-progress snapshot store round-trip (W1.2, TDD)', () => {
  let controller: MediaVideoController;
  let consumer: MediaResultConsumer;

  // One shared store backs both the writer and the reader.
  const store = new Map<string, unknown>();
  const fakeRedis: Pick<RedisCacheService, 'set' | 'get' | 'del'> = {
    set: jest.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }) as never,
    get: jest.fn(async (key: string) => store.get(key)) as never,
    del: jest.fn(async (key: string) => {
      store.delete(key);
    }) as never
  };

  beforeEach(async () => {
    store.clear();
    jest.clearAllMocks();

    // Stub the terminal handler the `finished-encoding` branch calls so this spec
    // exercises the snapshot del/idle round-trip, not the unrelated stream-results path.
    const streamResultsStub = {
      handleMovieStreamQueueDone: jest.fn().mockResolvedValue(undefined),
      handleTVEpisodeStreamQueueDone: jest.fn().mockResolvedValue(undefined)
    };
    const consumerModule: TestingModule = await Test.createTestingModule({
      providers: [
        MediaResultConsumer,
        { provide: MediaStreamResultsService, useValue: streamResultsStub },
        { provide: RedisCacheService, useValue: fakeRedis }
      ]
    }).compile();
    consumer = consumerModule.get(MediaResultConsumer);
    jest
      .spyOn((consumer as unknown as { logger: { log: jest.Mock; error: jest.Mock } }).logger, 'log')
      .mockImplementation();
    jest
      .spyOn((consumer as unknown as { logger: { log: jest.Mock; error: jest.Mock } }).logger, 'error')
      .mockImplementation();

    const controllerModule: TestingModule = await Test.createTestingModule({
      controllers: [MediaVideoController],
      providers: [{ provide: RedisCacheService, useValue: fakeRedis }]
    })
      .useMocker(() => ({}))
      .compile();
    controller = controllerModule.get(MediaVideoController);
  });

  const authUser = { _id: BigInt(1) } as never;
  // Cast to `never` so the test compiles regardless of the exact JobNameType union.
  const makeJob = (name: string, data: Record<string, unknown>): never =>
    ({ id: 'job-1', name, data }) as unknown as never;
  // Handler does not exist yet; cast through `any` to call the future signature.
  const call = (id: bigint, episode?: bigint): Promise<Record<string, unknown> | undefined> =>
    (
      controller as unknown as {
        getTranscodeProgress: (u: never, id: bigint, ep?: bigint) => Promise<Record<string, unknown> | undefined>;
      }
    ).getTranscodeProgress(authUser, id, episode);

  it('movie: a progress write is readable through GET on the same media id', async () => {
    await consumer.process(makeJob('progress', { media: 101, status: 'PROCESSING', percent: 55 }));
    const result = await call(BigInt(101));
    expect(result).toMatchObject({ mediaId: '101', status: 'PROCESSING', percent: 55 });
  });

  it('episode: a progress write is readable through GET on the same media+episode id', async () => {
    await consumer.process(makeJob('progress', { media: 101, episode: 7, status: 'PROCESSING', percent: 12 }));
    const result = await call(BigInt(101), BigInt(7));
    expect(result).toMatchObject({ mediaId: '101', episodeId: '7', percent: 12 });
  });

  it('a terminal event clears the snapshot so GET goes idle', async () => {
    await consumer.process(makeJob('progress', { media: 101, status: 'PROCESSING', percent: 55 }));
    await consumer.process(makeJob('finished-encoding', { media: 101 }));
    const result = await call(BigInt(101));
    expect(result == null || Object.keys(result).length === 0).toBe(true);
  });

  it('an expired snapshot (manually evicted, as a TTL would) reads back idle', async () => {
    await consumer.process(makeJob('progress', { media: 101, status: 'PROCESSING', percent: 55 }));
    // Simulate the ~60s TTL elapsing: the key is gone from the store.
    store.clear();
    const result = await call(BigInt(101));
    expect(result == null || Object.keys(result).length === 0).toBe(true);
  });
});
