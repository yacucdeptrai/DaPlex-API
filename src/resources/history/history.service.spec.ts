import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { HttpStatus } from '@nestjs/common';

import { HistoryService } from './history.service';
import { MediaService } from '../media/media.service';
import { MediaPStatus, MediaType, MediaVisibility, MongooseConnection, StatusCode } from '../../enums';
import { History } from '../../schemas';

// markWatched / updateWatchTime create rows via `new this.historyModel({ _id: await createSnowFlakeId(), ... })`.
// The real createSnowFlakeId pulls in `../config` (env-coupled) and a Snowflake instance; stub it to a fixed
// id so the create specs are deterministic and the config side-effects stay out of the unit run. Everything
// else in the utils barrel keeps its real implementation. The literal is inlined in the factory because
// jest.mock is hoisted above module-scope consts (a referenced const would hit the TDZ).
jest.mock('../../utils', () => ({
  ...jest.requireActual('../../utils'),
  createSnowFlakeId: jest.fn().mockResolvedValue(BigInt('900000000000000001'))
}));
const FIXED_SNOWFLAKE = BigInt('900000000000000001');

// Walks the built pipeline and pulls out the parts the inProgress filter touches.
function inspectPipeline(pipeline: any[]) {
  const matchStage = pipeline.find((stage) => stage.$match);
  const facetStage = pipeline.find((stage) => stage.$facet);
  const stage2: any[] = facetStage?.$facet?.stage2 ?? [];
  const hasGroupByDate = stage2.some((stage) => stage.$addFields?.groupByDate != undefined);
  return { filters: matchStage?.$match, hasGroupByDate };
}

