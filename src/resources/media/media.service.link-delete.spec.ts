import { Test, TestingModule } from '@nestjs/testing';

import { MediaCrudService } from './media-crud.service';

/**
 * Characterization net for the 7.1 Slice-C MediaCrudService extraction: the five
 * entity-link cascade deletes that strip a removed genre/production/collection/
 * tag/chapter-type out of the media docs that referenced it.
 *
 * These are called BY cross-resource services through forwardRef(MediaService):
 *   GenresService:172,201      -> deleteGenreMedia
 *   ProductionsService:117,144 -> deleteProductionMedia
 *   CollectionService:191,220  -> deleteCollectionMedia
 *   TagsService:147,174        -> deleteTagMedia
 *   ChapterTypeService:116     -> deleteChapterMedia
 * The surgeon will move the bodies into MediaCrudService behind the facade, so the
 * exact updateMany filter + $pull mutation + the empty-array short-circuit + the
 * session passthrough + the return value are what those callers depend on. Nothing
 * pinned these before; this spec locks them so the move is provably identical.
 *
 * Dependency-light: only mediaModel / tvEpisodeModel. Idiom matches the sibling
 * specs — providers:[MediaService] + useMocker(()=>({})) + (service as any).<model>.
 */
describe('MediaCrudService Slice-C link cascade deletes (characterization)', () => {
  // SUT re-pointed to MediaCrudService: these cascade deletes moved there. Same model
  // field names, so the mocks and every assertion stay byte-identical.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let service: any;
  let mediaModel: { updateMany: jest.Mock };
  let tvEpisodeModel: { updateMany: jest.Mock };
  const session = { id: 'SESSION' } as any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({ providers: [MediaCrudService] })
      .useMocker(() => ({}))
      .compile();
    service = module.get<MediaCrudService>(MediaCrudService);

    mediaModel = { updateMany: jest.fn().mockResolvedValue({ modifiedCount: 1 }) };
    tvEpisodeModel = { updateMany: jest.fn().mockResolvedValue({ modifiedCount: 1 }) };
    service.mediaModel = mediaModel;
    service.tvEpisodeModel = tvEpisodeModel;
  });

  // ---------------------------------------------------------------------------
  // deleteGenreMedia — $pull genres
  // ---------------------------------------------------------------------------
  describe('deleteGenreMedia', () => {
    it('pulls the genre id from every listed media and returns the updateMany result', () => {
      const result = service.deleteGenreMedia(BigInt(10), [BigInt(1), BigInt(2)], session);
      expect(mediaModel.updateMany).toHaveBeenCalledTimes(1);
      expect(mediaModel.updateMany).toHaveBeenCalledWith(
        { _id: { $in: [BigInt(1), BigInt(2)] } },
        { $pull: { genres: BigInt(10) } },
        { session }
      );
      expect(result).toBe(mediaModel.updateMany.mock.results[0].value);
    });

    it('short-circuits to undefined with no DB call when mediaIds is empty', () => {
      const result = service.deleteGenreMedia(BigInt(10), [], session);
      expect(result).toBeUndefined();
      expect(mediaModel.updateMany).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // deleteProductionMedia — $pull studios AND producers (same id)
  // ---------------------------------------------------------------------------
  describe('deleteProductionMedia', () => {
    it('pulls the production id from BOTH studios and producers', () => {
      service.deleteProductionMedia(BigInt(20), [BigInt(1)], session);
      expect(mediaModel.updateMany).toHaveBeenCalledWith(
        { _id: { $in: [BigInt(1)] } },
        { $pull: { studios: BigInt(20), producers: BigInt(20) } },
        { session }
      );
    });

    it('short-circuits to undefined with no DB call when mediaIds is empty', () => {
      expect(service.deleteProductionMedia(BigInt(20), [], session)).toBeUndefined();
      expect(mediaModel.updateMany).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // deleteCollectionMedia — $pull inCollections
  // ---------------------------------------------------------------------------
  describe('deleteCollectionMedia', () => {
    it('pulls the collection id from inCollections', () => {
      service.deleteCollectionMedia(BigInt(30), [BigInt(1), BigInt(2)], session);
      expect(mediaModel.updateMany).toHaveBeenCalledWith(
        { _id: { $in: [BigInt(1), BigInt(2)] } },
        { $pull: { inCollections: BigInt(30) } },
        { session }
      );
    });

    it('short-circuits to undefined with no DB call when mediaIds is empty', () => {
      expect(service.deleteCollectionMedia(BigInt(30), [], session)).toBeUndefined();
      expect(mediaModel.updateMany).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // deleteTagMedia — $pull tags
  // ---------------------------------------------------------------------------
  describe('deleteTagMedia', () => {
    it('pulls the tag id from tags', () => {
      service.deleteTagMedia(BigInt(40), [BigInt(1)], session);
      expect(mediaModel.updateMany).toHaveBeenCalledWith(
        { _id: { $in: [BigInt(1)] } },
        { $pull: { tags: BigInt(40) } },
        { session }
      );
    });

    it('short-circuits to undefined with no DB call when mediaIds is empty', () => {
      expect(service.deleteTagMedia(BigInt(40), [], session)).toBeUndefined();
      expect(mediaModel.updateMany).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // deleteChapterMedia — dual-model: media.movie.chapters + tvEpisode.chapters
  // ---------------------------------------------------------------------------
  describe('deleteChapterMedia', () => {
    const session2 = session;

    it('pulls the chapter type from movie.chapters on the listed media', async () => {
      await service.deleteChapterMedia(BigInt(50), [BigInt(1), BigInt(2)], [], session2);
      expect(mediaModel.updateMany).toHaveBeenCalledTimes(1);
      expect(mediaModel.updateMany).toHaveBeenCalledWith(
        { _id: { $in: [BigInt(1), BigInt(2)] } },
        { $pull: { 'movie.chapters': { $elemMatch: { type: BigInt(50) } } } },
        { session: session2 }
      );
      expect(tvEpisodeModel.updateMany).not.toHaveBeenCalled();
    });

    it('pulls the chapter type from tvEpisode chapters on the listed episodes', async () => {
      await service.deleteChapterMedia(BigInt(50), [], [BigInt(9)], session2);
      expect(tvEpisodeModel.updateMany).toHaveBeenCalledTimes(1);
      expect(tvEpisodeModel.updateMany).toHaveBeenCalledWith(
        { _id: { $in: [BigInt(9)] } },
        { $pull: { chapters: { $elemMatch: { type: BigInt(50) } } } },
        { session: session2 }
      );
      expect(mediaModel.updateMany).not.toHaveBeenCalled();
    });

    it('updates BOTH models when both mediaIds and episodeIds are supplied', async () => {
      await service.deleteChapterMedia(BigInt(50), [BigInt(1)], [BigInt(9)], session2);
      expect(mediaModel.updateMany).toHaveBeenCalledTimes(1);
      expect(tvEpisodeModel.updateMany).toHaveBeenCalledTimes(1);
    });

    it('touches NEITHER model and resolves to undefined when both id arrays are empty', async () => {
      const result = await service.deleteChapterMedia(BigInt(50), [], [], session2);
      expect(result).toBeUndefined();
      expect(mediaModel.updateMany).not.toHaveBeenCalled();
      expect(tvEpisodeModel.updateMany).not.toHaveBeenCalled();
    });
  });
});
