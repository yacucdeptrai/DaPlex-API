import { ExecutionContext, CallHandler, HttpException } from '@nestjs/common';
import { of } from 'rxjs';

import { StatusCode } from '../../enums';

// ---------------------------------------------------------------------------
// Harness notes (read before editing — these are load-bearing for the gate):
//
// * The interceptor is NOT DI-provided; it is `new`'d per route. So we drive it
//   directly with `new UploadImageInterceptor({...})`, no TestingModule.
// * `sharp` is globally mocked (test/mocks/sharp.js) but that shared stub
//   returns {width:0,height:0} and lacks `.ensureAlpha()`, so the URL "happy
//   path" (which reaches createThumbhash → .ensureAlpha()) cannot run against
//   it. We override sharp locally with a superset stub that returns valid dims
//   and a correctly-sized raw buffer, isolated to this spec.
// * `fetch` is a Node global (undici inside Node). We replace globalThis.fetch
//   per test. The surgeon's guard MUST remain drivable this way: keep
//   getImageFromUrl using the global `fetch` (or an undici Agent dispatcher) so
//   a global-fetch mock observes the call; do not hide it behind an un-mockable
//   transport.
// * `dns` is mocked so the SSRF IP-pinning logic resolves to addresses we
//   control. The surgeon must drive the private-IP decision off a `dns.lookup`
//   result (the brief's requirement), which this mock provides.
// * `StatusCode.URL_HOST_NOT_ALLOWED` does NOT exist yet (the surgeon adds 1104).
//   To keep this spec compiling RED-for-the-right-reason on UNCHANGED code, the
//   SSRF-rejection tests assert the numeric code 1104 (URL_HOST_NOT_ALLOWED_CODE
//   below), not the enum member. Once the surgeon adds the enum, 1104 still holds.
// ---------------------------------------------------------------------------

const URL_HOST_NOT_ALLOWED_CODE = 1104;

// --- sharp: local superset of the shared mock -------------------------------
// Returns valid metadata + an alpha-capable chain so the happy path can reach
// createThumbhash without exploding. Tiny 2x3 dims (so an enabled 2:3 ratio
// would also pass) with a matching raw buffer for rgbaToThumbHash.
const sharpMetadata = { width: 2, height: 3, format: 'jpeg', pages: 1, size: 1024 };
jest.mock('sharp', () => {
  const pipeline = () => {
    const chain: any = {
      resize: () => chain,
      extend: () => chain,
      flatten: () => chain,
      toFormat: () => chain,
      toColorspace: () => chain,
      ensureAlpha: () => chain,
      raw: () => chain,
      metadata: () => Promise.resolve(sharpMetadata),
      toBuffer: () => Promise.resolve(Buffer.alloc(2 * 3 * 4)),
      toFile: () => Promise.resolve({})
    };
    return chain;
  };
  return { __esModule: true, default: pipeline };
});

// --- dns: drive the IP-pinning decision -------------------------------------
// dns.lookup is the resolution the SSRF guard must pin on. Default: a public IP.
// Individual tests override resolvedAddresses to simulate rebinding / private IPs.
let resolvedAddresses: Array<{ address: string; family: number }> = [{ address: '93.184.216.34', family: 4 }];
jest.mock('dns', () => {
  const actual = jest.requireActual('dns');
  const lookup = (hostname: string, opts: any, cb?: any) => {
    const callback = typeof opts === 'function' ? opts : cb;
    const wantsAll = opts && typeof opts === 'object' && opts.all;
    process.nextTick(() => {
      if (!resolvedAddresses.length) return callback(new Error('ENOTFOUND'));
      if (wantsAll) return callback(null, resolvedAddresses);
      return callback(null, resolvedAddresses[0].address, resolvedAddresses[0].family);
    });
  };
  return {
    ...actual,
    lookup,
    promises: { ...actual.promises, lookup: jest.fn(async () => resolvedAddresses) }
  };
});

// --- undici: the interceptor uses undici's own fetch + Agent (Node-24 bundled
// fetch is incompatible with a standalone undici@8 dispatcher). Mock the fetch so
// the SSRF tests still intercept the code's network call; Agent is a no-op stub
// (its connect.lookup never fires because fetch is mocked).
jest.mock('undici', () => ({
  __esModule: true,
  fetch: jest.fn(),
  Agent: jest.fn().mockImplementation(() => ({}))
}));
import { fetch as undiciFetch } from 'undici';

import { UploadImageInterceptor } from './upload-image.interceptor';

// A minimal valid PNG header buffer; content is irrelevant because sharp is mocked.
const FAKE_IMAGE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

interface MockReqOptions {
  multipart?: boolean;
  body?: any;
}

