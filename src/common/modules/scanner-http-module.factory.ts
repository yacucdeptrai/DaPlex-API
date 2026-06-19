import { HttpModuleOptions } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { SocksProxyAgent } from 'socks-proxy-agent';

const PROXY_ENV_VAR = 'SCANNER_HTTP_PROXY';

/**
 * Builds the axios config for the scanner HttpModule.
 *
 * When SCANNER_HTTP_PROXY is set to a socks5://host:port URL the scanner egress is
 * tunneled through that SOCKS5 proxy by attaching a SocksProxyAgent to both httpAgent
 * and httpsAgent. When unset it returns config with no agent — identical to the bare
 * HttpModule the scanner modules used before. The agent is scoped to these axios
 * instances only; no process-wide proxy env (ALL_PROXY/HTTPS_PROXY) is touched.
 */
export function buildScannerHttpModuleOptions(configService: ConfigService): HttpModuleOptions {
  const proxyUrl = configService.get<string>(PROXY_ENV_VAR);
  if (!proxyUrl) return {};

  const agent = new SocksProxyAgent(proxyUrl);
  return { httpAgent: agent, httpsAgent: agent };
}
