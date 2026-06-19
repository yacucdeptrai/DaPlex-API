/**
 * FU10 — env-gated SOCKS5 egress for the scanner HttpModule.
 *
 * RED-PENDING-SURGEON: this spec is written against the INTENDED factory the surgeon
 * will create at ./scanner-http-module.factory.ts. That module does not exist yet and
 * `socks-proxy-agent` is not yet a dependency, so this whole suite FAILS TO COMPILE/RUN
 * today (cannot find module). That is the expected RED baseline for the new behavior.
 *
 * Intended factory contract (mirrors buildMongooseOptions in mongo-connectivity):
 *
 *   import { ConfigService } from '@nestjs/config';
 *   import { HttpModuleOptions } from '@nestjs/axios';
 *
 *   // Returns the axios config for the scanner HttpModule. When SCANNER_HTTP_PROXY is
 *   // set to a socks5://host:port URL it attaches a SocksProxyAgent to BOTH httpAgent
 *   // and httpsAgent; otherwise it returns config with no agent (today's behavior).
 *   export function buildScannerHttpModuleOptions(configService: ConfigService): HttpModuleOptions;
 *
 * Wired into each scanner module via:
 *   HttpModule.registerAsync({ useFactory: buildScannerHttpModuleOptions, inject: [ConfigService] })
 *
 * The env var name (SCANNER_HTTP_PROXY) is the analyst's recommendation; if the surgeon
 * / leader picks a different name, update PROXY_ENV_VAR below to match.
 */
import { ConfigService } from '@nestjs/config';
import { SocksProxyAgent } from 'socks-proxy-agent';

import { buildScannerHttpModuleOptions } from './scanner-http-module.factory';

const PROXY_ENV_VAR = 'SCANNER_HTTP_PROXY';

// Minimal ConfigService stub backed by a plain map, so the factory reads exactly the
// keys we set and nothing else (it must NOT fall back to process.env / global proxies).
function configWith(values: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

describe('buildScannerHttpModuleOptions (FU10 scanner egress)', () => {
  // CHARACTERIZATION (default-off) — env var UNSET → no agent attached, identical to
  // the bare HttpModule the scanner modules use today. This is the behavior to preserve.
  it('returns config with NO httpAgent/httpsAgent when the proxy env var is unset', () => {
    const options = buildScannerHttpModuleOptions(configWith({}));

    expect(options.httpAgent).toBeUndefined();
    expect(options.httpsAgent).toBeUndefined();
  });

  // NEW / RED — env var SET to a socks5:// URL → a SocksProxyAgent is attached to BOTH
  // httpAgent and httpsAgent so plain-http and TLS scanner egress both tunnel.
  it('attaches a SocksProxyAgent to httpAgent and httpsAgent when the proxy env var is a socks5 URL', () => {
    const options = buildScannerHttpModuleOptions(configWith({ [PROXY_ENV_VAR]: 'socks5://127.0.0.1:40000' }));

    expect(options.httpAgent).toBeInstanceOf(SocksProxyAgent);
    expect(options.httpsAgent).toBeInstanceOf(SocksProxyAgent);
  });

  // GUARD — the proxy is scoped to the scanner HttpModule egress ONLY. Building the
  // factory must NOT mutate process-wide proxy state (ALL_PROXY / HTTPS_PROXY / global
  // agents), which would silently tunnel auth callbacks, storage, SendGrid, etc.
  it('does NOT mutate process.env.ALL_PROXY / HTTPS_PROXY (egress stays scanner-scoped)', () => {
    const beforeAll = process.env.ALL_PROXY;
    const beforeHttps = process.env.HTTPS_PROXY;

    buildScannerHttpModuleOptions(configWith({ [PROXY_ENV_VAR]: 'socks5://127.0.0.1:40000' }));

    expect(process.env.ALL_PROXY).toBe(beforeAll);
    expect(process.env.HTTPS_PROXY).toBe(beforeHttps);
  });
});
