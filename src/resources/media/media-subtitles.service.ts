import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { instanceToPlain, plainToInstance } from 'class-transformer';
import ISO6391 from 'iso-639-1';
import pLimit from 'p-limit';

import { DeleteMediaSubtitlesDto } from './dto';
import { AuthUserDto } from '../users/dto/auth-user.dto';
import { Media, MediaDocument, MediaFile, TVEpisode, TVEpisodeDocument } from '../../schemas';
import { AuditLogService } from '../audit-log/audit-log.service';
import { CloudflareR2Service } from '../../common/modules/cloudflare-r2';
import { WsAdminGateway } from '../ws-admin';
import { HeadersDto } from '../../common/dto';
import { MediaSubtitle } from './entities';
import { createSnowFlakeId, trimSlugFilename, AuditLogBuilder } from '../../utils';
import {
  MediaType,
  StatusCode,
  MongooseConnection,
  AuditLogType,
  MediaFileType,
  MediaVisibility,
  SocketMessage,
  SocketRoom,
  CloudflareR2Container
} from '../../enums';
import { UPLOAD_SUBTITLE_EXT } from '../../config';

/**
 * Subtitle upload / list / delete for movies and TV episodes. Carries its own
 * resolveIoEmitter (wsAdminGateway) and deleteMediaSubtitle (cloudflareR2) helpers;
 * deleteMediaSubtitle also remains in MediaService (remove() / deleteEpisodeById),
 * reading the same injected services so behaviour is identical.
 */
@Injectable()
export class MediaSubtitlesService {
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

  async uploadMovieSubtitle(id: bigint, file: Storage.MultipartFile, headers: HeadersDto, authUser: AuthUserDto) {
    const language = await this.validateSubtitle(file);
    const media = await this.mediaModel.findOne({ _id: id, type: MediaType.MOVIE }, { 'movie.subtitles': 1 }).exec();
    if (!media)
      throw new HttpException({ code: StatusCode.MEDIA_NOT_FOUND, message: 'Media not found' }, HttpStatus.NOT_FOUND);
    if (media.movie.subtitles?.length) {
      const subtitle = media.movie.subtitles.find((s) => s.lang === language);
      if (subtitle)
        throw new HttpException(
          { code: StatusCode.SUBTITLE_EXIST, message: 'Subtitle with this language has already been added' },
          HttpStatus.BAD_REQUEST
        );
    }
    const auditLog = new AuditLogBuilder(authUser._id, media._id, Media.name, AuditLogType.MOVIE_SUBTITLE_CREATE);
    const subtitleId = await createSnowFlakeId();
    const trimmedFilename = trimSlugFilename(file.filename, undefined, UPLOAD_SUBTITLE_EXT);
    const saveFile = `${subtitleId}/${trimmedFilename}`;
    const subtitleFile = await this.cloudflareR2Service.upload(
      CloudflareR2Container.SUBTITLES,
      saveFile,
      file.filepath,
      file.detectedMimetype
    );
    const subtitle = new MediaFile();
    subtitle._id = subtitleId;
    subtitle.type = MediaFileType.SUBTITLE;
    subtitle.name = trimmedFilename;
    subtitle.size = subtitleFile.size;
    subtitle.lang = language;
    subtitle.mimeType = file.detectedMimetype;
    media.movie.subtitles.push(subtitle);
    auditLog.getChangesFrom(media, ['type']);
    try {
      await Promise.all([media.save({ timestamps: false }), this.auditLogService.createLogFromBuilder(auditLog)]);
    } catch (e) {
      await this.cloudflareR2Service.delete(CloudflareR2Container.SUBTITLES, saveFile);
      throw e;
    }
    const serializedSubtitles = instanceToPlain(plainToInstance(MediaSubtitle, media.movie.subtitles.toObject()));
    const ioEmitter = this.resolveIoEmitter(headers.socketId);
    ioEmitter.to(`${SocketRoom.ADMIN_MEDIA_DETAILS}:${media._id}`).emit(SocketMessage.REFRESH_MOVIE_SUBTITLES, {
      mediaId: media._id,
      subtitles: serializedSubtitles
    });
    return serializedSubtitles;
  }

