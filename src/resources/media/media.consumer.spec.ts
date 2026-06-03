import 'reflect-metadata';
import { MediaConsumerH264, MediaConsumerH265, MediaConsumerVP9, MediaConsumerAV1 } from './media.consumer';

/**
 * Characterization + safety tests for the shared BaseMediaConsumer.
 *
 * The four per-codec listeners now inherit their active/completed/failed handlers from a
 * shared abstract base. These tests pin (a) the unchanged handler behaviour and (b) the
 * decisive safety property: the @OnQueueEvent metadata still resolves on each subclass's
 * (inherited) handler methods, so @nestjs/bullmq's prototype-chain scan keeps registering
 * them. If the hoist had dropped the decoration, queue events would silently stop firing
 * while the build stayed green.
 */
const ON_QUEUE_EVENT_METADATA = 'bullmq:queue_events_metadata';
const QUEUE_EVENTS_LISTENER_METADATA = 'bullmq:queue_events_listener_metadata';

type Consumer = {
  onGlobalActive(arg: { jobId: string }): void;
  onGlobalCompleted(arg: { jobId: string }): Promise<void>;
  onGlobalFailed(arg: { jobId: string; failedReason: string }): Promise<void>;
};

describe('MediaConsumer (shared base)', () => {
  const makeQueue = () => ({
    remove: jest.fn().mockResolvedValue(undefined),
    getJob: jest.fn().mockResolvedValue(undefined)
  });
  const makeMediaService = () => ({
    handleTVEpisodeStreamQueueError: jest.fn().mockResolvedValue(undefined),
    handleMovieStreamQueueError: jest.fn().mockResolvedValue(undefined)
  });

  const cases: Array<[string, new (queue: any, mediaService: any) => Consumer, string]> = [
    ['H264', MediaConsumerH264, 'H264'],
    ['H265', MediaConsumerH265, 'H265'],
    ['VP9', MediaConsumerVP9, 'VP9'],
    ['AV1', MediaConsumerAV1, 'AV1']
  ];

  describe.each(cases)('%s', (_label, Ctor, codec) => {
    let queue: ReturnType<typeof makeQueue>;
    let mediaService: ReturnType<typeof makeMediaService>;
    let consumer: Consumer;

    beforeEach(() => {
      queue = makeQueue();
      mediaService = makeMediaService();
      consumer = new Ctor(queue, mediaService);
    });

    it('logs the codec label on active', () => {
      const spy = jest.spyOn((consumer as any).logger, 'log');
      consumer.onGlobalActive({ jobId: 'j1' });
      expect(spy).toHaveBeenCalledWith(`Processing job j1 of type ${codec}`);
    });

    it('removes the job on completed', async () => {
      await consumer.onGlobalCompleted({ jobId: 'j1' });
      expect(queue.remove).toHaveBeenCalledWith('j1');
    });

    it('on failed: removes the job and routes movie errors to handleMovieStreamQueueError', async () => {
      queue.getJob.mockResolvedValue({ id: 'j2', data: { media: 1 } });
      await consumer.onGlobalFailed({ jobId: 'j2', failedReason: 'boom' });
      expect(queue.remove).toHaveBeenCalledWith('j2');
      expect(mediaService.handleMovieStreamQueueError).toHaveBeenCalledTimes(1);
      expect(mediaService.handleTVEpisodeStreamQueueError).not.toHaveBeenCalled();
    });

    it('on failed: routes episode errors to handleTVEpisodeStreamQueueError', async () => {
      queue.getJob.mockResolvedValue({ id: 'j3', data: { episode: 1 } });
      await consumer.onGlobalFailed({ jobId: 'j3', failedReason: 'boom' });
      expect(mediaService.handleTVEpisodeStreamQueueError).toHaveBeenCalledTimes(1);
      expect(mediaService.handleMovieStreamQueueError).not.toHaveBeenCalled();
    });

    it('on failed: still removes but skips cleanup when the error was already handled (errorCode)', async () => {
      queue.getJob.mockResolvedValue({ id: 'j4', data: { errorCode: 1, episode: 1 } });
      await consumer.onGlobalFailed({ jobId: 'j4', failedReason: 'boom' });
      expect(queue.remove).toHaveBeenCalledWith('j4');
      expect(mediaService.handleTVEpisodeStreamQueueError).not.toHaveBeenCalled();
      expect(mediaService.handleMovieStreamQueueError).not.toHaveBeenCalled();
    });

    it('on failed: skips cleanup when the job is missing', async () => {
      queue.getJob.mockResolvedValue(undefined);
      await consumer.onGlobalFailed({ jobId: 'j5', failedReason: 'boom' });
      expect(queue.remove).toHaveBeenCalledWith('j5');
      expect(mediaService.handleTVEpisodeStreamQueueError).not.toHaveBeenCalled();
      expect(mediaService.handleMovieStreamQueueError).not.toHaveBeenCalled();
    });

    it('preserves @OnQueueEvent metadata on the inherited handlers (decoration survives the base-class hoist)', () => {
      for (const method of ['onGlobalActive', 'onGlobalCompleted', 'onGlobalFailed'] as const) {
        const meta = Reflect.getMetadata(ON_QUEUE_EVENT_METADATA, (Ctor.prototype as any)[method]);
        expect(meta).toBeDefined();
      }
    });

    it('keeps its own @QueueEventsListener queue binding on the concrete class', () => {
      const meta = Reflect.getMetadata(QUEUE_EVENTS_LISTENER_METADATA, Ctor);
      expect(meta).toBeDefined();
    });
  });
});
