import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';

import { HistoryService } from './history.service';
import { MediaService } from '../media/media.service';
import { MediaPStatus, MediaType, MediaVisibility, MongooseConnection } from '../../enums';
import { History } from '../../schemas';

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
  let mediaService: { findOneTVEpisodeByNumber: jest.Mock };

  const headers: any = { acceptLanguage: ['en'] };
  const authUser: any = { _id: BigInt(1) };

  beforeEach(async () => {
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
    const historyModel = { aggregate, find };

    mediaService = { findOneTVEpisodeByNumber: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HistoryService,
        { provide: getModelToken(History.name, MongooseConnection.DATABASE_A), useValue: historyModel },
        { provide: MediaService, useValue: mediaService }
      ]
    }).compile();

    service = module.get<HistoryService>(HistoryService);
  });

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
});
