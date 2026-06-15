import { Test, TestingModule } from '@nestjs/testing';
import { HttpException, HttpStatus } from '@nestjs/common';

import { MediaCrudService } from './media-crud.service';
import { MediaDetails } from './entities';
import { MediaType, StatusCode } from '../../enums';

/**
 * Characterization net for the 7.1 Slice-B MediaCrudService extraction
 * (create / update / find-or-create / validateCollections). These bodies will
 * move out of MediaService into MediaCrudService, and — critically — the surgeon
 * will RELOCATE the genres/productions/tags/collection forwardRef wiring with
 * them. That relocation is the highest risk in the slice.
 *
 * The pre-existing media.service.find-or-create.spec.ts already covers the
 * find-or-create generic in isolation (countByIds/createMany interaction,
 * MAX_LENGTH, IS_NOT_EMPTY, *_NOT_FOUND, country parsing). What had NO coverage:
 * the create/update RETURN SHAPES and the cross-resource SIDE-EFFECT calls those
 * methods make (genresService.addMediaGenres / productionsService.addMedia* /
 * tagsService.addMediaTags / collectionService.addMediaCollections and the
 * update* variants). This spec locks exactly those so the forwardRef relocation
 * is provably behaviour-identical: create/update must still call the same
 * cross-resource methods with the same args and return the same shape.
 *
 * Idiom matches the sibling specs (media-tv-episodes.service.spec.ts):
 * providers:[MediaService] + useMocker(()=>({})), then (service as any).<dep>
 * mocks, with a withTransaction session that simply runs its callback.
 */
