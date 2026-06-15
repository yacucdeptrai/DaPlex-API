import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, FilterQuery, Model, Types, UpdateQuery } from 'mongoose';
import mimeTypes from 'mime-types';

import { MediaService } from './media.service';
import { MediaQueueResultDto } from './dto';
import {
  Media,
  MediaDocument,
  MediaStorage,
  MediaStorageDocument,
  MediaStorageStream,
  TVEpisode,
  TVEpisodeDocument
} from '../../schemas';
import { ExternalStoragesService } from '../external-storages/external-storages.service';
import { RedisPubSubService } from '../../common/modules/redis-pubsub';
import { WsAdminGateway } from '../ws-admin';
import {
  MediaType,
  MongooseConnection,
  MediaStorageType,
  MediaPStatus,
  MediaSourceStatus,
  MediaVisibility,
  SocketMessage,
  SocketRoom,
  VideoCodec
} from '../../enums';

// Minimal shape of the file metadata returned by storage providers (Filer/S3/OneDrive)
// findPath calls; only name and size are consumed here.
interface StorageFileInfo {
  name: string;
  size: number;
}

/**
 * Stream-result handlers driven by the transcoder result queues: processes the
 * MediaQueueResultDto messages (update-source / add audio|video|manifest stream /
 * finished|cancelled|retry|failed encoding) for both movies and TV episodes.
 * These methods are invoked only by MediaResultConsumer and the per-codec
 * MediaConsumer, never inside MediaService. Shared storage helpers
 * (resolveStorageService, deleteMediaSource/Streams/StreamFromStorage) are
 * delegated to the injected MediaService (one-way; MediaService never calls back
 * into this service, so there is no cycle).
 */
@Injectable()
export class MediaStreamResultsService {
  constructor(
    @InjectModel(Media.name, MongooseConnection.DATABASE_A) private mediaModel: Model<MediaDocument>,
    @InjectModel(MediaStorage.name, MongooseConnection.DATABASE_A)
    private mediaStorageModel: Model<MediaStorageDocument>,
    @InjectModel(TVEpisode.name, MongooseConnection.DATABASE_A) private tvEpisodeModel: Model<TVEpisodeDocument>,
    @InjectConnection(MongooseConnection.DATABASE_A) private mongooseConnection: Connection,
    private externalStoragesService: ExternalStoragesService,
    private redisPubSubService: RedisPubSubService,
    private wsAdminGateway: WsAdminGateway,
    private mediaService: MediaService
  ) {}

  updateMediaSourceData(mediaQueueResultDto: MediaQueueResultDto) {
    const updateStorageFilters: FilterQuery<MediaStorageDocument> = {
      _id: mediaQueueResultDto.progress.sourceId,
      media: mediaQueueResultDto.media
    };
    const updatePromises = [];
    if (mediaQueueResultDto.episode) {
      updateStorageFilters.episode = mediaQueueResultDto.episode;
      updatePromises.push(
        this.tvEpisodeModel
          .updateOne(
            { _id: mediaQueueResultDto.episode, media: mediaQueueResultDto.media },
            { $set: { runtime: mediaQueueResultDto.progress.runtime } }
          )
          .exec()
      );
    }
    updatePromises.push(
      this.mediaModel
        .updateOne(
          { _id: mediaQueueResultDto.media, runtime: null },
          { $set: { runtime: mediaQueueResultDto.progress.runtime } },
          { timestamps: false }
        )
        .exec()
    );
    updatePromises.push(
      this.mediaStorageModel
        .updateOne(updateStorageFilters, { $set: { quality: mediaQueueResultDto.progress.quality } })
        .exec()
    );
    return Promise.all(updatePromises);
  }

