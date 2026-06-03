import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, PopulateOptions } from 'mongoose';
import { plainToInstance } from 'class-transformer';

import { FindTVEpisodesDto, AddTVEpisodeDto } from './dto';
import { AuthUserDto } from '../users/dto/auth-user.dto';
import { Media, MediaDocument, TVEpisode, TVEpisodeDocument } from '../../schemas';
import { AuditLogService } from '../audit-log/audit-log.service';
import { WsAdminGateway } from '../ws-admin';
import { HeadersDto } from '../../common/dto';
import { TVEpisode as TVEpisodeEntity, TVEpisodeDetails } from './entities';
import { convertToLanguage, convertToLanguageArray, createSnowFlakeId, AuditLogBuilder } from '../../utils';
import {
  MediaType,
  StatusCode,
  MongooseConnection,
  MediaPStatus,
  MediaSourceStatus,
  AuditLogType,
  MediaVisibility,
  SocketMessage,
  SocketRoom
} from '../../enums';

/**
 * TV-episode add and read (addTVEpisode/findAllTVEpisodes/findOneTVEpisode) for
 * media. The update/delete episode methods and the deleteEpisodeById cascade
 * stay in MediaService (the cascade is shared by the media-delete path). Carries
 * its own resolveIoEmitter (wsAdminGateway) helper, reading the same injected
 * gateway as MediaService so behaviour is identical.
 */
@Injectable()
export class MediaTVEpisodesService {
  constructor(
    @InjectModel(Media.name, MongooseConnection.DATABASE_A) private mediaModel: Model<MediaDocument>,
    @InjectModel(TVEpisode.name, MongooseConnection.DATABASE_A) private tvEpisodeModel: Model<TVEpisodeDocument>,
    @InjectConnection(MongooseConnection.DATABASE_A) private mongooseConnection: Connection,
    private auditLogService: AuditLogService,
    private wsAdminGateway: WsAdminGateway
  ) {}

  private resolveIoEmitter(socketId?: string) {
    return (socketId && this.wsAdminGateway.server.sockets.get(socketId)) || this.wsAdminGateway.server;
  }

  async addTVEpisode(id: bigint, addTVEpisodeDto: AddTVEpisodeDto, headers: HeadersDto, authUser: AuthUserDto) {
    const { epNumber, name, overview, runtime, airDate, visibility } = addTVEpisodeDto;
    const episodeExist = await this.tvEpisodeModel.findOne({ media: id, epNumber: epNumber }).lean().exec();
    if (episodeExist)
      throw new HttpException(
        { code: StatusCode.EPISODE_NUMBER_EXIST, message: 'Episode number has already been used' },
        HttpStatus.BAD_REQUEST
      );
    let media: MediaDocument;
    let episode: TVEpisodeDocument;
    const session = await this.mongooseConnection.startSession();
    await session
      .withTransaction(async () => {
        media = await this.mediaModel.findOne({ _id: id, type: MediaType.TV }, { _id: 1, tv: 1 }, { session });
        if (!media)
          throw new HttpException(
            { code: StatusCode.MEDIA_NOT_FOUND, message: 'Media not found' },
            HttpStatus.NOT_FOUND
          );
        episode = new this.tvEpisodeModel();
        episode._id = await createSnowFlakeId();
        episode.epNumber = epNumber;
        name && (episode.name = name);
        overview && (episode.overview = overview);
        episode.runtime = runtime;
        episode.airDate = airDate;
        episode.visibility = visibility;
        episode.media = media._id;
        episode.status = MediaSourceStatus.PENDING;
        episode.pStatus = MediaPStatus.PENDING;
        const auditLog = new AuditLogBuilder(authUser._id, episode._id, TVEpisode.name, AuditLogType.EPISODE_CREATE);
        media.tv.episodes.push(episode._id);
        media.tv.episodeCount = media.tv.episodes.length;
        media.tv.lastAirDate = airDate;
        auditLog.getChangesFrom(episode, ['media', 'status', 'pStatus']);
        await episode.save({ session });
        // Populate episodes and sort by episode number
        await media.populate('tv.episodes', { epNumber: 1 });
        const sortedEpisodes = media.tv.episodes.sort((curEp, nextEp) => curEp.epNumber - nextEp.epNumber);
        media.depopulate('tv.episodes');
        media.tv.episodes = <any>sortedEpisodes.map((e) => e._id);
        // Save media
        await Promise.all([
          media.updateOne(media.getChanges(), { session, timestamps: false }),
          this.auditLogService.createLogFromBuilder(auditLog)
        ]);
      })
      .finally(() => session.endSession().catch(() => {}));
    const ioEmitter = this.resolveIoEmitter(headers.socketId);
    ioEmitter
      .to([SocketRoom.ADMIN_MEDIA_LIST, `${SocketRoom.ADMIN_MEDIA_DETAILS}:${media._id}`])
      .emit(SocketMessage.REFRESH_MEDIA, {
        mediaId: media._id
      });
    return plainToInstance(TVEpisodeEntity, episode.toObject());
  }

