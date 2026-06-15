import { forwardRef, HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, PopulateOptions, ProjectionType } from 'mongoose';
import { instanceToPlain, plainToInstance, plainToClassFromExist } from 'class-transformer';
import slugify from 'slugify';
import removeAccents from 'remove-accents';
import isISO31661Alpha2 from 'validator/lib/isISO31661Alpha2';

import { FindMediaDto, OffsetPageMediaDto, CursorPageMediaDto, CreateMediaDto, UpdateMediaDto } from './dto';
import { AuthUserDto } from '../users/dto/auth-user.dto';
import { Media, MediaDocument, Movie, TVShow, TVEpisode, TVEpisodeDocument } from '../../schemas';
import { S3Service } from '../../common/modules/s3/s3.service';
import { LocalCacheService } from '../../common/modules/local-cache/local-cache.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { GenresService } from '../genres/genres.service';
import { ProductionsService } from '../productions/productions.service';
import { TagsService } from '../tags/tags.service';
import { CollectionService } from '../collection/collection.service';
import { WsAdminGateway } from '../ws-admin';
import { HeadersDto } from '../../common/dto';
import { CursorPaginated, Paginated } from '../../common/entities';
import { Media as MediaEntity, MediaDetails } from './entities';
import {
  LookupOptions,
  MongooseOffsetPagination,
  convertToLanguage,
  convertToLanguageArray,
  createSnowFlakeId,
  AuditLogBuilder,
  slugMediaTitle,
  arrayEqualShallow,
  MongooseCursorPagination
} from '../../utils';
import {
  MediaType,
  StatusCode,
  MongooseConnection,
  MediaPStatus,
  MediaSourceStatus,
  AuditLogType,
  MediaVisibility,
  SocketMessage,
  SocketRoom,
  CachePrefix,
  CloudStorage
} from '../../enums';
import { I18N_DEFAULT_LANGUAGE } from '../../config';

/**
 * Read / list / search side of media: pagination, single-media projection, and
 * the thin cross-resource read helpers (by id, for playlist, TV episode lookups).
 * MediaService delegates to these so external consumers keep their existing
 * surface. Mutations and the source/episode/cascade groups stay in MediaService.
 */
@Injectable()
export class MediaCrudService {
  constructor(
    @InjectModel(Media.name, MongooseConnection.DATABASE_A) private mediaModel: Model<MediaDocument>,
    @InjectModel(TVEpisode.name, MongooseConnection.DATABASE_A) private tvEpisodeModel: Model<TVEpisodeDocument>,
    @InjectConnection(MongooseConnection.DATABASE_A) private mongooseConnection: Connection,
    @Inject(forwardRef(() => GenresService)) private genresService: GenresService,
    @Inject(forwardRef(() => ProductionsService)) private productionsService: ProductionsService,
    @Inject(forwardRef(() => TagsService)) private tagsService: TagsService,
    @Inject(forwardRef(() => CollectionService)) private collectionService: CollectionService,
    private auditLogService: AuditLogService,
    private wsAdminGateway: WsAdminGateway,
    private s3Service: S3Service,
    private localCacheService: LocalCacheService
  ) {}

  private resolveIoEmitter(socketId?: string) {
    return (socketId && this.wsAdminGateway.server.sockets.get(socketId)) || this.wsAdminGateway.server;
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

  private async validateCollection(id: bigint) {
    const collection = await this.collectionService.findById(id);
    if (!collection)
      throw new HttpException(
        { code: StatusCode.COLLECTION_NOT_FOUND, message: 'Collection not found' },
        HttpStatus.NOT_FOUND
      );
    return collection;
  }

  async validateCollections(ids: bigint[]) {
    const collections = [];
    for (let i = 0; i < ids.length; i++) {
      const collection = await this.validateCollection(ids[i]);
      collections.push(collection);
    }
    return collections;
  }

  /**
   * Shared find-or-create for genre/production/tag references. Entries shaped
   * `create:name=...` become new documents; everything else is treated as an
   * existing BigInt id and verified to resolve. Per-entity differences come from `config`.
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

  resolveStoragePublicUrl(kind: number, url: string, _folderId?: string): string {
    let serviceUrl = url;
    switch (kind) {
      case CloudStorage.S3:
      case CloudStorage.FILER:
        serviceUrl = this.s3Service.resolvePublicUrl(url);
        break;
    }
    return serviceUrl;
  }
}
