import { Test, TestingModule } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { HttpException, HttpStatus } from '@nestjs/common';
import { of, throwError } from 'rxjs';

import { TmdbScannerService } from './tmdb-scanner.service';
import { StatusCode } from '../../../enums';

// Builds an object shaped like the axios error the catch blocks branch on. The
// `response`-present variant is the contract that exists today; the no-`response`
// variant is the network error FU9 must start mapping to the same 503 envelope.
function axiosErrorWithResponse(status: number, statusText: string): any {
  return { isAxiosError: true, response: { status, statusText } };
}

function axiosNetworkError(code: string): any {
  // A socket-layer failure (ENOTFOUND / ETIMEDOUT / ECONNREFUSED / socket hang up):
  // axios sets isAxiosError but there was no HTTP exchange, so `.response` is undefined.
  return { isAxiosError: true, code, message: `connect ${code}` };
}

describe('TmdbScannerService', () => {
  let service: TmdbScannerService;
  let httpService: { get: jest.Mock };

  beforeEach(async () => {
    httpService = { get: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [TmdbScannerService]
    })
      // TmdbScannerService reads config in its constructor, so the ConfigService
      // mock must expose a callable get(); the HttpService is replaced with a stub
      // whose get() we drive per-test. Other deps can stay empty.
      .useMocker((token): any => {
        if (token === ConfigService) return { get: (): undefined => undefined };
        if (token === HttpService) return httpService;
        return {};
      })
      .compile();

    service = module.get<TmdbScannerService>(TmdbScannerService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('third-party error mapping (FU9)', () => {
    // CHARACTERIZATION — locks the established contract: an axios error that DID
    // get an HTTP response (provider returned 4xx/5xx) maps to the 503/1100 envelope
    // with the exact `Received <status> <statusText> ...` message. Green on current code.
    it('maps an axios error WITH a response to HttpException 503 / THRID_PARTY_REQUEST_FAILED (searchMovie)', async () => {
      httpService.get.mockReturnValue(throwError(() => axiosErrorWithResponse(429, 'Too Many Requests')));

      await expect(service.searchMovie('dune', 1, 2021, 'en', false)).rejects.toBeInstanceOf(HttpException);

      try {
        await service.searchMovie('dune', 1, 2021, 'en', false);
        fail('expected searchMovie to throw');
      } catch (e) {
        const err = e as HttpException;
        expect(err.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
        const body = err.getResponse() as { code: number; message: string };
        expect(body.code).toBe(StatusCode.THRID_PARTY_REQUEST_FAILED);
        expect(body.message).toBe('Received 429 Too Many Requests error from third party api');
      }
    });

    it('maps an axios error WITH a response to 503 for movieDetails as well', async () => {
      httpService.get.mockReturnValue(throwError(() => axiosErrorWithResponse(401, 'Unauthorized')));

      try {
        await service.movieDetails('438631', 'en');
        fail('expected movieDetails to throw');
      } catch (e) {
        const err = e as HttpException;
        expect(err.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
        const body = err.getResponse() as { code: number };
        expect(body.code).toBe(StatusCode.THRID_PARTY_REQUEST_FAILED);
      }
    });

    // NEW / RED on unchanged code — the FU9 fix. A network error has NO `.response`,
    // so today the `&& e.response` guard is false and the raw error re-throws (→ HTTP 500).
    // After the fix it MUST map to the same 503 / THRID_PARTY_REQUEST_FAILED envelope.
    it('maps an axios network error (no response) to HttpException 503 / THRID_PARTY_REQUEST_FAILED (searchMovie)', async () => {
      httpService.get.mockReturnValue(throwError(() => axiosNetworkError('ENOTFOUND')));

      let thrown: unknown;
      try {
        await service.searchMovie('dune', 1, 2021, 'en', false);
        fail('expected searchMovie to throw');
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
      httpService.get.mockReturnValue(throwError(() => axiosNetworkError('ETIMEDOUT')));

      let thrown: unknown;
      try {
        await service.movieDetails('438631', 'en');
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

    // CHARACTERIZATION — a non-axios error (a programming error, not a transport
    // failure) must keep flowing through untouched so it is NOT misreported as a
    // third-party 503. This guards the FU9 fix from over-broadening the catch.
    it('re-throws a non-axios error unchanged (not reclassified to 503)', async () => {
      const boom = new Error('boom');
      httpService.get.mockReturnValue(throwError(() => boom));

      await expect(service.searchMovie('dune', 1, 2021, 'en', false)).rejects.toBe(boom);
      await expect(service.searchMovie('dune', 1, 2021, 'en', false)).rejects.not.toBeInstanceOf(HttpException);
    });
  });

  // DEC-4 — scanned keyword→tag list is capped at 15. TMDB maps each keyword name
  // through apStyleTitleCase, so the cap must be applied AFTER the title-case map (the
  // styled name still counts toward the 15). Movie keywords live at
  // data.keywords.keywords[].name; tv keywords at data.keywords.results[].name. The
  // >15 cases are RED on the unchanged (uncapped) code; the ≤15 cases stay GREEN, and
  // the under-cap characterization also pins that apStyleTitleCase is still applied.
  describe('DEC-4 keyword cap (15)', () => {
    // A keyword set of `count` lowercase names so apStyleTitleCase output is observable.
    function keywords(count: number): { name: string }[] {
      return Array.from({ length: count }, (_v, i) => ({ name: `space opera ${i}` }));
    }

    // Minimal-but-complete TMDB /movie/:id payload. belongs_to_collection is omitted so
    // the collectionDetails recursion is skipped (no extra http call to mock).
    function movieDetailsData(keywordCount: number): any {
      return {
        id: 603,
        title: 'The Matrix',
        original_title: 'The Matrix',
        original_language: 'en',
        overview: 'overview',
        poster_path: '/p.jpg',
        backdrop_path: '/b.jpg',
        runtime: 136,
        status: 'Released',
        release_date: '1999-03-30',
        adult: false,
        imdb_id: 'tt0133093',
        genres: [{ name: 'Action' }],
        production_companies: [{ name: 'Warner Bros.', origin_country: 'US' }],
        alternative_titles: { titles: [] },
        videos: { results: [] },
        keywords: { keywords: keywords(keywordCount) },
        translations: { translations: [] }
      };
    }

    // Minimal-but-complete TMDB /tv/:id payload.
    function tvDetailsData(keywordCount: number): any {
      return {
        id: 1399,
        name: 'Game of Thrones',
        original_name: 'Game of Thrones',
        original_language: 'en',
        overview: 'overview',
        poster_path: '/p.jpg',
        backdrop_path: '/b.jpg',
        episode_run_time: [60],
        status: 'Ended',
        first_air_date: '2011-04-17',
        last_air_date: '2019-05-19',
        number_of_seasons: 8,
        number_of_episodes: 73,
        genres: [{ name: 'Drama' }],
        production_companies: [{ name: 'HBO', origin_country: 'US' }],
        alternative_titles: { results: [] },
        videos: { results: [] },
        keywords: { results: keywords(keywordCount) },
        seasons: [],
        external_ids: { imdb_id: 'tt0944947' },
        translations: { translations: [] }
      };
    }

    describe('movieDetails', () => {
      it('TDD: 20 provider keywords are capped to 15', async () => {
        httpService.get.mockReturnValue(of({ data: movieDetailsData(20) }));

        const result = await service.movieDetails('603', 'en');

        expect(result.tags).toHaveLength(15);
      });

      it('CHARACTERIZATION: 10 keywords stay 10 and apStyleTitleCase is still applied', async () => {
        httpService.get.mockReturnValue(of({ data: movieDetailsData(10) }));

        const result = await service.movieDetails('603', 'en');

        expect(result.tags).toHaveLength(10);
        // 'space opera 0' → title-cased 'Space Opera 0' proves the map still runs.
        expect(result.tags![0]).toBe('Space Opera 0');
      });
    });

    describe('tvDetails', () => {
      it('TDD: 20 provider keywords are capped to 15', async () => {
        httpService.get.mockReturnValue(of({ data: tvDetailsData(20) }));

        const result = await service.tvDetails('1399', 'en');

        expect(result.tags).toHaveLength(15);
      });

      it('CHARACTERIZATION: 10 keywords stay 10 and apStyleTitleCase is still applied', async () => {
        httpService.get.mockReturnValue(of({ data: tvDetailsData(10) }));

        const result = await service.tvDetails('1399', 'en');

        expect(result.tags).toHaveLength(10);
        expect(result.tags![0]).toBe('Space Opera 0');
      });
    });
  });
});
