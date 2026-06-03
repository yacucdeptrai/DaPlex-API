import { forwardRef, HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';

import { AddMediaChapterDto, UpdateMediaChapterDto, DeleteMediaChaptersDto } from './dto';
import { AuthUserDto } from '../users/dto/auth-user.dto';
import { Media, MediaDocument, TVEpisode, TVEpisodeDocument, MediaChapter, ChapterType } from '../../schemas';
import { AuditLogService } from '../audit-log/audit-log.service';
import { ChapterTypeService } from '../chapter-type/chapter-type.service';
import { WsAdminGateway } from '../ws-admin';
import { HeadersDto } from '../../common/dto';
import { convertToLanguage, createSnowFlakeId, AuditLogBuilder } from '../../utils';
import {
  MediaType,
  StatusCode,
  MongooseConnection,
  AuditLogType,
  MediaVisibility,
  SocketMessage,
  SocketRoom
} from '../../enums';

/**
 * Movie and TV-episode chapter add / list / update / delete. Carries its own
 * resolveIoEmitter (wsAdminGateway) plus the addMediaChapter / validateChapterType
 * helpers, reading the same injected services as MediaService so behaviour is
 * identical. deleteChapterMedia stays in MediaService (called by ChapterTypeService).
 */
@Injectable()
export class MediaChaptersService {
  constructor(
    @InjectModel(Media.name, MongooseConnection.DATABASE_A) private mediaModel: Model<MediaDocument>,
    @InjectModel(TVEpisode.name, MongooseConnection.DATABASE_A) private tvEpisodeModel: Model<TVEpisodeDocument>,
    @InjectConnection(MongooseConnection.DATABASE_A) private mongooseConnection: Connection,
    @Inject(forwardRef(() => ChapterTypeService)) private chapterTypeService: ChapterTypeService,
    private auditLogService: AuditLogService,
    private wsAdminGateway: WsAdminGateway
  ) {}

  private resolveIoEmitter(socketId?: string) {
    return (socketId && this.wsAdminGateway.server.sockets.get(socketId)) || this.wsAdminGateway.server;
  }

  async addMovieChapter(
    id: bigint,
    addMediaChapterDto: AddMediaChapterDto,
    headers: HeadersDto,
    authUser: AuthUserDto
  ) {
    let media: MediaDocument;
    let chapter: MediaChapter;
    const session = await this.mongooseConnection.startSession();
    await session
      .withTransaction(async () => {
        media = await this.mediaModel.findOne({ _id: id, type: MediaType.MOVIE }, { _id: 1, movie: 1 }, { session });
        if (!media)
          throw new HttpException(
            { code: StatusCode.MEDIA_NOT_FOUND, message: 'Media not found' },
            HttpStatus.NOT_FOUND
          );
        const auditLog = new AuditLogBuilder(authUser._id, media._id, Media.name, AuditLogType.MOVIE_CHAPTER_CREATE);
        chapter = await this.addMediaChapter(media.movie.chapters, addMediaChapterDto);
        media.movie.chapters.push(chapter);
        auditLog.getChangesFrom(media);
        await media.save({ session, timestamps: false });
        await Promise.all([
          this.chapterTypeService.addMovieChapterType(id, <bigint>(<unknown>chapter.type), session),
          this.auditLogService.createLogFromBuilder(auditLog)
        ]);
      })
      .finally(() => session.endSession().catch(() => {}));
    const chapterType = await this.chapterTypeService.findById(addMediaChapterDto.type);
    const populatedChapter: MediaChapter = { ...chapter, type: chapterType };
    const ioEmitter = this.resolveIoEmitter(headers.socketId);
    ioEmitter.to(`${SocketRoom.ADMIN_MEDIA_DETAILS}:${media._id}`).emit(SocketMessage.REFRESH_MOVIE_CHAPTERS, {
      mediaId: media._id,
      chapter: populatedChapter
    });
    const translated = { ...populatedChapter, type: { ...populatedChapter.type } };
    translated.type = convertToLanguage<ChapterType>(headers.acceptLanguage, translated.type, {
      keepTranslationsObject: authUser.hasPermission
    });
    return translated;
  }

  async findAllMovieChapters(id: bigint, headers: HeadersDto, authUser: AuthUserDto) {
    const media = await this.mediaModel
      .findOne({ _id: id, type: MediaType.MOVIE }, { _id: 1, movie: 1, visibility: 1 })
      .populate({ path: 'movie.chapters.type', select: { _id: 1, name: 1, _translations: 1 } })
      .lean()
      .exec();
    if (!media)
      throw new HttpException({ code: StatusCode.MEDIA_NOT_FOUND, message: 'Media not found' }, HttpStatus.NOT_FOUND);
    if (media.visibility === MediaVisibility.PRIVATE && !authUser.hasPermission)
      throw new HttpException(
        { code: StatusCode.MEDIA_PRIVATE, message: 'This media is private' },
        HttpStatus.FORBIDDEN
      );
    const chapters = media.movie.chapters.map((chapter) => {
      chapter = convertToLanguage<MediaChapter>(headers.acceptLanguage, chapter, {
        keepTranslationsObject: authUser.hasPermission
      });
      chapter.type = convertToLanguage<ChapterType>(headers.acceptLanguage, chapter.type, {
        keepTranslationsObject: authUser.hasPermission
      });
      return chapter;
    });
    return chapters;
  }

  async updateMovieChapter(
    id: bigint,
    chapterId: bigint,
    updateMediaChapterDto: UpdateMediaChapterDto,
    headers: HeadersDto,
    authUser: AuthUserDto
  ) {
    const media = await this.mediaModel.findOne({ _id: id, type: MediaType.MOVIE }, { _id: 1, movie: 1 }).exec();
    if (!media)
      throw new HttpException({ code: StatusCode.MEDIA_NOT_FOUND, message: 'Media not found' }, HttpStatus.NOT_FOUND);
    const chapterIndex = media.movie.chapters.findIndex((c) => c._id === chapterId);
    if (chapterIndex === -1)
      throw new HttpException(
        { code: StatusCode.CHAPTER_NOT_FOUND, message: 'Chapter not found' },
        HttpStatus.NOT_FOUND
      );
    const targetChapter = media.movie.chapters[chapterIndex];
    const session = await this.mongooseConnection.startSession();
    await session
      .withTransaction(async () => {
        const auditLog = new AuditLogBuilder(authUser._id, media._id, Media.name, AuditLogType.MOVIE_CHAPTER_UPDATE);
        if (updateMediaChapterDto.type != undefined) {
          await this.validateChapterType(updateMediaChapterDto.type);
          await this.chapterTypeService.updateMovieChapterType(
            id,
            <bigint>(<unknown>targetChapter.type),
            updateMediaChapterDto.type,
            session
          );
          targetChapter.type = <any>updateMediaChapterDto.type;
        }
        if (updateMediaChapterDto.start != undefined) {
          targetChapter.start = updateMediaChapterDto.start;
        }
        if (updateMediaChapterDto.length != undefined) {
          targetChapter.length = updateMediaChapterDto.length;
        }
        auditLog.getChangesFrom(media);
        await Promise.all([
          media.save({ session, timestamps: false }),
          this.auditLogService.createLogFromBuilder(auditLog)
        ]);
      })
      .finally(() => session.endSession().catch(() => {}));
    const chapterType = await this.chapterTypeService.findById(<bigint>(<unknown>targetChapter.type));
    const populatedChapter: MediaChapter = { ...targetChapter, type: chapterType };
    const ioEmitter = this.resolveIoEmitter(headers.socketId);
    ioEmitter.to(`${SocketRoom.ADMIN_MEDIA_DETAILS}:${media._id}`).emit(SocketMessage.REFRESH_MOVIE_CHAPTERS, {
      mediaId: media._id,
      chapter: populatedChapter
    });
    const translated = { ...populatedChapter, type: { ...populatedChapter.type } };
    translated.type = convertToLanguage<ChapterType>(headers.acceptLanguage, translated.type, {
      keepTranslationsObject: authUser.hasPermission
    });
    return translated;
  }

  async deleteMovieChapter(id: bigint, chapterId: bigint, headers: HeadersDto, authUser: AuthUserDto) {
    const media = await this.mediaModel.findOne({ _id: id, type: MediaType.MOVIE }, { _id: 1, movie: 1 }).exec();
    if (!media)
      throw new HttpException({ code: StatusCode.MEDIA_NOT_FOUND, message: 'Media not found' }, HttpStatus.NOT_FOUND);
    const session = await this.mongooseConnection.startSession();
    await session
      .withTransaction(async () => {
        const chapter = media.movie.chapters.find((c) => c._id === chapterId);
        if (!chapter)
          throw new HttpException(
            { code: StatusCode.CHAPTER_NOT_FOUND, message: 'Chapter not found' },
            HttpStatus.NOT_FOUND
          );
        await media.updateOne({ $pull: { 'movie.chapters': { _id: chapterId } } }, { session, timestamps: false });
        await Promise.all([
          this.chapterTypeService.deleteMovieChapterType(id, <bigint>(<unknown>chapter.type), session),
          this.auditLogService.createLog(authUser._id, media._id, Media.name, AuditLogType.MOVIE_CHAPTER_DELETE)
        ]);
      })
      .finally(() => session.endSession().catch(() => {}));
    const ioEmitter = this.resolveIoEmitter(headers.socketId);
    ioEmitter.to(`${SocketRoom.ADMIN_MEDIA_DETAILS}:${media._id}`).emit(SocketMessage.REFRESH_MOVIE_CHAPTERS, {
      mediaId: media._id,
      chapterId: chapterId,
      deleted: true
    });
  }

  async deleteMovieChapters(
    id: bigint,
    deleteMediaChaptersDto: DeleteMediaChaptersDto,
    headers: HeadersDto,
    authUser: AuthUserDto
  ) {
    const media = await this.mediaModel.findOne({ _id: id }, { 'movie.chapters': 1 }).lean().exec();
    if (!media)
      throw new HttpException({ code: StatusCode.MEDIA_NOT_FOUND, message: 'Media not found' }, HttpStatus.NOT_FOUND);
    const deleteChapters = media.movie.chapters.filter((v) => deleteMediaChaptersDto.ids.includes(v._id));
    const deleteChapterIds = deleteChapters.map((v) => v._id);
    const deleteChapterTypes = deleteChapters.map((v) => <bigint>(<unknown>v.type));
    const session = await this.mongooseConnection.startSession();
    await session
      .withTransaction(async () => {
        const updatedMedia = await this.mediaModel
          .findOneAndUpdate(
            { _id: id },
            { $pull: { 'movie.chapters': { _id: { $in: deleteChapterIds } } } },
            { new: true, session, timestamps: false }
          )
          .lean();
        const auditLog = new AuditLogBuilder(
          authUser._id,
          updatedMedia._id,
          Media.name,
          AuditLogType.MOVIE_CHAPTER_DELETE
        );
        deleteChapterIds.forEach((id) => {
          auditLog.appendChange('_id', undefined, id);
        });
        await Promise.all([
          this.chapterTypeService.deleteMovieChapterTypes(id, deleteChapterTypes, session),
          this.auditLogService.createLogFromBuilder(auditLog)
        ]);
      })
      .finally(() => session.endSession().catch(() => {}));
    const ioEmitter = this.resolveIoEmitter(headers.socketId);
    ioEmitter.to(`${SocketRoom.ADMIN_MEDIA_DETAILS}:${id}`).emit(SocketMessage.REFRESH_MOVIE_CHAPTERS, {
      mediaId: id,
      chapterIds: deleteChapterIds,
      deleted: true
    });
  }

  async addTVEpisodeChapter(
    id: bigint,
    episodeId: bigint,
    addMediaChapterDto: AddMediaChapterDto,
    headers: HeadersDto,
    authUser: AuthUserDto
  ) {
    let episode: TVEpisodeDocument;
    let chapter: MediaChapter;
    const session = await this.mongooseConnection.startSession();
    await session
      .withTransaction(async () => {
        episode = await this.tvEpisodeModel.findOne(
          { _id: episodeId, media: id },
          { _id: 1, chapters: 1 },
          { session }
        );
        if (!episode)
          throw new HttpException(
            { code: StatusCode.EPISODE_NOT_FOUND, message: 'Episode not found' },
            HttpStatus.NOT_FOUND
          );
        const auditLog = new AuditLogBuilder(
          authUser._id,
          episode._id,
          TVEpisode.name,
          AuditLogType.EPISODE_CHAPTER_CREATE
        );
        chapter = await this.addMediaChapter(episode.chapters, addMediaChapterDto);
        episode.chapters.push(chapter);
        auditLog.getChangesFrom(episode);
        await episode.save({ session });
        await Promise.all([
          this.chapterTypeService.addTVEpisodeChapterType(episodeId, <bigint>(<unknown>chapter.type), session),
          this.auditLogService.createLogFromBuilder(auditLog)
        ]);
      })
      .finally(() => session.endSession().catch(() => {}));
    const chapterType = await this.chapterTypeService.findById(addMediaChapterDto.type);
    const populatedChapter: MediaChapter = { ...chapter, type: chapterType };
    const ioEmitter = this.resolveIoEmitter(headers.socketId);
    ioEmitter.to(`${SocketRoom.ADMIN_EPISODE_DETAILS}:${episode._id}`).emit(SocketMessage.REFRESH_TV_CHAPTERS, {
      mediaId: episode.media,
      episodeId: episode._id,
      chapter: populatedChapter
    });
    const translated = { ...populatedChapter, type: { ...populatedChapter.type } };
    translated.type = convertToLanguage<ChapterType>(headers.acceptLanguage, translated.type, {
      keepTranslationsObject: authUser.hasPermission
    });
    return translated;
  }

  async findAllTVEpisodeChapters(id: bigint, episodeId: bigint, headers: HeadersDto, authUser: AuthUserDto) {
    const episode = await this.tvEpisodeModel
      .findOne({ _id: episodeId, media: id }, { _id: 1, visibility: 1, chapters: 1 })
      .populate({ path: 'chapters.type', select: { _id: 1, name: 1, _translations: 1 } })
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
    const chapters = episode.chapters.map((chapter) => {
      chapter = convertToLanguage<MediaChapter>(headers.acceptLanguage, chapter, {
        keepTranslationsObject: authUser.hasPermission
      });
      chapter.type = convertToLanguage<ChapterType>(headers.acceptLanguage, chapter.type, {
        keepTranslationsObject: authUser.hasPermission
      });
      return chapter;
    });
    return chapters;
  }

  async updateTVEpisodeChapter(
    id: bigint,
    episodeId: bigint,
    chapterId: bigint,
    updateMediaChapterDto: UpdateMediaChapterDto,
    headers: HeadersDto,
    authUser: AuthUserDto
  ) {
    const episode = await this.tvEpisodeModel.findOne({ _id: episodeId, media: id }, { _id: 1, chapters: 1 }).exec();
    if (!episode)
      throw new HttpException(
        { code: StatusCode.EPISODE_NOT_FOUND, message: 'Episode not found' },
        HttpStatus.NOT_FOUND
      );
    const chapterIndex = episode.chapters.findIndex((c) => c._id === chapterId);
    if (chapterIndex === -1)
      throw new HttpException(
        { code: StatusCode.CHAPTER_NOT_FOUND, message: 'Chapter not found' },
        HttpStatus.NOT_FOUND
      );
    const targetChapter = episode.chapters[chapterIndex];
    const session = await this.mongooseConnection.startSession();
    await session
      .withTransaction(async () => {
        const auditLog = new AuditLogBuilder(
          authUser._id,
          episode._id,
          TVEpisode.name,
          AuditLogType.EPISODE_CHAPTER_UPDATE
        );
        if (updateMediaChapterDto.type != undefined) {
          await this.validateChapterType(updateMediaChapterDto.type);
          await this.chapterTypeService.updateTVEpisodeChapterType(
            episodeId,
            <bigint>(<unknown>targetChapter.type),
            updateMediaChapterDto.type,
            session
          );
          targetChapter.type = <any>updateMediaChapterDto.type;
        }
        if (updateMediaChapterDto.start != undefined) {
          targetChapter.start = updateMediaChapterDto.start;
        }
        if (updateMediaChapterDto.length != undefined) {
          targetChapter.length = updateMediaChapterDto.length;
        }
        auditLog.getChangesFrom(episode);
        await Promise.all([episode.save({ session }), this.auditLogService.createLogFromBuilder(auditLog)]);
      })
      .finally(() => session.endSession().catch(() => {}));
    const chapterType = await this.chapterTypeService.findById(<bigint>(<unknown>targetChapter.type));
    const populatedChapter: MediaChapter = { ...targetChapter, type: chapterType };
    const ioEmitter = this.resolveIoEmitter(headers.socketId);
    ioEmitter.to(`${SocketRoom.ADMIN_EPISODE_DETAILS}:${episode._id}`).emit(SocketMessage.REFRESH_TV_CHAPTERS, {
      mediaId: episode.media,
      episodeId: episode._id,
      chapter: populatedChapter
    });
    const translated = { ...populatedChapter, type: { ...populatedChapter.type } };
    translated.type = convertToLanguage<ChapterType>(headers.acceptLanguage, translated.type, {
      keepTranslationsObject: authUser.hasPermission
    });
    return translated;
  }

  async deleteTVEpisodeChapter(
    id: bigint,
    episodeId: bigint,
    chapterId: bigint,
    headers: HeadersDto,
    authUser: AuthUserDto
  ) {
    const episode = await this.tvEpisodeModel
      .findOne({ _id: episodeId, media: id }, { _id: 1, media: 1, chapters: 1 })
      .exec();
    if (!episode)
      throw new HttpException(
        { code: StatusCode.EPISODE_NOT_FOUND, message: 'Episode not found' },
        HttpStatus.NOT_FOUND
      );
    const session = await this.mongooseConnection.startSession();
    await session
      .withTransaction(async () => {
        const chapter = episode.chapters.find((c) => c._id === chapterId);
        if (!chapter)
          throw new HttpException(
            { code: StatusCode.CHAPTER_NOT_FOUND, message: 'Chapter not found' },
            HttpStatus.NOT_FOUND
          );
        await episode.updateOne({ $pull: { chapters: { _id: chapterId } } }, { session });
        await Promise.all([
          this.chapterTypeService.deleteTVEpisodeChapterType(episodeId, <bigint>(<unknown>chapter.type), session),
          this.auditLogService.createLog(authUser._id, episode._id, TVEpisode.name, AuditLogType.EPISODE_CHAPTER_DELETE)
        ]);
      })
      .finally(() => session.endSession().catch(() => {}));
    const ioEmitter = this.resolveIoEmitter(headers.socketId);
    ioEmitter.to(`${SocketRoom.ADMIN_EPISODE_DETAILS}:${episode._id}`).emit(SocketMessage.REFRESH_TV_CHAPTERS, {
      mediaId: episode.media,
      episodeId: episode._id,
      chapterId: chapterId,
      deleted: true
    });
  }

  async deleteTVEpisodeChapters(
    id: bigint,
    episodeId: bigint,
    deleteMediaChaptersDto: DeleteMediaChaptersDto,
    headers: HeadersDto,
    authUser: AuthUserDto
  ) {
    const episode = await this.tvEpisodeModel.findOne({ _id: episodeId, media: id }, { chapters: 1 }).lean().exec();
    if (!episode)
      throw new HttpException(
        { code: StatusCode.EPISODE_NOT_FOUND, message: 'Episode not found' },
        HttpStatus.NOT_FOUND
      );
    const deleteChapters = episode.chapters.filter((v) => deleteMediaChaptersDto.ids.includes(v._id));
    const deleteChapterIds = deleteChapters.map((v) => v._id);
    const deleteChapterTypes = deleteChapters.map((v) => <bigint>(<unknown>v.type));
    const session = await this.mongooseConnection.startSession();
    await session
      .withTransaction(async () => {
        const updatedEpisode = await this.tvEpisodeModel
          .findOneAndUpdate(
            { _id: episodeId, media: <any>id },
            { $pull: { chapters: { _id: { $in: deleteChapterIds } } } },
            { new: true, session }
          )
          .lean();
        const auditLog = new AuditLogBuilder(
          authUser._id,
          updatedEpisode._id,
          Media.name,
          AuditLogType.EPISODE_CHAPTER_DELETE
        );
        deleteChapterIds.forEach((id) => {
          auditLog.appendChange('_id', undefined, id);
        });
        await Promise.all([
          this.chapterTypeService.deleteTVEpisodeChapterTypes(episodeId, deleteChapterTypes, session),
          this.auditLogService.createLogFromBuilder(auditLog)
        ]);
      })
      .finally(() => session.endSession().catch(() => {}));
    const ioEmitter = this.resolveIoEmitter(headers.socketId);
    ioEmitter.to(`${SocketRoom.ADMIN_MEDIA_DETAILS}:${id}`).emit(SocketMessage.REFRESH_TV_CHAPTERS, {
      mediaId: id,
      episodeId: episodeId,
      chapterIds: deleteChapterIds,
      deleted: true
    });
  }

  private async addMediaChapter(chapters: Types.Array<MediaChapter>, addMediaChapterDto: AddMediaChapterDto) {
    const checkChapter = chapters.find(
      (c) => c.start === addMediaChapterDto.start && c.length === addMediaChapterDto.length
    );
    if (checkChapter)
      throw new HttpException(
        { code: StatusCode.CHAPTER_TIME_DUPLICATED, message: 'Duplicated start and end time' },
        HttpStatus.CONFLICT
      );
    await this.validateChapterType(addMediaChapterDto.type);
    const chapter = new MediaChapter();
    chapter._id = await createSnowFlakeId();
    chapter.type = <any>addMediaChapterDto.type;
    chapter.start = addMediaChapterDto.start;
    chapter.length = addMediaChapterDto.length;
    addMediaChapterDto.name && (chapter.name = addMediaChapterDto.name);
    return chapter;
  }

  private async validateChapterType(type: bigint) {
    const chapterType = await this.chapterTypeService.findById(type);
    if (!chapterType)
      throw new HttpException(
        { code: StatusCode.CHAPTER_TYPE_NOT_FOUND, message: 'Chapter type not found' },
        HttpStatus.NOT_FOUND
      );
    return chapterType;
  }
}
