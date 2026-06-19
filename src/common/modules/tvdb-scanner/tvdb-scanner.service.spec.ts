import { Test, TestingModule } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { HttpException, HttpStatus } from '@nestjs/common';
import { of, throwError } from 'rxjs';

import { TvdbScannerService } from './tvdb-scanner.service';
import { TmdbScannerService } from '../tmdb-scanner/tmdb-scanner.service';
import { StatusCode } from '../../../enums';

// See the tmdb spec for the rationale: `.response`-present = today's contract,
// no-`.response` = the network error FU9 must start mapping to the 503 envelope.
function axiosErrorWithResponse(status: number, statusText: string): any {
  return { isAxiosError: true, response: { status, statusText } };
}

function axiosNetworkError(code: string): any {
  return { isAxiosError: true, code, message: `connect ${code}` };
}

describe('TvdbScannerService', () => {
  let service: TvdbScannerService;
  let httpService: { get: jest.Mock; post: jest.Mock };

  beforeEach(async () => {
    httpService = {
      get: jest.fn(),
      // refreshToken() posts to /login and reads response.data.data.token before any
      // get() runs, so every error-path test needs a successful login mock in place.
      post: jest.fn().mockReturnValue(of({ data: { data: { token: 'fake-token' } } }))
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [TvdbScannerService]
    })
      .useMocker((token): any => {
        if (token === ConfigService) return { get: (): undefined => undefined };
        if (token === HttpService) return httpService;
        // TmdbScannerService is injected for cross-provider enrichment but is not
        // reached on the error paths exercised here; an empty stub is sufficient.
        if (token === TmdbScannerService) return {};
        return {};
      })
      .compile();

    service = module.get<TvdbScannerService>(TvdbScannerService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('third-party error mapping (FU9)', () => {
    // CHARACTERIZATION — axios error WITH a response maps to 503/1100 with the exact
    // message. Green on current code.
    it('maps an axios error WITH a response to HttpException 503 / THRID_PARTY_REQUEST_FAILED (search)', async () => {
      httpService.get.mockReturnValue(throwError(() => axiosErrorWithResponse(429, 'Too Many Requests')));

      try {
        await service.search('dune', 1, 2021, 'en', 'movie');
        fail('expected search to throw');
      } catch (e) {
        const err = e as HttpException;
        expect(err.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
        const body = err.getResponse() as { code: number; message: string };
        expect(body.code).toBe(StatusCode.THRID_PARTY_REQUEST_FAILED);
        expect(body.message).toBe('Received 429 Too Many Requests error from third party api');
      }
    });

    it('maps an axios error WITH a response to 503 for movieDetails as well', async () => {
      httpService.get.mockReturnValue(throwError(() => axiosErrorWithResponse(503, 'Service Unavailable')));

      try {
        await service.movieDetails('289', 'en');
        fail('expected movieDetails to throw');
      } catch (e) {
        const err = e as HttpException;
        expect(err.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
        const body = err.getResponse() as { code: number };
        expect(body.code).toBe(StatusCode.THRID_PARTY_REQUEST_FAILED);
      }
    });

    // NEW / RED on unchanged code — the FU9 fix. No `.response` (network error) →
    // today re-throws raw (HTTP 500); after the fix it must map to 503/1100.
    it('maps an axios network error (no response) to HttpException 503 / THRID_PARTY_REQUEST_FAILED (search)', async () => {
      httpService.get.mockReturnValue(throwError(() => axiosNetworkError('ENOTFOUND')));

      let thrown: unknown;
      try {
        await service.search('dune', 1, 2021, 'en', 'movie');
        fail('expected search to throw');
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBeInstanceOf(HttpException);
      const err = thrown as HttpException;
      expect(err.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      const body = err.getResponse() as { code: number };
      expect(body.code).toBe(StatusCode.THRID_PARTY_REQUEST_FAILED);
    });

    it('maps an axios network error (no response) to 503 for movieDetails as well', async () => {
      httpService.get.mockReturnValue(throwError(() => axiosNetworkError('ECONNREFUSED')));

      let thrown: unknown;
      try {
        await service.movieDetails('289', 'en');
        fail('expected movieDetails to throw');
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBeInstanceOf(HttpException);
      const err = thrown as HttpException;
      expect(err.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      const body = err.getResponse() as { code: number };
      expect(body.code).toBe(StatusCode.THRID_PARTY_REQUEST_FAILED);
    });

    // CHARACTERIZATION — a non-axios error re-throws unchanged.
    it('re-throws a non-axios error unchanged (not reclassified to 503)', async () => {
      const boom = new Error('boom');
      httpService.get.mockReturnValue(throwError(() => boom));

      await expect(service.search('dune', 1, 2021, 'en', 'movie')).rejects.toBe(boom);
    });
  });

  describe('episodeDetails not-found passthrough (FU9 guard)', () => {
    // CHARACTERIZATION — episodeDetails throws its own EPISODE_NOT_FOUND HttpException
    // (404) when the lookup returns no episode. That is an HttpException, NOT an axios
    // error, so it survives the catch unchanged. The FU9 broadening must NOT reclassify
    // it to a 503. Green on current code; the test fails loudly if the fix swallows it.
    it('throws 404 EPISODE_NOT_FOUND (not 503) when no episode matches', async () => {
      // The first get() (episodes/default) resolves with an empty episodes array, so
      // episodeId is undefined and the service throws its own 404 before any 503 path.
      httpService.get.mockReturnValue(of({ data: { data: { episodes: [] } } }));

      try {
        await service.episodeDetails('289', '1', '1', 'en');
        fail('expected episodeDetails to throw');
      } catch (e) {
        const err = e as HttpException;
        expect(err).toBeInstanceOf(HttpException);
        expect(err.getStatus()).toBe(HttpStatus.NOT_FOUND);
        const body = err.getResponse() as { code: number };
        expect(body.code).toBe(StatusCode.EPISODE_NOT_FOUND);
      }
    });
  });

  // W4.9.4 — externalIds.tvdb round-trip. movieDetails()/tvDetails() must surface the
  // TVDB id (data.id) on result.externalIds.tvdb, ADDING to (never clobbering) the
  // imdb/tmdb that the optional TMDB cross-ref supplies. The load-bearing edge is the
  // no-cross-ref case (no remoteIds type 12 → ...FromTMDB is null), where externalIds
  // does not exist yet and must be created so .tvdb has somewhere to live.
  describe('externalIds.tvdb round-trip (W4.9.4)', () => {
    // 'en' resolves to iso639_2 'eng' (language-codes.util) — translations/aliases use
    // 'eng' so langNameTranslation / langNameAlias resolve and the service reaches the
    // externalIds assignment without a lookup crash.
    const TVDB_MOVIE_ID = 289; // the TVDB id; becomes result.externalIds.tvdb
    const TVDB_TV_ID = 12345;

    // Read `tvdb` via an index signature so this spec compiles against the UNCHANGED
    // entity (where the field does not exist yet). The assertion stays exact — on
    // current code this returns undefined (TDD RED for the right reason: not the id),
    // after the surgeon adds the field it returns data.id (GREEN). Not a weakening: the
    // value contract `=== TVDB id` is unchanged; only the static read is detyped.
    function readTvdb(externalIds: unknown): unknown {
      return (externalIds as Record<string, unknown> | undefined)?.['tvdb'];
    }

    // A minimal MediaDetails-shaped cross-ref the TmdbScannerService stub returns when a
    // remoteIds type-12 (TheMovieDB) id is present. Only externalIds is asserted here.
    function tmdbCrossRef(): any {
      return {
        title: 'From TMDB',
        originalTitle: 'From TMDB',
        altTitles: [],
        overview: 'tmdb overview',
        posterPath: '/tmdb-poster.jpg',
        backdropPath: '/tmdb-backdrop.jpg',
        collection: undefined,
        tags: ['tmdb-tag'],
        externalIds: { imdb: 'tt0111161', tmdb: 603 }
      };
    }

    // TVDB /movies/:id/extended payload. `withTmdbRemoteId` toggles the type-12 remote id
    // that drives whether the TMDB cross-ref is invoked.
    function movieExtendedData(withTmdbRemoteId: boolean): any {
      return {
        id: TVDB_MOVIE_ID,
        name: 'TVDB Movie',
        originalLanguage: 'eng',
        image: '/tvdb-poster.jpg',
        runtime: 130,
        aliases: [{ language: 'eng', name: 'TVDB Movie Alias' }],
        artworks: [],
        genres: [{ name: 'Action' }],
        companies: { studio: [], production: [] },
        tagOptions: [],
        trailers: [],
        status: { id: 5 },
        first_release: { date: '1994-09-23' },
        remoteIds: withTmdbRemoteId ? [{ type: 12, id: '603' }] : [{ type: 99, id: 'other' }],
        translations: {
          nameTranslations: [{ language: 'eng', name: 'TVDB Movie' }],
          overviewTranslations: [{ language: 'eng', overview: 'tvdb overview' }]
        }
      };
    }

    // TVDB /series/:id/extended payload. No seasons → the season fan-out loop is skipped.
    function tvExtendedData(withTmdbRemoteId: boolean): any {
      return {
        id: TVDB_TV_ID,
        name: 'TVDB Series',
        originalLanguage: 'eng',
        image: '/tvdb-poster.jpg',
        averageRuntime: 42,
        aliases: [{ language: 'eng', name: 'TVDB Series Alias' }],
        artworks: [],
        genres: [{ name: 'Drama' }],
        companies: [],
        tags: [],
        trailers: [],
        status: { id: 1 },
        firstAired: '2010-01-01',
        lastAired: '2015-12-31',
        seasons: [],
        remoteIds: withTmdbRemoteId ? [{ type: 12, id: '1399' }] : [{ type: 99, id: 'other' }],
        translations: {
          nameTranslations: [{ language: 'eng', name: 'TVDB Series' }],
          overviewTranslations: [{ language: 'eng', overview: 'tvdb overview' }]
        }
      };
    }

    let tmdbScannerService: { movieDetails: jest.Mock; tvDetails: jest.Mock };

    beforeEach(async () => {
      // A controllable TMDB cross-ref mock (the outer beforeEach stubs it as {} — that is
      // fine for the error-path tests but here the cross-ref methods must be jest mocks).
      tmdbScannerService = { movieDetails: jest.fn(), tvDetails: jest.fn() };
      const module: TestingModule = await Test.createTestingModule({
        providers: [TvdbScannerService]
      })
        .useMocker((token): any => {
          if (token === ConfigService) return { get: (): undefined => undefined };
          if (token === HttpService) return httpService;
          if (token === TmdbScannerService) return tmdbScannerService;
          return {};
        })
        .compile();
      service = module.get<TvdbScannerService>(TvdbScannerService);
    });

    describe('movieDetails', () => {
      it('CHARACTERIZATION: when a TMDB cross-ref is present, imdb/tmdb populate exactly as today', async () => {
        tmdbScannerService.movieDetails.mockResolvedValue(tmdbCrossRef());
        httpService.get.mockReturnValue(of({ data: { data: movieExtendedData(true) } }));

        const result = await service.movieDetails('289', 'en');

        expect(tmdbScannerService.movieDetails).toHaveBeenCalledWith('603', 'en');
        expect(result.externalIds.imdb).toBe('tt0111161');
        expect(result.externalIds.tmdb).toBe(603);
      });

      it('TDD: result.externalIds.tvdb === data.id (the TVDB id)', async () => {
        tmdbScannerService.movieDetails.mockResolvedValue(tmdbCrossRef());
        httpService.get.mockReturnValue(of({ data: { data: movieExtendedData(true) } }));

        const result = await service.movieDetails('289', 'en');

        expect(readTvdb(result.externalIds)).toBe(TVDB_MOVIE_ID);
      });

      it('TDD: tvdb is ADDED — the TMDB cross-ref still wins for imdb/tmdb', async () => {
        tmdbScannerService.movieDetails.mockResolvedValue(tmdbCrossRef());
        httpService.get.mockReturnValue(of({ data: { data: movieExtendedData(true) } }));

        const result = await service.movieDetails('289', 'en');

        expect(result.externalIds.imdb).toBe('tt0111161');
        expect(result.externalIds.tmdb).toBe(603);
        expect(readTvdb(result.externalIds)).toBe(TVDB_MOVIE_ID);
      });

      it('TDD (load-bearing edge): no TMDB cross-ref → externalIds is a defined object with tvdb set, not a crash', async () => {
        // No remoteIds type 12 → tmdbId undefined → movieDetailsFromTMDB is null →
        // externalIds is undefined today; the fix must create the object so tvdb fits.
        httpService.get.mockReturnValue(of({ data: { data: movieExtendedData(false) } }));

        const result = await service.movieDetails('289', 'en');

        expect(tmdbScannerService.movieDetails).not.toHaveBeenCalled();
        expect(result.externalIds).toBeDefined();
        expect(readTvdb(result.externalIds)).toBe(TVDB_MOVIE_ID);
      });
    });

    describe('tvDetails', () => {
      it('CHARACTERIZATION: when a TMDB cross-ref is present, imdb/tmdb populate exactly as today', async () => {
        tmdbScannerService.tvDetails.mockResolvedValue(tmdbCrossRef());
        httpService.get.mockReturnValue(of({ data: { data: tvExtendedData(true) } }));

        const result = await service.tvDetails('12345', 'en');

        expect(tmdbScannerService.tvDetails).toHaveBeenCalledWith('1399', 'en');
        expect(result.externalIds.imdb).toBe('tt0111161');
        expect(result.externalIds.tmdb).toBe(603);
      });

      it('TDD: result.externalIds.tvdb === data.id (the TVDB id)', async () => {
        tmdbScannerService.tvDetails.mockResolvedValue(tmdbCrossRef());
        httpService.get.mockReturnValue(of({ data: { data: tvExtendedData(true) } }));

        const result = await service.tvDetails('12345', 'en');

        expect(readTvdb(result.externalIds)).toBe(TVDB_TV_ID);
      });

      it('TDD: tvdb is ADDED — the TMDB cross-ref still wins for imdb/tmdb', async () => {
        tmdbScannerService.tvDetails.mockResolvedValue(tmdbCrossRef());
        httpService.get.mockReturnValue(of({ data: { data: tvExtendedData(true) } }));

        const result = await service.tvDetails('12345', 'en');

        expect(result.externalIds.imdb).toBe('tt0111161');
        expect(result.externalIds.tmdb).toBe(603);
        expect(readTvdb(result.externalIds)).toBe(TVDB_TV_ID);
      });

      it('TDD (load-bearing edge): no TMDB cross-ref → externalIds is a defined object with tvdb set, not a crash', async () => {
        httpService.get.mockReturnValue(of({ data: { data: tvExtendedData(false) } }));

        const result = await service.tvDetails('12345', 'en');

        expect(tmdbScannerService.tvDetails).not.toHaveBeenCalled();
        expect(result.externalIds).toBeDefined();
        expect(readTvdb(result.externalIds)).toBe(TVDB_TV_ID);
      });
    });
  });
});
