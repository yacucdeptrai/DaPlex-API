import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { AddMediaVideoDto, UpdateMediaVideoDto, DeleteMediaVideosDto } from './dto';
import { AuthUserDto } from '../users/dto/auth-user.dto';
import { Media, MediaDocument, MediaVideo } from '../../schemas';
import { AuditLogService } from '../audit-log/audit-log.service';
import { WsAdminGateway } from '../ws-admin';
import { HeadersDto } from '../../common/dto';
import { createSnowFlakeId, convertToLanguageArray, AuditLogBuilder } from '../../utils';
import {
  StatusCode,
  MongooseConnection,
  MediaVideoSite,
  AuditLogType,
  MediaVisibility,
  SocketMessage,
  SocketRoom
} from '../../enums';
import { I18N_DEFAULT_LANGUAGE } from '../../config';

/**
 * YouTube video / trailer add, list, update and delete for media. Carries its
 * own resolveIoEmitter (wsAdminGateway) helper, reading the same injected
 * gateway as MediaService so behaviour is identical.
 */
@Injectable()
export class MediaVideosService {
  constructor(
    @InjectModel(Media.name, MongooseConnection.DATABASE_A) private mediaModel: Model<MediaDocument>,
    private auditLogService: AuditLogService,
    private wsAdminGateway: WsAdminGateway
  ) {}

  private resolveIoEmitter(socketId?: string) {
    return (socketId && this.wsAdminGateway.server.sockets.get(socketId)) || this.wsAdminGateway.server;
  }

