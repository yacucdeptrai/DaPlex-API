import { Test, TestingModule } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { HttpException, HttpStatus } from '@nestjs/common';
import { throwError } from 'rxjs';

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
});
