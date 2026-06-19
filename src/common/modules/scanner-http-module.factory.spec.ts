/**
 * Scanner egress factory — characterization (current SCANNER_HTTP_PROXY behavior) +
 * TDD specs for the auto-WARP precedence ladder.
 *
 * STATE TODAY (baseline): buildScannerHttpModuleOptions is SYNC and only honors
 * SCANNER_HTTP_PROXY (attach SocksProxyAgent) else {}. The two CHARACTERIZATION cases
 * below (explicit-proxy attaches an agent; the scope guard does not touch ALL_PROXY)
 * pass on the unchanged code once the suite is `await`ed — `await`ing a sync return is
 * a no-op, so they are green on the current factory.
 *
 * RED-PENDING-SURGEON: the auto-WARP cases require the surgeon to (1) make the factory
 * ASYNC and (2) call ensureWarpProxy from '../network/warp-proxy' (which does not exist
 * yet). Until then the `jest.mock('../network/warp-proxy', ...)` below fails to resolve
 * and the auto-WARP assertions are RED. That is the expected RED baseline for the new
 * behavior.
 *
 * Intended async contract (analyst brief §4 precedence ladder):
 *   export async function buildScannerHttpModuleOptions(cs: ConfigService): Promise<HttpModuleOptions>;
 *     1. SCANNER_HTTP_PROXY set            -> SocksProxyAgent for THAT url; ensureWarpProxy NOT called.
 *     2. else SCANNER_AUTO_WARP !== 'false' && NODE_ENV !== 'test'
 *                                          -> ensureWarpProxy({ port, warpCliPath, probe });
 *                                             if it returns opts, agent for socks5://127.0.0.1:<port>.
 *     3. else                              -> {} (direct).
 *   SCANNER_WARP_PORT default 40000; WARP_CLI_PATH reused; never mutate process-wide proxy env.
 *
 * SAFETY: ensureWarpProxy is fully mocked here so the factory spec NEVER probes the
 * network or spawns warp-cli. The NODE_ENV='test' guard is itself asserted so the live
 * suite can never trigger a real ensure even if a future edit regressed the mock.
 */
jest.mock('../network/warp-proxy');

import { ConfigService } from '@nestjs/config';
import { SocksProxyAgent } from 'socks-proxy-agent';

import { ensureWarpProxy } from '../network/warp-proxy';
import { buildScannerHttpModuleOptions } from './scanner-http-module.factory';

const mockedEnsureWarpProxy = ensureWarpProxy as jest.Mock;

const PROXY_ENV_VAR = 'SCANNER_HTTP_PROXY';
const DEFAULT_WARP_PORT = 40000;

