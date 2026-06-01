import { Logger } from '@nestjs/common';
import { execFileSync } from 'child_process';
import * as dns from 'dns/promises';
import * as fs from 'fs';
import * as net from 'net';

const logger = new Logger('MongoConnectivity');

const DIRECT_PROBE_TIMEOUT_MS = 6000;
const WARP_READY_TIMEOUT_MS = 25000;
const WARP_POLL_INTERVAL_MS = 1000;
const DEFAULT_SHARD_PORT = 27017;

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

function findWarpCli(warpCliPath: string): string | null {
  if (process.platform !== 'win32') return null;
  return warpCliPath && fs.existsSync(warpCliPath) ? warpCliPath : null;
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

async function decide(uri: string, warpPort: number, warpCliPath: string): Promise<MongoProxyOptions | null> {
  const srvHost = parseSrvHost(uri);
  if (!srvHost) {
    logger.warn('Could not parse the Mongo host from the connection string; skipping auto-WARP.');
    return null;
  }

  if (await isMongoReachableDirectly(srvHost)) {
    logger.log(`MongoDB reachable directly (${srvHost}); using the normal connection.`);
    return null;
  }

  const warpCli = findWarpCli(warpCliPath);
  if (!warpCli) {
    logger.warn(
      'MongoDB is unreachable directly and Cloudflare WARP is not available here; ' +
        'the connection will be attempted directly and may fail.'
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
  warpCliPath: string
): Promise<MongoProxyOptions | null> {
  const key = parseSrvHost(uri) ?? uri;
  let cached = decisionCache.get(key);
  if (!cached) {
    cached = decide(uri, warpPort, warpCliPath);
    decisionCache.set(key, cached);
  }
  return cached;
}