  async addMovieAudioStream(mediaQueueResultDto: MediaQueueResultDto) {
    const filePath = `${mediaQueueResultDto.progress.sourceId}/${mediaQueueResultDto.progress.streamId}/${mediaQueueResultDto.progress.fileName}`;
    const storage = await this.externalStoragesService.findStorageById(mediaQueueResultDto.storage);
    let fileInfo: StorageFileInfo;
    fileInfo = await this.mediaService
      .resolveStorageService(storage.kind)
      .findPath(filePath, mediaQueueResultDto.storage);
    let source: MediaStorageDocument;
    const session = await this.mongooseConnection.startSession();
    await session
      .withTransaction(async () => {
        source = await this.mediaStorageModel.findOne({ _id: mediaQueueResultDto._id }, {}, { session });
        if (!source) return;
        const fileMimeType = mimeTypes.lookup(mediaQueueResultDto.progress.fileName) || 'application/octet-stream';
        const stream = new MediaStorageStream();
        stream._id = mediaQueueResultDto.progress.streamId;
        stream.type = MediaStorageType.STREAM_AUDIO;
        stream.name = mediaQueueResultDto.progress.fileName;
        stream.codec = mediaQueueResultDto.progress.codec;
        stream.channels = mediaQueueResultDto.progress.channels;
        stream.mimeType = fileMimeType;
        stream.size = fileInfo.size;
        source.streams.push(stream);
        await source.save({ session });
        await this.externalStoragesService.updateStorageSize(mediaQueueResultDto.storage, +fileInfo.size, session);
      })
      .finally(() => session.endSession().catch(() => {}));
  }

  async addMovieStream(mediaQueueResultDto: MediaQueueResultDto) {
    const filePath = `${mediaQueueResultDto.progress.sourceId}/${mediaQueueResultDto.progress.streamId}/${mediaQueueResultDto.progress.fileName}`;
    const storage = await this.externalStoragesService.findStorageById(mediaQueueResultDto.storage);
    let fileInfo: StorageFileInfo;
    fileInfo = await this.mediaService
      .resolveStorageService(storage.kind)
      .findPath(filePath, mediaQueueResultDto.storage);
    let source: MediaStorageDocument;
    const session = await this.mongooseConnection.startSession();
    await session
      .withTransaction(async () => {
        source = await this.mediaStorageModel.findOne({ _id: mediaQueueResultDto._id }, {}, { session });
        if (!source) return;
        const fileMimeType = mimeTypes.lookup(mediaQueueResultDto.progress.fileName) || 'application/octet-stream';
        const stream = new MediaStorageStream();
        stream._id = mediaQueueResultDto.progress.streamId;
        stream.type = MediaStorageType.STREAM_VIDEO;
        stream.name = mediaQueueResultDto.progress.fileName;
        stream.quality = mediaQueueResultDto.progress.quality;
        stream.codec = mediaQueueResultDto.progress.codec;
        stream.mimeType = fileMimeType;
        stream.size = fileInfo.size;
        source.streams.push(stream);
        await source.save({ session });
        await this.externalStoragesService.updateStorageSize(mediaQueueResultDto.storage, +fileInfo.size, session);
      })
      .finally(() => session.endSession().catch(() => {}));
  }