  async findAllMovieSubtitles(id: bigint, authUser: AuthUserDto) {
    const media = await this.mediaModel
      .findOne(
        { _id: id, type: MediaType.MOVIE },
        {
          visibility: 1,
          'movie.subtitles._id': 1,
          'movie.subtitles.lang': 1
        }
      )
      .lean()
      .exec();
    if (!media)
      throw new HttpException({ code: StatusCode.MEDIA_NOT_FOUND, message: 'Media not found' }, HttpStatus.NOT_FOUND);
    if (media.visibility === MediaVisibility.PRIVATE && !authUser.hasPermission)
      throw new HttpException(
        { code: StatusCode.MEDIA_PRIVATE, message: 'This media is private' },
        HttpStatus.FORBIDDEN
      );
    if (!media.movie.subtitles) return [];
    return media.movie.subtitles;
  }

  async deleteMovieSubtitle(id: bigint, subtitleId: bigint, headers: HeadersDto, authUser: AuthUserDto) {
    const media = await this.mediaModel.findOne({ _id: id, type: MediaType.MOVIE }, { 'movie.subtitles': 1 }).exec();
    if (!media)
      throw new HttpException({ code: StatusCode.MEDIA_NOT_FOUND, message: 'Media not found' }, HttpStatus.NOT_FOUND);
    const subtitle = media.movie.subtitles.find((s) => s._id === subtitleId);
    await this.deleteMediaSubtitle(subtitle);
    media.movie.subtitles.pull({ _id: subtitleId });
    const auditLog = new AuditLogBuilder(authUser._id, media._id, Media.name, AuditLogType.MOVIE_SUBTITLE_DELETE);
    auditLog.appendChange('_id', undefined, subtitleId);
    await Promise.all([media.save({ timestamps: false }), this.auditLogService.createLogFromBuilder(auditLog)]);
    const serializedSubtitles = instanceToPlain(plainToInstance(MediaSubtitle, media.movie.subtitles.toObject()));
    const ioEmitter = this.resolveIoEmitter(headers.socketId);
    ioEmitter.to(`${SocketRoom.ADMIN_MEDIA_DETAILS}:${media._id}`).emit(SocketMessage.REFRESH_MOVIE_SUBTITLES, {
      mediaId: media._id,
      subtitles: serializedSubtitles
    });
    return serializedSubtitles;
  }

  async deleteMovieSubtitles(
    id: bigint,
    deleteMediaSubtitlesDto: DeleteMediaSubtitlesDto,
    headers: HeadersDto,
    authUser: AuthUserDto
  ) {
    const media = await this.mediaModel.findOne({ _id: id }, { 'movie.subtitles': 1 }).lean().exec();
    if (!media)
      throw new HttpException({ code: StatusCode.MEDIA_NOT_FOUND, message: 'Media not found' }, HttpStatus.NOT_FOUND);
    const deleteSubtitles = media.movie.subtitles.filter((s) => deleteMediaSubtitlesDto.ids.includes(s._id));
    const updatedMedia = await this.mediaModel
      .findOneAndUpdate(
        { _id: id },
        { $pull: { 'movie.subtitles': { _id: { $in: deleteSubtitles.map((s) => s._id) } } } },
        { new: true, timestamps: false }
      )
      .select({ 'movie.subtitles': 1 })
      .lean()
      .exec();
    const auditLog = new AuditLogBuilder(
      authUser._id,
      updatedMedia._id,
      Media.name,
      AuditLogType.MOVIE_SUBTITLE_DELETE
    );
    const deleteSubtitleLimit = pLimit(5);
    await Promise.all(
      deleteSubtitles.map((subtitle) => {
        auditLog.appendChange('_id', undefined, subtitle._id);
        return deleteSubtitleLimit(() => this.deleteMediaSubtitle(subtitle));
      })
    );
    await this.auditLogService.createLogFromBuilder(auditLog);
    const serializedSubtitles = instanceToPlain(
      plainToInstance(MediaSubtitle, updatedMedia.movie.subtitles.toObject())
    );
    const ioEmitter = this.resolveIoEmitter(headers.socketId);
    ioEmitter.to(`${SocketRoom.ADMIN_MEDIA_DETAILS}:${updatedMedia._id}`).emit(SocketMessage.REFRESH_MOVIE_SUBTITLES, {
      mediaId: updatedMedia._id,
      subtitles: serializedSubtitles
    });
    return serializedSubtitles;
  }