  async findAllTVEpisodes(id: bigint, findEpisodesDto: FindTVEpisodesDto, headers: HeadersDto, authUser: AuthUserDto) {
    const population: PopulateOptions = {
      path: 'tv.episodes',
      select: {
        _id: 1,
        epNumber: 1,
        name: 1,
        overview: 1,
        runtime: 1,
        airDate: 1,
        still: 1,
        views: 1,
        status: 1,
        visibility: 1,
        _translations: 1,
        createdAt: 1,
        updatedAt: 1
      },
      match: {}
    };
    authUser.hasPermission && (population.select.pStatus = 1);
    const { includeHidden, includeUnprocessed } = findEpisodesDto;
    (!authUser.hasPermission || !includeHidden) && (population.match.visibility = MediaVisibility.PUBLIC);
    (!authUser.hasPermission || !includeUnprocessed) && (population.match.pStatus = MediaPStatus.DONE);
    // If the object is empty make it undefined
    !Object.keys(population.match).length && (population.match = undefined);
    const media = await this.mediaModel
      .findOne({ _id: id, type: MediaType.TV }, { tv: 1 })
      .populate(population)
      .lean()
      .exec();
    if (!media)
      throw new HttpException({ code: StatusCode.MEDIA_NOT_FOUND, message: 'Media not found' }, HttpStatus.NOT_FOUND);
    if (media.visibility === MediaVisibility.PRIVATE && !authUser.hasPermission)
      throw new HttpException(
        { code: StatusCode.MEDIA_PRIVATE, message: 'This media is private' },
        HttpStatus.FORBIDDEN
      );
    const translated = convertToLanguageArray<TVEpisode>(headers.acceptLanguage, media.tv.episodes, {
      keepTranslationsObject: authUser.hasPermission
    });
    return plainToInstance(TVEpisodeEntity, translated);
  }

  async findOneTVEpisode(id: bigint, episodeId: bigint, headers: HeadersDto, authUser: AuthUserDto) {
    const project: { [key: string]: number } = {
      _id: 1,
      epNumber: 1,
      name: 1,
      overview: 1,
      runtime: 1,
      airDate: 1,
      still: 1,
      views: 1,
      chapters: 1,
      visibility: 1,
      _translations: 1,
      createdAt: 1,
      updatedAt: 1
    };
    const match: { [key: string]: any } = { _id: episodeId, media: id };
    if (authUser.hasPermission) {
      project.status = 1;
      project.subtitles = 1;
      project.chapters = 1;
    } else {
      match.pStatus = MediaPStatus.DONE;
    }
    const episode = await this.tvEpisodeModel.findOne(match, project).lean().exec();
    if (!episode)
      throw new HttpException({ code: StatusCode.MEDIA_NOT_FOUND, message: 'Media not found' }, HttpStatus.NOT_FOUND);
    if (episode.visibility === MediaVisibility.PRIVATE && !authUser.hasPermission)
      throw new HttpException(
        { code: StatusCode.EPISODE_PRIVATE, message: 'This episode is private' },
        HttpStatus.FORBIDDEN
      );
    const translated = convertToLanguage<TVEpisode>(headers.acceptLanguage, episode, {
      keepTranslationsObject: authUser.hasPermission
    });
    return plainToInstance(TVEpisodeDetails, translated);
  }
}