  async addMovieStreamManifest(mediaQueueResultDto: MediaQueueResultDto) {
    const filePath = `${mediaQueueResultDto.progress.sourceId}/${mediaQueueResultDto.progress.streamId}/${mediaQueueResultDto.progress.fileName}`;
    const storage = await this.externalStoragesService.findStorageById(mediaQueueResultDto.storage);
    let fileInfo: StorageFileInfo;
    fileInfo = await this.mediaService
      .resolveStorageService(storage.kind)
      .findPath(filePath, mediaQueueResultDto.storage);
    let media: MediaDocument;
    let source: MediaStorageDocument;
    const session = await this.mongooseConnection.startSession();
    await session
      .withTransaction(async () => {
        media = await this.mediaModel.findOne(
          { _id: mediaQueueResultDto.media, type: MediaType.MOVIE },
          { _id: 1, movie: 1, pStatus: 1 },
          { session }
        );
        if (!media) return;
        source = await this.mediaStorageModel.findOne({ _id: mediaQueueResultDto._id }, {}, { session });
        if (!source) return;
        const fileMimeType = mimeTypes.lookup(mediaQueueResultDto.progress.fileName) || 'application/octet-stream';
        const stream = new MediaStorageStream();
        stream._id = mediaQueueResultDto.progress.streamId;
        stream.type = MediaStorageType.MANIFEST;
        stream.name = mediaQueueResultDto.progress.fileName;
        stream.codec = mediaQueueResultDto.progress.codec;
        stream.hdrFormat = mediaQueueResultDto.progress.hdrFormat || undefined;
        stream.mimeType = fileMimeType;
        stream.size = fileInfo.size;
        stream.hdrFormat && (source.hdrFormat = stream.hdrFormat);
        const oldManifests = source.streams.filter(
          (s) => s.type === MediaStorageType.MANIFEST && s.codec === mediaQueueResultDto.progress.codec
        );
        if (oldManifests.length) {
          const oldManifestIds = oldManifests.map<bigint>((m) => m._id);
          source.streams.pull(...oldManifestIds);
          await this.mediaService.deleteMediaStreams(oldManifestIds, source._id, session);
          await this.mediaService.deleteMediaStreamFromStorage(oldManifestIds, source._id, storage);
        }
        source.streams.push(stream);
        media.movie.status !== MediaSourceStatus.DONE && (media.movie.status = MediaSourceStatus.READY);
        if (media.pStatus !== MediaPStatus.DONE) {
          media.pStatus = MediaPStatus.DONE;
          this.wsAdminGateway.server
            .to([SocketRoom.ADMIN_MEDIA_LIST, `${SocketRoom.ADMIN_MEDIA_DETAILS}:${media._id}`])
            .emit(SocketMessage.ADD_MOVIE_STREAM, {
              mediaId: media._id
            });
        }
        await source.save({ session });
        await media.save({ session });
        await this.externalStoragesService.updateStorageSize(mediaQueueResultDto.storage, +fileInfo.size, session);
      })
      .finally(() => session.endSession().catch(() => {}));
  }

  async handleMovieStreamQueueDone(jobId: number | string, mediaQueueResultDto: MediaQueueResultDto) {
    const session = await this.mongooseConnection.startSession();
    await session
      .withTransaction(async () => {
        const updateQuery: UpdateQuery<MediaDocument> = {
          $pull: { 'movie.tJobs': jobId },
          $set: { 'movie.status': MediaSourceStatus.DONE }
        };
        const media = await this.mediaModel.findOneAndUpdate({ _id: mediaQueueResultDto.media }, updateQuery, {
          session,
          lean: true
        });
        // Replace old streams
        if (mediaQueueResultDto.replaceStreams?.length)
          await this.mediaService.deleteMediaStreams(
            mediaQueueResultDto.replaceStreams,
            <bigint>(<unknown>media.movie.source),
            session
          );
      })
      .finally(() => session.endSession().catch(() => {}));
    if (!mediaQueueResultDto.isPrimary) return;
    this.wsAdminGateway.server
      .to(`${SocketRoom.USER_ID}:${mediaQueueResultDto._id}`)
      .emit(SocketMessage.MEDIA_PROCESSING_SUCCESS, {
        mediaId: mediaQueueResultDto.media
      });
    this.wsAdminGateway.server
      .to(SocketRoom.ADMIN_MEDIA_LIST)
      .to(`${SocketRoom.ADMIN_MEDIA_DETAILS}:${mediaQueueResultDto.media}`)
      .emit(SocketMessage.REFRESH_MEDIA, {
        mediaId: mediaQueueResultDto.media
      });
    /*
    this.httpEmailService.sendEmailSendGrid(infoData.user.email, infoData.user.username, 'Your movie is ready',
      SendgridTemplate.MEDIA_PROCESSING_SUCCESS, {
      recipient_name: infoData.user.username,
      button_url: `${this.configService.get('WEBSITE_URL')}/watch/${infoData.media}`
    }).catch(err => {
      this.logger.error(err);
    });
    */
  }