  async uploadTVEpisodeSubtitle(
    id: bigint,
    episodeId: bigint,
    file: Storage.MultipartFile,
    headers: HeadersDto,
    authUser: AuthUserDto
  ) {
    const language = await this.validateSubtitle(file);
    const subtitleId = await createSnowFlakeId();
    const trimmedFilename = trimSlugFilename(file.filename, undefined, UPLOAD_SUBTITLE_EXT);
    const saveFile = `${subtitleId}/${trimmedFilename}`;
    const subtitleFile = await this.cloudflareR2Service.upload(
      CloudflareR2Container.SUBTITLES,
      saveFile,
      file.filepath,
      file.mimetype
    );
    let episode: TVEpisodeDocument;
    const session = await this.mongooseConnection.startSession();
    await session
      .withTransaction(async () => {
        episode = await this.tvEpisodeModel.findOne({ _id: episodeId, media: id }, { subtitles: 1 }).exec();
        if (!episode)
          throw new HttpException(
            { code: StatusCode.EPISODE_NOT_FOUND, message: 'Episode not found' },
            HttpStatus.NOT_FOUND
          );
        if (episode.subtitles?.length) {
          const subtitle = episode.subtitles.find((s) => s.lang === language);
          if (subtitle)
            throw new HttpException(
              { code: StatusCode.SUBTITLE_EXIST, message: 'Subtitle with this language has already been added' },
              HttpStatus.BAD_REQUEST
            );
        }
        const auditLog = new AuditLogBuilder(
          authUser._id,
          episode._id,
          TVEpisode.name,
          AuditLogType.EPISODE_SUBTITLE_CREATE
        );
        const subtitle = new MediaFile();
        subtitle._id = subtitleId;
        subtitle.type = MediaFileType.SUBTITLE;
        subtitle.name = trimmedFilename;
        subtitle.size = subtitleFile.size;
        subtitle.lang = language;
        subtitle.mimeType = file.detectedMimetype;
        episode.subtitles.push(subtitle);
        auditLog.getChangesFrom(episode, ['type']);
        try {
          await Promise.all([episode.save({ session }), this.auditLogService.createLogFromBuilder(auditLog)]);
        } catch (e) {
          await this.cloudflareR2Service.delete(CloudflareR2Container.SUBTITLES, saveFile);
          throw e;
        }
      })
      .finally(() => session.endSession().catch(() => {}));
    const serializedSubtitles = instanceToPlain(plainToInstance(MediaSubtitle, episode.subtitles.toObject()));
    const ioEmitter = this.resolveIoEmitter(headers.socketId);
    ioEmitter.to(`${SocketRoom.ADMIN_EPISODE_DETAILS}:${episodeId}`).emit(SocketMessage.REFRESH_TV_SUBTITLES, {
      mediaId: id,
      episodeId: episodeId,
      subtitles: serializedSubtitles
    });
    return serializedSubtitles;
  }

  async findAllTVEpisodeSubtitles(id: bigint, episodeId: bigint, authUser: AuthUserDto) {
    const episode = await this.tvEpisodeModel
      .findOne(
        { _id: episodeId, media: <any>id },
        {
          visibility: 1,
          'subtitles._id': 1,
          'subtitles.lang': 1
        }
      )
      .lean()
      .exec();
    if (!episode)
      throw new HttpException(
        { code: StatusCode.EPISODE_NOT_FOUND, message: 'Episode not found' },
        HttpStatus.NOT_FOUND
      );
    if (episode.visibility === MediaVisibility.PRIVATE && !authUser.hasPermission)
      throw new HttpException(
        { code: StatusCode.EPISODE_PRIVATE, message: 'This episode is private' },
        HttpStatus.FORBIDDEN
      );
    if (!episode.subtitles) return [];
    return episode.subtitles;
  }

  async deleteTVEpisodeSubtitle(
    id: bigint,
    episodeId: bigint,
    subtitleId: bigint,
    headers: HeadersDto,
    authUser: AuthUserDto
  ) {
    const episode = await this.tvEpisodeModel.findOne({ _id: episodeId, media: id }, { subtitles: 1 }).exec();
    if (!episode)
      throw new HttpException(
        { code: StatusCode.EPISODE_NOT_FOUND, message: 'Episode not found' },
        HttpStatus.NOT_FOUND
      );
    const session = await this.mongooseConnection.startSession();
    await session
      .withTransaction(async () => {
        const subtitle = episode.subtitles.find((s) => s._id === subtitleId);
        await this.deleteMediaSubtitle(subtitle);
        episode.subtitles.pull({ _id: subtitleId });
        const auditLog = new AuditLogBuilder(
          authUser._id,
          episode._id,
          TVEpisode.name,
          AuditLogType.EPISODE_SUBTITLE_DELETE
        );
        auditLog.appendChange('_id', undefined, subtitleId);
        await Promise.all([episode.save({ session }), this.auditLogService.createLogFromBuilder(auditLog)]);
      })
      .finally(() => session.endSession().catch(() => {}));
    const serializedSubtitles = instanceToPlain(plainToInstance(MediaSubtitle, episode.subtitles.toObject()));
    const ioEmitter = this.resolveIoEmitter(headers.socketId);
    ioEmitter.to(`${SocketRoom.ADMIN_EPISODE_DETAILS}:${episodeId}`).emit(SocketMessage.REFRESH_TV_SUBTITLES, {
      mediaId: id,
      episodeId: episodeId,
      subtitles: serializedSubtitles
    });
    return serializedSubtitles;
  }

