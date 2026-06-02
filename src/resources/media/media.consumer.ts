import { Logger } from '@nestjs/common';
import { InjectQueue, OnQueueEvent, QueueEventsHost, QueueEventsListener } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { plainToInstance } from 'class-transformer';

import { MediaQueueResultDto } from './dto';
import { MediaService } from './media.service';
import { TaskQueue, VideoCodec } from '../../enums';

/**
 * Shared queue-event handling for the per-codec transcode listeners (Phase 6.1).
 *
 * MediaConsumerH264/H265/VP9/AV1 were four byte-identical classes differing only by the
 * codec label, the injected queue, and the class/field names. The active/completed/failed
 * handlers are hoisted here; each concrete subclass keeps its own @QueueEventsListener
 * (a distinct queue name) and injects its own queue. @nestjs/bullmq discovers @OnQueueEvent
 * handlers via MetadataScanner.scanFromPrototype, which walks the FULL prototype chain
 * (`do { ... } while (prototype = Reflect.getPrototypeOf(prototype))`), so the inherited
 * handlers are registered for every subclass — verified against @nestjs/bullmq 10.2.0 /
 * @nestjs/core metadata-scanner.
 */
abstract class BaseMediaConsumer extends QueueEventsHost {
  protected abstract readonly logger: Logger;
  protected abstract readonly codec: string;
  protected abstract readonly queue: Queue;
  protected abstract readonly mediaService: MediaService;

  @OnQueueEvent('active')
  onGlobalActive({ jobId }: { jobId: string }) {
    this.logger.log(`Processing job ${jobId} of type ${this.codec}`);
  }

  @OnQueueEvent('completed')
  async onGlobalCompleted({ jobId }: { jobId: string }) {
    this.logger.log(`Job finished: ${jobId}`);
    await this.queue.remove(jobId);
  }

  @OnQueueEvent('failed')
  async onGlobalFailed({ jobId, failedReason }: { jobId: string; failedReason: string }) {
    this.logger.error(`Found an error on job ${jobId}: ${failedReason}`);
    const job = await this.queue.getJob(jobId);
    await this.queue.remove(jobId);
    if (!job || job.data?.errorCode) return; // Stop if the error has already beed handled
    this.logger.log(`Cleanning failed job ${jobId}`);
    const jobData = plainToInstance(MediaQueueResultDto, { jobId: job.id, ...job.data });
    if (jobData.episode) {
      await this.mediaService.handleTVEpisodeStreamQueueError(jobData.jobId, jobData);
    } else {
      await this.mediaService.handleMovieStreamQueueError(jobData.jobId, jobData);
    }
  }
}

@QueueEventsListener(`${TaskQueue.VIDEO_TRANSCODE}:${VideoCodec.H264}`)
export class MediaConsumerH264 extends BaseMediaConsumer {
  protected readonly logger = new Logger(MediaConsumerH264.name);
  protected readonly codec = 'H264';

  constructor(
    @InjectQueue(`${TaskQueue.VIDEO_TRANSCODE}:${VideoCodec.H264}`) protected readonly queue: Queue,
    protected readonly mediaService: MediaService
  ) {
    super();
  }
}

@QueueEventsListener(`${TaskQueue.VIDEO_TRANSCODE}:${VideoCodec.H265}`)
export class MediaConsumerH265 extends BaseMediaConsumer {
  protected readonly logger = new Logger(MediaConsumerH265.name);
  protected readonly codec = 'H265';

  constructor(
    @InjectQueue(`${TaskQueue.VIDEO_TRANSCODE}:${VideoCodec.H265}`) protected readonly queue: Queue,
    protected readonly mediaService: MediaService
  ) {
    super();
  }
}

@QueueEventsListener(`${TaskQueue.VIDEO_TRANSCODE}:${VideoCodec.VP9}`)
export class MediaConsumerVP9 extends BaseMediaConsumer {
  protected readonly logger = new Logger(MediaConsumerVP9.name);
  protected readonly codec = 'VP9';

  constructor(
    @InjectQueue(`${TaskQueue.VIDEO_TRANSCODE}:${VideoCodec.VP9}`) protected readonly queue: Queue,
    protected readonly mediaService: MediaService
  ) {
    super();
  }
}

@QueueEventsListener(`${TaskQueue.VIDEO_TRANSCODE}:${VideoCodec.AV1}`)
export class MediaConsumerAV1 extends BaseMediaConsumer {
  protected readonly logger = new Logger(MediaConsumerAV1.name);
  protected readonly codec = 'AV1';

  constructor(
    @InjectQueue(`${TaskQueue.VIDEO_TRANSCODE}:${VideoCodec.AV1}`) protected readonly queue: Queue,
    protected readonly mediaService: MediaService
  ) {
    super();
  }
}