  async handleMovieStreamQueueCancel(jobId: number | string, mediaQueueResultDto: MediaQueueResultDto) {
    const session = await this.mongooseConnection.startSession();
    await session
      .withTransaction(async () => {
        let updateSetQuery: UpdateQuery<MediaDocument> = {
          'movie.status': MediaSourceStatus.PENDING,
          pStatus: MediaPStatus.PENDING
        };
        if (mediaQueueResultDto.keepStreams)
          updateSetQuery = { 'movie.status': MediaSourceStatus.DONE, pStatus: MediaPStatus.DONE };
        const media = await this.mediaModel
          .findOneAndUpdate(
            { _id: mediaQueueResultDto.media },
            {
              $pull: { 'movie.tJobs': jobId },
              $set: updateSetQuery
            },
            { session, lean: true, timestamps: false }
          )
          .populate({ path: 'movie.source' });
        if (!mediaQueueResultDto.keepStreams && media) {
          const streamIds = media.movie.source.streams.map((s) => s._id);
          await this.mediaService.deleteMediaStreams(streamIds, media.movie.source._id, session);
        }
      })
      .finally(() => session.endSession().catch(() => {}));
    this.wsAdminGateway.server
      .to(SocketRoom.ADMIN_MEDIA_LIST)
      .to(`${SocketRoom.ADMIN_MEDIA_DETAILS}:${mediaQueueResultDto.media}`)
      .emit(SocketMessage.REFRESH_MEDIA, {
        mediaId: mediaQueueResultDto.media
      });
  }

  async handleMovieStreamQueueRetry(_jobId: number | string, mediaQueueResultDto: MediaQueueResultDto) {
    const source = await this.mediaStorageModel.findOne({ _id: mediaQueueResultDto._id }).populate('storage').exec();
    if (!source) return;
    const session = await this.mongooseConnection.startSession();
    await session
      .withTransaction(async () => {
        let streamsByCodec: MediaStorageStream[];
        if (mediaQueueResultDto.codec === VideoCodec.H264) {
          streamsByCodec = source.streams.filter(
            (s) =>
              s.type === MediaStorageType.STREAM_AUDIO || (MediaStorageType.STREAM_VIDEO && s.codec === VideoCodec.H264)
          );
        } else {
          streamsByCodec = source.streams.filter(
            (s) => MediaStorageType.STREAM_VIDEO && s.codec === mediaQueueResultDto.codec
          );
        }
        const streamIds = streamsByCodec.map((s) => s._id);
        await this.mediaService.deleteMediaStreams(streamIds, source._id, session);
        await this.mediaService.deleteMediaStreamFromStorage(
          source.streams.map((s) => s._id),
          source._id,
          source.storage
        );
        source.streams = new Types.DocumentArray<MediaStorageStream>([]);
        await source.save({ session });
      })
      .finally(() => session.endSession().catch(() => {}));
  }

  async handleMovieStreamQueueError(jobId: number | string, mediaQueueResultDto: MediaQueueResultDto) {
    const media = await this.mediaModel.findOne({ _id: mediaQueueResultDto.media }).exec();
    if (media && <bigint>(<unknown>media.movie.source) === mediaQueueResultDto._id) {
      const session = await this.mongooseConnection.startSession();
      await session
        .withTransaction(async () => {
          if (mediaQueueResultDto.isPrimary) {
            await this.mediaService.deleteMediaSource(<bigint>(<unknown>media.movie.source), session);
            await this.redisPubSubService.publishJson('video-cancel', { ids: media.movie.tJobs });
            media.movie.source = undefined;
            media.movie.status = MediaSourceStatus.PENDING;
            media.pStatus = MediaPStatus.PENDING;
            media.movie.tJobs = new Types.Array<number>();
          } else {
            // Delete only streams with selected codec
            const source = await this.mediaStorageModel
              .findOne({ _id: media.movie.source })
              .populate('storage')
              .lean()
              .exec();
            if (source?.streams) {
              const streamsByCodec = source.streams.filter(
                (s) => s.type === MediaStorageType.STREAM_VIDEO && s.codec === mediaQueueResultDto.codec
              );
              const streamByCodecIds = streamsByCodec.map((s) => s._id);
              await this.mediaService.deleteMediaStreams(streamByCodecIds, source._id, session);
              await this.mediaService.deleteMediaStreamFromStorage(streamByCodecIds, source._id, source.storage);
            }
            media.movie.tJobs.pull(jobId);
          }
          await media.save({ session, timestamps: false });
          this.wsAdminGateway.server
            .to(`${SocketRoom.USER_ID}:${mediaQueueResultDto.user}`)
            .emit(SocketMessage.MEDIA_PROCESSING_FAILURE, {
              mediaId: media._id
            });
          this.wsAdminGateway.server
            .to([SocketRoom.ADMIN_MEDIA_LIST, `${SocketRoom.ADMIN_MEDIA_DETAILS}:${media._id}`])
            .emit(SocketMessage.REFRESH_MEDIA, {
              mediaId: media._id
            });
        })
        .finally(() => session.endSession().catch(() => {}));
    }
  }

