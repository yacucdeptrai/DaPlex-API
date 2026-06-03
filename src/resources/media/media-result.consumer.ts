import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { plainToInstance } from 'class-transformer';

import { MediaStreamResultsService } from './media-stream-results.service';
import { TaskQueue } from '../../enums';
import { MediaQueueResultDto } from './dto';

type JobNameType =
  | 'update-source'
  | 'add-stream-video'
  | 'add-stream-audio'
  | 'add-stream-manifest'
  | 'finished-encoding'
  | 'cancelled-encoding'
  | 'retry-encoding'
  | 'failed-encoding';

@Processor(TaskQueue.VIDEO_TRANSCODE_RESULT, { concurrency: 1 })
export class MediaResultConsumer extends WorkerHost {
  private readonly logger = new Logger(MediaResultConsumer.name);

  constructor(private readonly mediaStreamResultsService: MediaStreamResultsService) {
    super();
  }

  async process(job: Job<MediaQueueResultDto, Record<string, never>, JobNameType>): Promise<Record<string, never>> {
    try {
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

  @OnWorkerEvent('active')
  onActive(job: Job) {
    this.logger.log(`Processing job ${job.id} of result type ${job.name}`);
  }
}
