import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';
import { MediaService } from './media.service';
import { StatusCode } from '../../enums';

/**
 * Characterization tests for findOrCreateGenres / findOrCreateProductions /
 * findOrCreateTags.
 *
 * The three helpers are near-identical: parse "create:name=..." entries into new
 * documents, collect existing BigInt ids, verify all existing ids resolve, then
 * createMany the new ones. They differ only in entity label, max name length
 * (32 vs 150), not-found status code, and productions' extra ISO country field.
 * These tests pin the per-entity behavior before collapsing into one generic.
 */
describe('MediaService find-or-create helpers (characterization)', () => {
  let service: MediaService;
  let genresService: { countByIds: jest.Mock; createMany: jest.Mock };
  let productionsService: { countByIds: jest.Mock; createMany: jest.Mock };
  let tagsService: { countByIds: jest.Mock; createMany: jest.Mock };

  const creatorId = BigInt(999);
  const session = {} as any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [MediaService]
    })
      .useMocker(() => ({}))
      .compile();

    service = module.get<MediaService>(MediaService);

    genresService = { countByIds: jest.fn().mockResolvedValue(0), createMany: jest.fn().mockResolvedValue([]) };
    productionsService = { countByIds: jest.fn().mockResolvedValue(0), createMany: jest.fn().mockResolvedValue([]) };
    tagsService = { countByIds: jest.fn().mockResolvedValue(0), createMany: jest.fn().mockResolvedValue([]) };
    (service as any).genresService = genresService;
    (service as any).productionsService = productionsService;
    (service as any).tagsService = tagsService;
  });

  const callGenres = (ids: string[]) => (service as any).findOrCreateGenres(ids, creatorId, session);
  const callProductions = (ids: string[]) => (service as any).findOrCreateProductions(ids, creatorId, session);
  const callTags = (ids: string[]) => (service as any).findOrCreateTags(ids, creatorId, session);

  const expectCode = async (promise: Promise<unknown>, code: StatusCode) => {
    await expect(promise).rejects.toBeInstanceOf(HttpException);
    await promise.catch((e: HttpException) => expect((e.getResponse() as any).code).toBe(code));
  };

  describe('findOrCreateGenres', () => {
    it('collects existing BigInt ids and verifies them', async () => {
      genresService.countByIds.mockResolvedValue(2);
      const result = await callGenres(['100', '101']);
      expect(genresService.countByIds).toHaveBeenCalledWith([BigInt(100), BigInt(101)]);
      expect(result).toEqual([BigInt(100), BigInt(101)]);
      expect(genresService.createMany).not.toHaveBeenCalled();
    });

    it('skips entries that are not valid BigInts', async () => {
      genresService.countByIds.mockResolvedValue(1);
      const result = await callGenres(['100', 'not-a-bigint']);
      expect(result).toEqual([BigInt(100)]);
    });

    it('creates new entries from create:name= and appends their ids', async () => {
      genresService.countByIds.mockResolvedValue(0);
      genresService.createMany.mockResolvedValue([{ _id: BigInt(500) }]);
      const result = await callGenres(['create:name=Action']);
      expect(genresService.createMany).toHaveBeenCalledWith([{ name: 'Action' }], creatorId, session);
      expect(result).toEqual([BigInt(500)]);
    });

    it('throws IS_NOT_EMPTY when a create entry has no name', async () => {
      await expectCode(callGenres(['create:foo=bar']), StatusCode.IS_NOT_EMPTY);
    });

    it('throws MAX_LENGTH when a genre name exceeds 32 chars', async () => {
      await expectCode(callGenres([`create:name=${'a'.repeat(33)}`]), StatusCode.MAX_LENGTH);
    });

    it('allows a 32-char genre name', async () => {
      genresService.createMany.mockResolvedValue([{ _id: BigInt(7) }]);
      const result = await callGenres([`create:name=${'a'.repeat(32)}`]);
      expect(result).toEqual([BigInt(7)]);
    });

    it('throws GENRES_NOT_FOUND when existing ids do not all resolve', async () => {
      genresService.countByIds.mockResolvedValue(1);
      await expectCode(callGenres(['100', '101']), StatusCode.GENRES_NOT_FOUND);
    });
  });

  describe('findOrCreateTags', () => {
    it('creates new tags and appends ids', async () => {
      tagsService.createMany.mockResolvedValue([{ _id: BigInt(12) }]);
      const result = await callTags(['create:name=4k']);
      expect(tagsService.createMany).toHaveBeenCalledWith([{ name: '4k' }], creatorId, session);
      expect(result).toEqual([BigInt(12)]);
    });

    it('throws MAX_LENGTH when a tag name exceeds 32 chars', async () => {
      await expectCode(callTags([`create:name=${'a'.repeat(33)}`]), StatusCode.MAX_LENGTH);
    });

    it('throws TAGS_NOT_FOUND on id mismatch', async () => {
      tagsService.countByIds.mockResolvedValue(0);
      await expectCode(callTags(['100']), StatusCode.TAGS_NOT_FOUND);
    });
  });

  describe('findOrCreateProductions', () => {
    it('parses a valid ISO country and keeps it', async () => {
      productionsService.createMany.mockResolvedValue([{ _id: BigInt(21) }]);
      const result = await callProductions(['create:name=Studio&country=US']);
      expect(productionsService.createMany).toHaveBeenCalledWith(
        [{ name: 'Studio', country: 'US' }],
        creatorId,
        session
      );
      expect(result).toEqual([BigInt(21)]);
    });

    it('nulls an invalid ISO country', async () => {
      productionsService.createMany.mockResolvedValue([{ _id: BigInt(22) }]);
      await callProductions(['create:name=Studio&country=ZZ']);
      expect(productionsService.createMany).toHaveBeenCalledWith(
        [{ name: 'Studio', country: null }],
        creatorId,
        session
      );
    });

    it('nulls an absent country', async () => {
      productionsService.createMany.mockResolvedValue([{ _id: BigInt(23) }]);
      await callProductions(['create:name=Studio']);
      expect(productionsService.createMany).toHaveBeenCalledWith(
        [{ name: 'Studio', country: null }],
        creatorId,
        session
      );
    });

    it('allows a 150-char production name but rejects 151', async () => {
      productionsService.createMany.mockResolvedValue([{ _id: BigInt(24) }]);
      await expect(callProductions([`create:name=${'a'.repeat(150)}`])).resolves.toEqual([BigInt(24)]);
      await expectCode(callProductions([`create:name=${'a'.repeat(151)}`]), StatusCode.MAX_LENGTH);
    });

    it('does NOT call countByIds when there are no existing ids', async () => {
      productionsService.createMany.mockResolvedValue([{ _id: BigInt(25) }]);
      await callProductions(['create:name=Studio']);
      expect(productionsService.countByIds).not.toHaveBeenCalled();
    });

    it('throws PRODUCTIONS_NOT_FOUND on id mismatch', async () => {
      productionsService.countByIds.mockResolvedValue(0);
      await expectCode(callProductions(['100']), StatusCode.PRODUCTIONS_NOT_FOUND);
    });
  });
});