  async deleteTVEpisodeSubtitles(
    id: bigint,
    episodeId: bigint,
    deleteMediaSubtitlesDto: DeleteMediaSubtitlesDto,
    headers: HeadersDto,
    authUser: AuthUserDto
  ) {
    const episode = await this.tvEpisodeModel.findOne({ _id: episodeId, media: id }, { subtitles: 1 }).exec();
    if (!episode)
      throw new HttpException(
        { code: StatusCode.EPISODE_NOT_FOUND, message: 'Episode not found' },
        HttpStatus.NOT_FOUND
      );
    const deleteSubtitles = episode.subtitles.filter((s) => deleteMediaSubtitlesDto.ids.includes(s._id));
    const updatedEpisode = await this.tvEpisodeModel
      .findOneAndUpdate(
        { _id: episodeId, media: <any>id },
        { $pull: { subtitles: { _id: { $in: deleteSubtitles.map((s) => s._id) } } } },
        { new: true }
      )
      .select({ subtitles: 1 })
      .lean()
      .exec();
    const auditLog = new AuditLogBuilder(
      authUser._id,
      updatedEpisode._id,
      Media.name,
      AuditLogType.EPISODE_SUBTITLE_DELETE
    );
    const deleteSubtitleLimit = pLimit(5);
    await Promise.all(
      deleteSubtitles.map((subtitle) => {
        auditLog.appendChange('_id', undefined, subtitle._id);
        return deleteSubtitleLimit(() => this.deleteMediaSubtitle(subtitle));
      })
    );
    await this.auditLogService.createLogFromBuilder(auditLog);
    const serializedSubtitles = instanceToPlain(plainToInstance(MediaSubtitle, episode.subtitles.toObject()));
    const ioEmitter = this.resolveIoEmitter(headers.socketId);
    ioEmitter.to(`${SocketRoom.ADMIN_MEDIA_DETAILS}:${updatedEpisode._id}`).emit(SocketMessage.REFRESH_TV_SUBTITLES, {
      mediaId: updatedEpisode._id,
      episodeId: episodeId,
      subtitles: serializedSubtitles
    });
    return serializedSubtitles;
  }

  private async validateSubtitle(file: Storage.MultipartFile) {
    if (!file.fields.language)
      throw new HttpException(
        { code: StatusCode.IS_NOT_EMPTY, message: 'Language is required' },
        HttpStatus.BAD_REQUEST
      );
    const language = file.fields.language['value'];
    if (!ISO6391.validate(language))
      throw new HttpException(
        { code: StatusCode.IS_ISO6391, message: 'Language must be an ISO6391 code' },
        HttpStatus.BAD_REQUEST
      );
    const allowedExtensions = [
      '.vtt',
      '.srt',
      '.ass',
      '.vtt.gz',
      '.srt.gz',
      '.ass.gz',
      '.vtt.br',
      '.srt.br',
      '.ass.br'
    ];
    if (allowedExtensions.every((ext) => !file.filename.endsWith(ext))) {
      throw new HttpException(
        { code: StatusCode.INVALID_SUBTITLE, message: 'Subtitle is invalid' },
        HttpStatus.BAD_REQUEST
      );
    }
    //const firstLine = await readFirstLine(file.filepath);
    //if (!firstLine.includes('WEBVTT'))
    //  throw new HttpException({ code: StatusCode.INVALID_SUBTITLE, message: 'Subtitle is invalid' }, HttpStatus.BAD_REQUEST);
    return language;
  }

  private async deleteMediaSubtitle(subtitle: MediaFile) {
    if (!subtitle) return;
    await this.cloudflareR2Service.delete(CloudflareR2Container.SUBTITLES, `${subtitle._id}/${subtitle.name}`);
  }
}
