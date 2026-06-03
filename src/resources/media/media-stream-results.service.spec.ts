import { Test, TestingModule } from '@nestjs/testing';

import { MediaStreamResultsService } from './media-stream-results.service';

/**
 * Smoke + surface tests for the stream-result handlers extracted from
 * MediaService. The 15 methods are I/O-heavy (storage transactions, queues) and
 * were moved verbatim; only the 4 shared storage helpers were repointed to the
 * injected MediaService. Behavioural coverage of the error-routing path is
 * provided by media.consumer.spec.ts (which exercises handleMovie/
 * TVEpisodeStreamQueueError through the per-codec consumers); here we pin the DI
 * shape and the full public method surface so a dropped/renamed handler fails CI.
 */
describe('MediaStreamResultsService', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let service: any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({ providers: [MediaStreamResultsService] })
      .useMocker(() => ({}))
      .compile();
    service = module.get<MediaStreamResultsService>(MediaStreamResultsService);
  });

  it('is defined', () => expect(service).toBeDefined());

  it('exposes the full stream-result handler surface', () => {
    const expected = [
      'updateMediaSourceData',
      'addMovieAudioStream',
      'addMovieStream',
      'addMovieStreamManifest',
      'handleMovieStreamQueueDone',
      'handleMovieStreamQueueCancel',
      'handleMovieStreamQueueRetry',
      'handleMovieStreamQueueError',
      'addTVEpisodeAudioStream',
      'addTVEpisodeStream',
      'addTVEpisodeStreamManifest',
      'handleTVEpisodeStreamQueueDone',
      'handleTVEpisodeStreamQueueCancel',
      'handleTVEpisodeStreamQueueRetry',
      'handleTVEpisodeStreamQueueError'
    ];
    for (const method of expected) {
      expect(typeof service[method]).toBe('function');
    }
  });
});