describe('MediaService Slice-B create/update/validate (characterization)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let service: any;
  let genresService: {
    addMediaGenres: jest.Mock;
    updateMediaGenres: jest.Mock;
    countByIds: jest.Mock;
    createMany: jest.Mock;
  };
  let productionsService: {
    addMediaStudios: jest.Mock;
    addMediaProductions: jest.Mock;
    updateMediaStudios: jest.Mock;
    updateMediaProductions: jest.Mock;
    countByIds: jest.Mock;
    createMany: jest.Mock;
  };
  let tagsService: {
    addMediaTags: jest.Mock;
    updateMediaTags: jest.Mock;
    countByIds: jest.Mock;
    createMany: jest.Mock;
  };
  let collectionService: {
    findById: jest.Mock;
    addMediaCollections: jest.Mock;
    updateMediaCollections: jest.Mock;
  };
  let auditLogService: { createLogFromBuilder: jest.Mock };
  let localCacheService: { del: jest.Mock };
  let emit: jest.Mock;
  let to: jest.Mock;

  const headers = { socketId: undefined, acceptLanguage: undefined } as any;
  const authUser = { _id: BigInt(7), hasPermission: true } as any;

  // A fake Mongoose media document: mutable fields + the methods create/update call.
  // toObject returns the current field bag so plainToInstance(MediaDetails, ...) runs real.
  const makeMediaDoc = (overrides: Record<string, any> = {}) => {
    const doc: any = {
      _id: BigInt(1),
      type: MediaType.MOVIE,
      title: 'Title',
      originalTitle: 'Original',
      slug: 'title',
      genres: Object.assign([], { toObject: () => [] }),
      studios: [],
      producers: [],
      tags: Object.assign([], { toObject: () => [] }),
      inCollections: Object.assign([], { toObject: () => [] }),
      movie: {},
      tv: {},
      ...overrides
    };
    doc.set = jest.fn((path: string, value: any) => {
      doc[path] = value;
    });
    doc.save = jest.fn().mockResolvedValue(doc);
    doc.populate = jest.fn().mockResolvedValue(doc);
    doc.toObject = jest.fn(() => ({ ...doc }));
    // Mongoose-doc surface that AuditLogBuilder.getChangesFrom touches: no
    // modified paths -> the audit diff loop is an inert no-op (not under test).
    doc.modifiedPaths = jest.fn(() => []);
    doc._original = {};
    return doc;
  };

  // A session whose withTransaction simply awaits the supplied callback.
  const makeSession = () => ({
    withTransaction: jest.fn(async (cb: () => Promise<void>) => {
      await cb();
    }),
    endSession: jest.fn().mockResolvedValue(undefined)
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({ providers: [MediaCrudService] })
      .useMocker(() => ({}))
      .compile();
    service = module.get<MediaCrudService>(MediaCrudService);

    genresService = {
      addMediaGenres: jest.fn().mockResolvedValue(undefined),
      updateMediaGenres: jest.fn().mockResolvedValue(undefined),
      countByIds: jest.fn().mockResolvedValue(1),
      createMany: jest.fn().mockResolvedValue([])
    };
    productionsService = {
      addMediaStudios: jest.fn().mockResolvedValue(undefined),
      addMediaProductions: jest.fn().mockResolvedValue(undefined),
      updateMediaStudios: jest.fn().mockResolvedValue(undefined),
      updateMediaProductions: jest.fn().mockResolvedValue(undefined),
      countByIds: jest.fn().mockResolvedValue(1),
      createMany: jest.fn().mockResolvedValue([])
    };
    tagsService = {
      addMediaTags: jest.fn().mockResolvedValue(undefined),
      updateMediaTags: jest.fn().mockResolvedValue(undefined),
      countByIds: jest.fn().mockResolvedValue(1),
      createMany: jest.fn().mockResolvedValue([])
    };
    collectionService = {
      findById: jest.fn().mockResolvedValue({ _id: BigInt(50) }),
      addMediaCollections: jest.fn().mockResolvedValue(undefined),
      updateMediaCollections: jest.fn().mockResolvedValue(undefined)
    };
    auditLogService = { createLogFromBuilder: jest.fn().mockResolvedValue(undefined) };
    localCacheService = { del: jest.fn().mockResolvedValue(undefined) };

    emit = jest.fn();
    to = jest.fn().mockReturnValue({ emit });

    service.genresService = genresService;
    service.productionsService = productionsService;
    service.tagsService = tagsService;
    service.collectionService = collectionService;
    service.auditLogService = auditLogService;
    service.localCacheService = localCacheService;
    service.mongooseConnection = { startSession: jest.fn().mockResolvedValue(makeSession()) };
    service.wsAdminGateway = { server: { to, emit, sockets: { get: jest.fn() } } };
  });

  // ---------------------------------------------------------------------------
  // create — return shape + forwardRef side-effect wiring (the relocation risk)
  // ---------------------------------------------------------------------------
  describe('create', () => {
    const setupModel = () => {
      const doc = makeMediaDoc();
      service.mediaModel = jest.fn().mockImplementation(() => doc);
      return doc;
    };

    it('returns a MediaDetails instance', async () => {
      setupModel();
      const result = await service.create({ type: MediaType.MOVIE, title: 'T' }, headers, authUser);
      expect(result).toBeInstanceOf(MediaDetails);
    });

    // create assigns media._id = await createSnowFlakeId() (a generated bigint),
    // so side-effect calls carry the doc's actual _id, not the fake's initial one.

    it('forwards genres to genresService.addMediaGenres (forwardRef side-effect)', async () => {
      const doc = setupModel();
      await service.create({ type: MediaType.MOVIE, title: 'T', genres: ['100'] }, headers, authUser);
      expect(genresService.addMediaGenres).toHaveBeenCalledTimes(1);
      const [mediaId, genreIds] = genresService.addMediaGenres.mock.calls[0];
      expect(mediaId).toBe(doc._id);
      expect(genreIds).toEqual([BigInt(100)]);
    });

    it('forwards studios to productionsService.addMediaStudios and producers to addMediaProductions', async () => {
      const doc = setupModel();
      await service.create(
        { type: MediaType.MOVIE, title: 'T', studios: ['200'], producers: ['300'] },
        headers,
        authUser
      );
      expect(productionsService.addMediaStudios).toHaveBeenCalledWith(doc._id, [BigInt(200)], expect.anything());
      expect(productionsService.addMediaProductions).toHaveBeenCalledWith(doc._id, [BigInt(300)], expect.anything());
    });

    it('forwards tags to tagsService.addMediaTags (forwardRef side-effect)', async () => {
      const doc = setupModel();
      await service.create({ type: MediaType.MOVIE, title: 'T', tags: ['400'] }, headers, authUser);
      expect(tagsService.addMediaTags).toHaveBeenCalledWith(doc._id, [BigInt(400)], expect.anything());
    });

    it('validates + forwards collections to collectionService.addMediaCollections (forwardRef side-effect)', async () => {
      const doc = setupModel();
      await service.create({ type: MediaType.MOVIE, title: 'T', inCollections: [BigInt(50)] }, headers, authUser);
      // validateCollections -> collectionService.findById per id
      expect(collectionService.findById).toHaveBeenCalledWith(BigInt(50));
      expect(collectionService.addMediaCollections).toHaveBeenCalledWith(doc._id, [BigInt(50)], expect.anything());
    });

    it('does NOT touch any cross-resource service when no genres/studios/tags/collections are supplied', async () => {
      setupModel();
      await service.create({ type: MediaType.MOVIE, title: 'T' }, headers, authUser);
      expect(genresService.addMediaGenres).not.toHaveBeenCalled();
      expect(productionsService.addMediaStudios).not.toHaveBeenCalled();
      expect(productionsService.addMediaProductions).not.toHaveBeenCalled();
      expect(tagsService.addMediaTags).not.toHaveBeenCalled();
      expect(collectionService.addMediaCollections).not.toHaveBeenCalled();
    });

    it('emits REFRESH_MEDIA on the ADMIN_MEDIA_LIST room after creating', async () => {
      setupModel();
      await service.create({ type: MediaType.MOVIE, title: 'T' }, headers, authUser);
      expect(to).toHaveBeenCalled();
      expect(emit).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // update — guards, return shape, forwardRef update side-effects
  // ---------------------------------------------------------------------------
  describe('update', () => {
    const mockFindOne = (doc: unknown) => {
      service.mediaModel = { findOne: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(doc) }) };
    };

    it('throws EMPTY_BODY (400) for an empty update DTO, before any query', async () => {
      mockFindOne(makeMediaDoc());
      try {
        await service.update(BigInt(1), {}, headers, authUser);
        fail('expected update to throw');
      } catch (e) {
        expect(e).toBeInstanceOf(HttpException);
        expect((e as HttpException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
        expect(((e as HttpException).getResponse() as any).code).toBe(StatusCode.EMPTY_BODY);
      }
      expect(service.mediaModel.findOne).not.toHaveBeenCalled();
    });

    it('throws MEDIA_NOT_FOUND (404) when the media does not exist', async () => {
      mockFindOne(null);
      try {
        await service.update(BigInt(1), { title: 'New' }, headers, authUser);
        fail('expected update to throw');
      } catch (e) {
        expect(e).toBeInstanceOf(HttpException);
        expect((e as HttpException).getStatus()).toBe(HttpStatus.NOT_FOUND);
        expect(((e as HttpException).getResponse() as any).code).toBe(StatusCode.MEDIA_NOT_FOUND);
      }
    });

    it('returns a plain serialized object (instanceToPlain of MediaDetails), not a class instance', async () => {
      mockFindOne(makeMediaDoc());
      const result = await service.update(BigInt(1), { title: 'New' }, headers, authUser);
      // update returns instanceToPlain(plainToInstance(MediaDetails, ...)) -> plain object
      expect(result).not.toBeInstanceOf(MediaDetails);
      expect(typeof result).toBe('object');
      expect(result).not.toBeNull();
    });

    it('forwards genre changes to genresService.updateMediaGenres with the new/old diff (forwardRef side-effect)', async () => {
      const doc = makeMediaDoc({ genres: Object.assign([], { toObject: () => [BigInt(100)] }) });
      mockFindOne(doc);
      await service.update(BigInt(1), { genres: ['200'] }, headers, authUser);
      expect(genresService.updateMediaGenres).toHaveBeenCalledTimes(1);
      const [mediaId, newGenres, oldGenres] = genresService.updateMediaGenres.mock.calls[0];
      expect(mediaId).toBe(BigInt(1));
      expect(newGenres).toEqual([BigInt(200)]); // added
      expect(oldGenres).toEqual([BigInt(100)]); // removed
    });

    it('forwards studio/producer changes to productionsService.update* (forwardRef side-effect)', async () => {
      mockFindOne(makeMediaDoc({ studios: [], producers: [] }));
      await service.update(BigInt(1), { studios: ['200'], producers: ['300'] }, headers, authUser);
      expect(productionsService.updateMediaStudios).toHaveBeenCalledTimes(1);
      expect(productionsService.updateMediaProductions).toHaveBeenCalledTimes(1);
    });

    it('forwards tag changes to tagsService.updateMediaTags (forwardRef side-effect)', async () => {
      mockFindOne(makeMediaDoc({ tags: Object.assign([], { toObject: () => [] }) }));
      await service.update(BigInt(1), { tags: ['400'] }, headers, authUser);
      expect(tagsService.updateMediaTags).toHaveBeenCalledTimes(1);
    });

    it('validates + forwards collection changes to collectionService.updateMediaCollections (forwardRef side-effect)', async () => {
      mockFindOne(makeMediaDoc({ inCollections: Object.assign([], { toObject: () => [] }) }));
      await service.update(BigInt(1), { inCollections: [BigInt(50)] }, headers, authUser);
      expect(collectionService.findById).toHaveBeenCalledWith(BigInt(50));
      expect(collectionService.updateMediaCollections).toHaveBeenCalledTimes(1);
    });

    it('does NOT call collectionService.updateMediaCollections when inCollections is unchanged', async () => {
      mockFindOne(makeMediaDoc({ inCollections: Object.assign([BigInt(50)], { toObject: () => [BigInt(50)] }) }));
      await service.update(BigInt(1), { inCollections: [BigInt(50)] }, headers, authUser);
      expect(collectionService.updateMediaCollections).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // validateCollections — collectionService.findById interaction + not-found
  // ---------------------------------------------------------------------------
  describe('validateCollections', () => {
    it('calls collectionService.findById for each id and returns the resolved collections', async () => {
      collectionService.findById.mockResolvedValueOnce({ _id: BigInt(1) }).mockResolvedValueOnce({ _id: BigInt(2) });
      const result = await service.validateCollections([BigInt(1), BigInt(2)]);
      expect(collectionService.findById).toHaveBeenNthCalledWith(1, BigInt(1));
      expect(collectionService.findById).toHaveBeenNthCalledWith(2, BigInt(2));
      expect(result).toEqual([{ _id: BigInt(1) }, { _id: BigInt(2) }]);
    });

    it('throws COLLECTION_NOT_FOUND (404) when a collection id does not resolve', async () => {
      collectionService.findById.mockResolvedValue(null);
      try {
        await service.validateCollections([BigInt(99)]);
        fail('expected validateCollections to throw');
      } catch (e) {
        expect(e).toBeInstanceOf(HttpException);
        expect((e as HttpException).getStatus()).toBe(HttpStatus.NOT_FOUND);
        expect(((e as HttpException).getResponse() as any).code).toBe(StatusCode.COLLECTION_NOT_FOUND);
      }
    });
  });
});
