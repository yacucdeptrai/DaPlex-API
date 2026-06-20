import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { instanceToPlain, plainToInstance } from 'class-transformer';
import fs from 'fs';

import { AuthUserDto } from '../users/dto/auth-user.dto';
import { Media, MediaDocument, MediaFile, TVEpisode, TVEpisodeDocument } from '../../schemas';
import { AuditLogService } from '../audit-log/audit-log.service';
import { CloudflareR2Service } from '../../common/modules/cloudflare-r2';
import { WsAdminGateway } from '../ws-admin';
import { HeadersDto } from '../../common/dto';
import { MediaDetails, TVEpisode as TVEpisodeEntity } from './entities';
import { createSnowFlakeId, trimSlugFilename } from '../../utils';
import {
  StatusCode,
  MongooseConnection,
  AuditLogType,
  MediaFileType,
  SocketMessage,
  SocketRoom,
  CloudflareR2Container
} from '../../enums';

/**
 * Poster / backdrop upload + delete for media, and still-image upload + delete
 * for TV episodes. Carries its own resolveIoEmitter (wsAdminGateway) and
 * deleteMediaImage (cloudflareR2) helpers; deleteMediaImage also remains in
 * MediaService (remove / deleteEpisodeById), reading the same injected services
 * so behaviour is identical.
 */
@Injectable()
export class MediaImagesService {
  constructor(
    @InjectModel(Media.name, MongooseConnection.DATABASE_A) private mediaModel: Model<MediaDocument>,
    @InjectModel(TVEpisode.name, MongooseConnection.DATABASE_A) private tvEpisodeModel: Model<TVEpisodeDocument>,
    @InjectConnection(MongooseConnection.DATABASE_A) private mongooseConnection: Connection,
    private auditLogService: AuditLogService,
    private cloudflareR2Service: CloudflareR2Service,
    private wsAdminGateway: WsAdminGateway
  ) {}

  private resolveIoEmitter(socketId?: string) {
    return (socketId && this.wsAdminGateway.server.sockets.get(socketId)) || this.wsAdminGateway.server;
  }

  async uploadMediaPoster(id: bigint, file: Storage.MultipartFile, headers: HeadersDto, authUser: AuthUserDto) {
    const media = await this.mediaModel.findOne({ _id: id }, { poster: 1 }).exec();
    if (!media)
      throw new HttpException({ code: StatusCode.MEDIA_NOT_FOUND, message: 'Media not found' }, HttpStatus.NOT_FOUND);
    try {
      const posterId = await createSnowFlakeId();
      const trimmedFilename = trimSlugFilename(file.filename);
      const saveFile = `${posterId}/${trimmedFilename}`;
      const image = await this.cloudflareR2Service.upload(
        CloudflareR2Container.POSTERS,
        saveFile,
        file.filepath,
        file.detectedMimetype
      );
      if (media.poster) await this.deleteMediaImage(media.poster, CloudflareR2Container.POSTERS);
      const poster = new MediaFile();
      poster._id = posterId;
      poster.type = MediaFileType.POSTER;
      poster.name = trimmedFilename;
      poster.color = file.color;
      poster.placeholder = file.thumbhash;
      poster.size = image.size;
      poster.mimeType = file.detectedMimetype;
      media.poster = poster;
      try {
        await Promise.all([
          media.save({ timestamps: false }),
          this.auditLogService.createLog(authUser._id, media._id, Media.name, AuditLogType.MEDIA_POSTER_UPDATE)
        ]);
      } catch (e) {
        await this.cloudflareR2Service.delete(CloudflareR2Container.POSTERS, saveFile);
        throw e;
      }
      const serializedMedia = instanceToPlain(plainToInstance(MediaDetails, media.toObject()));
      const ioEmitter = this.resolveIoEmitter(headers.socketId);
      ioEmitter
        .to([SocketRoom.ADMIN_MEDIA_LIST, `${SocketRoom.ADMIN_MEDIA_DETAILS}:${media._id}`])
        .emit(SocketMessage.REFRESH_MEDIA, {
          mediaId: media._id,
          media: serializedMedia
        });
      return serializedMedia;
    } finally {
      if (file.isUrl) await fs.promises.unlink(file.filepath).catch(() => {});
    }
  }

