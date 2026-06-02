import { Logger } from '@nestjs/common';
import { execFileSync } from 'child_process';
import { setServers as setDefaultResolverServers } from 'dns';
import * as dns from 'dns/promises';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';

const logger = new Logger('MongoConnectivity');

const DIRECT_PROBE_TIMEOUT_MS = 6000;
const WARP_READY_TIMEOUT_MS = 25000;
const WARP_POLL_INTERVAL_MS = 1000;
const DEFAULT_SHARD_PORT = 27017;

// Public resolvers used only when the OS resolver cannot answer SRV. On Windows,
// c-ares falls back to a loopback resolver (e.g. the flaky Internet Connection
// Sharing DNS proxy on 127.0.0.1) that refuses queries with ECONNREFUSED, which
// breaks SRV resolution for mongodb+srv URIs even though the shards are reachable.
const PUBLIC_DNS_FALLBACK = ['1.1.1.1', '8.8.8.8'];

const WARP_CLI_BINARY = process.platform === 'win32' ? 'warp-cli.exe' : 'warp-cli';

// Well-known install locations checked only after the PATH lookup fails. These are
// discovery hints, not configuration — set the WARP_CLI_PATH env var to override.
const WELL_KNOWN_WARP_PATHS: Record<string, string[]> = {
  win32: ['C:\\Program Files\\Cloudflare\\Cloudflare WARP\\warp-cli.exe'],
  darwin: ['/Applications/Cloudflare WARP.app/Contents/Resources/warp-cli', '/usr/local/bin/warp-cli'],
  linux: ['/usr/bin/warp-cli', '/usr/local/bin/warp-cli']
};

export interface MongoProxyOptions {
  proxyHost: string;
  proxyPort: number;
}

// Connectivity is a machine-level property, so the probe/decision runs once per
// cluster host and is shared across every Mongoose connection in the process.
const decisionCache = new Map<string, Promise<MongoProxyOptions | null>>();

/** Extract the cluster hostname from a mongodb / mongodb+srv URI (no port). */
export function parseSrvHost(uri: string): string | null {
  const match = uri.match(/^mongodb(?:\+srv)?:\/\/(?:[^@/]+@)?([^/?,]+)/i);
  if (!match) return null;
  return match[1].split(':')[0];
}

function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const finish = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

/**
 * True if at least one Atlas shard is reachable over the DIRECT path. A raw TCP
 * socket never uses the SOCKS proxy, so this always reflects the real ISP route.
 */
async function isMongoReachableDirectly(srvHost: string): Promise<boolean> {
  try {
    const records = await dns.resolveSrv(`_mongodb._tcp.${srvHost}`);
    if (!records.length) {
      logger.warn(`No SRV records for ${srvHost}; cannot probe directly.`);
      return false;
    }
    const reachable = await Promise.all(
      records.map((record) => tcpProbe(record.name, record.port || DEFAULT_SHARD_PORT, DIRECT_PROBE_TIMEOUT_MS))
    );
    return reachable.some(Boolean);
  } catch (error) {
    logger.warn(`Direct SRV/TCP probe failed for ${srvHost}: ${(error as Error).message}`);
    return false;
  }
}

/** True for a resolver address that cannot reach the public internet (loopback / unspecified). */
function isLoopbackResolver(server: string): boolean {
  // dns.getServers() may append a port: "1.1.1.1:5353" (v4) or "[::1]:5353" (v6).
  let host = server;
  const bracketed = host.match(/^\[(.+)\](?::\d+)?$/);
  if (bracketed) {
    host = bracketed[1];
  } else if ((host.match(/:/g) || []).length === 1) {
    host = host.split(':')[0];
  }
  return host === '::1' || host === '0.0.0.0' || host.startsWith('127.');
}

/** True when every configured resolver is loopback/unspecified (or there are none). */
function isLoopbackOnly(servers: string[]): boolean {
  return servers.length === 0 || servers.every(isLoopbackResolver);
}

/**
 * Make sure Node can resolve the cluster's SRV record before the driver tries to.
 *
 * c-ares occasionally ends up pinned to a loopback resolver that does not actually
 * answer (notably the Windows ICS DNS proxy on 127.0.0.1, which returns ECONNREFUSED).
 * Because SRV resolution for mongodb+srv URIs never goes through the SOCKS proxy, a
 * broken resolver fails the connection on every path — direct and WARP alike. If the
 * configured resolver is loopback-only, or it cannot answer the SRV query, switch the
 * process to public resolvers. No-op when the OS resolver already works. Idempotent.
 */
