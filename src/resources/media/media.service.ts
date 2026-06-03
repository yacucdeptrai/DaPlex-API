import { forwardRef, HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import {
  ClientSession,
  Connection,
  FilterQuery,
  FlattenMaps,
  Model,
  PopulateOptions,
  ProjectionType,
  Types,
  UpdateQuery
} from 'mongoose';
import { Cron } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { instanceToPlain, plainToInstance, plainToClassFromExist } from 'class-transformer';
import slugify from 'slugify';
import removeAccents from 'remove-accents';
import mimeTypes from 'mime-types';
import isISO31661Alpha2 from 'validator/lib/isISO31661Alpha2';
import pLimit from 'p-limit';
import path from 'path';

import {
  CreateMediaDto,
  UpdateMediaDto,
  AddMediaSourceDto,
  SaveMediaSourceDto,
  UpdateTVEpisodeDto,
  FindMediaDto,
  OffsetPageMediaDto,
  CursorPageMediaDto,
  MediaQueueDataDto,
  MediaQueueResultDto,
  EncodeMediaSourceDto,
  MediaQueueAdvancedDto,
  AddLinkedMediaSourceDto,
  FindMediaStreamsDto
} from './dto';
import { AuthUserDto } from '../users/dto/auth-user.dto';
import {
  Media,
  MediaDocument,
  MediaStorage,
  MediaStorageDocument,
  MediaFile,
  DriveSession,
  DriveSessionDocument,
  Movie,
  TVShow,
  TVEpisode,
  TVEpisodeDocument,
  Setting,
  EncodingSetting,
  MediaSourceOptions,
  MediaStorageStream,
  ExternalStorage
} from '../../schemas';
import { AuditLogService } from '../audit-log/audit-log.service';
import { GenresService } from '../genres/genres.service';
import { ProductionsService } from '../productions/productions.service';
import { TagsService } from '../tags/tags.service';
import { ChapterTypeService } from '../chapter-type/chapter-type.service';
import { CollectionService } from '../collection/collection.service';
import { HistoryService } from '../history/history.service';
import { PlaylistsService } from '../playlists/playlists.service';
import { RatingsService } from '../ratings/ratings.service';
import { SettingsService } from '../settings/settings.service';
import { CloudflareR2Service } from '../../common/modules/cloudflare-r2';
import { OnedriveService } from '../../common/modules/onedrive/onedrive.service';
import { FilerService } from '../../common/modules/filer/filer.service';
import { S3Service } from '../../common/modules/s3/s3.service';
import { LocalCacheService } from '../../common/modules/local-cache/local-cache.service';
import { RedisPubSubService } from '../../common/modules/redis-pubsub';
import { ExternalStoragesService } from '../external-storages/external-storages.service';
import { WsAdminGateway } from '../ws-admin';
import { HeadersDto } from '../../common/dto';
import { CursorPaginated, Paginated } from '../../common/entities';
import { Media as MediaEntity, MediaDetails, MediaStream, TVEpisode as TVEpisodeEntity } from './entities';
import {
  LookupOptions,
  MongooseOffsetPagination,
  convertToLanguage,
  convertToLanguageArray,
  createSnowFlakeId,
  trimSlugFilename,
  AuditLogBuilder,
  MongooseCursorPagination,
  slugMediaTitle,
  arrayEqualShallow
} from '../../utils';
import {
  MediaType,
  StatusCode,
  MongooseConnection,
  TaskQueue,
  MediaStorageType,
  MediaPStatus,
  MediaSourceStatus,
  AuditLogType,
  MediaVisibility,
  SocketMessage,
  SocketRoom,
  VideoCodec,
  CachePrefix,
  CloudflareR2Container,
  CloudStorage
} from '../../enums';
import { I18N_DEFAULT_LANGUAGE, STREAM_CODECS } from '../../config';

// Minimal shape of the file metadata returned by storage providers (Filer/S3/OneDrive)
// findId/findPath calls; only name and size are consumed here.
interface StorageFileInfo {
  name: string;
  size: number;
}

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    @InjectModel(Media.name, MongooseConnection.DATABASE_A) private mediaModel: Model<MediaDocument>,
    @InjectModel(MediaStorage.name, MongooseConnection.DATABASE_A)
    private mediaStorageModel: Model<MediaStorageDocument>,
    @InjectModel(DriveSession.name, MongooseConnection.DATABASE_A)
    private driveSessionModel: Model<DriveSessionDocument>,
    @InjectModel(TVEpisode.name, MongooseConnection.DATABASE_A) private tvEpisodeModel: Model<TVEpisodeDocument>,
    @InjectConnection(MongooseConnection.DATABASE_A) private mongooseConnection: Connection,
    @InjectQueue(`${TaskQueue.VIDEO_TRANSCODE}:${VideoCodec.H264}`) private videoTranscodeH264Queue: Queue,
    @InjectQueue(`${TaskQueue.VIDEO_TRANSCODE}:${VideoCodec.H265}`) private videoTranscodeH265Queue: Queue,
    @InjectQueue(`${TaskQueue.VIDEO_TRANSCODE}:${VideoCodec.VP9}`) private videoTranscodeVP9Queue: Queue,
    @InjectQueue(`${TaskQueue.VIDEO_TRANSCODE}:${VideoCodec.AV1}`) private videoTranscodeAV1Queue: Queue,
    @Inject(forwardRef(() => GenresService)) private genresService: GenresService,
    @Inject(forwardRef(() => ProductionsService)) private productionsService: ProductionsService,
    @Inject(forwardRef(() => TagsService)) private tagsService: TagsService,
    @Inject(forwardRef(() => ChapterTypeService)) private chapterTypeService: ChapterTypeService,
    @Inject(forwardRef(() => CollectionService)) private collectionService: CollectionService,
    @Inject(forwardRef(() => HistoryService)) private historyService: HistoryService,
    @Inject(forwardRef(() => PlaylistsService)) private playlistsService: PlaylistsService,
    @Inject(forwardRef(() => RatingsService)) private ratingsService: RatingsService,
    private redisPubSubService: RedisPubSubService,
    private auditLogService: AuditLogService,
    private externalStoragesService: ExternalStoragesService,
    private settingsService: SettingsService,
    private wsAdminGateway: WsAdminGateway,
    private onedriveService: OnedriveService,
    private filerService: FilerService,
    private s3Service: S3Service,
    private cloudflareR2Service: CloudflareR2Service,
    private localCacheService: LocalCacheService
  ) {}

  /**
   * Resolve the socket.io emit target: the caller's own socket when its id is
   * still connected, otherwise the whole admin namespace (broadcast to everyone).
   */
  private resolveIoEmitter(socketId?: string) {
    return (socketId && this.wsAdminGateway.server.sockets.get(socketId)) || this.wsAdminGateway.server;
  }

  /**
   * Resolves the cloud-storage service for a storage kind:
   * `FILER → filer / S3 → s3 / else → onedrive`. Each service keeps its own
   * findId / findPath / deleteFolder retry defaults since its own method is invoked.
   */
  private resolveStorageService(kind: number): FilerService | S3Service | OnedriveService {
    if (kind === CloudStorage.FILER) return this.filerService;
    if (kind === CloudStorage.S3) return this.s3Service;
    return this.onedriveService;
  }

  async create(createMediaDto: CreateMediaDto, headers: HeadersDto, authUser: AuthUserDto) {
    const {
      type,
      title,
      originalTitle,
      overview,
      originalLang,
      runtime,
      adult,
      releaseDate,
      lastAirDate,
      status,
      inCollections,
      visibility,
      externalIds,
      scanner
    } = createMediaDto;
    const slug = slugMediaTitle(title, originalTitle);
    const media = new this.mediaModel({
      type,
      title,
      originalTitle,
      slug,
      overview,
      originalLang,
      runtime,
      adult,
      releaseDate,
      status,
      visibility,
      pStatus: MediaPStatus.PENDING,
      externalIds,
      scanner,
      addedBy: authUser._id
    });
    media._id = await createSnowFlakeId();
    const auditLog = new AuditLogBuilder(authUser._id, media._id, Media.name, AuditLogType.MEDIA_CREATE);
    if (inCollections) {
      await this.validateCollections(inCollections);
      media.inCollections = <any>inCollections;
    }
    if (createMediaDto.type === MediaType.MOVIE) {
      media.movie = new Movie();
      media.movie.status = MediaSourceStatus.PENDING;
    } else if (createMediaDto.type === MediaType.TV) {
      media.tv = new TVShow();
      if (lastAirDate) {
        media.tv.lastAirDate = lastAirDate;
      }
    }
    const session = await this.mongooseConnection.startSession();
    await session
      .withTransaction(async () => {
        if (createMediaDto.genres) {
          const genreIds = await this.findOrCreateGenres(createMediaDto.genres, authUser._id, session);
          media.genres = <any>genreIds;
          await this.genresService.addMediaGenres(media._id, genreIds, session);
        }
        if (createMediaDto.studios) {
          const studioIds = await this.findOrCreateProductions(createMediaDto.studios, authUser._id, session);
          media.studios = <any>studioIds;
          await this.productionsService.addMediaStudios(media._id, studioIds, session);
        }
        if (createMediaDto.producers) {
          const producerIds = await this.findOrCreateProductions(createMediaDto.producers, authUser._id, session);
          media.producers = <any>producerIds;
          await this.productionsService.addMediaProductions(media._id, producerIds, session);
        }
        if (createMediaDto.tags) {
          const tagIds = await this.findOrCreateTags(createMediaDto.tags, authUser._id, session);
          media.tags = <any>tagIds;
          await this.tagsService.addMediaTags(media._id, tagIds, session);
        }
        if (createMediaDto.inCollections) {
          await this.validateCollections(createMediaDto.inCollections);
          await this.collectionService.addMediaCollections(media._id, createMediaDto.inCollections, session);
          media.inCollections = <any>createMediaDto.inCollections;
        }
        auditLog.getChangesFrom(media, ['slug']);
        await Promise.all([media.save({ session }), this.auditLogService.createLogFromBuilder(auditLog)]);
      })
      .finally(() => session.endSession().catch(() => {}));
    await media.populate([
      { path: 'inCollections', select: { _id: 1, name: 1, poster: 1, backdrop: 1 } },
      { path: 'genres', select: { _id: 1, name: 1 } },
      { path: 'studios', select: { _id: 1, name: 1 } },
      { path: 'producers', select: { _id: 1, name: 1 } },
      { path: 'tags', select: { _id: 1, name: 1 } }
    ]);
    const ioEmitter = this.resolveIoEmitter(headers.socketId);
    ioEmitter.to(SocketRoom.ADMIN_MEDIA_LIST).emit(SocketMessage.REFRESH_MEDIA);
    return plainToInstance(MediaDetails, media.toObject());
  }

  async findAll(offsetPageMediaDto: OffsetPageMediaDto, headers: HeadersDto, authUser: AuthUserDto) {
    const sortEnum = [
      '_id',
      'title',
      'originalLang',
      'releaseDate.year',
      'releaseDate.month',
      'releaseDate.day',
      'views',
      'dailyViews',
      'weeklyViews',
      'monthlyViews',
      'ratingAverage',
      'createdAt',
      'updatedAt'
    ];
    const [fields, filters] = await this.createFindAllParams(offsetPageMediaDto, authUser.hasPermission);
    const { page, limit, sort, search } = offsetPageMediaDto;
    const aggregation = new MongooseOffsetPagination({
      page,
      limit,
      fields,
      sortQuery: sort,
      search,
      sortEnum,
      fullTextSearch: true
    });
    Object.keys(filters).length && (aggregation.filters = filters);
    const lookupOptions: LookupOptions[] = [
      {
        from: 'genres',
        localField: 'genres',
        foreignField: '_id',
        as: 'genres',
        isArray: true,
        pipeline: [{ $project: { _id: 1, name: 1, _translations: 1 } }]
      },
      {
        from: 'tvepisodes',
        localField: 'tv.pLastEpisode',
        foreignField: '_id',
        as: 'tv.pLastEpisode',
        isArray: false,
        pipeline: [{ $project: { _id: 1, name: 1, epNumber: 1 } }]
      }
    ];
    if (authUser.hasPermission)
      lookupOptions.push({
        from: 'tvepisodes',
        localField: 'tv.lastEpisode',
        foreignField: '_id',
        as: 'tv.lastEpisode',
        isArray: false,
        pipeline: [{ $project: { _id: 1, name: 1, epNumber: 1 } }]
      });
    const pipeline = aggregation.buildLookup(lookupOptions);
    const [data] = await this.mediaModel.aggregate(pipeline).exec();
    let mediaList = new Paginated<MediaEntity>();
    if (data) {
      const translatedResults = convertToLanguageArray<MediaEntity>(headers.acceptLanguage, data.results, {
        populate: ['genres'],
        keepTranslationsObject: authUser.hasPermission
      });
      mediaList = plainToClassFromExist(new Paginated<MediaEntity>({ type: MediaEntity }), {
        page: data.page,
        totalPages: data.totalPages,
        totalResults: data.totalResults,
        results: translatedResults
      });
    }
    return mediaList;
  }

  async findAllCursor(cursorPageMediaDto: CursorPageMediaDto, headers: HeadersDto, authUser: AuthUserDto) {
    const sortEnum = ['_id', 'createdAt', 'updatedAt'];
    const [fields, filters] = await this.createFindAllParams(cursorPageMediaDto, authUser.hasPermission);
    const { pageToken, limit, sort, search } = cursorPageMediaDto;
    const typeMap = new Map<string, any>([
      ['_id', BigInt],
      ['createdAt', Date],
      ['updatedAt', Date]
    ]);
    const aggregation = new MongooseCursorPagination({
      pageToken,
      limit,
      fields,
      sortQuery: sort,
      search,
      sortEnum,
      typeMap,
      fullTextSearch: true
    });
    Object.keys(filters).length && (aggregation.filters = filters);
    const lookupOptions: LookupOptions[] = [
      {
        from: 'genres',
        localField: 'genres',
        foreignField: '_id',
        as: 'genres',
        isArray: true,
        pipeline: [{ $project: { _id: 1, name: 1, _translations: 1 } }]
      },
      {
        from: 'tvepisodes',
        localField: 'tv.pLastEpisode',
        foreignField: '_id',
        as: 'tv.pLastEpisode',
        isArray: false,
        pipeline: [{ $project: { _id: 1, name: 1, epNumber: 1 } }]
      }
    ];
    if (authUser.hasPermission)
      lookupOptions.push({
        from: 'tvepisodes',
        localField: 'tv.lastEpisode',
        foreignField: '_id',
        as: 'tv.lastEpisode',
        isArray: false,
        pipeline: [{ $project: { _id: 1, name: 1, epNumber: 1 } }]
      });
    const pipeline = aggregation.buildLookup(lookupOptions);
    const [data] = await this.mediaModel.aggregate(pipeline).exec();
    let mediaList = new CursorPaginated<MediaEntity>();
    if (data) {
      const translatedResults = convertToLanguageArray<MediaEntity>(headers.acceptLanguage, data.results, {
        populate: ['genres'],
        keepTranslationsObject: authUser.hasPermission
      });
      mediaList = plainToClassFromExist(new CursorPaginated<MediaEntity>({ type: MediaEntity }), {
        totalResults: data.totalResults,
        results: translatedResults,
        hasNextPage: data.hasNextPage,
        nextPageToken: data.nextPageToken,
        prevPageToken: data.prevPageToken
      });
    }
    return mediaList;
  }

  async findOne(id: bigint, headers: HeadersDto, findMediaDto: FindMediaDto, authUser: AuthUserDto) {
    const project: ProjectionType<MediaDocument> = {
      _id: 1,
      type: 1,
      title: 1,
      originalTitle: 1,
      slug: 1,
      overview: 1,
      poster: 1,
      backdrop: 1,
      genres: 1,
      originalLang: 1,
      studios: 1,
      producers: 1,
      tags: 1,
      credits: 1,
      runtime: 1,
      videos: 1,
      adult: 1,
      releaseDate: 1,
      status: 1,
      externalIds: 1,
      views: 1,
      dailyViews: 1,
      weeklyViews: 1,
      monthlyViews: 1,
      ratingCount: 1,
      ratingScore: 1,
      ratingAverage: 1,
      visibility: 1,
      _translations: 1,
      createdAt: 1,
      updatedAt: 1,
      'tv.pLastEpisode': 1,
      'tv.lastAirDate': 1,
      'tv.episodes': 1
    };
    const population: PopulateOptions[] = [
      { path: 'genres', select: { _id: 1, name: 1, _translations: 1 } },
      { path: 'studios', select: { _id: 1, name: 1 } },
      { path: 'producers', select: { _id: 1, name: 1 } },
      { path: 'tags', select: { _id: 1, name: 1, _translations: 1 } },
      { path: 'tv.pLastEpisode', select: { _id: 1, epNumber: 1, name: 1 } }
    ];
    if (authUser.hasPermission) {
      project.scanner = 1;
      project.pStatus = 1;
      project.addedBy = 1;
      project['movie.subtitles'] = 1;
      project['movie.chapters'] = 1;
      project['movie.status'] = 1;
      project['tv.episodeCount'] = 1;
      project['tv.lastEpisode'] = 1;
      population.push(
        { path: 'tv.lastEpisode', select: { _id: 1, epNumber: 1, name: 1 } },
        {
          path: 'addedBy',
          select: { _id: 1, username: 1, nickname: 1, createdAt: 1, banned: 1, lastActiveAt: 1, avatar: 1 }
        }
      );
    }
    const episodePopulation: PopulateOptions = {
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
    const translationPopulation: string[] = ['genres', 'tags', 'tv.episodes', 'videos'];
    authUser.hasPermission && (episodePopulation.select.pStatus = 1);
    if (!authUser.hasPermission || !findMediaDto.includeHiddenEps) episodePopulation.match.pStatus = MediaPStatus.DONE;
    if (!authUser.hasPermission || !findMediaDto.includeUnprocessedEps)
      episodePopulation.match.visibility = MediaVisibility.PUBLIC;
    population.push(episodePopulation);
    if (findMediaDto.appendToResponse) {
      if (findMediaDto.appendToResponse.includes('inCollections')) {
        const collectionMediaPopulation: PopulateOptions = {
          path: 'media',
          select: {
            _id: 1,
            type: 1,
            title: 1,
            originalTitle: 1,
            overview: 1,
            runtime: 1,
            'movie.status': 1,
            'tv.pEpisodeCount': 1,
            'tv.lastAirDate': 1,
            poster: 1,
            backdrop: 1,
            originalLang: 1,
            adult: 1,
            releaseDate: 1,
            views: 1,
            ratingCount: 1,
            ratingAverage: 1,
            visibility: 1,
            _translations: 1,
            createdAt: 1,
            updatedAt: 1
          },
          match: {}
        };
        (!authUser.hasPermission || !findMediaDto.includeHiddenMedia) &&
          (collectionMediaPopulation.match.visibility = MediaVisibility.PUBLIC);
        (!authUser.hasPermission || !findMediaDto.includeUnprocessedMedia) &&
          (collectionMediaPopulation.match.pStatus = MediaPStatus.DONE);
        const inCollectionsPopulation: PopulateOptions = {
          path: 'inCollections',
          select: { _id: 1, name: 1, overview: 1, poster: 1, backdrop: 1, media: 1, mediaCount: 1, _translations: 1 },
          populate: collectionMediaPopulation
        };
        project.inCollections = 1;
        population.push(inCollectionsPopulation);
        translationPopulation.push('inCollections');
      }
      if (findMediaDto.appendToResponse.includes('subtitles')) {
        project['movie.subtitles'] = 1;
      }
      if (findMediaDto.appendToResponse.includes('chapters')) {
        project['movie.chapters'] = 1;
      }
    }
    const media = await this.mediaModel.findOne({ _id: id }, project).populate(population).lean().exec();
    if (!media)
      throw new HttpException({ code: StatusCode.MEDIA_NOT_FOUND, message: 'Media not found' }, HttpStatus.NOT_FOUND);
    if (media.visibility === MediaVisibility.PRIVATE && !authUser.hasPermission)
      throw new HttpException(
        { code: StatusCode.MEDIA_PRIVATE, message: 'This media is private' },
        HttpStatus.FORBIDDEN
      );

    const translated = convertToLanguage<Media>(headers.acceptLanguage, media, {
      populate: ['inCollections', 'genres', 'tags', 'tv.episodes', 'videos'],
      keepTranslationsObject: authUser.hasPermission
    });
    return plainToInstance(MediaDetails, translated);
  }

  async update(id: bigint, updateMediaDto: UpdateMediaDto, headers: HeadersDto, authUser: AuthUserDto) {
    if (!Object.keys(updateMediaDto).length)
      throw new HttpException({ code: StatusCode.EMPTY_BODY, message: 'Nothing to update' }, HttpStatus.BAD_REQUEST);
    const media = await this.mediaModel
      .findOne(
        { _id: id },
        {
          _id: 1,
          type: 1,
          title: 1,
          originalTitle: 1,
          slug: 1,
          overview: 1,
          genres: 1,
          originalLang: 1,
          studios: 1,
          producers: 1,
          tags: 1,
          credits: 1,
          runtime: 1,
          videos: 1,
          adult: 1,
          releaseDate: 1,
          status: 1,
          inCollections: 1,
          externalIds: 1,
          ratingCount: 1,
          ratingAverage: 1,
          visibility: 1,
          _translations: 1,
          createdAt: 1,
          updatedAt: 1,
          movie: 1,
          'tv.episodeCount': 1,
          'tv.lastEpisode': 1,
          'tv.pLastEpisode': 1,
          'tv.lastAirDate': 1,
          scanner: 1
        }
      )
      .exec();
    if (!media)
      throw new HttpException({ code: StatusCode.MEDIA_NOT_FOUND, message: 'Media not found' }, HttpStatus.NOT_FOUND);
    const auditLog = new AuditLogBuilder(authUser._id, media._id, Media.name, AuditLogType.MEDIA_UPDATE);
    if (updateMediaDto.translate && updateMediaDto.translate !== I18N_DEFAULT_LANGUAGE) {
      const titleKey = `_translations.${updateMediaDto.translate}.title`;
      if (updateMediaDto.title) media.set(titleKey, updateMediaDto.title);
      const overviewKey = `_translations.${updateMediaDto.translate}.overview`;
      if (updateMediaDto.overview) media.set(overviewKey, updateMediaDto.overview);
      const slug = slugify(removeAccents(updateMediaDto.title), { lower: true, locale: updateMediaDto.translate });
      media.set(`_translations.${updateMediaDto.translate}.slug`, slug || null);
      await media.save();
    } else {
      const session = await this.mongooseConnection.startSession();
      await session
        .withTransaction(async () => {
          if (updateMediaDto.title) media.title = updateMediaDto.title;
          if (updateMediaDto.originalTitle !== undefined) media.originalTitle = updateMediaDto.originalTitle;
          if (updateMediaDto.overview) media.overview = updateMediaDto.overview;
          if (updateMediaDto.originalLang !== undefined) media.originalLang = updateMediaDto.originalLang;
          if (updateMediaDto.runtime != undefined) media.runtime = updateMediaDto.runtime;
          if (updateMediaDto.visibility != undefined) media.visibility = updateMediaDto.visibility;
          if (updateMediaDto.adult != undefined) media.adult = updateMediaDto.adult;
          if (updateMediaDto.status != undefined) media.status = updateMediaDto.status;
          if (updateMediaDto.releaseDate != undefined) media.releaseDate = updateMediaDto.releaseDate;
          if (updateMediaDto.lastAirDate !== undefined && media.type === MediaType.TV)
            media.tv.lastAirDate = updateMediaDto.lastAirDate;
          if (updateMediaDto.externalIds) {
            if (updateMediaDto.externalIds.imdb !== undefined)
              media.set('externalIds.imdb', updateMediaDto.externalIds.imdb);
            if (updateMediaDto.externalIds.tmdb !== undefined)
              media.set('externalIds.tmdb', updateMediaDto.externalIds.tmdb);
            if (updateMediaDto.externalIds.aniList !== undefined)
              media.set('externalIds.aniList', updateMediaDto.externalIds.aniList);
            if (updateMediaDto.externalIds.mal !== undefined)
              media.set('externalIds.mal', updateMediaDto.externalIds.mal);
          }
          if (updateMediaDto.scanner) {
            if (updateMediaDto.scanner.enabled != undefined)
              media.set('scanner.enabled', updateMediaDto.scanner.enabled);
            if (updateMediaDto.scanner.tvSeason !== undefined && media.type === MediaType.TV)
              media.set('scanner.tvSeason', updateMediaDto.scanner.tvSeason);
          }
          if (updateMediaDto.title || updateMediaDto.originalTitle !== undefined) {
            const slug = slugMediaTitle(media.title, media.originalTitle);
            media.slug = slug;
          }
          if (updateMediaDto.genres) {
            const updateGenreIds = await this.findOrCreateGenres(updateMediaDto.genres, authUser._id, session);
            const mediaGenres: any[] = media.genres.toObject();
            const newGenres = updateGenreIds.filter((e) => !mediaGenres.includes(e));
            const oldGenres = mediaGenres.filter((e) => !updateGenreIds.includes(e));
            media.genres = <any>updateGenreIds;
            await this.genresService.updateMediaGenres(media._id, newGenres, oldGenres, session);
          }
          if (updateMediaDto.studios) {
            const updateStudioIds = await this.findOrCreateProductions(updateMediaDto.studios, authUser._id, session);
            const mediaStudios: any[] = media.studios;
            const newStudios = updateStudioIds.filter((e) => !mediaStudios.includes(e));
            const oldStudios = mediaStudios.filter((e) => !updateStudioIds.includes(e));
            media.studios = <any>updateStudioIds;
            await this.productionsService.updateMediaStudios(media._id, newStudios, oldStudios, session);
          }
          if (updateMediaDto.producers) {
            const updateProductionIds = await this.findOrCreateProductions(
              updateMediaDto.producers,
              authUser._id,
              session
            );
            const mediaProductions: any[] = media.producers;
            const newProductions = updateProductionIds.filter((e) => !mediaProductions.includes(e));
            const oldProductions = mediaProductions.filter((e) => !updateProductionIds.includes(e));
            media.producers = <any>updateProductionIds;
            await this.productionsService.updateMediaProductions(media._id, newProductions, oldProductions, session);
          }
          if (updateMediaDto.tags) {
            const updateTagIds = await this.findOrCreateTags(updateMediaDto.tags, authUser._id, session);
            const mediaTags: any[] = media.tags.toObject();
            const newTags = updateTagIds.filter((e) => !mediaTags.includes(e));
            const oldTags = mediaTags.filter((e) => !updateTagIds.includes(e));
            media.tags = <any>updateTagIds;
            await this.tagsService.updateMediaTags(media._id, newTags, oldTags, session);
          }
          if (
            updateMediaDto.inCollections &&
            !arrayEqualShallow(media.inCollections, <any>updateMediaDto.inCollections)
          ) {
            const updateCollectionIds = updateMediaDto.inCollections;
            const mediaCollections: any[] = media.inCollections.toObject();
            const newCollections = updateCollectionIds.filter((e) => !mediaCollections.includes(e));
            const oldCollections = mediaCollections.filter((e) => !updateCollectionIds.includes(e));
            await this.validateCollections(newCollections);
            media.inCollections = <any>updateMediaDto.inCollections;
            await this.collectionService.updateMediaCollections(media._id, newCollections, oldCollections, session);
          }
          auditLog.getChangesFrom(media, ['slug']);
          await media.save({ session, timestamps: updateMediaDto.updateTimestamp });
        })
        .finally(() => session.endSession().catch(() => {}));
    }
    await media.populate([
      { path: 'inCollections', select: { _id: 1, name: 1, poster: 1, backdrop: 1 } },
      { path: 'genres', select: { _id: 1, name: 1, _translations: 1 } },
      { path: 'studios', select: { _id: 1, name: 1 } },
      { path: 'producers', select: { _id: 1, name: 1 } },
      { path: 'tags', select: { _id: 1, name: 1, _translations: 1 } },
      {
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
        }
      },
      {
        path: 'addedBy',
        select: { _id: 1, username: 1, nickname: 1, createdAt: 1, banned: 1, lastActiveAt: 1, avatar: 1 }
      }
    ]);
    const translated = convertToLanguage<Media>(updateMediaDto.translate, media.toObject(), {
      populate: ['genres', 'tags', 'tv.episodes'],
      keepTranslationsObject: authUser.hasPermission
    });
    const serializedMedia = instanceToPlain(plainToInstance(MediaDetails, translated));
    await Promise.all([
      this.auditLogService.createLogFromBuilder(auditLog),
      this.localCacheService.del(`${CachePrefix.MEDIA_FIND_FILTER_RELATED}:${id}`)
    ]);
    const ioEmitter = this.resolveIoEmitter(headers.socketId);
    ioEmitter
      .to([SocketRoom.ADMIN_MEDIA_LIST, `${SocketRoom.ADMIN_MEDIA_DETAILS}:${translated._id}`])
      .emit(SocketMessage.REFRESH_MEDIA, {
        mediaId: translated._id,
        media: serializedMedia
      });
    return serializedMedia;
  }

  async remove(id: bigint, headers: HeadersDto, authUser: AuthUserDto) {
    let deletedMedia: Media;
    const session = await this.mongooseConnection.startSession();
    await session
      .withTransaction(async () => {
        deletedMedia = await this.mediaModel.findOneAndDelete({ _id: id }, { session }).lean();
        if (!deletedMedia)
          throw new HttpException(
            { code: StatusCode.MEDIA_NOT_FOUND, message: 'Media not found' },
            HttpStatus.NOT_FOUND
          );
        await Promise.all([
          this.deleteMediaImage(deletedMedia.poster, CloudflareR2Container.POSTERS),
          this.deleteMediaImage(deletedMedia.backdrop, CloudflareR2Container.BACKDROPS),
          this.genresService.deleteMediaGenres(id, <bigint[]>(<unknown>deletedMedia.genres), session),
          this.productionsService.deleteMediaStudios(id, <bigint[]>(<unknown>deletedMedia.studios), session),
          this.productionsService.deleteMediaProductions(id, <bigint[]>(<unknown>deletedMedia.producers), session),
          this.tagsService.deleteMediaTags(id, <bigint[]>(<unknown>deletedMedia.tags), session),
          this.historyService.deleteMediaHistory(id, session),
          this.ratingsService.deleteMediaRating(id, session),
          this.collectionService.deleteMediaCollections(id, <any>deletedMedia.inCollections, session)
        ]);
        if (deletedMedia.type === MediaType.MOVIE) {
          const deleteSubtitleLimit = pLimit(5);
          await Promise.all(
            deletedMedia.movie.subtitles.map((subtitle) =>
              deleteSubtitleLimit(() => this.deleteMediaSubtitle(subtitle))
            )
          );
          await Promise.all([
            this.deleteMediaSource(<bigint>(<unknown>deletedMedia.movie.source), session),
            this.chapterTypeService.deleteMovieChapterTypes(
              id,
              deletedMedia.movie.chapters.map((c) => <bigint>(<unknown>c.type)),
              session
            )
          ]);
          if (deletedMedia.movie.tJobs?.length) {
            await this.redisPubSubService.publishJson('video-cancel', { ids: deletedMedia.movie.tJobs.toObject() });
            await this.removeFromTranscodeQueue(deletedMedia.movie.tJobs.toObject());
          }
        } else if (deletedMedia.type === MediaType.TV) {
          const deleteEpisodeLimit = pLimit(5);
          await Promise.all(
            deletedMedia.tv.episodes.map((episodeId) =>
              deleteEpisodeLimit(() => this.deleteEpisodeById(<bigint>(<unknown>episodeId), session))
            )
          );
        }
        await this.auditLogService.createLog(authUser._id, deletedMedia._id, Media.name, AuditLogType.MEDIA_DELETE);
      })
      .finally(() => session.endSession().catch(() => {}));
    const ioEmitter = this.resolveIoEmitter(headers.socketId);
    ioEmitter
      .to([SocketRoom.ADMIN_MEDIA_LIST, `${SocketRoom.ADMIN_MEDIA_DETAILS}:${deletedMedia._id}`])
      .emit(SocketMessage.REFRESH_MEDIA, {
        mediaId: deletedMedia._id
      });
  }

  private async deleteMediaImage(image: MediaFile, container: string) {
    if (!image) return;
    await this.cloudflareR2Service.delete(container, `${image._id}/${image.name}`);
  }

  async uploadMovieSource(id: bigint, addMediaSourceDto: AddMediaSourceDto, authUser: AuthUserDto) {
    const media = await this.mediaModel.findOne({ _id: id, type: MediaType.MOVIE }, { _id: 1, movie: 1 }).lean().exec();
    if (!media)
      throw new HttpException({ code: StatusCode.MEDIA_NOT_FOUND, message: 'Media not found' }, HttpStatus.NOT_FOUND);
    if (media.movie.source)
      throw new HttpException(
        { code: StatusCode.MEDIA_SOURCE_EXIST, message: 'Source has already been added' },
        HttpStatus.BAD_REQUEST
      );
    return this.createUploadSourceSession(addMediaSourceDto, authUser._id);
  }

  async addLinkedMovieSource(
    id: bigint,
    addLinkedMediaSourceDto: AddLinkedMediaSourceDto,
    baseUrl: string,
    authUser: AuthUserDto
  ) {
    const media = await this.mediaModel
      .findOne({ _id: id, type: MediaType.MOVIE }, { _id: 1, movie: 1, pStatus: 1 })
      .exec();
    if (!media)
      throw new HttpException({ code: StatusCode.MEDIA_NOT_FOUND, message: 'Media not found' }, HttpStatus.NOT_FOUND);
    if (media.movie.source)
      throw new HttpException(
        { code: StatusCode.MEDIA_SOURCE_EXIST, message: 'Source has already been added' },
        HttpStatus.BAD_REQUEST
      );
    const mediaSource = await this.createLinkedMediaSource(addLinkedMediaSourceDto, id);
    // Start encoding from linked source
    const streamSettings = await this.settingsService.findStreamSettings();
    media.movie.source = mediaSource._id;
    media.movie.status = MediaSourceStatus.PROCESSING;
    media.pStatus = MediaPStatus.PROCESSING;
    const queueData: MediaQueueDataDto = {
      _id: mediaSource._id,
      filename: mediaSource.name,
      path: mediaSource.path,
      size: mediaSource.size,
      mimeType: mediaSource.mimeType,
      storage: <bigint>(<unknown>mediaSource.storage),
      linkedStorage: <bigint>(<unknown>mediaSource.linkedStorage),
      user: authUser._id,
      producerUrl: baseUrl,
      advancedOptions: mediaSource.options
    };
    const addedJobs = await this.createTranscodeQueue(media._id, queueData, streamSettings);
    addedJobs.forEach((j) => media.movie.tJobs.push(+j.id));
    await media.save({ timestamps: false });
    this.wsAdminGateway.server
      .to([SocketRoom.ADMIN_MEDIA_LIST, `${SocketRoom.ADMIN_MEDIA_DETAILS}:${media._id}`])
      .emit(SocketMessage.SAVE_MOVIE_SOURCE, {
        mediaId: media._id
      });
  }

  async encodeMovieSource(
    id: bigint,
    encodeMediaSourceDto: EncodeMediaSourceDto,
    baseUrl: string,
    authUser: AuthUserDto
  ) {
    const media = await this.mediaModel.findOne({ _id: id, type: MediaType.MOVIE }, { movie: 1 }).exec();
    if (!media)
      throw new HttpException({ code: StatusCode.MEDIA_NOT_FOUND, message: 'Media not found' }, HttpStatus.NOT_FOUND);
    if (!media.movie.source)
      throw new HttpException(
        { code: StatusCode.MEDIA_SOURCE_NOT_FOUND, message: 'Media source not found' },
        HttpStatus.NOT_FOUND
      );
    if (media.movie.status !== MediaSourceStatus.DONE)
      throw new HttpException(
        { code: StatusCode.MOVIE_ENCODING_UNAVAILABLE, message: 'This feature is currently not available' },
        HttpStatus.NOT_FOUND
      );
    const sourceAdvancedOptions = encodeMediaSourceDto.options || {};
    // Save options to database
    const {
      selectAudioTracks,
      extraAudioTracks,
      forceVideoQuality,
      h264Tune,
      queuePriority,
      videoCodecs,
      overrideSettings,
      audioOnly,
      videoOnly
    } = sourceAdvancedOptions;
    const updateQuery: UpdateQuery<MediaStorageDocument> = encodeMediaSourceDto.options
      ? {
          $set: {
            options: {
              selectAudioTracks,
              extraAudioTracks,
              forceVideoQuality,
              h264Tune,
              queuePriority,
              videoCodecs,
              overrideSettings
            }
          }
        }
      : {};
    const uploadedSource = await this.mediaStorageModel
      .findOneAndUpdate({ _id: media.movie.source }, updateQuery, { new: true })
      .populate('storage')
      .lean()
      .exec();
    if (!uploadedSource)
      throw new HttpException(
        { code: StatusCode.MEDIA_SOURCE_NOT_FOUND, message: 'Media source not found' },
        HttpStatus.NOT_FOUND
      );
    /*
    if (media.movie.streams?.length) {
      // Remove all streams first
      await Promise.all(media.movie.streams.map(id =>
        this.onedriveService.deleteFolder(`${media.movie.source}/${id}`, uploadedSource.storage)));
      media.movie.streams = <Types.Array<MediaStorage>>[];
    }
    */
    const streamSettings = await this.settingsService.findStreamSettings();
    const targetVideoCodecs =
      uploadedSource.options?.videoCodecs ||
      (streamSettings.defaultVideoCodecs !== STREAM_CODECS[0] ? streamSettings.defaultVideoCodecs : null);
    const replaceStreams = this.findReplaceStreams(uploadedSource, targetVideoCodecs, audioOnly, videoOnly);
    const queueData: MediaQueueDataDto = {
      _id: uploadedSource._id,
      filename: uploadedSource.name,
      path: uploadedSource.path,
      size: uploadedSource.size,
      mimeType: uploadedSource.mimeType,
      storage: uploadedSource.storage._id,
      linkedStorage: <bigint>(<unknown>uploadedSource.linkedStorage),
      user: authUser._id,
      update: true,
      replaceStreams,
      producerUrl: baseUrl,
      advancedOptions: encodeMediaSourceDto.options
    };
    const addedJobs = await this.createTranscodeQueue(media._id, queueData, streamSettings);
    addedJobs.forEach((j) => media.movie.tJobs.push(+j.id));
    if (replaceStreams.length) {
      // Back to ready status
      media.movie.status = MediaSourceStatus.READY;
    }
    await media.save({ timestamps: false });
    this.wsAdminGateway.server
      .to([SocketRoom.ADMIN_MEDIA_LIST, `${SocketRoom.ADMIN_MEDIA_DETAILS}:${media._id}`])
      .emit(SocketMessage.SAVE_MOVIE_SOURCE, {
        mediaId: media._id
      });
  }

  async saveMovieSource(
    id: bigint,
    sessionId: bigint,
    saveMediaSourceDto: SaveMediaSourceDto,
    baseUrl: string,
    authUser: AuthUserDto
  ) {
    const media = await this.mediaModel
      .findOne({ _id: id, type: MediaType.MOVIE }, { _id: 1, movie: 1, pStatus: 1 })
      .exec();
    if (!media)
      throw new HttpException({ code: StatusCode.MEDIA_NOT_FOUND, message: 'Media not found' }, HttpStatus.NOT_FOUND);
    if (media.movie.source)
      throw new HttpException(
        { code: StatusCode.MEDIA_SOURCE_EXIST, message: 'Source has already been added' },
        HttpStatus.CONFLICT
      );
    const uploadSession = await this.driveSessionModel
      .findOne({ _id: sessionId, user: <any>authUser._id })
      .populate('storage')
      .populate('user', { _id: 1, username: 1, email: 1, nickname: 1 })
      .lean()
      .exec();
    if (!uploadSession)
      throw new HttpException(
        { code: StatusCode.DRIVE_SESSION_NOT_FOUND, message: 'Upload session not found' },
        HttpStatus.NOT_FOUND
      );
    let fileInfo: StorageFileInfo;
    fileInfo = await this.resolveStorageService(uploadSession.storage.kind).findId(
      saveMediaSourceDto.fileId,
      uploadSession.storage
    );
    if (fileInfo.name !== uploadSession.filename || fileInfo.size != uploadSession.size) {
      await this.resolveStorageService(uploadSession.storage.kind).deleteFolder(
        uploadSession._id,
        uploadSession.storage
      );
      await this.driveSessionModel.deleteOne({ _id: sessionId }).exec();
      throw new HttpException(
        { code: StatusCode.DRIVE_FILE_INVALID, message: 'You have uploaded an invalid file' },
        HttpStatus.UNSUPPORTED_MEDIA_TYPE
      );
    }
    const auditLog = new AuditLogBuilder(
      authUser._id,
      uploadSession._id,
      MediaStorage.name,
      AuditLogType.MEDIA_STORAGE_FILE_CREATE
    );
    const streamSettings = await this.settingsService.findStreamSettings();
    const session = await this.mongooseConnection.startSession();
    await session
      .withTransaction(async () => {
        // Add original source to media
        const mediaSource = new this.mediaStorageModel({
          _id: uploadSession._id,
          type: MediaStorageType.SOURCE,
          name: uploadSession.filename,
          path: String(uploadSession._id),
          mimeType: uploadSession.mimeType,
          size: uploadSession.size,
          options: uploadSession.options,
          media: media._id,
          storage: uploadSession.storage._id
        });
        media.movie.source = uploadSession._id;
        media.movie.status = MediaSourceStatus.PROCESSING;
        media.pStatus = MediaPStatus.PROCESSING;
        const queueData: MediaQueueDataDto = {
          _id: uploadSession._id,
          filename: uploadSession.filename,
          path: mediaSource.path,
          size: uploadSession.size,
          mimeType: uploadSession.mimeType,
          storage: uploadSession.storage._id,
          user: authUser._id,
          producerUrl: baseUrl,
          advancedOptions: uploadSession.options
        };
        const addedJobs = await this.createTranscodeQueue(media._id, queueData, streamSettings);
        addedJobs.forEach((j) => media.movie.tJobs.push(+j.id));
        auditLog.appendChange('type', MediaStorageType.SOURCE);
        auditLog.appendChange('name', uploadSession.filename);
        auditLog.appendChange('path', uploadSession._id);
        auditLog.appendChange('size', uploadSession.size);
        auditLog.appendChange('mimeType', uploadSession.mimeType);
        auditLog.appendChange('storage', uploadSession.storage._id);
        await mediaSource.save({ session });
        await Promise.all([
          this.externalStoragesService.addFileToStorage(
            uploadSession.storage._id,
            uploadSession._id,
            uploadSession.size,
            session
          ),
          this.driveSessionModel.deleteOne({ _id: sessionId }, { session }),
          media.updateOne(media.getChanges(), { session, timestamps: false }),
          this.auditLogService.createLogFromBuilder(auditLog)
        ]);
      })
      .finally(() => session.endSession().catch(() => {}));
    this.wsAdminGateway.server
      .to([SocketRoom.ADMIN_MEDIA_LIST, `${SocketRoom.ADMIN_MEDIA_DETAILS}:${media._id}`])
      .emit(SocketMessage.SAVE_MOVIE_SOURCE, {
        mediaId: media._id
      });
  }

  async deleteMovieSource(id: bigint, headers: HeadersDto, authUser: AuthUserDto) {
    const media = await this.mediaModel.findOne({ _id: id, type: MediaType.MOVIE }, { _id: 1, movie: 1 }).exec();
    if (!media)
      throw new HttpException({ code: StatusCode.MEDIA_NOT_FOUND, message: 'Media not found' }, HttpStatus.NOT_FOUND);
    if (media.movie.status === MediaSourceStatus.PENDING)
      throw new HttpException(
        { code: StatusCode.MEDIA_SOURCE_NOT_FOUND, message: 'Media source not found' },
        HttpStatus.NOT_FOUND
      );
    const session = await this.mongooseConnection.startSession();
    await session
      .withTransaction(async () => {
        await this.deleteMediaSource(<bigint>(<unknown>media.movie.source), session);
        if (media.movie.tJobs.length) {
          await this.redisPubSubService.publishJson('video-cancel', { ids: media.movie.tJobs.toObject() });
          await this.removeFromTranscodeQueue(media.movie.tJobs.toObject());
          media.movie.tJobs = new Types.Array<number>();
        }
        const auditLog = new AuditLogBuilder(
          authUser._id,
          <bigint>(<unknown>media.movie.source),
          MediaStorage.name,
          AuditLogType.MEDIA_STORAGE_FILE_DELETE
        );
        media.movie.tJobs = new Types.Array<number>();
        media.movie.source = undefined;
        media.movie.status = MediaSourceStatus.PENDING;
        media.pStatus = MediaPStatus.PENDING;
        await Promise.all([
          media.save({ session, timestamps: false }),
          this.auditLogService.createLogFromBuilder(auditLog)
        ]);
      })
      .finally(() => session.endSession().catch(() => {}));
    const ioEmitter = this.resolveIoEmitter(headers.socketId);
    ioEmitter
      .to([SocketRoom.ADMIN_MEDIA_LIST, `${SocketRoom.ADMIN_MEDIA_DETAILS}:${media._id}`])
      .emit(SocketMessage.DELETE_MOVIE_SOURCE, {
        mediaId: media._id
      });
  }

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
    fileInfo = await this.resolveStorageService(storage.kind).findPath(filePath, mediaQueueResultDto.storage);
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
    fileInfo = await this.resolveStorageService(storage.kind).findPath(filePath, mediaQueueResultDto.storage);
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
    fileInfo = await this.resolveStorageService(storage.kind).findPath(filePath, mediaQueueResultDto.storage);
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
          await this.deleteMediaStreams(oldManifestIds, source._id, session);
          await this.deleteMediaStreamFromStorage(oldManifestIds, source._id, storage);
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
          await this.deleteMediaStreams(
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
          await this.deleteMediaStreams(streamIds, media.movie.source._id, session);
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

  async handleMovieStreamQueueRetry(jobId: number | string, mediaQueueResultDto: MediaQueueResultDto) {
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
        await this.deleteMediaStreams(streamIds, source._id, session);
        await this.deleteMediaStreamFromStorage(
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
            await this.deleteMediaSource(<bigint>(<unknown>media.movie.source), session);
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
              await this.deleteMediaStreams(streamByCodecIds, source._id, session);
              await this.deleteMediaStreamFromStorage(streamByCodecIds, source._id, source.storage);
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

  async findAllMovieStreams(id: bigint, findMediaStreamsDto: FindMediaStreamsDto, authUser: AuthUserDto) {
    const incViews = findMediaStreamsDto.preview && authUser.hasPermission ? 0 : 1;
    const media = await this.mediaModel
      .findOneAndUpdate(
        { _id: id, type: MediaType.MOVIE },
        { $inc: { views: incViews, dailyViews: incViews, weeklyViews: incViews, monthlyViews: incViews } },
        { timestamps: false }
      )
      .select({ _id: 1, movie: 1, pStatus: 1, visibility: 1 })
      .populate([
        {
          path: 'movie.source',
          populate: { path: 'storage', select: { _id: 1, kind: 1, folderId: 1, publicUrl: 1, secondPublicUrl: 1 } }
        }
      ])
      .lean()
      .exec();
    if (!media)
      throw new HttpException({ code: StatusCode.MEDIA_NOT_FOUND, message: 'Media not found' }, HttpStatus.NOT_FOUND);
    if (media.visibility === MediaVisibility.PRIVATE && !authUser.hasPermission)
      throw new HttpException(
        { code: StatusCode.MEDIA_PRIVATE, message: 'This media is private' },
        HttpStatus.FORBIDDEN
      );
    if (media.pStatus !== MediaPStatus.DONE)
      throw new HttpException(
        { code: StatusCode.MOVIE_NOT_READY, message: 'Movie is not ready' },
        HttpStatus.NOT_FOUND
      );
    if (!media.movie.source.streams?.length)
      throw new HttpException(
        { code: StatusCode.MEDIA_STREAM_NOT_FOUND, message: 'Media stream not found' },
        HttpStatus.NOT_FOUND
      );
    const manifestStreams = media.movie.source.streams.filter((s) => s.type === MediaStorageType.MANIFEST);
    const storage = {
      ...media.movie.source.storage,
      publicUrl: this.resolveStoragePublicUrl(
        media.movie.source.storage.kind,
        media.movie.source.storage.publicUrl,
        media.movie.source.storage.folderId
      ),
      secondPublicUrl: media.movie.source.storage.secondPublicUrl
        ? this.resolveStoragePublicUrl(
            media.movie.source.storage.kind,
            media.movie.source.storage.secondPublicUrl,
            media.movie.source.storage.folderId
          )
        : undefined
    };
    return plainToInstance(MediaStream, {
      _id: media._id,
      storage: storage,
      sourcePath: storage.folderId
        ? storage.folderId + '/' + media.movie.source._id.toString()
        : media.movie.source._id.toString(),
      streams: manifestStreams,
      subtitles: media.movie.subtitles
    });
  }

  async updateTVEpisode(
    id: bigint,
    episodeId: bigint,
    updateTVEpisodeDto: UpdateTVEpisodeDto,
    headers: HeadersDto,
    authUser: AuthUserDto
  ) {
    if (!Object.keys(updateTVEpisodeDto).length)
      throw new HttpException({ code: StatusCode.EMPTY_BODY, message: 'Nothing to update' }, HttpStatus.BAD_REQUEST);
    const media = await this.mediaModel.findOne({ _id: id, type: MediaType.TV }, { _id: 1, tv: 1 }).exec();
    if (!media)
      throw new HttpException({ code: StatusCode.MEDIA_NOT_FOUND, message: 'Media not found' }, HttpStatus.NOT_FOUND);
    const episode = await this.tvEpisodeModel
      .findOne(
        { _id: episodeId, media: id },
        {
          _id: 1,
          epNumber: 1,
          name: 1,
          overview: 1,
          runtime: 1,
          airDate: 1,
          still: 1,
          views: 1,
          status: 1,
          pStatus: 1,
          subtitles: 1,
          chapters: 1,
          visibility: 1,
          source: 1,
          _translations: 1,
          createdAt: 1,
          updatedAt: 1
        }
      )
      .exec();
    if (!episode)
      throw new HttpException(
        { code: StatusCode.EPISODE_NOT_FOUND, message: 'Episode not found' },
        HttpStatus.NOT_FOUND
      );
    const auditLog = new AuditLogBuilder(authUser._id, episode._id, TVEpisode.name, AuditLogType.EPISODE_UPDATE);
    if (updateTVEpisodeDto.translate && updateTVEpisodeDto.translate !== I18N_DEFAULT_LANGUAGE) {
      const nameKey = `_translations.${updateTVEpisodeDto.translate}.name`;
      const overviewKey = `_translations.${updateTVEpisodeDto.translate}.overview`;
      if (updateTVEpisodeDto.name != undefined) {
        episode.set(nameKey, updateTVEpisodeDto.name);
      }
      if (updateTVEpisodeDto.overview != undefined) {
        episode.set(overviewKey, updateTVEpisodeDto.overview);
      }
      auditLog.getChangesFrom(episode, ['status', 'pStatus']);
      await Promise.all([episode.save(), this.auditLogService.createLogFromBuilder(auditLog)]);
    } else {
      const session = await this.mongooseConnection.startSession();
      await session
        .withTransaction(async () => {
          const oldEpisodeNumber = episode.epNumber;
          if (updateTVEpisodeDto.epNumber != undefined && updateTVEpisodeDto.epNumber !== episode.epNumber) {
            const episodeExist = await this.tvEpisodeModel
              .findOne({ media: id, epNumber: updateTVEpisodeDto.epNumber })
              .lean()
              .exec();
            if (episodeExist)
              throw new HttpException(
                { code: StatusCode.EPISODE_NUMBER_EXIST, message: 'Episode number has already been used' },
                HttpStatus.BAD_REQUEST
              );
            episode.epNumber = updateTVEpisodeDto.epNumber;
          }
          if (updateTVEpisodeDto.name !== undefined) episode.name = updateTVEpisodeDto.name;
          if (updateTVEpisodeDto.overview !== undefined) episode.overview = updateTVEpisodeDto.overview;
          if (updateTVEpisodeDto.runtime != undefined) episode.runtime = updateTVEpisodeDto.runtime;
          if (updateTVEpisodeDto.airDate != undefined) episode.airDate = updateTVEpisodeDto.airDate;
          if (updateTVEpisodeDto.visibility !== undefined) episode.visibility = updateTVEpisodeDto.visibility;
          if (episode.isModified('visibility') || episode.isModified('epNumber')) {
            // Try to find the latest episode
            if (media.tv.lastEpisode == undefined) {
              if (episode.pStatus === MediaPStatus.DONE) media.tv.lastEpisode = episode._id;
            } else {
              const lastEpisode = await this.findLastEpisode(id, episode._id, false, true);
              const isCurrentEpisodeValid = episode.pStatus === MediaPStatus.DONE;
              if (lastEpisode && (lastEpisode.epNumber > episode.epNumber || !isCurrentEpisodeValid)) {
                media.tv.lastEpisode = lastEpisode._id;
              } else if (isCurrentEpisodeValid) {
                media.tv.lastEpisode = episode._id;
              } else {
                media.tv.lastEpisode = undefined;
              }
            }
            // Try to find the latest public episode if the current episode is not public anymore
            if (media.tv.pLastEpisode == undefined) {
              if (episode.visibility === MediaVisibility.PUBLIC && episode.pStatus === MediaPStatus.DONE)
                media.tv.pLastEpisode = episode._id;
            } else {
              const publicLastEpisode = await this.findLastEpisode(id, episode._id, true, true);
              const isCurrentEpisodeValid =
                episode.visibility === MediaVisibility.PUBLIC && episode.pStatus === MediaPStatus.DONE;
              if (publicLastEpisode && (publicLastEpisode.epNumber > episode.epNumber || !isCurrentEpisodeValid)) {
                media.tv.pLastEpisode = publicLastEpisode._id;
              } else if (isCurrentEpisodeValid) {
                media.tv.pLastEpisode = episode._id;
              } else {
                media.tv.pLastEpisode = undefined;
              }
            }
          }
          auditLog.getChangesFrom(episode, ['status', 'pStatus']);
          await episode.save({ session });
          // Populate episodes and sort by episode number, if the episode number is changed
          // Only populate episodes when the this episode is saved
          if (updateTVEpisodeDto.epNumber != undefined && updateTVEpisodeDto.epNumber !== oldEpisodeNumber) {
            media.$session(session);
            await media.populate('tv.episodes', { epNumber: 1 });
            const sortedEpisodes = media.tv.episodes.sort((curEp, nextEp) => curEp.epNumber - nextEp.epNumber);
            media.depopulate('tv.episodes');
            media.tv.episodes = <any>sortedEpisodes.map((e) => e._id);
          }
          await Promise.all([
            media.updateOne(media.getChanges(), { session, timestamps: false }),
            this.auditLogService.createLogFromBuilder(auditLog)
          ]);
        })
        .finally(() => session.endSession().catch(() => {}));
    }
    const serializedEpisode = instanceToPlain(plainToInstance(TVEpisodeEntity, episode.toObject()));
    serializedEpisode.pStatus = undefined;
    const ioEmitter = this.resolveIoEmitter(headers.socketId);
    ioEmitter
      .to([`${SocketRoom.ADMIN_MEDIA_DETAILS}:${id}`, `${SocketRoom.ADMIN_EPISODE_DETAILS}:${episode._id}`])
      .emit(SocketMessage.REFRESH_TV_EPISODE, {
        mediaId: id,
        episodeId: episode._id,
        episode: serializedEpisode
      });
    return serializedEpisode;
  }

  async deleteTVEpisode(id: bigint, episodeId: bigint, headers: HeadersDto, authUser: AuthUserDto) {
    const media = await this.mediaModel.findOne({ _id: id, type: MediaType.TV }, { _id: 1, tv: 1 }).exec();
    if (!media)
      throw new HttpException({ code: StatusCode.MEDIA_NOT_FOUND, message: 'Media not found' }, HttpStatus.NOT_FOUND);
    const session = await this.mongooseConnection.startSession();
    await session
      .withTransaction(async () => {
        const episode = await this.deleteEpisodeById(episodeId, session);
        if (!episode)
          throw new HttpException(
            { code: StatusCode.EPISODE_NOT_FOUND, message: 'Episode not found' },
            HttpStatus.NOT_FOUND
          );
        media.tv.episodes.pull(episodeId);
        media.tv.episodeCount = media.tv.episodes.length;
        let lastEpisode: TVEpisode;
        if (episode._id === media.tv.lastEpisode) {
          lastEpisode = await this.findLastEpisode(id, episode._id, false, true);
          media.tv.lastEpisode = <any>lastEpisode?._id;
        }
        if (episode._id === media.tv.pLastEpisode) {
          const publicLastEpisode =
            media.tv.lastEpisode === media.tv.pLastEpisode
              ? lastEpisode
              : await this.findLastEpisode(id, episode._id, true, true);
          media.tv.pLastEpisode = <any>publicLastEpisode?._id;
        }
        await Promise.all([
          media.save({ session, timestamps: false }),
          this.auditLogService.createLog(authUser._id, episode._id, TVEpisode.name, AuditLogType.EPISODE_DELETE)
        ]);
      })
      .finally(() => session.endSession().catch(() => {}));
    const ioEmitter = this.resolveIoEmitter(headers.socketId);
    ioEmitter
      .to([`${SocketRoom.ADMIN_MEDIA_DETAILS}:${id}`, `${SocketRoom.ADMIN_EPISODE_DETAILS}:${episodeId}`])
      .emit(SocketMessage.REFRESH_TV_EPISODE, {
        mediaId: id,
        episodeId: episodeId,
        deleted: true
      });
  }

  private async deleteEpisodeById(episodeId: bigint, session: ClientSession) {
    const episode = await this.tvEpisodeModel.findOneAndDelete({ _id: episodeId }, { session }).lean();
    if (!episode) return;
    await this.deleteMediaImage(episode.still, CloudflareR2Container.STILLS);
    const deleteSubtitleLimit = pLimit(5);
    await Promise.all(
      episode.subtitles.map((subtitle) => deleteSubtitleLimit(() => this.deleteMediaSubtitle(subtitle)))
    );
    await Promise.all([
      this.deleteMediaSource(<bigint>(<unknown>episode.source), session),
      this.chapterTypeService.deleteTVEpisodeChapterTypes(
        episodeId,
        episode.chapters.map((c) => <bigint>(<unknown>c.type)),
        session
      ),
      this.historyService.deleteTVEpisodeHistory(<bigint>(<unknown>episode.media), episodeId, session)
    ]);
    if (episode.tJobs.length) {
      await this.redisPubSubService.publishJson('video-cancel', { ids: episode.tJobs });
      await this.removeFromTranscodeQueue(episode.tJobs);
    }
    return episode;
  }

  async uploadTVEpisodeSource(
    id: bigint,
    episodeId: bigint,
    addMediaSourceDto: AddMediaSourceDto,
    authUser: AuthUserDto
  ) {
    const episode = await this.tvEpisodeModel.findOne({ _id: episodeId, media: id }, { source: 1 }).lean().exec();
    if (!episode)
      throw new HttpException(
        { code: StatusCode.EPISODE_NOT_FOUND, message: 'Episode not found' },
        HttpStatus.NOT_FOUND
      );
    if (episode.source)
      throw new HttpException(
        { code: StatusCode.MEDIA_SOURCE_EXIST, message: 'Source has already been added' },
        HttpStatus.BAD_REQUEST
      );
    return this.createUploadSourceSession(addMediaSourceDto, authUser._id);
  }

  async addLinkedTVEpisodeSource(
    id: bigint,
    episodeId: bigint,
    addLinkedMediaSourceDto: AddLinkedMediaSourceDto,
    baseUrl: string,
    authUser: AuthUserDto
  ) {
    const media = await this.mediaModel.findOne({ _id: id, type: MediaType.TV }, { _id: 1, pStatus: 1 }).exec();
    if (!media)
      throw new HttpException({ code: StatusCode.MEDIA_NOT_FOUND, message: 'Media not found' }, HttpStatus.NOT_FOUND);
    const episode = await this.tvEpisodeModel
      .findOne({ _id: episodeId, media: id }, { source: 1, status: 1, pStatus: 1, tJobs: 1 })
      .exec();
    if (!episode)
      throw new HttpException(
        { code: StatusCode.EPISODE_NOT_FOUND, message: 'Episode not found' },
        HttpStatus.NOT_FOUND
      );
    if (episode.source)
      throw new HttpException(
        { code: StatusCode.MEDIA_SOURCE_EXIST, message: 'Source has already been added' },
        HttpStatus.BAD_REQUEST
      );
    const mediaSource = await this.createLinkedMediaSource(addLinkedMediaSourceDto, id, episodeId);
    // Start encoding from linked source
    const streamSettings = await this.settingsService.findStreamSettings();
    episode.source = mediaSource._id;
    episode.status = MediaSourceStatus.PROCESSING;
    episode.pStatus = MediaPStatus.PROCESSING;
    media.pStatus !== MediaPStatus.DONE && (media.pStatus = MediaPStatus.PROCESSING);
    const queueData: MediaQueueDataDto = {
      _id: mediaSource._id,
      filename: mediaSource.name,
      path: mediaSource.path,
      size: mediaSource.size,
      mimeType: mediaSource.mimeType,
      storage: <bigint>(<unknown>mediaSource.storage),
      linkedStorage: <bigint>(<unknown>mediaSource.linkedStorage),
      user: authUser._id,
      producerUrl: baseUrl,
      advancedOptions: mediaSource.options
    };
    const addedJobs = await this.createTranscodeQueue(media._id, queueData, streamSettings, episode._id);
    addedJobs.forEach((j) => episode.tJobs.push(+j.id));
    await media.save({ timestamps: false });
    await episode.save();
    this.wsAdminGateway.server
      .to([
        SocketRoom.ADMIN_MEDIA_LIST,
        `${SocketRoom.ADMIN_MEDIA_DETAILS}:${id}`,
        `${SocketRoom.ADMIN_EPISODE_DETAILS}:${episodeId}`
      ])
      .emit(SocketMessage.SAVE_TV_SOURCE, {
        mediaId: media._id,
        episodeId: episode._id
      });
  }

  async encodeTVEpisodeSource(
    id: bigint,
    episodeId: bigint,
    encodeMediaSourceDto: EncodeMediaSourceDto,
    baseUrl: string,
    authUser: AuthUserDto
  ) {
    const episode = await this.tvEpisodeModel.findOne({ _id: episodeId, media: id }).exec();
    if (!episode)
      throw new HttpException(
        { code: StatusCode.EPISODE_NOT_FOUND, message: 'Episode not found' },
        HttpStatus.NOT_FOUND
      );
    if (!episode.source)
      throw new HttpException(
        { code: StatusCode.MEDIA_SOURCE_NOT_FOUND, message: 'Media source not found' },
        HttpStatus.NOT_FOUND
      );
    if (episode.status !== MediaSourceStatus.DONE)
      throw new HttpException(
        { code: StatusCode.EPISODE_ENCODING_UNAVAILABLE, message: 'This feature is currently not available' },
        HttpStatus.NOT_FOUND
      );
    const sourceAdvancedOptions = encodeMediaSourceDto.options || {};
    // Save options to database
    const {
      selectAudioTracks,
      extraAudioTracks,
      forceVideoQuality,
      h264Tune,
      queuePriority,
      videoCodecs,
      overrideSettings,
      audioOnly,
      videoOnly
    } = sourceAdvancedOptions;
    const updateQuery: UpdateQuery<MediaStorageDocument> = encodeMediaSourceDto.options
      ? {
          $set: {
            options: {
              selectAudioTracks,
              extraAudioTracks,
              forceVideoQuality,
              h264Tune,
              queuePriority,
              videoCodecs,
              overrideSettings
            }
          }
        }
      : {};
    const uploadedSource = await this.mediaStorageModel
      .findOneAndUpdate({ _id: episode.source }, updateQuery, { new: true })
      .populate('storage')
      .lean()
      .exec();
    if (!uploadedSource)
      throw new HttpException(
        { code: StatusCode.MEDIA_SOURCE_NOT_FOUND, message: 'Media source not found' },
        HttpStatus.NOT_FOUND
      );
    const streamSettings = await this.settingsService.findStreamSettings();
    const targetVideoCodecs =
      uploadedSource.options?.videoCodecs ||
      (streamSettings.defaultVideoCodecs !== STREAM_CODECS[0] ? streamSettings.defaultVideoCodecs : null);
    const replaceStreams = this.findReplaceStreams(uploadedSource, targetVideoCodecs, audioOnly, videoOnly);
    const queueData: MediaQueueDataDto = {
      _id: uploadedSource._id,
      filename: uploadedSource.name,
      path: uploadedSource.path,
      size: uploadedSource.size,
      mimeType: uploadedSource.mimeType,
      storage: uploadedSource.storage._id,
      linkedStorage: <bigint>(<unknown>uploadedSource.linkedStorage),
      user: authUser._id,
      update: true,
      replaceStreams,
      producerUrl: baseUrl,
      advancedOptions: encodeMediaSourceDto.options
    };
    const addedJobs = await this.createTranscodeQueue(id, queueData, streamSettings, episodeId);
    addedJobs.forEach((j) => episode.tJobs.push(+j.id));
    if (replaceStreams.length) {
      // Back to ready status
      episode.status = MediaSourceStatus.READY;
    }
    await episode.save();
    this.wsAdminGateway.server
      .to([SocketRoom.ADMIN_MEDIA_LIST, `${SocketRoom.ADMIN_MEDIA_DETAILS}:${episode._id}`])
      .emit(SocketMessage.SAVE_MOVIE_SOURCE, {
        mediaId: episode._id
      });
  }

  async saveTVEpisodeSource(
    id: bigint,
    episodeId: bigint,
    sessionId: bigint,
    saveMediaSourceDto: SaveMediaSourceDto,
    baseUrl: string,
    authUser: AuthUserDto
  ) {
    const media = await this.mediaModel.findOne({ _id: id, type: MediaType.TV }, { _id: 1, pStatus: 1 }).exec();
    if (!media)
      throw new HttpException({ code: StatusCode.MEDIA_NOT_FOUND, message: 'Media not found' }, HttpStatus.NOT_FOUND);
    const episode = await this.tvEpisodeModel
      .findOne({ _id: episodeId, media: id }, { _id: 1, source: 1, status: 1, tJobs: 1 })
      .exec();
    if (!episode)
      throw new HttpException(
        { code: StatusCode.EPISODE_NOT_FOUND, message: 'Episode not found' },
        HttpStatus.NOT_FOUND
      );
    if (episode.source)
      throw new HttpException(
        { code: StatusCode.MEDIA_SOURCE_EXIST, message: 'Source has already been added' },
        HttpStatus.CONFLICT
      );
    const uploadSession = await this.driveSessionModel
      .findOne({ _id: sessionId, user: authUser._id })
      .populate('storage')
      .lean()
      .exec();
    if (!uploadSession)
      throw new HttpException(
        { code: StatusCode.DRIVE_SESSION_NOT_FOUND, message: 'Upload session not found' },
        HttpStatus.NOT_FOUND
      );
    let fileInfo: StorageFileInfo;
    fileInfo = await this.resolveStorageService(uploadSession.storage.kind).findId(
      saveMediaSourceDto.fileId,
      uploadSession.storage
    );
    if (fileInfo.name !== uploadSession.filename || fileInfo.size != uploadSession.size) {
      await this.resolveStorageService(uploadSession.storage.kind).deleteFolder(
        uploadSession._id,
        uploadSession.storage
      );
      await this.driveSessionModel.deleteOne({ _id: sessionId }).exec();
      throw new HttpException(
        { code: StatusCode.DRIVE_FILE_INVALID, message: 'You have uploaded an invalid file' },
        HttpStatus.UNSUPPORTED_MEDIA_TYPE
      );
    }
    const auditLog = new AuditLogBuilder(
      authUser._id,
      uploadSession._id,
      MediaStorage.name,
      AuditLogType.MEDIA_STORAGE_FILE_CREATE
    );
    const streamSettings = await this.settingsService.findStreamSettings();
    const session = await this.mongooseConnection.startSession();
    await session
      .withTransaction(async () => {
        // Add original source to media
        const mediaSource = new this.mediaStorageModel({
          _id: uploadSession._id,
          type: MediaStorageType.SOURCE,
          name: uploadSession.filename,
          path: String(uploadSession._id),
          mimeType: uploadSession.mimeType,
          size: uploadSession.size,
          options: uploadSession.options,
          media: media._id,
          episode: episode._id,
          storage: uploadSession.storage._id
        });
        episode.source = uploadSession._id;
        episode.status = MediaSourceStatus.PROCESSING;
        episode.pStatus = MediaPStatus.PROCESSING;
        media.pStatus !== MediaPStatus.DONE && (media.pStatus = MediaPStatus.PROCESSING);
        const queueData: MediaQueueDataDto = {
          _id: uploadSession._id,
          filename: uploadSession.filename,
          path: mediaSource.path,
          size: uploadSession.size,
          mimeType: uploadSession.mimeType,
          storage: uploadSession.storage._id,
          user: authUser._id,
          producerUrl: baseUrl,
          advancedOptions: uploadSession.options
        };
        const addedJobs = await this.createTranscodeQueue(media._id, queueData, streamSettings, episode._id);
        addedJobs.forEach((j) => episode.tJobs.push(+j.id));
        auditLog.appendChange('type', MediaStorageType.SOURCE);
        auditLog.appendChange('name', uploadSession.filename);
        auditLog.appendChange('path', uploadSession._id);
        auditLog.appendChange('size', uploadSession.size);
        auditLog.appendChange('mimeType', uploadSession.mimeType);
        auditLog.appendChange('storage', uploadSession.storage._id);
        await mediaSource.save({ session });
        await Promise.all([
          this.externalStoragesService.addFileToStorage(
            uploadSession.storage._id,
            uploadSession._id,
            uploadSession.size,
            session
          ),
          this.driveSessionModel.deleteOne({ _id: sessionId }, { session }),
          episode.updateOne(episode.getChanges(), { session }),
          media.updateOne(media.getChanges(), { session, timestamps: false }),
          this.auditLogService.createLogFromBuilder(auditLog)
        ]);
      })
      .finally(() => session.endSession().catch(() => {}));
    this.wsAdminGateway.server
      .to([
        SocketRoom.ADMIN_MEDIA_LIST,
        `${SocketRoom.ADMIN_MEDIA_DETAILS}:${id}`,
        `${SocketRoom.ADMIN_EPISODE_DETAILS}:${episodeId}`
      ])
      .emit(SocketMessage.SAVE_TV_SOURCE, {
        mediaId: media._id,
        episodeId: episode._id
      });
  }

  async deleteTVEpisodeSource(id: bigint, episodeId: bigint, headers: HeadersDto, authUser: AuthUserDto) {
    const media = await this.mediaModel.findOne({ _id: id, type: MediaType.TV }, { _id: 1, tv: 1, pStatus: 1 }).exec();
    if (!media)
      throw new HttpException({ code: StatusCode.MEDIA_NOT_FOUND, message: 'Media not found' }, HttpStatus.NOT_FOUND);
    const episode = await this.tvEpisodeModel
      .findOne({ _id: episodeId, media: id }, { _id: 1, source: 1, streams: 1, status: 1, tJobs: 1 })
      .exec();
    if (!episode)
      throw new HttpException(
        { code: StatusCode.EPISODE_NOT_FOUND, message: 'Episode not found' },
        HttpStatus.NOT_FOUND
      );
    const session = await this.mongooseConnection.startSession();
    await session
      .withTransaction(async () => {
        await this.deleteMediaSource(<bigint>(<unknown>episode.source), session);
        if (episode.tJobs.length) {
          await this.redisPubSubService.publishJson('video-cancel', { ids: episode.tJobs });
          await this.removeFromTranscodeQueue(episode.tJobs);
          episode.tJobs = new Types.Array<number>();
        }
        episode.source = undefined;
        episode.status = MediaSourceStatus.PENDING;
        episode.pStatus = MediaPStatus.PENDING;
        let lastEpisode: TVEpisode;
        if (episode._id === media.tv.lastEpisode) {
          lastEpisode = await this.findLastEpisode(id, episode._id, false, true);
          media.tv.lastEpisode = <any>lastEpisode?._id;
        }
        if (episode._id === media.tv.pLastEpisode) {
          const publicLastEpisode =
            media.tv.pLastEpisode === media.tv.lastEpisode
              ? lastEpisode
              : await this.findLastEpisode(id, episode._id, true, true);
          media.tv.pLastEpisode = <any>publicLastEpisode?._id;
        }
        if (!media.tv.pLastEpisode && !media.tv.lastEpisode) {
          media.pStatus = MediaPStatus.PENDING;
        }
        await episode.save({ session });
        await Promise.all([
          media.updateOne(media.getChanges(), { session, timestamps: false }),
          this.auditLogService.createLog(authUser._id, episode._id, TVEpisode.name, AuditLogType.EPISODE_SOURCE_DELETE)
        ]);
      })
      .finally(() => session.endSession().catch(() => {}));
    const ioEmitter = this.resolveIoEmitter(headers.socketId);
    ioEmitter
      .to([SocketRoom.ADMIN_MEDIA_LIST, `${SocketRoom.ADMIN_MEDIA_DETAILS}:${id}`])
      .to(`${SocketRoom.ADMIN_EPISODE_DETAILS}:${episodeId}`)
      .emit(SocketMessage.DELETE_TV_SOURCE, {
        mediaId: id,
        episodeId: episodeId
      });
    ioEmitter.to(SocketRoom.ADMIN_MEDIA_LIST).emit(SocketMessage.REFRESH_MEDIA, {
      mediaId: media._id
    });
  }

  async addTVEpisodeAudioStream(mediaQueueResultDto: MediaQueueResultDto) {
    const filePath = `${mediaQueueResultDto.progress.sourceId}/${mediaQueueResultDto.progress.streamId}/${mediaQueueResultDto.progress.fileName}`;
    const storage = await this.externalStoragesService.findStorageById(mediaQueueResultDto.storage);
    let fileInfo: StorageFileInfo;
    fileInfo = await this.resolveStorageService(storage.kind).findPath(filePath, mediaQueueResultDto.storage);
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
    fileInfo = await this.resolveStorageService(storage.kind).findPath(filePath, mediaQueueResultDto.storage);
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
    fileInfo = await this.resolveStorageService(storage.kind).findPath(filePath, mediaQueueResultDto.storage);
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
          await this.deleteMediaStreams(oldManifestIds, source._id, session);
          await this.deleteMediaStreamFromStorage(oldManifestIds, source._id, storage);
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
          await this.deleteMediaStreams(mediaQueueResultDto.replaceStreams, <bigint>(<unknown>episode.source), session);
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
          await this.deleteMediaStreams(streamIds, episode.source._id, session);
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

  async handleTVEpisodeStreamQueueRetry(jobId: number | string, mediaQueueResultDto: MediaQueueResultDto) {
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
        await this.deleteMediaStreams(streamIds, source._id, session);
        await this.deleteMediaStreamFromStorage(
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
            await this.deleteMediaSource(<bigint>(<unknown>episode.source), session);
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
              await this.deleteMediaStreams(streamByCodecIds, source._id, session);
              await this.deleteMediaStreamFromStorage(streamByCodecIds, source._id, source.storage);
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

  async findAllTVEpisodeStreams(
    id: bigint,
    epNumber: number,
    findMediaStreamsDto: FindMediaStreamsDto,
    authUser: AuthUserDto
  ) {
    const incViews = findMediaStreamsDto.preview && authUser.hasPermission ? 0 : 1;
    const media = await this.mediaModel
      .findOneAndUpdate(
        { _id: id, type: MediaType.TV },
        { $inc: { views: incViews, dailyViews: incViews, weeklyViews: incViews, monthlyViews: incViews } },
        { timestamps: false }
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
    if (media.pStatus !== MediaPStatus.DONE)
      throw new HttpException({ code: StatusCode.TV_NOT_READY, message: 'TV Show is not ready' }, HttpStatus.NOT_FOUND);
    const episode = await this.tvEpisodeModel
      .findOneAndUpdate({ media: id, epNumber: epNumber }, { $inc: { views: 1 } }, { timestamps: false })
      .populate([
        {
          path: 'source',
          populate: { path: 'storage', select: { _id: 1, kind: 1, folderId: 1, publicUrl: 1, secondPublicUrl: 1 } }
        }
      ])
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
    if (!episode.source.streams?.length)
      throw new HttpException(
        { code: StatusCode.MEDIA_STREAM_NOT_FOUND, message: 'Media stream not found' },
        HttpStatus.NOT_FOUND
      );
    const manifestStreams = episode.source.streams.filter((s) => s.type === MediaStorageType.MANIFEST);
    const storage = {
      ...episode.source.storage,
      publicUrl: this.resolveStoragePublicUrl(
        episode.source.storage.kind,
        episode.source.storage.publicUrl,
        episode.source.storage.folderId
      ),
      secondPublicUrl: episode.source.storage.secondPublicUrl
        ? this.resolveStoragePublicUrl(
            episode.source.storage.kind,
            episode.source.storage.secondPublicUrl,
            episode.source.storage.folderId
          )
        : undefined
    };
    return plainToInstance(MediaStream, {
      _id: media._id,
      episode: episode,
      storage: storage,
      sourcePath: storage.folderId
        ? storage.folderId + '/' + episode.source._id.toString()
        : episode.source._id.toString(),
      streams: manifestStreams,
      subtitles: episode.subtitles
    });
  }

  @Cron('0 0 0 * * *')
  async removeOldUploadSessionsCron() {
    const uploadSessions = await this.driveSessionModel
      .find({ expiry: { $lte: new Date() } })
      .populate('storage')
      .lean()
      .exec();
    await this.driveSessionModel.deleteMany({ expiry: { $lte: new Date() } }).exec();
    for (let i = 0; i < uploadSessions.length; i++) {
      const session = uploadSessions[i];
      await this.resolveStorageService(session.storage.kind).deleteFolder(session._id, session.storage);
    }
  }

  @Cron('0 0 * * *')
  async resetDailyViewsCron() {
    await this.mediaModel.updateMany({ dailyViews: { $gt: 0 } }, { dailyViews: 0 }).exec();
  }

  @Cron('0 0 * * 1')
  async resetWeeklyViewsCron() {
    await this.mediaModel.updateMany({ weeklyViews: { $gt: 0 } }, { weeklyViews: 0 }).exec();
  }

  @Cron('0 0 1 * *')
  async resetMonthlyViewsCron() {
    await this.mediaModel.updateMany({ monthlyViews: { $gt: 0 } }, { monthlyViews: 0 }).exec();
  }

  async updateMediaRating(id: bigint, incCount: number, incScore: number, session?: ClientSession) {
    const media = await this.mediaModel.findOne(
      { _id: id, pStatus: MediaPStatus.DONE },
      {
        ratingCount: 1,
        ratingScore: 1,
        ratingAverage: 1
      },
      { session }
    );
    if (!media) return;
    media.ratingCount += incCount;
    media.ratingScore += incScore;
    // Avoid divine by zero in case rating count is 0
    media.ratingAverage = media.ratingCount === 0 ? 0 : +(media.ratingScore / media.ratingCount).toFixed(1);
    await media.save({ session });
    return media.toObject();
  }

  findOneById(id: bigint, fields?: { [key: string]: any }) {
    return this.mediaModel.findOne({ _id: id }, fields).lean().exec();
  }

  findOneTVEpisodeById(id: bigint, episodeId: bigint, fields?: { [key: string]: any }) {
    return this.tvEpisodeModel.findOne({ _id: episodeId, media: id }, fields).lean().exec();
  }

  findOneTVEpisodeByNumber(id: bigint, epNumber: number, fields?: { [key: string]: any }) {
    return this.tvEpisodeModel.findOne({ media: id, epNumber: epNumber }, fields).lean().exec();
  }

  findAvailableMedia(id: bigint, session?: ClientSession) {
    return this.mediaModel.findOne({ _id: id, pStatus: MediaPStatus.DONE }, {}, { session }).lean();
  }

  async findOneForPlaylist(id: bigint) {
    return this.mediaModel
      .findOne(
        { _id: id },
        {
          _id: 1,
          type: 1,
          title: 1,
          originalTitle: 1,
          overview: 1,
          runtime: 1,
          'movie.status': 1,
          'tv.pLastEpisode': 1,
          poster: 1,
          backdrop: 1,
          originalLang: 1,
          adult: 1,
          releaseDate: 1,
          views: 1,
          visibility: 1,
          _translations: 1,
          pStatus: 1,
          createdAt: 1,
          updatedAt: 1
        }
      )
      .lean()
      .exec();
  }

  private async createFindAllParams(
    paginateMediaDto: OffsetPageMediaDto | CursorPageMediaDto,
    hasPermission: boolean
  ): Promise<[{ [key: string]: number }, { [key: string]: any }]> {
    const fields: { [key: string]: number } = {
      _id: 1,
      type: 1,
      title: 1,
      originalTitle: 1,
      slug: 1,
      overview: 1,
      runtime: 1,
      'movie.status': 1,
      'tv.episodeCount': 1,
      'tv.lastAirDate': 1,
      'tv.pLastEpisode': 1,
      poster: 1,
      backdrop: 1,
      genres: 1,
      originalLang: 1,
      adult: 1,
      releaseDate: 1,
      views: 1,
      dailyViews: 1,
      weeklyViews: 1,
      monthlyViews: 1,
      ratingCount: 1,
      ratingAverage: 1,
      visibility: 1,
      _translations: 1,
      createdAt: 1,
      updatedAt: 1
    };
    const {
      adult,
      type,
      originalLang,
      year,
      genres,
      tags,
      genreMatch,
      tagMatch,
      excludeIds,
      preset,
      presetParams,
      includeHidden,
      includeUnprocessed
    } = paginateMediaDto;
    const filters: { [key: string]: any } = {};
    if (presetParams?.length) {
      if (preset === 'related') {
        const refMediaId = BigInt(presetParams[0]);
        filters.$or = await this.localCacheService.wrap(
          `${CachePrefix.MEDIA_FIND_FILTER_RELATED}:${refMediaId}`,
          async () => {
            const refMedia = await this.mediaModel
              .findOne({ _id: refMediaId }, { genres: 1, studios: 1, producers: 1, tags: 1 })
              .lean()
              .exec();
            return [
              { genres: { $in: refMedia.genres } },
              { producers: { $in: refMedia.producers } },
              { studios: { $in: refMedia.studios } },
              { tags: { $in: refMedia.tags } }
            ];
          },
          1_800_000
        );
        filters._id = { $ne: refMediaId };
      }
    }
    type != undefined && (filters.type = type);
    originalLang != undefined && (filters.originalLang = originalLang);
    year != undefined && (filters['releaseDate.year'] = year);
    adult != undefined && (filters.adult = adult);
    if (Array.isArray(genres)) {
      const genreMatchMode = genreMatch === 'all' ? '$all' : '$in';
      filters.genres = { [genreMatchMode]: genres };
    } else if (genres != undefined) {
      filters.genres = genres;
    }
    if (Array.isArray(tags)) {
      const tagMatchMode = tagMatch === 'all' ? '$all' : '$in';
      filters.tags = { [tagMatchMode]: tags };
    } else if (tags != undefined) {
      filters.tags = tags;
    }
    if (Array.isArray(excludeIds)) {
      filters._id = { $nin: excludeIds };
    } else if (excludeIds != undefined) {
      filters._id = { $ne: excludeIds };
    }
    hasPermission && (fields.pStatus = 1);
    hasPermission && (fields['tv.lastEpisode'] = 1);
    (!hasPermission || !includeHidden) && (filters.visibility = MediaVisibility.PUBLIC);
    (!hasPermission || !includeUnprocessed) && (filters.pStatus = MediaPStatus.DONE);
    return [fields, filters];
  }

  private findLastEpisode(
    mediaId: bigint,
    excludeEpId: bigint,
    publicOnly: boolean = false,
    watchable: boolean = false
  ) {
    const filters: FilterQuery<TVEpisodeDocument> = { media: mediaId, _id: { $ne: excludeEpId } };
    if (publicOnly) filters.visibility = MediaVisibility.PUBLIC;
    if (watchable) {
      filters.pStatus = MediaPStatus.DONE;
    }
    return this.tvEpisodeModel.findOne(filters, { _id: 1, epNumber: 1 }).sort({ epNumber: -1 }).lean().exec();
  }

  // Create new genres and productions start with "create:" keyword, check existing ones by ids
  /**
   * Shared find-or-create for genre/production/tag references. Entries shaped
   * `create:name=...` become new documents; everything else is treated as an
   * existing BigInt id and verified to resolve. Per-entity differences (label,
   * max name length, not-found code, extra fields) come from `config`.
   */
  private async findOrCreateEntities(
    inputs: string[],
    creatorId: bigint,
    session: ClientSession,
    config: {
      service: {
        countByIds(ids: bigint[]): Promise<number>;
        createMany(items: any[], creatorId: bigint, session?: ClientSession): Promise<any[]>;
      };
      label: string;
      maxNameLength: number;
      notFoundCode: StatusCode;
      buildEntity: (name: string, query: URLSearchParams) => Record<string, unknown>;
    }
  ) {
    const newEntities: Record<string, unknown>[] = [];
    const existingIds: bigint[] = [];
    for (let i = 0; i < inputs.length; i++) {
      if (inputs[i].startsWith('create:')) {
        const query = new URLSearchParams(inputs[i].substring(7));
        const name = query.get('name');
        if (!name)
          throw new HttpException(
            { code: StatusCode.IS_NOT_EMPTY, message: `${config.label} name must not be empty` },
            HttpStatus.BAD_REQUEST
          );
        if (name.length > config.maxNameLength)
          throw new HttpException(
            {
              code: StatusCode.MAX_LENGTH,
              message: `${config.label} name must not be longer than ${config.maxNameLength} characters`
            },
            HttpStatus.BAD_REQUEST
          );
        newEntities.push(config.buildEntity(name, query));
      } else {
        try {
          existingIds.push(BigInt(inputs[i]));
        } catch {
          continue;
        }
      }
    }
    if (existingIds.length) {
      const count = await config.service.countByIds(existingIds);
      if (count !== existingIds.length)
        throw new HttpException(
          { code: config.notFoundCode, message: `Cannot find all the required ${config.label.toLowerCase()}s` },
          HttpStatus.BAD_REQUEST
        );
    }
    if (newEntities.length) {
      const created = await config.service.createMany(newEntities, creatorId, session);
      existingIds.push(...created.map((e) => e._id));
    }
    return existingIds;
  }

  private findOrCreateGenres(genres: string[], creatorId: bigint, session: ClientSession) {
    return this.findOrCreateEntities(genres, creatorId, session, {
      service: this.genresService,
      label: 'Genre',
      maxNameLength: 32,
      notFoundCode: StatusCode.GENRES_NOT_FOUND,
      buildEntity: (name) => ({ name })
    });
  }

  private findOrCreateProductions(productions: string[], creatorId: bigint, session: ClientSession) {
    return this.findOrCreateEntities(productions, creatorId, session, {
      service: this.productionsService,
      label: 'Production',
      maxNameLength: 150,
      notFoundCode: StatusCode.PRODUCTIONS_NOT_FOUND,
      buildEntity: (name, query) => {
        const country = query.get('country');
        return { name, country: country && isISO31661Alpha2(country) ? country : null };
      }
    });
  }

  private findOrCreateTags(tags: string[], creatorId: bigint, session: ClientSession) {
    return this.findOrCreateEntities(tags, creatorId, session, {
      service: this.tagsService,
      label: 'Tag',
      maxNameLength: 32,
      notFoundCode: StatusCode.TAGS_NOT_FOUND,
      buildEntity: (name) => ({ name })
    });
  }

  private async deleteMediaSubtitle(subtitle: MediaFile) {
    if (!subtitle) return;
    await this.cloudflareR2Service.delete(CloudflareR2Container.SUBTITLES, `${subtitle._id}/${subtitle.name}`);
  }

  private async createUploadSourceSession(addMediaSourceDto: AddMediaSourceDto, userId: bigint) {
    const trimmedFilename = trimSlugFilename(addMediaSourceDto.filename);
    const driveSession = new this.driveSessionModel();
    driveSession._id = await createSnowFlakeId();
    driveSession.filename = trimmedFilename;
    driveSession.size = addMediaSourceDto.size;
    driveSession.mimeType = addMediaSourceDto.mimeType;
    addMediaSourceDto.options && (driveSession.options = this.createMediaSourceOptions(addMediaSourceDto.options));
    driveSession.user = <any>userId;
    driveSession.expiry = new Date(Date.now() + 86400000 * 3);
    const storage = await this.settingsService.findMediaSourceStorage();
    let uploadSession: any;
    if (storage.kind === CloudStorage.FILER) {
      uploadSession = await this.filerService.createUploadSession(
        trimmedFilename,
        driveSession._id.toString(),
        addMediaSourceDto.size,
        addMediaSourceDto.mimeType
      );
    } else if (storage.kind === CloudStorage.S3) {
      uploadSession = await this.s3Service.createMultipartUpload(
        trimmedFilename,
        addMediaSourceDto.mimeType,
        driveSession._id.toString()
      );
    } else {
      uploadSession = await this.onedriveService.createUploadSession(trimmedFilename, driveSession._id);
    }
    driveSession.storage = <any>uploadSession.storage;
    await driveSession.save();
    return { _id: driveSession._id, url: uploadSession.url, fileId: uploadSession.fileId };
  }

  private async createLinkedMediaSource(
    addMediaSourceDto: AddLinkedMediaSourceDto,
    mediaId: bigint,
    episodeId?: bigint
  ) {
    const linkedStorages = await this.settingsService.findLinkedMediaSourceStorages();

    let linkedFile: any = null;
    const filerStorages = linkedStorages.filter((s) => s.kind === CloudStorage.FILER);
    const s3Storages = linkedStorages.filter((s) => s.kind === CloudStorage.S3);
    const onedriveStorages = linkedStorages.filter((s) => s.kind === CloudStorage.ONEDRIVE);
    if (filerStorages.length) {
      linkedFile = await this.filerService.findInStorages(
        path.posix.join(addMediaSourceDto.linkedPath, addMediaSourceDto.filename),
        filerStorages
      );
    }
    if (!linkedFile && s3Storages.length) {
      linkedFile = await this.s3Service.findInStorages(
        path.posix.join(addMediaSourceDto.linkedPath, addMediaSourceDto.filename),
        s3Storages
      );
    }
    if (!linkedFile && onedriveStorages.length) {
      linkedFile = await this.onedriveService.findInStorages(
        path.posix.join(addMediaSourceDto.linkedPath, addMediaSourceDto.filename),
        onedriveStorages
      );
    }
    if (!linkedFile)
      throw new HttpException(
        { code: StatusCode.DRIVE_FILE_NOT_FOUND, message: 'Linked file not found' },
        HttpStatus.NOT_FOUND
      );
    const streamStorage = await this.settingsService.findMediaSourceStorage({ decrypt: false });
    const mediaSource = new this.mediaStorageModel();
    mediaSource._id = await createSnowFlakeId();
    mediaSource.type = MediaStorageType.SOURCE;
    mediaSource.name = linkedFile.file.name;
    mediaSource.path = addMediaSourceDto.linkedPath;
    mediaSource.mimeType = addMediaSourceDto.mimeType;
    mediaSource.size = linkedFile.file.size;
    addMediaSourceDto.options && (mediaSource.options = this.createMediaSourceOptions(addMediaSourceDto.options));
    mediaSource.media = <any>mediaId;
    episodeId && (mediaSource.episode = <any>episodeId);
    mediaSource.storage = <any>streamStorage._id;
    mediaSource.linkedStorage = <any>linkedFile.storage._id;
    await mediaSource.save();
    return mediaSource;
  }

  private createMediaSourceOptions(advancedOpions: MediaQueueAdvancedDto) {
    const options = new MediaSourceOptions();
    options.selectAudioTracks = advancedOpions.selectAudioTracks;
    options.extraAudioTracks = advancedOpions.extraAudioTracks;
    options.forceVideoQuality = advancedOpions.forceVideoQuality;
    options.h264Tune = advancedOpions.h264Tune;
    options.queuePriority = advancedOpions.queuePriority;
    options.videoCodecs = advancedOpions.videoCodecs;
    options.overrideSettings = new Types.DocumentArray<EncodingSetting>(advancedOpions.overrideSettings);
    return options;
  }

  private findReplaceStreams(
    uploadedSource: FlattenMaps<MediaStorageDocument>,
    targetVideoCodecs?: number,
    audioOnly?: boolean,
    videoOnly?: boolean
  ) {
    const replaceStreams: bigint[] = [];
    const videoStreams = uploadedSource.streams.filter((s) => s.type === MediaStorageType.STREAM_VIDEO);
    const manifestStreams = uploadedSource.streams.filter((s) => s.type === MediaStorageType.MANIFEST);
    const audioStreams = uploadedSource.streams.filter((s) => s.type === MediaStorageType.STREAM_AUDIO);
    if (!videoOnly && !audioOnly) {
      if (targetVideoCodecs) {
        for (let i = 0; i < STREAM_CODECS.length; i++) {
          if (targetVideoCodecs & STREAM_CODECS[i])
            replaceStreams.push(
              ...videoStreams.filter((s) => s.codec === STREAM_CODECS[i]).map((s) => s._id),
              ...manifestStreams.filter((s) => s.codec === STREAM_CODECS[i]).map((s) => s._id)
            );
          if (targetVideoCodecs & STREAM_CODECS[0]) replaceStreams.push(...audioStreams.map((s) => s._id));
        }
      } else {
        replaceStreams.push(...uploadedSource.streams.map((s) => s._id));
      }
    } else if (videoOnly) {
      if (targetVideoCodecs) {
        for (let i = 0; i < STREAM_CODECS.length; i++) {
          if (targetVideoCodecs & STREAM_CODECS[i])
            replaceStreams.push(...videoStreams.filter((s) => s.codec === STREAM_CODECS[i]).map((s) => s._id));
        }
      } else {
        replaceStreams.push(...videoStreams.map((s) => s._id));
      }
    } else if (audioOnly) {
      replaceStreams.push(...audioStreams.map((s) => s._id));
    }
    return replaceStreams;
  }

  private async createTranscodeQueue(
    mediaId: bigint,
    queueData: MediaQueueDataDto,
    streamSettings: Setting,
    episodeId?: bigint
  ) {
    const basePriority = queueData.advancedOptions?.queuePriority || 10;
    const defaultCodecs = streamSettings.defaultVideoCodecs > 0 ? streamSettings.defaultVideoCodecs : VideoCodec.H264;
    const videoCodecs = queueData.advancedOptions?.videoCodecs || defaultCodecs;
    // Create transcode queue
    const jobs: Awaited<ReturnType<typeof this.videoTranscodeH264Queue.add>>[] = [];
    for (let i = 0; i < STREAM_CODECS.length; i++) {
      if (!(videoCodecs & STREAM_CODECS[i])) continue;
      const data = {
        ...queueData,
        media: mediaId,
        episode: episodeId,
        codec: STREAM_CODECS[i],
        // First codec is the primary job
        isPrimary: i === 0
      };
      const opts = {
        // Codec order affects priority
        priority: i + basePriority
      };
      switch (STREAM_CODECS[i]) {
        case VideoCodec.H264: {
          const addedJob = await this.videoTranscodeH264Queue.add(STREAM_CODECS[i].toString(), data, opts);
          jobs.push(addedJob);
          break;
        }
        case VideoCodec.H265: {
          const addedJob = await this.videoTranscodeH265Queue.add(STREAM_CODECS[i].toString(), data, opts);
          jobs.push(addedJob);
          break;
        }
        case VideoCodec.VP9: {
          const addedJob = await this.videoTranscodeVP9Queue.add(STREAM_CODECS[i].toString(), data, opts);
          jobs.push(addedJob);
          break;
        }
        case VideoCodec.AV1: {
          const addedJob = await this.videoTranscodeAV1Queue.add(STREAM_CODECS[i].toString(), data, opts);
          jobs.push(addedJob);
          break;
        }
      }
    }
    if (!jobs.length) {
      const fallbackData = {
        ...queueData,
        media: mediaId,
        episode: episodeId,
        codec: VideoCodec.H264,
        isPrimary: true
      };
      const fallbackJob = await this.videoTranscodeH264Queue.add(VideoCodec.H264.toString(), fallbackData, {
        priority: basePriority
      });
      jobs.push(fallbackJob);
    }
    return jobs;
  }

  private async removeFromTranscodeQueue(jobIds: number[]) {
    if (!jobIds?.length) return;
    for (let i = 0; i < jobIds.length; i++) {
      await this.videoTranscodeH264Queue.remove(jobIds[i].toString());
      await this.videoTranscodeH265Queue.remove(jobIds[i].toString());
      await this.videoTranscodeVP9Queue.remove(jobIds[i].toString());
      await this.videoTranscodeAV1Queue.remove(jobIds[i].toString());
    }
  }

  private async deleteMediaSource(id: bigint, session?: ClientSession) {
    if (!id) return;
    const source = await this.mediaStorageModel.findOneAndDelete({ _id: id }, { session }).populate('storage').lean();
    if (source) {
      const totalSourceSize = source.size + (source.streams?.reduce((a, b) => a + b.size, 0) || 0);
      await this.externalStoragesService.deleteFileFromStorage(source.storage._id, id, totalSourceSize, session);
      await this.resolveStorageService(source.storage.kind).deleteFolder(id, source.storage, 5);
    }
  }

  private async deleteMediaStreams(ids: bigint[], sourceId: bigint, session?: ClientSession) {
    if (!Array.isArray(ids)) return;
    const source = await this.mediaStorageModel
      .findOneAndUpdate({ _id: sourceId }, { $pull: { streams: { _id: { $in: ids } } } }, { session })
      .lean()
      .exec();
    if (source?.streams?.length) {
      const totalStreamSize = source.streams.filter((s) => ids.includes(s._id)).reduce((a, b) => a + b.size, 0);
      await this.externalStoragesService.updateStorageSize(
        <bigint>(<unknown>source.storage),
        -totalStreamSize,
        session
      );
    }
  }

  private async deleteMediaStreamFromStorage(ids: bigint[], sourceId: bigint, storage: ExternalStorage) {
    if (!Array.isArray(ids)) return;
    const deleteStreamLimit = pLimit(5);
    await Promise.all(
      ids.map((id) =>
        deleteStreamLimit(() => {
          return this.resolveStorageService(storage.kind).deleteFolder(`${sourceId}/${id}`, storage, 5);
        })
      )
    );
  }

  private async validateCollection(id: bigint) {
    const collection = await this.collectionService.findById(id);
    if (!collection)
      throw new HttpException(
        { code: StatusCode.COLLECTION_NOT_FOUND, message: 'Collection not found' },
        HttpStatus.NOT_FOUND
      );
    return collection;
  }

  private async validateCollections(ids: bigint[]) {
    const collections = [];
    for (let i = 0; i < ids.length; i++) {
      const collection = await this.validateCollection(ids[i]);
      collections.push(collection);
    }
    return collections;
  }

  private resolveStoragePublicUrl(kind: number, url: string, folderId?: string): string {
    let serviceUrl = url;
    switch (kind) {
      case CloudStorage.S3:
      case CloudStorage.FILER:
        serviceUrl = this.s3Service.resolvePublicUrl(url);
        break;
    }
    return serviceUrl;
  }

  deleteGenreMedia(genreId: bigint, mediaIds: bigint[], session?: ClientSession) {
    if (mediaIds.length)
      return this.mediaModel.updateMany({ _id: { $in: mediaIds } }, { $pull: { genres: genreId } }, { session });
  }

  deleteProductionMedia(productionId: bigint, mediaIds: bigint[], session?: ClientSession) {
    if (mediaIds.length)
      return this.mediaModel.updateMany(
        { _id: { $in: mediaIds } },
        { $pull: { studios: productionId, producers: productionId } },
        { session }
      );
  }

  deleteCollectionMedia(collectionId: bigint, mediaIds: bigint[], session?: ClientSession) {
    if (mediaIds.length)
      return this.mediaModel.updateMany(
        { _id: { $in: mediaIds } },
        { $pull: { inCollections: collectionId } },
        { session }
      );
  }

  deleteTagMedia(tagId: bigint, mediaIds: bigint[], session?: ClientSession) {
    if (mediaIds.length)
      return this.mediaModel.updateMany({ _id: { $in: mediaIds } }, { $pull: { tags: tagId } }, { session });
  }

  async deleteChapterMedia(chapterTypeId: bigint, mediaIds: bigint[], episodeIds: bigint[], session?: ClientSession) {
    const updatePromises: Promise<any>[] = [];
    if (mediaIds.length) {
      updatePromises.push(
        this.mediaModel.updateMany(
          { _id: { $in: mediaIds } },
          {
            $pull: { 'movie.chapters': { $elemMatch: { type: chapterTypeId } } }
          },
          { session }
        )
      );
    }
    if (episodeIds.length) {
      updatePromises.push(
        this.tvEpisodeModel.updateMany(
          { _id: { $in: episodeIds } },
          {
            $pull: { chapters: { $elemMatch: { type: chapterTypeId } } }
          },
          { session }
        )
      );
    }
    await Promise.all(updatePromises);
  }
}