  async deleteMediaPoster(id: bigint, headers: HeadersDto, authUser: AuthUserDto) {
    const media = await this.mediaModel.findOne({ _id: id }, { poster: 1 }).exec();
    if (!media)
      throw new HttpException({ code: StatusCode.MEDIA_NOT_FOUND, message: 'Media not found' }, HttpStatus.NOT_FOUND);
    if (!media.poster) return;
    await this.deleteMediaImage(media.poster, CloudflareR2Container.POSTERS);
    media.poster = undefined;
    await Promise.all([
      media.save({ timestamps: false }),
      this.auditLogService.createLog(authUser._id, media._id, Media.name, AuditLogType.MEDIA_POSTER_DELETE)
    ]);
    const ioEmitter = this.resolveIoEmitter(headers.socketId);
    ioEmitter
      .to([SocketRoom.ADMIN_MEDIA_LIST, `${SocketRoom.ADMIN_MEDIA_DETAILS}:${media._id}`])
      .emit(SocketMessage.REFRESH_MEDIA, {
        mediaId: media._id
      });
  }

  async uploadMediaBackdrop(id: bigint, file: Storage.MultipartFile, headers: HeadersDto, authUser: AuthUserDto) {
    const media = await this.mediaModel.findOne({ _id: id }, { backdrop: 1 }).exec();
    if (!media)
      throw new HttpException({ code: StatusCode.MEDIA_NOT_FOUND, message: 'Media not found' }, HttpStatus.NOT_FOUND);
    try {
      const backdropId = await createSnowFlakeId();
      const trimmedFilename = trimSlugFilename(file.filename);
      const saveFile = `${backdropId}/${trimmedFilename}`;
      const image = await this.cloudflareR2Service.upload(
        CloudflareR2Container.BACKDROPS,
        saveFile,
        file.filepath,
        file.detectedMimetype
      );
      if (media.backdrop) await this.deleteMediaImage(media.backdrop, CloudflareR2Container.BACKDROPS);
      const backdrop = new MediaFile();
      backdrop._id = backdropId;
      backdrop.type = MediaFileType.BACKDROP;
      backdrop.name = trimmedFilename;
      backdrop.color = file.color;
      backdrop.placeholder = file.thumbhash;
      backdrop.size = image.size;
      backdrop.mimeType = file.detectedMimetype;
      media.backdrop = backdrop;
      try {
        await Promise.all([
          media.save({ timestamps: false }),
          this.auditLogService.createLog(authUser._id, media._id, Media.name, AuditLogType.MEDIA_BACKDROP_UPDATE)
        ]);
      } catch (e) {
        await this.cloudflareR2Service.delete(CloudflareR2Container.BACKDROPS, saveFile);
        throw e;
      }
      const serializedMedia = instanceToPlain(plainToInstance(MediaDetails, media.toObject()));
      const ioEmitter = this.resolveIoEmitter(headers.socketId);
      ioEmitter.to(`${SocketRoom.ADMIN_MEDIA_DETAILS}:${media._id}`).emit(SocketMessage.REFRESH_MEDIA, {
        mediaId: media._id,
        media: serializedMedia
      });
      return serializedMedia;
    } finally {
      if (file.isUrl) await fs.promises.unlink(file.filepath).catch(() => {});
    }
  }

  async deleteMediaBackdrop(id: bigint, headers: HeadersDto, authUser: AuthUserDto) {
    const media = await this.mediaModel.findOne({ _id: id }, { backdrop: 1 }).exec();
    if (!media)
      throw new HttpException({ code: StatusCode.MEDIA_NOT_FOUND, message: 'Media not found' }, HttpStatus.NOT_FOUND);
    if (!media.backdrop) return;
    await this.deleteMediaImage(media.backdrop, CloudflareR2Container.BACKDROPS);
    media.backdrop = undefined;
    await Promise.all([
      media.save({ timestamps: false }),
      this.auditLogService.createLog(authUser._id, media._id, Media.name, AuditLogType.MEDIA_BACKDROP_DELETE)
    ]);
    const ioEmitter = this.resolveIoEmitter(headers.socketId);
    ioEmitter.to(`${SocketRoom.ADMIN_MEDIA_DETAILS}:${media._id}`).emit(SocketMessage.REFRESH_MEDIA, {
      mediaId: media._id
    });
  }