  async addTVEpisodeAudioStream(mediaQueueResultDto: MediaQueueResultDto) {
    const filePath = `${mediaQueueResultDto.progress.sourceId}/${mediaQueueResultDto.progress.streamId}/${mediaQueueResultDto.progress.fileName}`;
    const storage = await this.externalStoragesService.findStorageById(mediaQueueResultDto.storage);
    let fileInfo: StorageFileInfo;
    fileInfo = await this.mediaService
      .resolveStorageService(storage.kind)
      .findPath(filePath, mediaQueueResultDto.storage);
    let source: MediaStorageDocument;
    const session = await this.mongooseConnection.startSession();
    await session
      .withTransaction(async () => {
        source = await this.mediaStorageModel.findOne({ _id: mediaQueueResultDto._id }, {}, { session });
        if (!source) return;
        const fileMimeType = mimeTypes.lookup(mediaQueueResultDto.progress.fileName) || 'application/octet-stream';
        const stream = new MediaStorageStream();
        stream._id = mediaQueueResultDto.progress.streamId;
        stream.type = MediaStorageType.STREAM_AUDIO;
        stream.name = mediaQueueResultDto.progress.fileName;
        stream.codec = mediaQueueResultDto.progress.codec;
        stream.channels = mediaQueueResultDto.progress.channels;
        stream.mimeType = fileMimeType;
        stream.size = fileInfo.size;
        source.streams.push(stream);
        await source.save({ session });
      })
      .finally(() => session.endSession().catch(() => {}));
  }

  async addTVEpisodeStream(mediaQueueResultDto: MediaQueueResultDto) {
    const filePath = `${mediaQueueResultDto.progress.sourceId}/${mediaQueueResultDto.progress.streamId}/${mediaQueueResultDto.progress.fileName}`;
    const storage = await this.externalStoragesService.findStorageById(mediaQueueResultDto.storage);
    let fileInfo: StorageFileInfo;
    fileInfo = await this.mediaService
      .resolveStorageService(storage.kind)
      .findPath(filePath, mediaQueueResultDto.storage);
    let source: MediaStorageDocument;
    const session = await this.mongooseConnection.startSession();
    await session
      .withTransaction(async () => {
        source = await this.mediaStorageModel.findOne({ _id: mediaQueueResultDto._id }, {}, { session });
        if (!source) return;
        const fileMimeType = mimeTypes.lookup(mediaQueueResultDto.progress.fileName) || 'application/octet-stream';
        const stream = new MediaStorageStream();
        stream._id = mediaQueueResultDto.progress.streamId;
        stream.type = MediaStorageType.STREAM_VIDEO;
        stream.name = mediaQueueResultDto.progress.fileName;
        stream.quality = mediaQueueResultDto.progress.quality;
        stream.codec = mediaQueueResultDto.progress.codec;
        stream.mimeType = fileMimeType;
        stream.size = fileInfo.size;
        source.streams.push(stream);
        await source.save({ session });
        await this.externalStoragesService.updateStorageSize(mediaQueueResultDto.storage, +fileInfo.size, session);
      })
      .finally(() => session.endSession().catch(() => {}));
  }