export async function ensureSrvResolvable(srvHost: string): Promise<void> {
  const servers = dns.getServers();

  if (!isLoopbackOnly(servers)) {
    try {
      await dns.resolveSrv(`_mongodb._tcp.${srvHost}`);
      return; // the configured resolver works; leave it alone
    } catch (error) {
      logger.warn(
        `SRV lookup failed via configured DNS (${servers.join(', ') || 'none'}): ` +
          `${(error as Error).message}; switching to public resolvers.`
      );
    }
  } else {
    logger.warn(
      `Node DNS resolver is loopback-only (${servers.join(', ') || 'none'}) — likely a local ` +
        'DNS proxy (e.g. Windows ICS) that breaks SRV resolution; switching MongoDB to public resolvers.'
    );
  }

  try {
    // Set both the promises and the callback default resolvers — they can diverge,
    // and the mongodb driver may use either depending on the Node/driver version.
    dns.setServers(PUBLIC_DNS_FALLBACK);
    setDefaultResolverServers(PUBLIC_DNS_FALLBACK);
    await dns.resolveSrv(`_mongodb._tcp.${srvHost}`);
    logger.log(`DNS fallback active: resolving via ${PUBLIC_DNS_FALLBACK.join(', ')}.`);
  } catch (error) {
    logger.error(`SRV lookup still failing after switching to public resolvers: ${(error as Error).message}`);
  }
}

/** First directory on PATH that contains the given binary, or null. */
function findOnPath(binary: string): string | null {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, binary);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Locate the Cloudflare warp-cli binary in a portable way:
 *   1. explicit WARP_CLI_PATH override (if it exists),
 *   2. the binary on the system PATH,
 *   3. per-OS well-known install locations.
 * Returns null when WARP is not installed on this machine.
 */
function resolveWarpCli(configuredPath?: string): string | null {
  if (configuredPath && fs.existsSync(configuredPath)) {
    return configuredPath;
  }

  const onPath = findOnPath(WARP_CLI_BINARY);
  if (onPath) {
    return onPath;
  }

  for (const candidate of WELL_KNOWN_WARP_PATHS[process.platform] ?? []) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function enableWarpProxyMode(warpCli: string, port: number): void {
  execFileSync(warpCli, ['mode', 'proxy'], { stdio: 'ignore' });
  execFileSync(warpCli, ['proxy', 'port', String(port)], { stdio: 'ignore' });
  execFileSync(warpCli, ['connect'], { stdio: 'ignore' });
}

async function waitForPort(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await tcpProbe(host, port, WARP_POLL_INTERVAL_MS)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, WARP_POLL_INTERVAL_MS));
  }
  return false;
}

async function decide(uri: string, warpPort: number, warpCliPath?: string): Promise<MongoProxyOptions | null> {
  const srvHost = parseSrvHost(uri);
  if (!srvHost) {
    logger.warn('Could not parse the Mongo host from the connection string; skipping auto-WARP.');
    return null;
  }

  // Repair the DNS resolver first — a dead loopback resolver breaks SRV on every path.
  if (/^mongodb\+srv:/i.test(uri)) {
    await ensureSrvResolvable(srvHost);
  }

  if (await isMongoReachableDirectly(srvHost)) {
    logger.log(`MongoDB reachable directly (${srvHost}); using the normal connection.`);
    return null;
  }

  const warpCli = resolveWarpCli(warpCliPath);
  if (!warpCli) {
    logger.warn(
      'MongoDB is unreachable directly and the Cloudflare warp-cli binary could not be found ' +
        '(set WARP_CLI_PATH to point at it); the connection will be attempted directly and may fail.'
    );
    return null;
  }

  logger.warn(`MongoDB unreachable directly; enabling Cloudflare WARP SOCKS5 proxy on 127.0.0.1:${warpPort}...`);
  try {
    enableWarpProxyMode(warpCli, warpPort);
  } catch (error) {
    logger.error(`Failed to enable the WARP proxy: ${(error as Error).message}`);
    return null;
  }

  if (!(await waitForPort('127.0.0.1', warpPort, WARP_READY_TIMEOUT_MS))) {
    logger.error(`WARP proxy did not come up on 127.0.0.1:${warpPort} in time.`);
    return null;
  }

  logger.log(`WARP proxy ready; routing MongoDB through 127.0.0.1:${warpPort}.`);
  return { proxyHost: '127.0.0.1', proxyPort: warpPort };
}

/**
 * Decides whether MongoDB should be routed through the Cloudflare WARP SOCKS5 proxy.
 *
 * Probes the Atlas shards over the direct path; if they are reachable, returns null
 * (use the normal connection). If they are blocked (e.g. the ISP drops the AWS shard
 * IPs), it enables WARP proxy mode and returns the local SOCKS5 proxy options so only
 * MongoDB traffic is tunneled. Memoized per cluster host.
 */
export function resolveAutoProxyOptions(
  uri: string,
  warpPort: number,
  warpCliPath?: string
): Promise<MongoProxyOptions | null> {
  const key = parseSrvHost(uri) ?? uri;
  let cached = decisionCache.get(key);
  if (!cached) {
    cached = decide(uri, warpPort, warpCliPath);
    decisionCache.set(key, cached);
  }
  return cached;
}
