import { Test, TestingModule } from '@nestjs/testing';
import { HttpException, HttpStatus } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';

import { MediaService } from './media.service';
import { MediaCrudService } from './media-crud.service';
import { MediaDetails, Media as MediaEntity } from './entities';
import { CursorPaginated, Paginated } from '../../common/entities';
import { CloudStorage, MediaPStatus, MediaVisibility, StatusCode } from '../../enums';

/**
 * Characterization net for the 7.1 Slice-A MediaCrudService extraction
 * (read / list / search). These methods currently live on MediaService and will
 * move into a new MediaCrudService that MediaService delegates to (facade-first).
 *
 * The pre-existing media specs cover controller->service DELEGATION ROUTING
 * (media.delegation.spec.ts) and the HTTP surface (media.routes.spec.ts), plus
 * the shared helpers resolveStorageService / resolveIoEmitter / find-or-create.
 * NONE of them pin the RETURN SHAPE of the Slice-A read methods. This spec fills
 * exactly that gap so the move is provably shape-identical: after the extraction,
 * MediaService.<method>(...) (the facade) must return the same shape it does now.
 *
 * Idiom matches the sibling specs: providers:[MediaService] + useMocker(()=>({})),
 * then method-level mocks assigned via (service as any).<dep>. The serialization
 * utilities (convertToLanguage*, plainToInstance, plainToClassFromExist) run for
 * REAL — that is the contract under test, not something to stub.
 */