  async addTVEpisodeStreamManifest(mediaQueueResultDto: MediaQueueResultDto) {
    const filePath = `${mediaQueueResultDto.progress.sourceId}/${mediaQueueResultDto.progress.streamId}/${mediaQueueResultDto.progress.fileName}`;
    const storage = await this.externalStoragesService.findStorageById(mediaQueueResultDto.storage);
    let fileInfo: StorageFileInfo;
    fileInfo = await this.mediaService
      .resolveStorageService(storage.kind)
      .findPath(filePath, mediaQueueResultDto.storage);
    const epProjection: { [key: string]: 1 | -1 } = { _id: 1, epNumber: 1 };
    let media: MediaDocument;
    let episode: TVEpisodeDocument;
    let source: MediaStorageDocument;
    const session = await this.mongooseConnection.startSession();
    await session
      .withTransaction(async () => {
        media = await this.mediaModel
          .findOne({ _id: mediaQueueResultDto.media, type: MediaType.TV }, { _id: 1, tv: 1, pStatus: 1 }, { session })
          .populate([
            { path: 'tv.lastEpisode', select: epProjection },
            { path: 'tv.pLastEpisode', select: epProjection }
          ]);
        if (!media)
          // Media could have been deleted
          return;
        episode = await this.tvEpisodeModel.findOne(
          { _id: mediaQueueResultDto.episode, media: mediaQueueResultDto.media },
          { _id: 1, epNumber: 1, streams: 1, status: 1, pStatus: 1, visibility: 1 },
          { session }
        );
        if (!episode)
          // Episode could have been deleted
          return;
        source = await this.mediaStorageModel.findOne({ _id: mediaQueueResultDto._id }, {}, { session });
        if (!source) return;
        const fileMimeType = mimeTypes.lookup(mediaQueueResultDto.progress.fileName) || 'application/octet-stream';
        const stream = new MediaStorageStream();
        stream._id = mediaQueueResultDto.progress.streamId;
        stream.type = MediaStorageType.MANIFEST;
        stream.name = mediaQueueResultDto.progress.fileName;
        stream.codec = mediaQueueResultDto.progress.codec;
        stream.hdrFormat = mediaQueueResultDto.progress.hdrFormat || undefined;
        stream.mimeType = fileMimeType;
        stream.size = fileInfo.size;
        stream.hdrFormat && (source.hdrFormat = stream.hdrFormat);
        const oldManifests = source.streams.filter(
          (s) => s.type === MediaStorageType.MANIFEST && s.codec === mediaQueueResultDto.progress.codec
        );
        if (oldManifests.length) {
          const oldManifestIds = oldManifests.map<bigint>((m) => m._id);
          source.streams.pull(...oldManifestIds);
          await this.mediaService.deleteMediaStreams(oldManifestIds, source._id, session);
          await this.mediaService.deleteMediaStreamFromStorage(oldManifestIds, source._id, storage);
        }
        source.streams.push(stream);
        episode.status !== MediaSourceStatus.DONE && (episode.status = MediaSourceStatus.READY);
        if (episode.pStatus !== MediaPStatus.DONE) {
          episode.pStatus = MediaPStatus.DONE;
          if (!media.tv.lastEpisode || media.tv.lastEpisode.epNumber < episode.epNumber) {
            media.depopulate('tv.lastEpisode');
            media.tv.lastEpisode = episode._id;
          }
          if (
            episode.visibility === MediaVisibility.PUBLIC &&
            (!media.tv.pLastEpisode || media.tv.pLastEpisode.epNumber < episode.epNumber)
          ) {
            media.depopulate('tv.pLastEpisode');
            media.tv.pLastEpisode = episode._id;
          }
        }
        if (media.pStatus !== MediaPStatus.DONE) {
          media.pStatus = MediaPStatus.DONE;
          this.wsAdminGateway.server
            .to([
              SocketRoom.ADMIN_MEDIA_LIST,
              `${SocketRoom.ADMIN_MEDIA_DETAILS}:${media._id}`,
              `${SocketRoom.ADMIN_EPISODE_DETAILS}:${episode._id}`
            ])
            .emit(SocketMessage.ADD_TV_STREAM, {
              mediaId: media._id,
              episodeId: episode._id
            });
        }
        await media.save({ session });
        await episode.save({ session });
        await source.save({ session });
        await this.externalStoragesService.updateStorageSize(mediaQueueResultDto.storage, +fileInfo.size, session);
      })
      .finally(() => session.endSession().catch(() => {}));
  }