  async addMediaVideo(id: bigint, addMediaVideoDto: AddMediaVideoDto, headers: HeadersDto, authUser: AuthUserDto) {
    const urlMatch = addMediaVideoDto.url.match(/.*(?:youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=)([^#\&\?]*).*/);
    if (!urlMatch || urlMatch[1].length !== 11)
      throw new HttpException(
        { code: StatusCode.INVALID_YOUTUBE_URL, message: 'Invalid YouTube url' },
        HttpStatus.BAD_REQUEST
      );
    const video = new MediaVideo();
    video._id = await createSnowFlakeId();
    addMediaVideoDto.name && (video.name = addMediaVideoDto.name);
    video.key = urlMatch[1];
    video.site = MediaVideoSite.YOUTUBE;
    video.official = addMediaVideoDto.official;
    const media = await this.mediaModel.findOne({ _id: id }).exec();
    if (!media)
      throw new HttpException({ code: StatusCode.MEDIA_NOT_FOUND, message: 'Media not found' }, HttpStatus.NOT_FOUND);
    if (media.videos.find((v) => v.key === urlMatch[1]))
      throw new HttpException(
        { code: StatusCode.MEDIA_VIDEO_EXIST, message: 'This video has already been added' },
        HttpStatus.BAD_REQUEST
      );
    media.videos.push(video);
    const auditLog = new AuditLogBuilder(authUser._id, media._id, Media.name, AuditLogType.MEDIA_VIDEO_CREATE);
    auditLog.getChangesFrom(media);
    await Promise.all([media.save({ timestamps: false }), this.auditLogService.createLogFromBuilder(auditLog)]);
    const videosObject = media.videos.toObject();
    const ioEmitter = this.resolveIoEmitter(headers.socketId);
    ioEmitter.to(`${SocketRoom.ADMIN_MEDIA_DETAILS}:${media._id}`).emit(SocketMessage.REFRESH_MEDIA_VIDEOS, {
      mediaId: media._id,
      videos: videosObject
    });
    return videosObject;
  }

  async findAllMediaVideos(id: bigint, headers: HeadersDto, authUser: AuthUserDto) {
    const media = await this.mediaModel.findOne({ _id: id }, { visibility: 1, videos: 1 }).lean().exec();
    if (!media)
      throw new HttpException({ code: StatusCode.MEDIA_NOT_FOUND, message: 'Media not found' }, HttpStatus.NOT_FOUND);
    if (media.visibility === MediaVisibility.PRIVATE && !authUser.hasPermission)
      throw new HttpException(
        { code: StatusCode.MEDIA_PRIVATE, message: 'This media is private' },
        HttpStatus.FORBIDDEN
      );
    if (!media.videos) return [];
    const translated = convertToLanguageArray<MediaVideo>(headers.acceptLanguage, media.videos, {
      keepTranslationsObject: authUser.hasPermission
    });
    return translated;
  }

  async updateMediaVideo(
    id: bigint,
    videoId: bigint,
    updateMediaVideoDto: UpdateMediaVideoDto,
    headers: HeadersDto,
    authUser: AuthUserDto
  ) {
    const media = await this.mediaModel.findOne({ _id: id, videos: { $elemMatch: { _id: videoId } } }).exec();
    if (!media)
      throw new HttpException({ code: StatusCode.MEDIA_NOT_FOUND, message: 'Media not found' }, HttpStatus.NOT_FOUND);
    const auditLog = new AuditLogBuilder(authUser._id, media._id, Media.name, AuditLogType.MEDIA_VIDEO_UPDATE);
    const videoIndex = media.videos.findIndex((v) => v._id === videoId);
    if (updateMediaVideoDto.translate && updateMediaVideoDto?.translate !== I18N_DEFAULT_LANGUAGE) {
      const nameKey = `_translations.${updateMediaVideoDto.translate}.name`;
      const nameKeyFromRoot = 'videos.' + videoIndex + '.' + nameKey;
      if (updateMediaVideoDto.name !== undefined) {
        media.set(nameKeyFromRoot, updateMediaVideoDto.name);
      }
    } else {
      const targetVideo = media.videos[videoIndex];
      if (updateMediaVideoDto.name !== undefined) {
        targetVideo.name = updateMediaVideoDto.name;
      }
      if (updateMediaVideoDto.url) {
        const urlMatch = updateMediaVideoDto.url.match(/.*(?:youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=)([^#\&\?]*).*/);
        if (!urlMatch || urlMatch[1].length !== 11)
          throw new HttpException(
            { code: StatusCode.INVALID_YOUTUBE_URL, message: 'Invalid YouTube Url' },
            HttpStatus.BAD_REQUEST
          );
        targetVideo.key = urlMatch[1];
      }
      if (updateMediaVideoDto.official != undefined) {
        targetVideo.official = updateMediaVideoDto.official;
      }
    }
    auditLog.getChangesFrom(media);
    await Promise.all([media.save({ timestamps: false }), this.auditLogService.createLogFromBuilder(auditLog)]);
    const videosObject = media.videos.toObject();
    const ioEmitter = this.resolveIoEmitter(headers.socketId);
    ioEmitter.to(`${SocketRoom.ADMIN_MEDIA_DETAILS}:${media._id}`).emit(SocketMessage.REFRESH_MEDIA_VIDEOS, {
      mediaId: media._id,
      videos: videosObject
    });
    return videosObject;
  }

  async deleteMediaVideo(id: bigint, videoId: bigint, headers: HeadersDto, authUser: AuthUserDto) {
    const media = await this.mediaModel
      .findOneAndUpdate(
        { _id: id, videos: { $elemMatch: { _id: videoId } } },
        { $pull: { videos: { _id: videoId } } },
        { new: true, timestamps: false }
      )
      .lean()
      .exec();
    if (!media)
      throw new HttpException({ code: StatusCode.MEDIA_NOT_FOUND, message: 'Media not found' }, HttpStatus.NOT_FOUND);
    const auditLog = new AuditLogBuilder(authUser._id, media._id, Media.name, AuditLogType.MEDIA_VIDEO_DELETE);
    auditLog.appendChange('_id', undefined, videoId);
    await this.auditLogService.createLogFromBuilder(auditLog);
    const ioEmitter = this.resolveIoEmitter(headers.socketId);
    ioEmitter.to(`${SocketRoom.ADMIN_MEDIA_DETAILS}:${media._id}`).emit(SocketMessage.REFRESH_MEDIA_VIDEOS, {
      mediaId: media._id,
      videos: media.videos
    });
    return media.videos;
  }

  async deleteMediaVideos(
    id: bigint,
    deleteMediaVideosDto: DeleteMediaVideosDto,
    headers: HeadersDto,
    authUser: AuthUserDto
  ) {
    const media = await this.mediaModel.findOne({ _id: id }, { videos: 1 }).lean().exec();
    if (!media)
      throw new HttpException({ code: StatusCode.MEDIA_NOT_FOUND, message: 'Media not found' }, HttpStatus.NOT_FOUND);
    const deleteVideoIds = media.videos.filter((v) => deleteMediaVideosDto.ids.includes(v._id)).map((v) => v._id);
    const deletedMedia = await this.mediaModel
      .findOneAndUpdate(
        { _id: id },
        { $pull: { videos: { _id: { $in: deleteVideoIds } } } },
        { new: true, timestamps: false }
      )
      .lean()
      .exec();
    const auditLog = new AuditLogBuilder(authUser._id, deletedMedia._id, Media.name, AuditLogType.MEDIA_VIDEO_DELETE);
    deleteVideoIds.forEach((id) => {
      auditLog.appendChange('_id', undefined, id);
    });
    await this.auditLogService.createLogFromBuilder(auditLog);
    const ioEmitter = this.resolveIoEmitter(headers.socketId);
    ioEmitter.to(`${SocketRoom.ADMIN_MEDIA_DETAILS}:${deletedMedia._id}`).emit(SocketMessage.REFRESH_MEDIA_VIDEOS, {
      mediaId: deletedMedia._id,
      videos: deletedMedia.videos
    });
    return deletedMedia.videos;
  }
}