describe('HistoryService', () => {
  let service: HistoryService;
  let aggregate: jest.Mock;
  let exec: jest.Mock;
  let findOne: jest.Mock;
  // Records every document constructed via `new this.historyModel(...)` so the create
  // specs can assert the constructor args + that .save() was called on the new doc.
  let createdDocs: any[];
  let mediaService: {
    findOneTVEpisodeByNumber: jest.Mock;
    findOneById: jest.Mock;
    findOneTVEpisodeById: jest.Mock;
  };

  const headers: any = { acceptLanguage: ['en'] };
  const authUser: any = { _id: BigInt(1) };
  // updateWatchTime reads authUser.settings.history.{paused,limit}; supply the nested
  // shape its consumers expect (not-paused, default 90% finish threshold).
  const watchAuthUser: any = { _id: BigInt(1), settings: { history: { paused: false, limit: 90 } } };

  // Build a mongoose doc-double for findOne()/new-model results: carries the given
  // fields plus jest-spied save()/toObject(). save() resolves to the doc; toObject()
  // returns a shallow copy (mirrors lean output the service returns to callers).
  function makeDoc(fields: Record<string, any>) {
    const doc: any = {
      ...fields,
      save: jest.fn().mockResolvedValue(undefined),
      toObject: jest.fn(function (this: any) {
        const { save, toObject, ...rest } = this;
        return { ...rest };
      })
    };
    return doc;
  }

  beforeEach(async () => {
    createdDocs = [];
    exec = jest.fn().mockResolvedValue([undefined]);
    aggregate = jest.fn().mockReturnValue({ exec });
    // Finished-candidate query: the surgeon may reach for it via either a second
    // `historyModel.aggregate(...)` or a `historyModel.find(...)` chain. Mock BOTH
    // surfaces so the new-behaviour specs do not over-prescribe the implementation.
    const findChain: any = {
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([])
    };
    const find = jest.fn().mockReturnValue(findChain);
    // findOne(...).exec() / .lean().exec() — single-record reads (update/findOneWatchTime/
    // updateWatchTime/markWatched). Each spec overrides the resolved value per case.
    findOne = jest.fn();
    // historyModel must be callable as a constructor (`new this.historyModel({...})`) AND
    // expose the static query helpers the service reaches through. A jest.fn() satisfies
    // both: existing findAll specs read .aggregate/.find unchanged; the create path uses
    // the constructor body to record + return a spied doc.
    const historyModel: any = jest.fn(function (this: any, init: Record<string, any>) {
      const doc = makeDoc(init);
      createdDocs.push(doc);
      return doc;
    });
    historyModel.aggregate = aggregate;
    historyModel.find = find;
    historyModel.findOne = findOne;

    mediaService = {
      findOneTVEpisodeByNumber: jest.fn(),
      findOneById: jest.fn(),
      findOneTVEpisodeById: jest.fn()
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HistoryService,
        { provide: getModelToken(History.name, MongooseConnection.DATABASE_A), useValue: historyModel },
        { provide: MediaService, useValue: mediaService }
      ]
    }).compile();

    service = module.get<HistoryService>(HistoryService);
  });

  // findOne(...) resolves a record (or null) through both the `.exec()` and the
  // `.lean().exec()` chain shapes the history service uses, so a spec can arrange a
  // record without knowing which read path the method took.
  function arrangeFindOne(record: any) {
    const chain: any = {
      exec: jest.fn().mockResolvedValue(record),
      lean: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(record) })
    };
    findOne.mockReturnValue(chain);
    return chain;
  }

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // CHARACTERIZATION — locks the CURRENT behaviour. These MUST stay green on the
  // unchanged service. The surgeon must not break any of these.
  // ---------------------------------------------------------------------------
  describe('findAll inProgress filter (characterization)', () => {
    it('excludes finished (watched >= 1) and not-started (time === 0) via doc filters', async () => {
      await service.findAll({ inProgress: true } as any, headers, authUser);

      const { filters } = inspectPipeline(aggregate.mock.calls[0][0]);
      // watched is a finish COUNT in the schema; < 1 means not yet finished.
      expect(filters.watched).toEqual({ $lt: 1 });
      // time > 0 means the user actually started watching.
      expect(filters.time).toEqual({ $gt: 0 });
      expect(filters.user).toBe(authUser._id);
    });

    it('returns a flat recency-sorted list (omits the date-grouping stage)', async () => {
      await service.findAll({ inProgress: true } as any, headers, authUser);

      const pipeline = aggregate.mock.calls[0][0];
      const { hasGroupByDate } = inspectPipeline(pipeline);
      expect(hasGroupByDate).toBe(false);
      const sortStage = pipeline.find((stage: any) => stage.$sort);
      expect(sortStage.$sort).toEqual({ date: -1 });
    });

    it('leaves the default (no inProgress) list unchanged — still date-grouped, no extra filters', async () => {
      await service.findAll({} as any, headers, authUser);

      const { filters, hasGroupByDate } = inspectPipeline(aggregate.mock.calls[0][0]);
      expect(filters.watched).toBeUndefined();
      expect(filters.time).toBeUndefined();
      expect(filters.user).toBe(authUser._id);
      expect(hasGroupByDate).toBe(true);
    });

    it('does not add a paused filter — paused-but-unfinished rows still appear (KEEP paused)', async () => {
      await service.findAll({ inProgress: true } as any, headers, authUser);

      const { filters } = inspectPipeline(aggregate.mock.calls[0][0]);
      // User-locked rule: the rail must NOT gain a `filters.paused`. A paused row
      // that is still unfinished (watched < 1, time > 0) must continue to surface.
      expect(filters.paused).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // TDD — NEW behaviour (next-episode-up enrichment). Expected RED until the
  // surgeon implements the post-aggregation resolve. These assert on the RETURNED
  // result list (the FE contract), independent of how the finished-candidate query
  // is run, so they bind the behaviour rather than the implementation.
  // ---------------------------------------------------------------------------
  describe('findAll inProgress next-episode-up resolve (TDD — RED until surgeon)', () => {
    const MEDIA_TV = BigInt(100);
    const MEDIA_MOVIE = BigInt(200);
    // A control series with a playable N+1 — used by the drop-off specs to prove
    // the resolve actually ran (the dropped series is absent BECAUSE the gate
    // rejected it, not because nothing resurfaces at all on the unchanged code).
    const MEDIA_CONTROL = BigInt(400);

    // Shape a finished-latest TV history row exactly as the aggregation would
    // project it: a populated `media` (type TV) + `episode` (with epNumber), and
    // the finish markers (watched >= 1, time === runtime, paused true).
    function finishedTVRow(opts: { media: bigint; epNumber: number; runtime: number; date: Date }) {
      return {
        _id: BigInt(Number(opts.media) + opts.epNumber),
        media: { _id: opts.media, type: MediaType.TV, runtime: opts.runtime },
        episode: {
          _id: BigInt(Number(opts.media) * 10 + opts.epNumber),
          epNumber: opts.epNumber,
          runtime: opts.runtime
        },
        time: opts.runtime,
        date: opts.date,
        paused: true,
        watched: 1
      };
    }

    // A genuine in-progress row (the aggregation already returns these unchanged).
    function inProgressTVRow(opts: { media: bigint; epNumber: number; runtime: number; time: number; date: Date }) {
      return {
        _id: BigInt(Number(opts.media) + opts.epNumber),
        media: { _id: opts.media, type: MediaType.TV, runtime: opts.runtime },
        episode: {
          _id: BigInt(Number(opts.media) * 10 + opts.epNumber),
          epNumber: opts.epNumber,
          runtime: opts.runtime
        },
        time: opts.time,
        date: opts.date,
        paused: false,
        watched: 0
      };
    }

    // A next episode doc as `findOneTVEpisodeByNumber` would return it.
    function nextEpisodeDoc(opts: {
      media: bigint;
      epNumber: number;
      runtime: number;
      visibility?: number;
      pStatus?: number;
    }) {
      return {
        _id: BigInt(Number(opts.media) * 10 + opts.epNumber),
        epNumber: opts.epNumber,
        runtime: opts.runtime,
        still: { name: `ep${opts.epNumber}.jpg` },
        visibility: opts.visibility ?? MediaVisibility.PUBLIC,
        pStatus: opts.pStatus ?? MediaPStatus.DONE
      };
    }

    // Wire the aggregation to return a CursorPaginated-shaped `[data]` with the
    // given in-progress rows, and feed the finished-candidate query (whichever
    // surface the surgeon uses) the given finished rows.
    function arrangeAggregation(inProgressRows: any[], finishedRows: any[]) {
      const data = {
        totalResults: inProgressRows.length,
        results: inProgressRows,
        hasNextPage: false,
        nextPageToken: null,
        prevPageToken: null
      };
      // First aggregate() call = the in-progress aggregation.
      // Optional second aggregate() call (if the surgeon runs the finished-candidate
      // query as an aggregation) returns the finished rows wrapped the same way the
      // pipeline would, i.e. a plain `[ ...rows ]`. We also expose the rows via the
      // .find() chain for the .find()-based implementation.
      const inProgressExec = jest.fn().mockResolvedValue([data]);
      const finishedExec = jest.fn().mockResolvedValue(finishedRows);
      aggregate.mockReturnValueOnce({ exec: inProgressExec }).mockReturnValue({ exec: finishedExec });

      const findChain: any = {
        sort: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(finishedRows)
      };
      // Re-point the .find() chain of the model the service holds, so a find()-based
      // finished-candidate query also returns the finished rows.
      const model: any = (service as any)['historyModel'];
      if (model?.find) model.find.mockReturnValue(findChain);
      return data;
    }

    // Resolve N+1 per series id: each entry maps media → the next-episode doc the
    // helper returns (or null). Lets a drop-off spec give the CONTROL series a
    // playable N+1 while the target series fails the gate.
    function resolveByMedia(byMedia: Map<bigint, any>) {
      mediaService.findOneTVEpisodeByNumber.mockImplementation((media: bigint) =>
        Promise.resolve(byMedia.has(media) ? byMedia.get(media) : null)
      );
    }

    it('resurfaces a finished-latest TV series whose N+1 is playable, as episode N+1 @ time=0', async () => {
      const finishedDate = new Date('2026-06-10T00:00:00Z');
      const finished = finishedTVRow({ media: MEDIA_TV, epNumber: 3, runtime: 1200, date: finishedDate });
      arrangeAggregation([], [finished]);
      mediaService.findOneTVEpisodeByNumber.mockResolvedValue(
        nextEpisodeDoc({ media: MEDIA_TV, epNumber: 4, runtime: 1300 })
      );

      const result: any = await service.findAll({ inProgress: true } as any, headers, authUser);

      const row = result.results.find((r: any) => r.media?._id === MEDIA_TV);
      expect(row).toBeDefined();
      expect(row.episode.epNumber).toBe(4);
      expect(row.time).toBe(0);
      // Same series.
      expect(row.media._id).toBe(MEDIA_TV);
    });

    it('resolves STRICTLY epNumber+1 even if N+1 is itself already watched (no skip to next-unwatched)', async () => {
      // User-locked: return exactly N+1, never "the next UNwatched" episode.
      const finished = finishedTVRow({
        media: MEDIA_TV,
        epNumber: 3,
        runtime: 1200,
        date: new Date('2026-06-10T00:00:00Z')
      });
      arrangeAggregation([], [finished]);
      mediaService.findOneTVEpisodeByNumber.mockResolvedValue(
        nextEpisodeDoc({ media: MEDIA_TV, epNumber: 4, runtime: 1300 })
      );

      const result: any = await service.findAll({ inProgress: true } as any, headers, authUser);

      const row = result.results.find((r: any) => r.media?._id === MEDIA_TV);
      expect(row.episode.epNumber).toBe(4);
      // The resolver was asked for exactly N+1 (= 4), not some "next unwatched" number.
      const requestedNumbers = mediaService.findOneTVEpisodeByNumber.mock.calls.map((c: any[]) => c[1]);
      expect(requestedNumbers).toContain(4);
      expect(requestedNumbers).not.toContain(5);
    });

    it('drops a finished FINALE off the rail (no N+1 episode exists) while a control series still resurfaces', async () => {
      // Finale series + a control series whose N+1 IS playable. The control proves
      // the resolve ran, so the finale's absence is the gate working, not a no-op.
      const finale = finishedTVRow({
        media: MEDIA_TV,
        epNumber: 10,
        runtime: 1200,
        date: new Date('2026-06-10T00:00:00Z')
      });
      const control = finishedTVRow({
        media: MEDIA_CONTROL,
        epNumber: 3,
        runtime: 1300,
        date: new Date('2026-06-11T00:00:00Z')
      });
      arrangeAggregation([], [finale, control]);
      // Finale: N+1 does not exist (null). Control: N+1 is playable.
      resolveByMedia(
        new Map<bigint, any>([[MEDIA_CONTROL, nextEpisodeDoc({ media: MEDIA_CONTROL, epNumber: 4, runtime: 1300 })]])
      );

      const result: any = await service.findAll({ inProgress: true } as any, headers, authUser);

      expect(result.results.some((r: any) => r.media?._id === MEDIA_TV)).toBe(false);
      expect(result.results.some((r: any) => r.media?._id === MEDIA_CONTROL)).toBe(true);
    });

    it('drops a series whose N+1 is NOT public (visibility !== PUBLIC) while a control series still resurfaces', async () => {
      const blocked = finishedTVRow({
        media: MEDIA_TV,
        epNumber: 3,
        runtime: 1200,
        date: new Date('2026-06-10T00:00:00Z')
      });
      const control = finishedTVRow({
        media: MEDIA_CONTROL,
        epNumber: 3,
        runtime: 1300,
        date: new Date('2026-06-11T00:00:00Z')
      });
      arrangeAggregation([], [blocked, control]);
      resolveByMedia(
        new Map<bigint, any>([
          [
            MEDIA_TV,
            nextEpisodeDoc({ media: MEDIA_TV, epNumber: 4, runtime: 1300, visibility: MediaVisibility.PRIVATE })
          ],
          [MEDIA_CONTROL, nextEpisodeDoc({ media: MEDIA_CONTROL, epNumber: 4, runtime: 1300 })]
        ])
      );

      const result: any = await service.findAll({ inProgress: true } as any, headers, authUser);

      expect(result.results.some((r: any) => r.media?._id === MEDIA_TV)).toBe(false);
      expect(result.results.some((r: any) => r.media?._id === MEDIA_CONTROL)).toBe(true);
    });

    it('drops a series whose N+1 is not DONE (pStatus !== DONE) while a control series still resurfaces', async () => {
      const blocked = finishedTVRow({
        media: MEDIA_TV,
        epNumber: 3,
        runtime: 1200,
        date: new Date('2026-06-10T00:00:00Z')
      });
      const control = finishedTVRow({
        media: MEDIA_CONTROL,
        epNumber: 3,
        runtime: 1300,
        date: new Date('2026-06-11T00:00:00Z')
      });
      arrangeAggregation([], [blocked, control]);
      resolveByMedia(
        new Map<bigint, any>([
          [MEDIA_TV, nextEpisodeDoc({ media: MEDIA_TV, epNumber: 4, runtime: 1300, pStatus: MediaPStatus.PROCESSING })],
          [MEDIA_CONTROL, nextEpisodeDoc({ media: MEDIA_CONTROL, epNumber: 4, runtime: 1300 })]
        ])
      );

      const result: any = await service.findAll({ inProgress: true } as any, headers, authUser);

      expect(result.results.some((r: any) => r.media?._id === MEDIA_TV)).toBe(false);
      expect(result.results.some((r: any) => r.media?._id === MEDIA_CONTROL)).toBe(true);
    });

    it('never leaks pStatus on a resurfaced episode (stripped before return)', async () => {
      const finished = finishedTVRow({
        media: MEDIA_TV,
        epNumber: 3,
        runtime: 1200,
        date: new Date('2026-06-10T00:00:00Z')
      });
      arrangeAggregation([], [finished]);
      mediaService.findOneTVEpisodeByNumber.mockResolvedValue(
        nextEpisodeDoc({ media: MEDIA_TV, epNumber: 4, runtime: 1300 })
      );

      const result: any = await service.findAll({ inProgress: true } as any, headers, authUser);

      const row = result.results.find((r: any) => r.media?._id === MEDIA_TV);
      expect(row).toBeDefined();
      // The gate reads pStatus internally but it must never reach the client.
      expect(row.episode.pStatus).toBeUndefined();
      // The episodeFields projection IS preserved (epNumber/runtime present).
      expect(row.episode.epNumber).toBe(4);
      expect(row.episode.runtime).toBe(1300);
    });

    it('does not resurface a finished MOVIE (no episode → never resolved as next-ep) while a control TV series resurfaces', async () => {
      const finishedMovie = {
        _id: BigInt(999),
        media: { _id: MEDIA_MOVIE, type: MediaType.MOVIE, runtime: 6000 },
        episode: undefined,
        time: 6000,
        date: new Date('2026-06-10T00:00:00Z'),
        paused: true,
        watched: 1
      };
      const control = finishedTVRow({
        media: MEDIA_CONTROL,
        epNumber: 3,
        runtime: 1300,
        date: new Date('2026-06-11T00:00:00Z')
      });
      arrangeAggregation([], [finishedMovie, control]);
      resolveByMedia(
        new Map<bigint, any>([[MEDIA_CONTROL, nextEpisodeDoc({ media: MEDIA_CONTROL, epNumber: 4, runtime: 1300 })]])
      );

      const result: any = await service.findAll({ inProgress: true } as any, headers, authUser);

      expect(result.results.some((r: any) => r.media?._id === MEDIA_MOVIE)).toBe(false);
      // The control TV series resurfaced — proving the resolve ran, so the movie's
      // absence is "movies are skipped", not "nothing resurfaces".
      expect(result.results.some((r: any) => r.media?._id === MEDIA_CONTROL)).toBe(true);
      // A movie must never be sent to the episode resolver.
      const requestedMedia = mediaService.findOneTVEpisodeByNumber.mock.calls.map((c: any[]) => c[0]);
      expect(requestedMedia).not.toContain(MEDIA_MOVIE);
    });

    it('merges a resurfaced N+1 row with genuine in-progress rows, sorted by date desc', async () => {
      const inProgressMedia = BigInt(300);
      // Genuine in-progress row touched 2026-06-12 (more recent than the finished row).
      const inProg = inProgressTVRow({
        media: inProgressMedia,
        epNumber: 2,
        runtime: 1100,
        time: 500,
        date: new Date('2026-06-12T00:00:00Z')
      });
      // Finished row touched 2026-06-10 (older) → its resurfaced N+1 sorts after.
      const finished = finishedTVRow({
        media: MEDIA_TV,
        epNumber: 3,
        runtime: 1200,
        date: new Date('2026-06-10T00:00:00Z')
      });
      arrangeAggregation([inProg], [finished]);
      mediaService.findOneTVEpisodeByNumber.mockResolvedValue(
        nextEpisodeDoc({ media: MEDIA_TV, epNumber: 4, runtime: 1300 })
      );

      const result: any = await service.findAll({ inProgress: true } as any, headers, authUser);

      const ids = result.results.map((r: any) => r.media?._id);
      expect(ids).toContain(inProgressMedia);
      expect(ids).toContain(MEDIA_TV);
      // Sorted by date desc: the more recent genuine in-progress row comes first,
      // the resurfaced row (finished row's date) comes after.
      expect(ids.indexOf(inProgressMedia)).toBeLessThan(ids.indexOf(MEDIA_TV));
      // The resurfaced row uses the finished episode's date, not "now".
      const resurfaced = result.results.find((r: any) => r.media?._id === MEDIA_TV);
      expect(new Date(resurfaced.date).toISOString()).toBe(new Date('2026-06-10T00:00:00Z').toISOString());
    });

    it('resolves a bounded number of times — one helper call per candidate series, both surfaced', async () => {
      // Two distinct finished series, each a single candidate with a playable N+1.
      const mediaA = BigInt(100);
      const mediaB = BigInt(101);
      const finishedA = finishedTVRow({
        media: mediaA,
        epNumber: 3,
        runtime: 1200,
        date: new Date('2026-06-10T00:00:00Z')
      });
      const finishedB = finishedTVRow({
        media: mediaB,
        epNumber: 5,
        runtime: 1400,
        date: new Date('2026-06-09T00:00:00Z')
      });
      arrangeAggregation([], [finishedA, finishedB]);
      mediaService.findOneTVEpisodeByNumber.mockImplementation((media: bigint, epNumber: number) =>
        Promise.resolve(nextEpisodeDoc({ media, epNumber, runtime: 1300 }))
      );

      const result: any = await service.findAll({ inProgress: true } as any, headers, authUser);

      // Both candidates resurfaced (proves the resolve ran for each).
      expect(result.results.some((r: any) => r.media?._id === mediaA)).toBe(true);
      expect(result.results.some((r: any) => r.media?._id === mediaB)).toBe(true);
      // Bounded: at most one resolve per candidate series, not an unbounded fan-out.
      expect(mediaService.findOneTVEpisodeByNumber.mock.calls.length).toBeLessThanOrEqual(2);
    });

    it('isolates a rejected lookup — other resurfaced + in-progress rows still return (no throw)', async () => {
      const mediaA = BigInt(100);
      const mediaB = BigInt(101);
      const inProgressMedia = BigInt(300);
      const inProg = inProgressTVRow({
        media: inProgressMedia,
        epNumber: 2,
        runtime: 1100,
        time: 500,
        date: new Date('2026-06-12T00:00:00Z')
      });
      const finishedA = finishedTVRow({
        media: mediaA,
        epNumber: 3,
        runtime: 1200,
        date: new Date('2026-06-10T00:00:00Z')
      });
      const finishedB = finishedTVRow({
        media: mediaB,
        epNumber: 5,
        runtime: 1400,
        date: new Date('2026-06-09T00:00:00Z')
      });
      arrangeAggregation([inProg], [finishedA, finishedB]);
      // mediaA's lookup rejects (DB hiccup); mediaB resolves a playable N+1.
      mediaService.findOneTVEpisodeByNumber.mockImplementation((media: bigint, epNumber: number) =>
        media === mediaA
          ? Promise.reject(new Error('db timeout'))
          : Promise.resolve(nextEpisodeDoc({ media, epNumber, runtime: 1300 }))
      );

      const result: any = await service.findAll({ inProgress: true } as any, headers, authUser);

      // No throw: the genuine in-progress row and the surviving resurfaced row both return.
      expect(result.results.some((r: any) => r.media?._id === inProgressMedia)).toBe(true);
      expect(result.results.some((r: any) => r.media?._id === mediaB)).toBe(true);
      // The series whose lookup failed is simply absent — it did not 500 the response.
      expect(result.results.some((r: any) => r.media?._id === mediaA)).toBe(false);
    });

    it('does not double-list a series already present as a genuine in-progress row', async () => {
      // User is mid-S1E1 (in-progress) AND finished S1E3 of the SAME series.
      const inProg = inProgressTVRow({
        media: MEDIA_TV,
        epNumber: 1,
        runtime: 1200,
        time: 400,
        date: new Date('2026-06-12T00:00:00Z')
      });
      const finished = finishedTVRow({
        media: MEDIA_TV,
        epNumber: 3,
        runtime: 1200,
        date: new Date('2026-06-10T00:00:00Z')
      });
      arrangeAggregation([inProg], [finished]);
      mediaService.findOneTVEpisodeByNumber.mockResolvedValue(
        nextEpisodeDoc({ media: MEDIA_TV, epNumber: 4, runtime: 1300 })
      );

      const result: any = await service.findAll({ inProgress: true } as any, headers, authUser);

      // Exactly one row for the series — the genuine in-progress one (real resume point).
      const rows = result.results.filter((r: any) => r.media?._id === MEDIA_TV);
      expect(rows.length).toBe(1);
      expect(rows[0].episode.epNumber).toBe(1);
      expect(rows[0].time).toBe(400);
      // The series was never resolved as a next-ep candidate (skipped before the lookup).
      const requestedMedia = mediaService.findOneTVEpisodeByNumber.mock.calls.map((c: any[]) => c[0]);
      expect(requestedMedia).not.toContain(MEDIA_TV);
    });

    it('resets the finished row flags on the resurfaced unstarted episode (watched 0, paused false)', async () => {
      const finished = finishedTVRow({
        media: MEDIA_TV,
        epNumber: 3,
        runtime: 1200,
        date: new Date('2026-06-10T00:00:00Z')
      });
      arrangeAggregation([], [finished]);
      mediaService.findOneTVEpisodeByNumber.mockResolvedValue(
        nextEpisodeDoc({ media: MEDIA_TV, epNumber: 4, runtime: 1300 })
      );

      const result: any = await service.findAll({ inProgress: true } as any, headers, authUser);

      const row = result.results.find((r: any) => r.media?._id === MEDIA_TV);
      expect(row).toBeDefined();
      // The next episode is unstarted — the finished row's watched/paused must not carry over.
      expect(row.watched).toBe(0);
      expect(row.paused).toBe(false);
      expect(row.time).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // CHARACTERIZATION — update() / updateWatchTime() / findOneWatchTime(). These
  // lock the CURRENT behaviour of the methods the W0.9 surgeon must NOT perturb
  // while adding markWatched(). MUST stay green on the unchanged service.
  // ---------------------------------------------------------------------------
  describe('update (characterization)', () => {
    it('throws EMPTY_BODY 400 when the dto is empty', async () => {
      await expect(service.update(BigInt(5), {} as any, authUser)).rejects.toMatchObject({
        response: { code: StatusCode.EMPTY_BODY },
        status: HttpStatus.BAD_REQUEST
      });
      // No record read attempted on an empty body.
      expect(findOne).not.toHaveBeenCalled();
    });

    it('throws HISTORY_NOT_FOUND 404 when no record matches', async () => {
      arrangeFindOne(null);
      await expect(service.update(BigInt(5), { watched: 1 } as any, authUser)).rejects.toMatchObject({
        response: { code: StatusCode.HISTORY_NOT_FOUND },
        status: HttpStatus.NOT_FOUND
      });
    });

    it('reads the record scoped to BOTH the record id and the user (no IDOR)', async () => {
      arrangeFindOne(makeDoc({ paused: false, watched: 0 }));
      await service.update(BigInt(5), { watched: 1 } as any, authUser);
      expect(findOne.mock.calls[0][0]).toEqual({ _id: BigInt(5), user: authUser._id });
    });

    it('watched===1 increments the finish count (watched += 1) and saves', async () => {
      const doc = makeDoc({ paused: false, watched: 2 });
      arrangeFindOne(doc);
      await service.update(BigInt(5), { watched: 1 } as any, authUser);
      expect(doc.watched).toBe(3);
      expect(doc.save).toHaveBeenCalledTimes(1);
    });

    it('watched===0 resets the finish count to 0 and saves', async () => {
      const doc = makeDoc({ paused: true, watched: 4 });
      arrangeFindOne(doc);
      await service.update(BigInt(5), { watched: 0 } as any, authUser);
      expect(doc.watched).toBe(0);
      expect(doc.save).toHaveBeenCalledTimes(1);
    });
  });

  describe('updateWatchTime (characterization)', () => {
    it('early-returns (no media lookup, no create) when the user has history paused', async () => {
      const paused: any = { _id: BigInt(1), settings: { history: { paused: true, limit: 90 } } };
      const result = await service.updateWatchTime({ media: BigInt(50), time: 100 } as any, paused);
      expect(result).toBeUndefined();
      expect(mediaService.findOneById).not.toHaveBeenCalled();
      expect(createdDocs.length).toBe(0);
    });

    it('throws MEDIA_NOT_FOUND 404 when the media does not exist', async () => {
      mediaService.findOneById.mockResolvedValue(null);
      await expect(
        service.updateWatchTime({ media: BigInt(50), time: 100 } as any, watchAuthUser)
      ).rejects.toMatchObject({ response: { code: StatusCode.MEDIA_NOT_FOUND }, status: HttpStatus.NOT_FOUND });
    });

    it('requires an episode for a TV media — throws EPISODE_NOT_FOUND when omitted', async () => {
      mediaService.findOneById.mockResolvedValue({ _id: BigInt(50), type: MediaType.TV, runtime: 1200 });
      await expect(
        service.updateWatchTime({ media: BigInt(50), time: 100 } as any, watchAuthUser)
      ).rejects.toMatchObject({ response: { code: StatusCode.EPISODE_NOT_FOUND }, status: HttpStatus.NOT_FOUND });
    });

    it('creates a new MOVIE row with watched:0 when none exists (partial progress)', async () => {
      mediaService.findOneById.mockResolvedValue({ _id: BigInt(50), type: MediaType.MOVIE, runtime: 6000 });
      arrangeFindOne(null);
      await service.updateWatchTime({ media: BigInt(50), time: 100 } as any, watchAuthUser);
      expect(createdDocs.length).toBe(1);
      const init = historyModelInit();
      expect(init._id).toBe(FIXED_SNOWFLAKE);
      expect(init.user).toBe(watchAuthUser._id);
      expect(init.media).toBe(BigInt(50));
      // Partial progress (time < runtime) is not a finish — watched stays 0.
      expect(init.watched).toBe(0);
      expect(createdDocs[0].save).toHaveBeenCalledTimes(1);
    });

    it('marks watched (watched += 1, paused = true) when calculatedTime reaches the runtime', async () => {
      mediaService.findOneById.mockResolvedValue({ _id: BigInt(50), type: MediaType.MOVIE, runtime: 6000 });
      const doc = makeDoc({ paused: false, watched: 0, time: 100 });
      arrangeFindOne(doc);
      // time === runtime → calculatedTime === runtime → finish.
      await service.updateWatchTime({ media: BigInt(50), time: 6000 } as any, watchAuthUser);
      expect(doc.watched).toBe(1);
      expect(doc.paused).toBe(true);
      expect(doc.save).toHaveBeenCalledTimes(1);
    });
  });

  describe('findOneWatchTime (characterization)', () => {
    it('reads user-scoped {user, media} and returns the lean record', async () => {
      const record = { _id: BigInt(7), time: 300, date: new Date(), paused: false, watched: 0 };
      arrangeFindOne(record);
      const result = await service.findOneWatchTime({ media: BigInt(50) } as any, authUser);
      expect(result).toBe(record);
      expect(findOne.mock.calls[0][0]).toEqual({ user: authUser._id, media: BigInt(50) });
    });

    it('includes the episode in the filter when one is supplied', async () => {
      arrangeFindOne(null);
      const result = await service.findOneWatchTime({ media: BigInt(50), episode: BigInt(60) } as any, authUser);
      expect(result).toBeNull();
      expect(findOne.mock.calls[0][0]).toEqual({ user: authUser._id, media: BigInt(50), episode: BigInt(60) });
    });
  });

  // findAll inProgress shape-smoke — guards the resume-path contract is not broken
  // by the markWatched addition (the deep next-episode-up behaviour is covered above).
  describe('findAll inProgress contract smoke (characterization)', () => {
    it('returns a CursorPaginated-shaped result with a results array on the resume path', async () => {
      const data = {
        totalResults: 1,
        results: [
          {
            _id: BigInt(11),
            media: { _id: BigInt(100), type: MediaType.TV, runtime: 1200 },
            episode: { _id: BigInt(1001), epNumber: 2, runtime: 1200 },
            time: 500,
            date: new Date('2026-06-12T00:00:00Z'),
            paused: false,
            watched: 0
          }
        ],
        hasNextPage: false,
        nextPageToken: null,
        prevPageToken: null
      };
      aggregate.mockReturnValue({ exec: jest.fn().mockResolvedValue([data]) });
      const result: any = await service.findAll({ inProgress: true } as any, headers, authUser);
      expect(Array.isArray(result.results)).toBe(true);
      expect(result.totalResults).toBe(1);
      expect(result.results.some((r: any) => r.media?._id === BigInt(100))).toBe(true);
    });
  });

  // Pull the constructor init args of the first `new this.historyModel(...)` call.
  function historyModelInit() {
    const model: any = (service as any)['historyModel'];
    return model.mock.calls[0][0];
  }

  // ---------------------------------------------------------------------------
  // TDD — NEW behaviour: markWatched(). Expected RED until the surgeon implements
  // the service method. These bind the locked contract from the analyst brief.
  // ---------------------------------------------------------------------------
  describe('markWatched (TDD — RED until surgeon)', () => {
    const MEDIA = BigInt(50);
    const EPISODE = BigInt(60);

    // Call markWatched through an any-typed view of the service. The method does not
    // exist yet, so this RED-fails at runtime (TypeError) until the surgeon adds it —
    // but the spec file still type-checks (ts-jest would otherwise fail the WHOLE file
    // to compile, hiding the Block-A characterization specs above it).
    const markWatched = (media: bigint, dto: any, user: any) => (service as any).markWatched(media, dto, user);

    it('mark + absent row → creates {watched:1, time:0, paused:false} with a snowflake _id, user-scoped', async () => {
      mediaService.findOneById.mockResolvedValue({ _id: MEDIA, type: MediaType.MOVIE, runtime: 6000 });
      arrangeFindOne(null);

      const result: any = await markWatched(MEDIA, { watched: 1 } as any, watchAuthUser);

      expect(createdDocs.length).toBe(1);
      const init = historyModelInit();
      expect(init._id).toBe(FIXED_SNOWFLAKE);
      expect(init.user).toBe(watchAuthUser._id);
      expect(init.media).toBe(MEDIA);
      expect(init.watched).toBe(1);
      expect(init.time).toBe(0);
      expect(init.paused).toBe(false);
      expect(init.date).toBeInstanceOf(Date);
      expect(createdDocs[0].save).toHaveBeenCalledTimes(1);
      // Returns the created record (watched surfaced so the FE knows the post-toggle state).
      expect(result.watched).toBe(1);
    });

    it('mark + existing row → watched += 1, saves, NO new doc created', async () => {
      mediaService.findOneById.mockResolvedValue({ _id: MEDIA, type: MediaType.MOVIE, runtime: 6000 });
      const doc = makeDoc({ user: watchAuthUser._id, media: MEDIA, time: 0, paused: false, watched: 1 });
      arrangeFindOne(doc);

      await markWatched(MEDIA, { watched: 1 } as any, watchAuthUser);

      expect(doc.watched).toBe(2);
      expect(doc.save).toHaveBeenCalledTimes(1);
      expect(createdDocs.length).toBe(0);
    });

    it('unmark + existing row → watched = 0 and saves', async () => {
      mediaService.findOneById.mockResolvedValue({ _id: MEDIA, type: MediaType.MOVIE, runtime: 6000 });
      const doc = makeDoc({ user: watchAuthUser._id, media: MEDIA, time: 0, paused: false, watched: 3 });
      arrangeFindOne(doc);

      const result: any = await markWatched(MEDIA, { watched: 0 } as any, watchAuthUser);

      expect(doc.watched).toBe(0);
      expect(doc.save).toHaveBeenCalledTimes(1);
      expect(result.watched).toBe(0);
    });

    it('unmark + absent row → returns null, NO create and NO save', async () => {
      mediaService.findOneById.mockResolvedValue({ _id: MEDIA, type: MediaType.MOVIE, runtime: 6000 });
      arrangeFindOne(null);

      const result = await markWatched(MEDIA, { watched: 0 } as any, watchAuthUser);

      expect(result).toBeNull();
      expect(createdDocs.length).toBe(0);
    });

    it('media not found → throws MEDIA_NOT_FOUND 404', async () => {
      mediaService.findOneById.mockResolvedValue(null);

      await expect(markWatched(MEDIA, { watched: 1 } as any, watchAuthUser)).rejects.toMatchObject({
        response: { code: StatusCode.MEDIA_NOT_FOUND },
        status: HttpStatus.NOT_FOUND
      });
      // Never touches the history collection when the media is missing.
      expect(findOne).not.toHaveBeenCalled();
      expect(createdDocs.length).toBe(0);
    });

    it('TV media with episode OMITTED → allowed (media-level), does NOT throw EPISODE_NOT_FOUND', async () => {
      // The one divergence from updateWatchTime: AC8 marks at media level for the grid card.
      mediaService.findOneById.mockResolvedValue({ _id: MEDIA, type: MediaType.TV, runtime: 1200 });
      arrangeFindOne(null);

      const result: any = await markWatched(MEDIA, { watched: 1 } as any, watchAuthUser);

      // Created/found a media-level row (no episode in the key).
      expect(createdDocs.length).toBe(1);
      const init = historyModelInit();
      expect(init.media).toBe(MEDIA);
      expect(init.episode).toBeUndefined();
      expect(result.watched).toBe(1);
    });

    it('keys on the episode when supplied — filter carries {user, media, episode}', async () => {
      mediaService.findOneById.mockResolvedValue({ _id: MEDIA, type: MediaType.TV, runtime: 1200 });
      arrangeFindOne(null);

      await markWatched(MEDIA, { episode: EPISODE, watched: 1 } as any, watchAuthUser);

      expect(findOne.mock.calls[0][0]).toEqual({ user: watchAuthUser._id, media: MEDIA, episode: EPISODE });
      const init = historyModelInit();
      expect(init.episode).toBe(EPISODE);
    });

    it('every query is user-scoped (IDOR guard) — find filter carries user: authUser._id', async () => {
      mediaService.findOneById.mockResolvedValue({ _id: MEDIA, type: MediaType.MOVIE, runtime: 6000 });
      arrangeFindOne(null);

      await markWatched(MEDIA, { watched: 1 } as any, watchAuthUser);

      expect(findOne.mock.calls[0][0]).toMatchObject({ user: watchAuthUser._id, media: MEDIA });
    });
  });
});
