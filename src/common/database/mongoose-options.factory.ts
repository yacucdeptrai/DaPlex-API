import { ConfigService } from '@nestjs/config';
import { MongooseModuleFactoryOptions } from '@nestjs/mongoose';

import { resolveAutoProxyOptions } from './mongo-connectivity';

type DatabaseUrlKey = 'DATABASE_URL' | 'DATABASE_URL_B';

const DEFAULT_WARP_PROXY_PORT = 40000;

/**
 * Builds the shared Mongoose connection options for a given database URL env key.
 *
 * Proxy selection (in priority order):
 *   1. Manual override — if MONGO_PROXY_HOST and MONGO_PROXY_PORT are set, MongoDB is
 *      routed through that SOCKS5 proxy verbatim.
 *   2. Automatic WARP fallback (default ON) — on startup the API probes the Atlas shards
 *      over the direct path. If they are reachable it uses the normal connection; if the
 *      ISP is blocking the Atlas (AWS) shard IPs it auto-enables the Cloudflare WARP
 *      SOCKS5 proxy and routes ONLY MongoDB through it. Set MONGO_AUTO_WARP=false to
 *      disable, MONGO_WARP_PORT to change the proxy port (default 40000), and
 *      WARP_CLI_PATH to override warp-cli discovery (otherwise found on PATH).
 *
 * Either way only MongoDB traffic is tunneled — the rest of the process keeps using the
 * direct connection.
 */
export async function buildMongooseOptions(
  configService: ConfigService,
  urlKey: DatabaseUrlKey
): Promise<MongooseModuleFactoryOptions> {
  const uri = configService.get<string>(urlKey);
  const options: MongooseModuleFactoryOptions = {
    uri,
    family: 4,
    useBigInt64: true
  };

  // 1. Explicit manual proxy override always wins.
  const proxyHost = configService.get<string>('MONGO_PROXY_HOST');
  const proxyPort = configService.get<string>('MONGO_PROXY_PORT');
  if (proxyHost && proxyPort) {
    options.proxyHost = proxyHost;
    options.proxyPort = Number(proxyPort);
    return options;
  }

  // 2. Automatic WARP fallback. Skipped when disabled, under tests, or without a URI.
  const autoWarpDisabled = configService.get<string>('MONGO_AUTO_WARP') === 'false';
  const isTest = configService.get<string>('NODE_ENV') === 'test';
  if (autoWarpDisabled || isTest || !uri) {
    return options;
  }

  const warpPort = Number(configService.get<string>('MONGO_WARP_PORT')) || DEFAULT_WARP_PROXY_PORT;
  const warpCliPath = configService.get<string>('WARP_CLI_PATH');
  const autoProxy = await resolveAutoProxyOptions(uri, warpPort, warpCliPath);
  if (autoProxy) {
    options.proxyHost = autoProxy.proxyHost;
    options.proxyPort = autoProxy.proxyPort;
  }

  return options;
}