describe('MediaCrudService Slice-A read/list/search (characterization)', () => {
  // SUT re-pointed to MediaCrudService: these methods moved off MediaService in the
  // facade extraction. Same dep field names, so the (service as any).<dep> mocks and
  // every assertion below stay byte-identical — only the SUT wiring follows the code.
  let service: MediaCrudService;
  let mediaModel: { findOne: jest.Mock; aggregate: jest.Mock };
  let tvEpisodeModel: { findOne: jest.Mock };

  const headers = { acceptLanguage: undefined } as any;
  const guestUser = { hasPermission: false } as any;
  const adminUser = { hasPermission: true } as any;

  // findOne(...).populate(...).lean().exec() => doc. Returns the chainable mock
  // and the populate spy so query-shape can be asserted.
  const mockFindOnePopulated = (doc: unknown) => {
    const exec = jest.fn().mockResolvedValue(doc);
    const lean = jest.fn().mockReturnValue({ exec });
    const populate = jest.fn().mockReturnValue({ lean });
    mediaModel.findOne.mockReturnValue({ populate });
    return { populate };
  };

  // findOne(...).lean().exec() => doc (no populate) for the thin delegators.
  const mockFindOneLean = (model: { findOne: jest.Mock }, doc: unknown) => {
    const exec = jest.fn().mockResolvedValue(doc);
    const lean = jest.fn().mockReturnValue({ exec });
    model.findOne.mockReturnValue({ lean, exec });
    return { lean, exec };
  };

  // aggregate(pipeline).exec() => [data]
  const mockAggregate = (data: unknown) => {
    const exec = jest.fn().mockResolvedValue([data]);
    mediaModel.aggregate.mockReturnValue({ exec });
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [MediaCrudService]
    })
      .useMocker(() => ({}))
      .compile();

    service = module.get<MediaCrudService>(MediaCrudService);

    mediaModel = { findOne: jest.fn(), aggregate: jest.fn() };
    tvEpisodeModel = { findOne: jest.fn() };
    (service as any).mediaModel = mediaModel;
    (service as any).tvEpisodeModel = tvEpisodeModel;
    // createFindAllParams reaches localCacheService.wrap only for the 'related'
    // preset; default passthrough keeps the common path inert.
    (service as any).localCacheService = { wrap: jest.fn(async (_k, fn) => fn()) };
    (service as any).s3Service = { resolvePublicUrl: jest.fn((u: string) => `s3://${u}`) };
  });

  // ---------------------------------------------------------------------------
  // findOne — 150-line projection + error contract (highest shape complexity)
  // ---------------------------------------------------------------------------
  describe('findOne', () => {
    const findMediaDto = {} as any;
    const baseDoc = {
      _id: BigInt(1),
      type: 'movie',
      title: 'T',
      visibility: MediaVisibility.PUBLIC,
      genres: [],
      tags: [],
      videos: [],
      tv: { episodes: [] }
    };

    it('queries the media model by _id', async () => {
      mockFindOnePopulated(baseDoc);
      await service.findOne(BigInt(42), headers, findMediaDto, guestUser);
      expect(mediaModel.findOne).toHaveBeenCalledTimes(1);
      expect(mediaModel.findOne.mock.calls[0][0]).toEqual({ _id: BigInt(42) });
    });

    it('returns a MediaDetails instance', async () => {
      mockFindOnePopulated(baseDoc);
      const result = await service.findOne(BigInt(1), headers, findMediaDto, guestUser);
      expect(result).toBeInstanceOf(MediaDetails);
    });

    it('throws MEDIA_NOT_FOUND (404) when the media does not exist', async () => {
      mockFindOnePopulated(null);
      try {
        await service.findOne(BigInt(1), headers, findMediaDto, guestUser);
        fail('expected findOne to throw');
      } catch (e) {
        expect(e).toBeInstanceOf(HttpException);
        expect((e as HttpException).getStatus()).toBe(HttpStatus.NOT_FOUND);
        expect(((e as HttpException).getResponse() as any).code).toBe(StatusCode.MEDIA_NOT_FOUND);
      }
    });

    it('throws MEDIA_PRIVATE (403) for a private media when the user lacks permission', async () => {
      mockFindOnePopulated({ ...baseDoc, visibility: MediaVisibility.PRIVATE });
      try {
        await service.findOne(BigInt(1), headers, findMediaDto, guestUser);
        fail('expected findOne to throw');
      } catch (e) {
        expect(e).toBeInstanceOf(HttpException);
        expect((e as HttpException).getStatus()).toBe(HttpStatus.FORBIDDEN);
        expect(((e as HttpException).getResponse() as any).code).toBe(StatusCode.MEDIA_PRIVATE);
      }
    });

    it('returns private media to a permissioned user (no throw)', async () => {
      mockFindOnePopulated({ ...baseDoc, visibility: MediaVisibility.PRIVATE });
      const result = await service.findOne(BigInt(1), headers, findMediaDto, adminUser);
      expect(result).toBeInstanceOf(MediaDetails);
    });

    it('projects permission-only fields (scanner/pStatus/addedBy/movie.status) ONLY for permissioned users', async () => {
      mockFindOnePopulated(baseDoc);
      await service.findOne(BigInt(1), headers, findMediaDto, guestUser);
      const guestProjection = mediaModel.findOne.mock.calls[0][1];
      expect(guestProjection.scanner).toBeUndefined();
      expect(guestProjection.pStatus).toBeUndefined();
      expect(guestProjection.addedBy).toBeUndefined();
      expect(guestProjection['movie.status']).toBeUndefined();

      mediaModel.findOne.mockClear();
      mockFindOnePopulated(baseDoc);
      await service.findOne(BigInt(1), headers, findMediaDto, adminUser);
      const adminProjection = mediaModel.findOne.mock.calls[0][1];
      expect(adminProjection.scanner).toBe(1);
      expect(adminProjection.pStatus).toBe(1);
      expect(adminProjection.addedBy).toBe(1);
      expect(adminProjection['movie.status']).toBe(1);
    });

    it('adds the inCollections projection only when appendToResponse includes it', async () => {
      mockFindOnePopulated(baseDoc);
      await service.findOne(BigInt(1), headers, { appendToResponse: ['inCollections'] } as any, guestUser);
      expect(mediaModel.findOne.mock.calls[0][1].inCollections).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // findAll — Paginated<MediaEntity> shape
  // ---------------------------------------------------------------------------
  describe('findAll', () => {
    const dto = { page: 1, limit: 10 } as any;

    it('returns an empty Paginated when the aggregation yields no data bucket', async () => {
      mockAggregate(undefined);
      const result = await service.findAll(dto, headers, guestUser);
      expect(result).toBeInstanceOf(Paginated);
      expect(result).toEqual(expect.objectContaining({ page: 0, totalPages: 0, totalResults: 0, results: [] }));
    });

    it('maps the aggregation bucket onto the {page,totalPages,totalResults,results} shape', async () => {
      mockAggregate({ page: 2, totalPages: 5, totalResults: 47, results: [{ _id: BigInt(1), genres: [] }] });
      const result = await service.findAll(dto, headers, guestUser);
      expect(result).toBeInstanceOf(Paginated);
      expect(result.page).toBe(2);
      expect(result.totalPages).toBe(5);
      expect(result.totalResults).toBe(47);
      expect(Array.isArray(result.results)).toBe(true);
      expect(result.results).toHaveLength(1);
      // shape must NOT carry cursor-only fields
      expect((result as any).hasNextPage).toBeUndefined();
      expect((result as any).nextPageToken).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // findAllCursor — CursorPaginated<MediaEntity> shape
  // ---------------------------------------------------------------------------
  describe('findAllCursor', () => {
    const dto = { limit: 10 } as any;

    it('returns an empty CursorPaginated when the aggregation yields no data bucket', async () => {
      mockAggregate(undefined);
      const result = await service.findAllCursor(dto, headers, guestUser);
      expect(result).toBeInstanceOf(CursorPaginated);
      expect(result).toEqual(
        expect.objectContaining({ totalResults: 0, results: [], hasNextPage: false, nextPageToken: null })
      );
    });

    it('maps the aggregation bucket onto the cursor shape (totalResults/hasNextPage/nextPageToken/prevPageToken/results)', async () => {
      mockAggregate({
        totalResults: 9,
        results: [{ _id: BigInt(1), genres: [] }],
        hasNextPage: true,
        nextPageToken: 'NEXT',
        prevPageToken: 'PREV'
      });
      const result = await service.findAllCursor(dto, headers, guestUser);
      expect(result).toBeInstanceOf(CursorPaginated);
      expect(result.totalResults).toBe(9);
      expect(result.hasNextPage).toBe(true);
      expect(result.nextPageToken).toBe('NEXT');
      expect(result.prevPageToken).toBe('PREV');
      expect(result.results).toHaveLength(1);
      // shape must NOT carry offset-only fields
      expect((result as any).page).toBeUndefined();
      expect((result as any).totalPages).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // createFindAllParams — [fields, filters] tuple (private helper)
  // ---------------------------------------------------------------------------
  describe('createFindAllParams', () => {
    const call = (dto: any, hasPermission: boolean) =>
      (service as any).createFindAllParams(dto, hasPermission) as Promise<
        [Record<string, number>, Record<string, any>]
      >;

    it('returns a [fields, filters] tuple', async () => {
      const out = await call({}, false);
      expect(Array.isArray(out)).toBe(true);
      expect(out).toHaveLength(2);
    });

    it('forces visibility=PUBLIC and pStatus=DONE filters for a guest', async () => {
      const [, filters] = await call({}, false);
      expect(filters.visibility).toBe(MediaVisibility.PUBLIC);
      expect(filters.pStatus).toBe(MediaPStatus.DONE);
    });

    it('exposes pStatus + tv.lastEpisode fields only when permissioned', async () => {
      const [guestFields] = await call({}, false);
      expect(guestFields.pStatus).toBeUndefined();
      expect(guestFields['tv.lastEpisode']).toBeUndefined();

      const [adminFields] = await call({ includeHidden: true, includeUnprocessed: true }, true);
      expect(adminFields.pStatus).toBe(1);
      expect(adminFields['tv.lastEpisode']).toBe(1);
    });

    it('does NOT force visibility/pStatus filters when a permissioned user includes hidden+unprocessed', async () => {
      const [, filters] = await call({ includeHidden: true, includeUnprocessed: true }, true);
      expect(filters.visibility).toBeUndefined();
      expect(filters.pStatus).toBeUndefined();
    });

    it('builds $all vs $in genre filters from genreMatch', async () => {
      const [, allFilters] = await call(
        { genres: [1, 2], genreMatch: 'all', includeHidden: true, includeUnprocessed: true },
        true
      );
      expect(allFilters.genres).toEqual({ $all: [1, 2] });
      const [, inFilters] = await call({ genres: [1, 2], includeHidden: true, includeUnprocessed: true }, true);
      expect(inFilters.genres).toEqual({ $in: [1, 2] });
    });

    it('maps type/originalLang/year/adult scalars straight into filters', async () => {
      const [, filters] = await call(
        { type: 1, originalLang: 'en', year: 2020, adult: false, includeHidden: true, includeUnprocessed: true },
        true
      );
      expect(filters.type).toBe(1);
      expect(filters.originalLang).toBe('en');
      expect(filters['releaseDate.year']).toBe(2020);
      expect(filters.adult).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Thin read delegators — query/projection passed to the model + result passthrough
  // ---------------------------------------------------------------------------
  describe('findOneById', () => {
    it('queries media by _id with the given fields and returns the lean doc', async () => {
      const doc = { _id: BigInt(5) };
      mockFindOneLean(mediaModel, doc);
      const fields = { title: 1 };
      const result = await service.findOneById(BigInt(5), fields);
      expect(mediaModel.findOne).toHaveBeenCalledWith({ _id: BigInt(5) }, fields);
      expect(result).toBe(doc);
    });
  });

  describe('findOneForPlaylist', () => {
    it('queries media by _id with the fixed playlist projection and returns the lean doc', async () => {
      const doc = { _id: BigInt(7) };
      mockFindOneLean(mediaModel, doc);
      const result = await service.findOneForPlaylist(BigInt(7));
      expect(mediaModel.findOne.mock.calls[0][0]).toEqual({ _id: BigInt(7) });
      const projection = mediaModel.findOne.mock.calls[0][1];
      // a representative subset of the locked projection shape
      expect(projection._id).toBe(1);
      expect(projection.type).toBe(1);
      expect(projection.poster).toBe(1);
      expect(projection.pStatus).toBe(1);
      expect(result).toBe(doc);
    });
  });

  describe('findOneTVEpisodeById', () => {
    it('queries the tvEpisode model by { _id: episodeId, media: id } with fields', async () => {
      const doc = { _id: BigInt(20) };
      mockFindOneLean(tvEpisodeModel, doc);
      const fields = { name: 1 };
      const result = await service.findOneTVEpisodeById(BigInt(3), BigInt(20), fields);
      expect(tvEpisodeModel.findOne).toHaveBeenCalledWith({ _id: BigInt(20), media: BigInt(3) }, fields);
      expect(result).toBe(doc);
    });
  });

  describe('findOneTVEpisodeByNumber', () => {
    it('queries the tvEpisode model by { media: id, epNumber } with fields', async () => {
      const doc = { _id: BigInt(21) };
      mockFindOneLean(tvEpisodeModel, doc);
      const fields = { name: 1 };
      const result = await service.findOneTVEpisodeByNumber(BigInt(3), 7, fields);
      expect(tvEpisodeModel.findOne).toHaveBeenCalledWith({ media: BigInt(3), epNumber: 7 }, fields);
      expect(result).toBe(doc);
    });
  });

  describe('findAvailableMedia', () => {
    it('queries media by { _id, pStatus: DONE } and returns the lean query', async () => {
      const lean = { tag: 'lean-query' };
      mediaModel.findOne.mockReturnValue({ lean: jest.fn().mockReturnValue(lean) });
      const result = service.findAvailableMedia(BigInt(9));
      expect(mediaModel.findOne.mock.calls[0][0]).toEqual({ _id: BigInt(9), pStatus: MediaPStatus.DONE });
      expect(result).toBe(lean);
    });
  });

  // ---------------------------------------------------------------------------
  // resolveStoragePublicUrl — kind -> url resolution (private helper, used by findOne path)
  // ---------------------------------------------------------------------------
  describe('resolveStoragePublicUrl', () => {
    const resolve = (kind: number, url: string, folderId?: string) =>
      (service as any).resolveStoragePublicUrl(kind, url, folderId);

    it('rewrites S3 urls through s3Service.resolvePublicUrl', () => {
      expect(resolve(CloudStorage.S3, 'bucket/key')).toBe('s3://bucket/key');
    });

    it('rewrites FILER urls through s3Service.resolvePublicUrl', () => {
      expect(resolve(CloudStorage.FILER, 'bucket/key')).toBe('s3://bucket/key');
    });

    it('passes other kinds through unchanged', () => {
      expect(resolve(CloudStorage.ONEDRIVE, 'https://drive/x')).toBe('https://drive/x');
      expect(resolve(-1 as unknown as number, 'raw')).toBe('raw');
    });
  });
});

// Delegation half: each MediaService facade method forwards to MediaCrudService with
// the same args and returns its result, so the 8 forwardRef consumers + 3 controllers
// keep their surface after the extraction.
describe('MediaService -> MediaCrudService delegation (Slice-A facade)', () => {
  let service: MediaService;
  let crud: jest.Mocked<MediaCrudService>;

  beforeEach(async () => {
    crud = {
      create: jest.fn(),
      update: jest.fn(),
      findAll: jest.fn(),
      findAllCursor: jest.fn(),
      findOne: jest.fn(),
      findOneById: jest.fn(),
      findOneTVEpisodeById: jest.fn(),
      findOneTVEpisodeByNumber: jest.fn(),
      findAvailableMedia: jest.fn(),
      findOneForPlaylist: jest.fn(),
      resolveStoragePublicUrl: jest.fn()
    } as unknown as jest.Mocked<MediaCrudService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [MediaService, { provide: MediaCrudService, useValue: crud }]
    })
      .useMocker(() => ({}))
      .compile();

    service = module.get<MediaService>(MediaService);
  });

  it('create forwards (dto, headers, authUser) and returns the crud result', () => {
    const out = {} as any;
    crud.create.mockReturnValue(out);
    const dto = {} as any;
    const headers = {} as any;
    const authUser = {} as any;
    expect(service.create(dto, headers, authUser)).toBe(out);
    expect(crud.create).toHaveBeenCalledWith(dto, headers, authUser);
  });

  it('update forwards (id, dto, headers, authUser) and returns the crud result', () => {
    const out = {} as any;
    crud.update.mockReturnValue(out);
    const dto = {} as any;
    const headers = {} as any;
    const authUser = {} as any;
    expect(service.update(BigInt(5), dto, headers, authUser)).toBe(out);
    expect(crud.update).toHaveBeenCalledWith(BigInt(5), dto, headers, authUser);
  });

  it('findAll forwards (dto, headers, authUser) and returns the crud result', () => {
    const out = {} as any;
    crud.findAll.mockReturnValue(out);
    const dto = {} as any;
    const headers = {} as any;
    const authUser = {} as any;
    expect(service.findAll(dto, headers, authUser)).toBe(out);
    expect(crud.findAll).toHaveBeenCalledWith(dto, headers, authUser);
  });

  it('findAllCursor forwards (dto, headers, authUser) and returns the crud result', () => {
    const out = {} as any;
    crud.findAllCursor.mockReturnValue(out);
    const dto = {} as any;
    const headers = {} as any;
    const authUser = {} as any;
    expect(service.findAllCursor(dto, headers, authUser)).toBe(out);
    expect(crud.findAllCursor).toHaveBeenCalledWith(dto, headers, authUser);
  });

  it('findOne forwards (id, headers, dto, authUser) and returns the crud result', () => {
    const out = {} as any;
    crud.findOne.mockReturnValue(out);
    const headers = {} as any;
    const dto = {} as any;
    const authUser = {} as any;
    expect(service.findOne(BigInt(1), headers, dto, authUser)).toBe(out);
    expect(crud.findOne).toHaveBeenCalledWith(BigInt(1), headers, dto, authUser);
  });

  it('findOneById forwards (id, fields) and returns the crud result', () => {
    const out = {} as any;
    crud.findOneById.mockReturnValue(out);
    const fields = { title: 1 };
    expect(service.findOneById(BigInt(2), fields)).toBe(out);
    expect(crud.findOneById).toHaveBeenCalledWith(BigInt(2), fields);
  });

  it('findOneTVEpisodeById forwards (id, episodeId, fields) and returns the crud result', () => {
    const out = {} as any;
    crud.findOneTVEpisodeById.mockReturnValue(out);
    const fields = { name: 1 };
    expect(service.findOneTVEpisodeById(BigInt(3), BigInt(20), fields)).toBe(out);
    expect(crud.findOneTVEpisodeById).toHaveBeenCalledWith(BigInt(3), BigInt(20), fields);
  });

  it('findOneTVEpisodeByNumber forwards (id, epNumber, fields) and returns the crud result', () => {
    const out = {} as any;
    crud.findOneTVEpisodeByNumber.mockReturnValue(out);
    const fields = { name: 1 };
    expect(service.findOneTVEpisodeByNumber(BigInt(3), 7, fields)).toBe(out);
    expect(crud.findOneTVEpisodeByNumber).toHaveBeenCalledWith(BigInt(3), 7, fields);
  });

  it('findAvailableMedia forwards (id, session) and returns the crud result', () => {
    const out = {} as any;
    crud.findAvailableMedia.mockReturnValue(out);
    const session = {} as any;
    expect(service.findAvailableMedia(BigInt(9), session)).toBe(out);
    expect(crud.findAvailableMedia).toHaveBeenCalledWith(BigInt(9), session);
  });

  it('findOneForPlaylist forwards (id) and returns the crud result', () => {
    const out = {} as any;
    crud.findOneForPlaylist.mockReturnValue(out);
    expect(service.findOneForPlaylist(BigInt(7))).toBe(out);
    expect(crud.findOneForPlaylist).toHaveBeenCalledWith(BigInt(7));
  });

  it('resolveStoragePublicUrl forwards (kind, url, folderId) and returns the crud result', () => {
    crud.resolveStoragePublicUrl.mockReturnValue('resolved');
    expect((service as any).resolveStoragePublicUrl(CloudStorage.S3, 'u', 'f')).toBe('resolved');
    expect(crud.resolveStoragePublicUrl).toHaveBeenCalledWith(CloudStorage.S3, 'u', 'f');
  });
});