  async uploadTVEpisodeStill(
    id: bigint,
    episodeId: bigint,
    file: Storage.MultipartFile,
    headers: HeadersDto,
    authUser: AuthUserDto
  ) {
    const episode = await this.tvEpisodeModel
      .findOne(
        { _id: episodeId, media: id },
        { epNumber: 1, name: 1, overview: 1, runtime: 1, still: 1, airDate: 1, visibility: 1 }
      )
      .exec();
    if (!episode)
      throw new HttpException(
        { code: StatusCode.EPISODE_NOT_FOUND, message: 'Episode not found' },
        HttpStatus.NOT_FOUND
      );
    const stillId = await createSnowFlakeId();
    const trimmedFilename = trimSlugFilename(file.filename);
    const saveFile = `${stillId}/${trimmedFilename}`;
    const image = await this.cloudflareR2Service.upload(
      CloudflareR2Container.STILLS,
      saveFile,
      file.filepath,
      file.detectedMimetype
    );
    const session = await this.mongooseConnection.startSession();
    await session
      .withTransaction(async () => {
        if (episode.still) await this.deleteMediaImage(episode.still, CloudflareR2Container.STILLS);
        const still = new MediaFile();
        still._id = stillId;
        still.type = MediaFileType.STILL;
        still.name = trimmedFilename;
        still.color = file.color;
        still.placeholder = file.thumbhash;
        still.size = image.size;
        still.mimeType = file.detectedMimetype;
        episode.still = still;
        try {
          await Promise.all([
            episode.save({ session }),
            this.auditLogService.createLog(authUser._id, episode._id, TVEpisode.name, AuditLogType.EPISODE_STILL_UPDATE)
          ]);
        } catch (e) {
          await this.cloudflareR2Service.delete(CloudflareR2Container.STILLS, saveFile);
          throw e;
        }
      })
      .finally(() => session.endSession().catch(() => {}));
    const serializedEpisode = instanceToPlain(plainToInstance(TVEpisodeEntity, episode.toObject()));
    const ioEmitter = this.resolveIoEmitter(headers.socketId);
    ioEmitter
      .to([`${SocketRoom.ADMIN_MEDIA_DETAILS}:${id}`, `${SocketRoom.ADMIN_EPISODE_DETAILS}:${episodeId}`])
      .emit(SocketMessage.REFRESH_TV_EPISODE, {
        mediaId: id,
        episodeId: episodeId,
        episode: serializedEpisode
      });
    return serializedEpisode;
  }

  async deleteTVEpisodeStill(id: bigint, episodeId: bigint, headers: HeadersDto, authUser: AuthUserDto) {
    const episode = await this.tvEpisodeModel.findOne({ _id: episodeId, media: id }, { still: 1 }).exec();
    if (!episode)
      throw new HttpException(
        { code: StatusCode.EPISODE_NOT_FOUND, message: 'Episode not found' },
        HttpStatus.NOT_FOUND
      );
    const session = await this.mongooseConnection.startSession();
    await session
      .withTransaction(async () => {
        if (!episode.still) return;
        await this.deleteMediaImage(episode.still, CloudflareR2Container.STILLS);
        episode.still = undefined;
        await Promise.all([
          episode.save({ session }),
          this.auditLogService.createLog(authUser._id, episode._id, TVEpisode.name, AuditLogType.EPISODE_STILL_DELETE)
        ]);
      })
      .finally(() => session.endSession().catch(() => {}));
    const ioEmitter = this.resolveIoEmitter(headers.socketId);
    ioEmitter
      .to([`${SocketRoom.ADMIN_MEDIA_DETAILS}:${id}`, `${SocketRoom.ADMIN_EPISODE_DETAILS}:${episodeId}`])
      .emit(SocketMessage.REFRESH_TV_EPISODE, {
        mediaId: id,
        episodeId: episodeId
      });
  }

  private async deleteMediaImage(image: MediaFile, container: string) {
    if (!image) return;
    await this.cloudflareR2Service.delete(container, `${image._id}/${image.name}`);
  }
}
