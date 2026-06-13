import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, PopulateOptions, ProjectionType } from 'mongoose';
import { plainToInstance, plainToClassFromExist } from 'class-transformer';

import { FindMediaDto, OffsetPageMediaDto, CursorPageMediaDto } from './dto';
import { AuthUserDto } from '../users/dto/auth-user.dto';
import { Media, MediaDocument, TVEpisode, TVEpisodeDocument } from '../../schemas';
import { S3Service } from '../../common/modules/s3/s3.service';
import { LocalCacheService } from '../../common/modules/local-cache/local-cache.service';
import { HeadersDto } from '../../common/dto';
import { CursorPaginated, Paginated } from '../../common/entities';
import { Media as MediaEntity, MediaDetails } from './entities';
import {
  LookupOptions,
  MongooseOffsetPagination,
  convertToLanguage,
  convertToLanguageArray,
  MongooseCursorPagination
} from '../../utils';
import {
  StatusCode,
  MongooseConnection,
  MediaPStatus,
  MediaVisibility,
  CachePrefix,
  CloudStorage
} from '../../enums';

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
    private s3Service: S3Service,
    private localCacheService: LocalCacheService
  ) {}

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

  resolveStoragePublicUrl(kind: number, url: string, folderId?: string): string {
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
