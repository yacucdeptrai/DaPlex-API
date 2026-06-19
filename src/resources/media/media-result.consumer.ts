import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { plainToInstance } from 'class-transformer';

import { MediaStreamResultsService } from './media-stream-results.service';
import { RedisCacheService } from '../../common/modules/redis-cache/redis-cache.service';
import { TaskQueue } from '../../enums';
import { MediaProgressDto, MediaQueueResultDto } from './dto';
import { buildProgressKey, PROGRESS_TTL } from './media-progress.util';

type JobNameType =
  | 'update-source'
  | 'add-stream-video'
  | 'add-stream-audio'
  | 'add-stream-manifest'
  | 'finished-encoding'
  | 'cancelled-encoding'
  | 'retry-encoding'
  | 'failed-encoding'
  | 'progress';

@Processor(TaskQueue.VIDEO_TRANSCODE_RESULT, { concurrency: 1 })
export class MediaResultConsumer extends WorkerHost {
  private readonly logger = new Logger(MediaResultConsumer.name);

  constructor(
    private readonly mediaStreamResultsService: MediaStreamResultsService,
    private readonly redisCacheService: RedisCacheService
  ) {
    super();
  }

  async process(job: Job<MediaQueueResultDto, Record<string, never>, JobNameType>): Promise<Record<string, never>> {
    try {
      // Progress ticks carry their own shape (percent/eta/status), not the stream
      // metadata MediaQueueResultDto.progress means — read job.data directly and
      // never coerce through plainToInstance.
      if (job.name === 'progress') {
        await this.writeProgressSnapshot(job.data as unknown as Record<string, unknown>);
        return {};
      }
      const jobData = plainToInstance(MediaQueueResultDto, { jobId: job.id, ...job.data });
      switch (job.name) {
        case 'update-source': {
          let message = `Updating source ${jobData.progress.quality} of media ${jobData.media}`;
          if (jobData.episode) message += `, episode ${jobData.episode}`;
          this.logger.log(message);
          await this.mediaStreamResultsService.updateMediaSourceData(jobData);
          break;
        }
        case 'add-stream-audio': {
          if (jobData.episode) {
            this.logger.log(
              `Adding audio of codec ${jobData.progress.codec} to media ${jobData.media}, episode ${jobData.episode}`
            );
            await this.mediaStreamResultsService.addTVEpisodeAudioStream(jobData);
          } else {
            this.logger.log(`Adding audio of codec ${jobData.progress.codec} to media ${jobData.media}`);
            await this.mediaStreamResultsService.addMovieAudioStream(jobData);
          }
          break;
        }
        case 'add-stream-video': {
          if (jobData.episode) {
            this.logger.log(
              `Adding quality ${jobData.progress.quality} and codec ${jobData.progress.codec} to media ${jobData.media}, episode ${jobData.episode}`
            );
            await this.mediaStreamResultsService.addTVEpisodeStream(jobData);
          } else {
            this.logger.log(
              `Adding quality ${jobData.progress.quality} and codec ${jobData.progress.codec} to media ${jobData.media}`
            );
            await this.mediaStreamResultsService.addMovieStream(jobData);
          }
          break;
        }
        case 'add-stream-manifest': {
          if (jobData.episode) {
            this.logger.log(
              `Adding manifest of codec ${jobData.progress.codec} to media ${jobData.media}, episode ${jobData.episode}`
            );
            await this.mediaStreamResultsService.addTVEpisodeStreamManifest(jobData);
          } else {
            this.logger.log(`Adding manifest of codec ${jobData.progress.codec} to media ${jobData.media}`);
            await this.mediaStreamResultsService.addMovieStreamManifest(jobData);
          }
          break;
        }
        case 'finished-encoding': {
          await this.redisCacheService.del(buildProgressKey(jobData.media, jobData.episode));
          if (jobData.episode) {
            this.logger.log(`Finished encoding media ${jobData.media}, episode ${jobData.episode}`);
            await this.mediaStreamResultsService.handleTVEpisodeStreamQueueDone(jobData.jobId, jobData);
          } else {
            this.logger.log(`Finished encoding media ${jobData.media}`);
            await this.mediaStreamResultsService.handleMovieStreamQueueDone(jobData.jobId, jobData);
          }
          break;
        }
        case 'cancelled-encoding': {
          await this.redisCacheService.del(buildProgressKey(jobData.media, jobData.episode));
          if (jobData.episode) {
            this.logger.log(`Cancelled encoding media ${jobData.media}, episode ${jobData.episode}`);
            await this.mediaStreamResultsService.handleTVEpisodeStreamQueueCancel(jobData.jobId, jobData);
          } else {
            this.logger.log(`Cancelled encoding media ${jobData.media}`);
            await this.mediaStreamResultsService.handleMovieStreamQueueCancel(jobData.jobId, jobData);
          }
          break;
        }
        case 'retry-encoding': {
          if (jobData.episode) {
            this.logger.log(`Preparing to retry encoding media ${jobData.media}, episode ${jobData.episode}`);
            await this.mediaStreamResultsService.handleTVEpisodeStreamQueueRetry(jobData.jobId, jobData);
          } else {
            this.logger.log(`Preparing to retry encoding media ${jobData.media}`);
            await this.mediaStreamResultsService.handleMovieStreamQueueRetry(jobData.jobId, jobData);
          }
          break;
        }
        case 'failed-encoding': {
          await this.redisCacheService.del(buildProgressKey(jobData.media, jobData.episode));
          if (jobData.episode) {
            this.logger.error(`Failed encoding media ${jobData.media}, episode ${jobData.episode}`);
            await this.mediaStreamResultsService.handleTVEpisodeStreamQueueError(jobData.jobId, jobData);
          } else {
            this.logger.error(`Failed encoding media ${jobData.media}`);
            await this.mediaStreamResultsService.handleMovieStreamQueueError(jobData.jobId, jobData);
          }
          break;
        }
      }
    } catch (e) {
      this.logger.error(e);
      throw e;
    }
    return {};
  }

  // Writes the live-progress snapshot to Redis under the shared key with a bounded
  // TTL. ids arrive as raw numbers from the producer; stringify them for the wire.
  private async writeProgressSnapshot(data: Record<string, unknown>): Promise<void> {
    const media = data.media as string | number;
    const episode = data.episode as string | number | undefined;
    const snapshot: MediaProgressDto = {
      mediaId: String(media),
      episodeId: episode != null ? String(episode) : undefined,
      status: 'PROCESSING',
      percent: Number(data.percent ?? 0),
      eta: data.eta != null ? Number(data.eta) : undefined
    };
    await this.redisCacheService.set(buildProgressKey(media, episode), snapshot, PROGRESS_TTL);
  }

  @OnWorkerEvent('active')
  onActive(job: Job) {
    this.logger.log(`Processing job ${job.id} of result type ${job.name}`);
  }
}
