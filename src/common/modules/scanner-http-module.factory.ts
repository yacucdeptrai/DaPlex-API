import { HttpModuleOptions } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { SocksProxyAgent } from 'socks-proxy-agent';

import { ensureWarpProxy, tcpReachable } from '../network/warp-proxy';

const PROXY_ENV_VAR = 'SCANNER_HTTP_PROXY';
const DEFAULT_WARP_PORT = 40000;

// Direct-reachability probe target. TVDB scanning shares the same egress path, so one TMDB
// probe gates WARP engagement for both scanners.
const TMDB_PROBE_HOST = 'api.themoviedb.org';
const TMDB_PROBE_PORT = 443;
const TMDB_PROBE_TIMEOUT_MS = 6000;

/**
 * Builds the axios config for the scanner HttpModule.
 *
 * Effective proxy selection (in priority order):
 *   1. Manual override — SCANNER_HTTP_PROXY (a socks5://host:port URL) is used verbatim.
 *   2. Automatic WARP fallback (default ON) — when no manual proxy is set and not under
 *      tests, the scanner probes TMDB over the direct path. If it is reachable the scanner
 *      egress stays direct; if the ISP blocks it, WARP proxy mode is auto-enabled and the
 *      scanner egress is tunneled through the local SOCKS5 proxy. Set SCANNER_AUTO_WARP=false
 *      to disable, SCANNER_WARP_PORT to change the port (default 40000), and WARP_CLI_PATH to
 *      override warp-cli discovery.
 *   3. Otherwise no agent — a direct connection.
 *
 * Either way the agent is scoped to these axios instances only; no process-wide proxy env
 * (ALL_PROXY/HTTPS_PROXY) is touched.
 */
export async function buildScannerHttpModuleOptions(configService: ConfigService): Promise<HttpModuleOptions> {
  // 1. Explicit manual proxy override always wins (never probe / ensure WARP).
  const manualProxy = configService.get<string>(PROXY_ENV_VAR);
  if (manualProxy) {
    return agentOptions(manualProxy);
  }

  // 2. Automatic WARP fallback. Skipped when disabled or under tests.
  const autoWarpDisabled = configService.get<string>('SCANNER_AUTO_WARP') === 'false';
  const isTest = configService.get<string>('NODE_ENV') === 'test';
  if (autoWarpDisabled || isTest) {
    return {};
  }

  const port = Number(configService.get<string>('SCANNER_WARP_PORT')) || DEFAULT_WARP_PORT;
  const warpCliPath = configService.get<string>('WARP_CLI_PATH');
  const proxy = await ensureWarpProxy({
    port,
    warpCliPath,
    probe: () => tcpReachable(TMDB_PROBE_HOST, TMDB_PROBE_PORT, TMDB_PROBE_TIMEOUT_MS)
  });
  if (proxy) {
    return agentOptions(`socks5://${proxy.proxyHost}:${proxy.proxyPort}`);
  }

  // 3. Direct.
  return {};
}

/** Same SocksProxyAgent instance on both httpAgent and httpsAgent (one socks5 endpoint). */
function agentOptions(proxyUrl: string): HttpModuleOptions {
  const agent = new SocksProxyAgent(proxyUrl);
  return { httpAgent: agent, httpsAgent: agent };
}