// Minimal ConfigService stub backed by a plain map, so the factory reads exactly the keys
// we set and nothing else (it must NOT fall back to process.env / global proxies).
function configWith(values: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

describe('buildScannerHttpModuleOptions (scanner egress + auto-WARP precedence)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: auto-WARP would find a working tunnel — individual tests override.
    mockedEnsureWarpProxy.mockResolvedValue({ proxyHost: '127.0.0.1', proxyPort: DEFAULT_WARP_PORT });
  });

  // CHARACTERIZATION — explicit SCANNER_HTTP_PROXY attaches a SocksProxyAgent to BOTH
  // httpAgent and httpsAgent (preserved from the current factory) AND wins over auto-WARP:
  // ensureWarpProxy is never consulted when the operator set the manual override.
  it('attaches a SocksProxyAgent for SCANNER_HTTP_PROXY and does NOT invoke auto-WARP', async () => {
    const options = await buildScannerHttpModuleOptions(configWith({ [PROXY_ENV_VAR]: 'socks5://127.0.0.1:40000' }));

    expect(options.httpAgent).toBeInstanceOf(SocksProxyAgent);
    expect(options.httpsAgent).toBeInstanceOf(SocksProxyAgent);
    expect(mockedEnsureWarpProxy).not.toHaveBeenCalled();
  });

  // NEW / RED — no explicit proxy, auto-WARP enabled (default), not under test, ensure
  // resolves a tunnel -> agent on httpAgent + httpsAgent for the resolved socks5 url.
  it('attaches a SocksProxyAgent for the auto-WARP socks5 url when ensureWarpProxy resolves one', async () => {
    const options = await buildScannerHttpModuleOptions(
      configWith({ NODE_ENV: 'production' }) // unset proxy, auto-WARP default ON
    );

    expect(mockedEnsureWarpProxy).toHaveBeenCalledTimes(1);
    expect(options.httpAgent).toBeInstanceOf(SocksProxyAgent);
    expect(options.httpsAgent).toBeInstanceOf(SocksProxyAgent);
    // Same agent instance on both (one socks5://127.0.0.1:<port> endpoint).
    expect(options.httpAgent).toBe(options.httpsAgent);
  });

  // NEW / RED — auto-WARP runs but the target is reachable directly (ensure returns null)
  // -> no agent, direct egress (today's no-proxy behavior).
  it('returns config with NO agent when ensureWarpProxy returns null (direct reachable)', async () => {
    mockedEnsureWarpProxy.mockResolvedValue(null);

    const options = await buildScannerHttpModuleOptions(configWith({ NODE_ENV: 'production' }));

    expect(mockedEnsureWarpProxy).toHaveBeenCalledTimes(1);
    expect(options.httpAgent).toBeUndefined();
    expect(options.httpsAgent).toBeUndefined();
  });

  // NEW / RED — SCANNER_AUTO_WARP='false' with no explicit proxy -> direct, ensure NOT called.
  it('does NOT invoke auto-WARP when SCANNER_AUTO_WARP is "false"', async () => {
    const options = await buildScannerHttpModuleOptions(
      configWith({ SCANNER_AUTO_WARP: 'false', NODE_ENV: 'production' })
    );

    expect(mockedEnsureWarpProxy).not.toHaveBeenCalled();
    expect(options.httpAgent).toBeUndefined();
    expect(options.httpsAgent).toBeUndefined();
  });

  // NEW / RED — spec-safety guard: under NODE_ENV='test' auto-WARP is skipped so the live
  // Jest suite can never trigger a real ensure / warp-cli spawn (mirrors mongoose factory).
  it('skips auto-WARP entirely under NODE_ENV=test', async () => {
    const options = await buildScannerHttpModuleOptions(configWith({ NODE_ENV: 'test' }));

    expect(mockedEnsureWarpProxy).not.toHaveBeenCalled();
    expect(options.httpAgent).toBeUndefined();
    expect(options.httpsAgent).toBeUndefined();
  });

  // NEW / RED — auto-WARP uses SCANNER_WARP_PORT (default 40000) and reuses WARP_CLI_PATH,
  // and the explicit override is checked first so a port override never overrides the manual
  // proxy. Assert the port/cli-path flow through to ensureWarpProxy.
  it('passes SCANNER_WARP_PORT and WARP_CLI_PATH through to ensureWarpProxy', async () => {
    await buildScannerHttpModuleOptions(
      configWith({ NODE_ENV: 'production', SCANNER_WARP_PORT: '40123', WARP_CLI_PATH: '/opt/warp-cli' })
    );

    expect(mockedEnsureWarpProxy).toHaveBeenCalledWith(
      expect.objectContaining({ port: 40123, warpCliPath: '/opt/warp-cli', probe: expect.any(Function) })
    );
  });

  // GUARD (carried over from FU10) — building the factory must NOT mutate process-wide proxy
  // state (ALL_PROXY / HTTPS_PROXY), which would silently tunnel auth callbacks, storage,
  // SendGrid, etc. through the scanner's SOCKS proxy. Egress stays scanner-scoped.
  it('does NOT mutate process.env.ALL_PROXY / HTTPS_PROXY (egress stays scanner-scoped)', async () => {
    const beforeAll = process.env.ALL_PROXY;
    const beforeHttps = process.env.HTTPS_PROXY;

    await buildScannerHttpModuleOptions(configWith({ [PROXY_ENV_VAR]: 'socks5://127.0.0.1:40000' }));
    await buildScannerHttpModuleOptions(configWith({ NODE_ENV: 'production' })); // auto path too

    expect(process.env.ALL_PROXY).toBe(beforeAll);
    expect(process.env.HTTPS_PROXY).toBe(beforeHttps);
  });
});