  async handleTVEpisodeStreamQueueDone(jobId: number | string, mediaQueueResultDto: MediaQueueResultDto) {
    let episode: TVEpisodeDocument;
    const session = await this.mongooseConnection.startSession();
    await session
      .withTransaction(async () => {
        const updateQuery: UpdateQuery<TVEpisodeDocument> = {
          $pull: { tJobs: jobId },
          $set: { status: MediaSourceStatus.DONE }
        };
        episode = await this.tvEpisodeModel.findOneAndUpdate(
          { _id: mediaQueueResultDto.episode, media: mediaQueueResultDto.media },
          updateQuery,
          { session, lean: true }
        );
        if (mediaQueueResultDto.replaceStreams?.length)
          await this.mediaService.deleteMediaStreams(
            mediaQueueResultDto.replaceStreams,
            <bigint>(<unknown>episode.source),
            session
          );
      })
      .finally(() => session.endSession().catch(() => {}));
    if (!mediaQueueResultDto.isPrimary) return;
    this.wsAdminGateway.server
      .to(`${SocketRoom.USER_ID}:${mediaQueueResultDto._id}`)
      .emit(SocketMessage.MEDIA_PROCESSING_SUCCESS, {
        mediaId: mediaQueueResultDto.media,
        epNumber: episode.epNumber
      });
    this.wsAdminGateway.server
      .to(SocketRoom.ADMIN_MEDIA_LIST)
      .to(`${SocketRoom.ADMIN_MEDIA_DETAILS}:${mediaQueueResultDto.media}`)
      .to(`${SocketRoom.ADMIN_EPISODE_DETAILS}:${episode._id}`)
      .emit(SocketMessage.REFRESH_MEDIA, {
        mediaId: mediaQueueResultDto.media
      });
    /*
    this.httpEmailService.sendEmailSendGrid(infoData.user.email, infoData.user.username, 'Your episode is ready',
      SendgridTemplate.MEDIA_PROCESSING_SUCCESS, {
      recipient_name: infoData.user.username,
      button_url: `${this.configService.get('WEBSITE_URL')}/watch/${infoData.media}?episode=${episode.epNumber}`
    }).catch(err => {
      this.logger.error(err);
    });
    */
  }

  async handleTVEpisodeStreamQueueCancel(jobId: number | string, mediaQueueResultDto: MediaQueueResultDto) {
    let episode: TVEpisodeDocument;
    const session = await this.mongooseConnection.startSession();
    await session
      .withTransaction(async () => {
        let updateSetQuery: UpdateQuery<MediaDocument> = {
          status: MediaSourceStatus.PENDING,
          pStatus: MediaPStatus.PENDING
        };
        if (mediaQueueResultDto.keepStreams)
          updateSetQuery = { status: MediaSourceStatus.DONE, pStatus: MediaPStatus.DONE };
        episode = await this.tvEpisodeModel
          .findOneAndUpdate(
            { _id: mediaQueueResultDto.episode, media: mediaQueueResultDto.media },
            { $pull: { tJobs: jobId }, $set: updateSetQuery },
            { session, lean: true }
          )
          .populate({ path: 'source' });
        if (!mediaQueueResultDto.keepStreams && episode) {
          const streamIds = episode.source.streams.map((s) => s._id);
          await this.mediaService.deleteMediaStreams(streamIds, episode.source._id, session);
        }
      })
      .finally(() => session.endSession().catch(() => {}));
    this.wsAdminGateway.server
      .to(SocketRoom.ADMIN_MEDIA_LIST)
      .to(`${SocketRoom.ADMIN_MEDIA_DETAILS}:${mediaQueueResultDto.media}`)
      .to(`${SocketRoom.ADMIN_EPISODE_DETAILS}:${episode._id}`)
      .emit(SocketMessage.REFRESH_MEDIA, {
        mediaId: mediaQueueResultDto.media
      });
  }

