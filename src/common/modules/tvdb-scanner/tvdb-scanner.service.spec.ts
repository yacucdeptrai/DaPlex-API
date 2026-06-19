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
});