function makeReq(opts: MockReqOptions = {}): any {
  const multipart = opts.multipart ?? false;
  return {
    isMultipart: () => multipart,
    body: opts.body ?? {},
    // incomingFile intentionally LEFT UNDEFINED — the URL branch must initialise
    // it itself (Change 2). On unchanged code, `req.incomingFile.filepath = url`
    // throws "Cannot set properties of undefined".
    incomingFile: undefined
  };
}

function makeContext(req: any): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req })
  } as unknown as ExecutionContext;
}

const nextHandler: CallHandler = { handle: () => of('downstream-result') };

/** Build a Response-like object for the mocked fetch. */
function fetchResponse(opts: { status?: number; headers?: Record<string, string>; body?: Buffer }): any {
  const headers = new Map(Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const buf = opts.body ?? FAKE_IMAGE;
  return {
    status: opts.status ?? 200,
    ok: (opts.status ?? 200) < 400,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    // undici streaming body — a single chunk. The guard's running-byte cap can
    // iterate this; tests that assert "did not fully buffer" spy on arrayBuffer.
    body: {
      async *[Symbol.asyncIterator]() {
        yield new Uint8Array(buf);
      }
    }
  };
}

/** Run intercept() and capture whatever it throws (or resolves to). */
async function runIntercept(
  interceptor: UploadImageInterceptor,
  req: any
): Promise<{ threw: boolean; error?: any; result?: unknown }> {
  try {
    const obs = await interceptor.intercept(makeContext(req), nextHandler);
    return { threw: false, result: obs };
  } catch (error) {
    return { threw: true, error };
  }
}

function errBody(error: any): { code?: number; message?: string } {
  if (error instanceof HttpException) return error.getResponse() as any;
  return {};
}

describe('UploadImageInterceptor', () => {
  // The code fetches via undici; this is that exact mock (see jest.mock('undici')).
  const fetchMock = undiciFetch as unknown as jest.Mock;

  beforeEach(() => {
    resolvedAddresses = [{ address: '93.184.216.34', family: 4 }]; // public default
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(fetchResponse({ status: 200 }));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // An interceptor configured for the URL path with NO dimension/ratio
  // constraints, so the mocked sharp metadata (2x3) flows through validation.
  function urlInterceptor(extra: Record<string, unknown> = {}): UploadImageInterceptor {
    return new UploadImageInterceptor({
      allowUrl: true,
      mimeTypes: [], // no mime gate — accept whatever sharp detects
      maxSize: 10 * 1024 * 1024,
      ...extra
    });
  }

  it('should be defined', () => {
    expect(new UploadImageInterceptor()).toBeDefined();
  });

  // =========================================================================
  // CHARACTERIZATION — must stay GREEN on UNCHANGED code.
  // =========================================================================
  describe('characterization (unchanged behavior)', () => {
    it('a non-multipart request with allowUrl:false and no url throws REQUIRE_MULTIPART', async () => {
      const interceptor = new UploadImageInterceptor({ allowUrl: false });
      const { threw, error } = await runIntercept(interceptor, makeReq({ multipart: false, body: {} }));

      expect(threw).toBe(true);
      expect(errBody(error).code).toBe(StatusCode.REQUIRE_MULTIPART);
    });

    it('a non-multipart request with allowUrl:true but no url throws REQUIRE_MULTIPART (url branch not taken)', async () => {
      const interceptor = urlInterceptor();
      const { threw, error } = await runIntercept(interceptor, makeReq({ multipart: false, body: {} }));

      expect(threw).toBe(true);
      expect(errBody(error).code).toBe(StatusCode.REQUIRE_MULTIPART);
    });

    it('the multipart branch is selected when req.isMultipart() is true (does not enter the url branch)', async () => {
      // Multipart with no file mock present → saveRequestFiles is undefined on our
      // bare req, so the multipart branch throws. The point of this test is that
      // the URL guards are NOT consulted for a multipart request (fetch untouched).
      const interceptor = urlInterceptor();
      const req: any = makeReq({ multipart: true });
      // saveRequestFiles missing → the multipart branch errors; assert we never fetched.
      await runIntercept(interceptor, req);

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // TDD — SSRF guard (RED on unchanged bare-fetch code, GREEN after the guard).
  // =========================================================================
  describe('SSRF guard (TDD)', () => {
    // (1) Allowed host proceeds end-to-end.
    it('an allowed host (image.tmdb.org) resolving to a PUBLIC ip proceeds: fetch attempted, incomingFile populated', async () => {
      resolvedAddresses = [{ address: '93.184.216.34', family: 4 }];
      const interceptor = urlInterceptor();
      const req = makeReq({ multipart: false, body: { url: 'https://image.tmdb.org/t/p/original/abc.jpg' } });

      const { threw, error } = await runIntercept(interceptor, req);

      expect(threw).toBe(false); // current code throws (incomingFile undefined) → RED
      if (threw) throw error;
      expect(fetchMock).toHaveBeenCalled();
      expect(req.incomingFile).toBeDefined();
      expect(req.incomingFile.isUrl).toBe(true);
    });

    // (2) Disallowed host → URL_HOST_NOT_ALLOWED (1104).
    it('a disallowed host (evil.com) throws URL_HOST_NOT_ALLOWED (1104) and never fetches', async () => {
      const interceptor = urlInterceptor();
      const req = makeReq({ multipart: false, body: { url: 'https://evil.com/x.jpg' } });

      const { threw, error } = await runIntercept(interceptor, req);

      expect(threw).toBe(true);
      expect(errBody(error).code).toBe(URL_HOST_NOT_ALLOWED_CODE);
      expect(fetchMock).not.toHaveBeenCalled(); // rejected BEFORE the network call
    });

    // (3) Hostname-EQUALITY, not suffix/substring. Forbids endsWith/includes allowlists.
    it('rejects evil-tmdb.org (suffix-trick) — hostname equality, not endsWith', async () => {
      const interceptor = urlInterceptor();
      const req = makeReq({ multipart: false, body: { url: 'https://evil-tmdb.org/x.jpg' } });

      const { threw, error } = await runIntercept(interceptor, req);

      expect(threw).toBe(true);
      expect(errBody(error).code).toBe(URL_HOST_NOT_ALLOWED_CODE);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects image.tmdb.org.evil.com (prefix-trick) — hostname equality, not includes', async () => {
      const interceptor = urlInterceptor();
      const req = makeReq({ multipart: false, body: { url: 'https://image.tmdb.org.evil.com/x.jpg' } });

      const { threw, error } = await runIntercept(interceptor, req);

      expect(threw).toBe(true);
      expect(errBody(error).code).toBe(URL_HOST_NOT_ALLOWED_CODE);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    // (4) Non-https scheme rejected.
    it('rejects a http:// (non-https) url even on an allowed host', async () => {
      const interceptor = urlInterceptor();
      const req = makeReq({ multipart: false, body: { url: 'http://image.tmdb.org/t/p/original/abc.jpg' } });

      const { threw, error } = await runIntercept(interceptor, req);

      expect(threw).toBe(true);
      expect(errBody(error).code).toBe(URL_HOST_NOT_ALLOWED_CODE);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    // (5) DNS-rebinding / private-IP pin — allowed host but resolves to private ranges.
    it.each([
      ['127.0.0.1 (loopback)', '127.0.0.1', 4],
      ['169.254.169.254 (cloud metadata)', '169.254.169.254', 4],
      ['10.0.0.5 (RFC1918)', '10.0.0.5', 4],
      ['192.168.1.10 (RFC1918)', '192.168.1.10', 4],
      ['172.16.0.1 (RFC1918)', '172.16.0.1', 4],
      ['::1 (v6 loopback)', '::1', 6],
      ['::ffff:169.254.169.254 (v4-mapped v6 metadata)', '::ffff:169.254.169.254', 6]
    ])('rejects an allowed host that resolves to %s', async (_label, address, family) => {
      resolvedAddresses = [{ address, family }];
      const interceptor = urlInterceptor();
      const req = makeReq({ multipart: false, body: { url: 'https://image.tmdb.org/t/p/original/abc.jpg' } });

      const { threw, error } = await runIntercept(interceptor, req);

      expect(threw).toBe(true);
      // The decision must be driven by the resolved IP; reject as URL_HOST_NOT_ALLOWED.
      expect(errBody(error).code).toBe(URL_HOST_NOT_ALLOWED_CODE);
    });

    // (6) URL credentials rejected.
    it('rejects a url carrying credentials (user:pass@) even on an allowed host', async () => {
      const interceptor = urlInterceptor();
      const req = makeReq({ multipart: false, body: { url: 'https://user:pass@image.tmdb.org/x.jpg' } });

      const { threw, error } = await runIntercept(interceptor, req);

      expect(threw).toBe(true);
      expect(errBody(error).code).toBe(URL_HOST_NOT_ALLOWED_CODE);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    // (7) Redirect to a disallowed host is not auto-followed.
    it('does not follow a 30x redirect whose Location points to a disallowed host', async () => {
      // First (and ideally only) fetch returns a redirect to evil.com.
      fetchMock.mockImplementation(async (_url: string, init?: any) => {
        // The guard must use manual redirect handling — assert it never silently
        // auto-follows to the disallowed target by checking the final state.
        return fetchResponse({ status: 302, headers: { location: 'https://evil.com/payload.jpg' } });
      });
      const interceptor = urlInterceptor();
      const req = makeReq({ multipart: false, body: { url: 'https://image.tmdb.org/t/p/original/abc.jpg' } });

      const { threw, error } = await runIntercept(interceptor, req);

      expect(threw).toBe(true);
      expect(errBody(error).code).toBe(URL_HOST_NOT_ALLOWED_CODE);
      // The disallowed redirect target must never have been fetched.
      const fetchedUrls = fetchMock.mock.calls.map((c) => String(c[0]));
      expect(fetchedUrls).not.toContain('https://evil.com/payload.jpg');
    });

    // (8) Oversize rejected pre-buffer (Content-Length).
    it('rejects when Content-Length exceeds maxSize WITHOUT consuming the full body', async () => {
      const arrayBufferSpy = jest.fn(async () => FAKE_IMAGE.buffer);
      fetchMock.mockImplementation(async () => {
        const r = fetchResponse({ status: 200, headers: { 'content-length': String(50 * 1024 * 1024) } });
        r.arrayBuffer = arrayBufferSpy;
        return r;
      });
      const interceptor = urlInterceptor({ maxSize: 1 * 1024 * 1024 }); // 1 MiB cap
      const req = makeReq({ multipart: false, body: { url: 'https://image.tmdb.org/t/p/original/big.jpg' } });

      const { threw, error } = await runIntercept(interceptor, req);

      expect(threw).toBe(true);
      expect(errBody(error).code).toBe(StatusCode.FILE_TOO_LARGE);
      // The whole body must NOT have been buffered via arrayBuffer() once
      // Content-Length already says it is over the cap.
      expect(arrayBufferSpy).not.toHaveBeenCalled();
    });

    // (9) Timeout: an AbortController/signal must be wired into fetch.
    it('wires an abort signal into fetch (timeout bound)', async () => {
      const interceptor = urlInterceptor();
      const req = makeReq({ multipart: false, body: { url: 'https://image.tmdb.org/t/p/original/abc.jpg' } });

      await runIntercept(interceptor, req);

      expect(fetchMock).toHaveBeenCalled();
      const init = fetchMock.mock.calls[0]?.[1] ?? {};
      // The guard must pass an AbortSignal so a hung fetch is bounded in time.
      expect(init.signal).toBeDefined();
    });

    // (10) A transport-level fetch failure surfaces as a coded error, not a bare 500.
    it('throws a coded THRID_PARTY_REQUEST_FAILED when the fetch itself rejects (allowed host, dns OK)', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));
      const interceptor = urlInterceptor();
      const req = makeReq({ multipart: false, body: { url: 'https://image.tmdb.org/t/p/original/abc.jpg' } });

      const { threw, error } = await runIntercept(interceptor, req);

      expect(threw).toBe(true);
      expect(errBody(error).code).toBe(StatusCode.THRID_PARTY_REQUEST_FAILED);
    });
  });

  // =========================================================================
  // TDD — incomingFile init (the latent crash fix at :186).
  // =========================================================================
  describe('incomingFile init (TDD)', () => {
    it('populates a full incomingFile with a real tmpdir disk path (NOT the url string) and isUrl:true', async () => {
      const os = require('os');
      const interceptor = urlInterceptor();
      const url = 'https://image.tmdb.org/t/p/original/poster.jpg';
      const req = makeReq({ multipart: false, body: { url } });

      const { threw, error } = await runIntercept(interceptor, req);

      expect(threw).toBe(false); // current code: TypeError (incomingFile undefined) → RED
      if (threw) throw error;
      const f = req.incomingFile;
      expect(f).toBeDefined();
      expect(f.isUrl).toBe(true);
      // filepath must be a real disk path under os.tmpdir(), not the URL string.
      expect(typeof f.filepath).toBe('string');
      expect(f.filepath).not.toBe(url);
      expect(f.filepath.startsWith(os.tmpdir())).toBe(true);
      // detectedMimetype / mimetype / color / thumbhash / filename all set.
      expect(f.detectedMimetype).toBeTruthy();
      expect(f.mimetype).toBeTruthy();
      expect(typeof f.color).toBe('number');
      expect(typeof f.thumbhash).toBe('string');
      expect(typeof f.filename).toBe('string');
    });

    it('does NOT crash on an uninitialised incomingFile — the branch initialises it itself', async () => {
      // The branch now inits incomingFile before assigning fields; the former
      // "Cannot set properties of undefined" crash is gone.
      const interceptor = urlInterceptor();
      const req = makeReq({ multipart: false, body: { url: 'https://image.tmdb.org/t/p/original/x.jpg' } });

      const { threw, error } = await runIntercept(interceptor, req);

      expect(threw).toBe(false);
      if (threw) throw error;
      expect(req.incomingFile).toBeDefined();
    });
  });
});