  async handleTVEpisodeStreamQueueRetry(_jobId: number | string, mediaQueueResultDto: MediaQueueResultDto) {
    const source = await this.mediaStorageModel.findOne({ _id: mediaQueueResultDto._id }).populate('storage').exec();
    if (!source) return;
    const session = await this.mongooseConnection.startSession();
    await session
      .withTransaction(async () => {
        let streamsByCodec: MediaStorageStream[];
        if (mediaQueueResultDto.codec === VideoCodec.H264) {
          streamsByCodec = source.streams.filter(
            (s) =>
              s.type === MediaStorageType.STREAM_AUDIO || (MediaStorageType.STREAM_VIDEO && s.codec === VideoCodec.H264)
          );
        } else {
          streamsByCodec = source.streams.filter(
            (s) => MediaStorageType.STREAM_VIDEO && s.codec === mediaQueueResultDto.codec
          );
        }
        const streamIds = streamsByCodec.map((s) => s._id);
        await this.mediaService.deleteMediaStreams(streamIds, source._id, session);
        await this.mediaService.deleteMediaStreamFromStorage(
          source.streams.map((s) => s._id),
          source._id,
          source.storage
        );
        source.streams = new Types.DocumentArray<MediaStorageStream>([]);
        await source.save({ session });
      })
      .finally(() => session.endSession().catch(() => {}));
  }

  async handleTVEpisodeStreamQueueError(jobId: number | string, mediaQueueResultDto: MediaQueueResultDto) {
    const episode = await this.tvEpisodeModel
      .findOne({ _id: mediaQueueResultDto.episode, media: mediaQueueResultDto.media })
      .exec();
    if (episode && <bigint>(<unknown>episode.source) === mediaQueueResultDto._id) {
      const session = await this.mongooseConnection.startSession();
      await session
        .withTransaction(async () => {
          if (mediaQueueResultDto.isPrimary) {
            await this.mediaService.deleteMediaSource(<bigint>(<unknown>episode.source), session);
            await this.redisPubSubService.publishJson('video-cancel', { ids: episode.tJobs });
            episode.source = undefined;
            episode.status = MediaSourceStatus.PENDING;
            episode.pStatus = MediaPStatus.PENDING;
            episode.tJobs = new Types.Array<number>();
          } else {
            // Delete only streams with selected codec
            const source = await this.mediaStorageModel
              .findOne({ _id: episode.source })
              .populate('storage')
              .lean()
              .exec();
            if (source?.streams) {
              const streamsByCodec = source.streams.filter(
                (s) => s.type === MediaStorageType.STREAM_VIDEO && s.codec === mediaQueueResultDto.codec
              );
              const streamByCodecIds = streamsByCodec.map((s) => s._id);
              await this.mediaService.deleteMediaStreams(streamByCodecIds, source._id, session);
              await this.mediaService.deleteMediaStreamFromStorage(streamByCodecIds, source._id, source.storage);
            }
            episode.tJobs.pull(jobId);
          }
          await episode.save({ session });
        })
        .finally(() => session.endSession().catch(() => {}));
      this.wsAdminGateway.server
        .to(`${SocketRoom.USER_ID}:${mediaQueueResultDto.user}`)
        .emit(SocketMessage.MEDIA_PROCESSING_FAILURE, {
          mediaId: mediaQueueResultDto.media,
          epNumber: episode.epNumber
        });
      this.wsAdminGateway.server
        .to([
          SocketRoom.ADMIN_MEDIA_LIST,
          `${SocketRoom.ADMIN_MEDIA_DETAILS}:${mediaQueueResultDto.media}`,
          `${SocketRoom.ADMIN_EPISODE_DETAILS}:${episode._id}`
        ])
        .emit(SocketMessage.REFRESH_MEDIA, {
          mediaId: mediaQueueResultDto.media
        });
    }
  }
}
