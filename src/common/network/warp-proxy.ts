import { Logger } from '@nestjs/common';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';

const logger = new Logger('WarpProxy');

const WARP_READY_TIMEOUT_MS = 25000;
const WARP_POLL_INTERVAL_MS = 1000;

const WARP_CLI_BINARY = process.platform === 'win32' ? 'warp-cli.exe' : 'warp-cli';

// Well-known install locations checked only after the PATH lookup fails. These are
// discovery hints, not configuration — set WARP_CLI_PATH to override.
const WELL_KNOWN_WARP_PATHS: Record<string, string[]> = {
  win32: ['C:\\Program Files\\Cloudflare\\Cloudflare WARP\\warp-cli.exe'],
  darwin: ['/Applications/Cloudflare WARP.app/Contents/Resources/warp-cli', '/usr/local/bin/warp-cli'],
  linux: ['/usr/bin/warp-cli', '/usr/local/bin/warp-cli']
};

export interface WarpProxyOptions {
  proxyHost: string;
  proxyPort: number;
}

export interface EnsureWarpProxyOptions {
  port: number;
  warpCliPath?: string;
  // Resolves true when the target is reachable over the DIRECT path (no WARP needed).
  probe: () => Promise<boolean>;
}

// WARP exposes a single machine-wide SOCKS5 listener per port, so the ensure decision is
// a per-port property. Memoizing the promise makes "ensure WARP on port X" run once per
// process per port, even when several callers race for the same port.
const ensureCache = new Map<number, Promise<WarpProxyOptions | null>>();

/** Raw TCP connect probe — never uses the SOCKS proxy, so it reflects the real route. */
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
 *   1. explicit warpCliPath override (if it exists),
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

async function decide(opts: EnsureWarpProxyOptions): Promise<WarpProxyOptions | null> {
  const { port, warpCliPath, probe } = opts;

  // Never start WARP on a host whose egress already works.
  if (await probe()) {
    return null;
  }

  const warpCli = resolveWarpCli(warpCliPath);
  if (!warpCli) {
    logger.warn(
      'Egress target is unreachable directly and the Cloudflare warp-cli binary could not be found ' +
        '(set WARP_CLI_PATH to point at it); the request will be attempted directly and may fail.'
    );
    return null;
  }

  logger.warn(`Egress target unreachable directly; enabling Cloudflare WARP SOCKS5 proxy on 127.0.0.1:${port}...`);
  try {
    enableWarpProxyMode(warpCli, port);
  } catch (error) {
    logger.error(`Failed to enable the WARP proxy: ${(error as Error).message}`);
    return null;
  }

  if (!(await waitForPort('127.0.0.1', port, WARP_READY_TIMEOUT_MS))) {
    logger.error(`WARP proxy did not come up on 127.0.0.1:${port} in time.`);
    return null;
  }

  logger.log(`WARP proxy ready on 127.0.0.1:${port}.`);
  return { proxyHost: '127.0.0.1', proxyPort: port };
}

/**
 * Ensures a Cloudflare WARP SOCKS5 proxy is available for a blocked egress target.
 *
 * Runs the caller's direct-reachability probe first; if the target is reachable it returns
 * null (use the direct path, never start WARP). If the target is blocked it resolves the
 * warp-cli binary and enables WARP proxy mode (mode proxy / proxy port <port> / connect),
 * then waits for the local SOCKS5 port to answer. Returns the local proxy endpoint on
 * success, or null on any failure (missing warp-cli, enable error, port never up) so the
 * caller degrades to a direct connection rather than crashing.
 *
 * Memoized per port: the probe + enable runs once per process per port.
 */
export function ensureWarpProxy(opts: EnsureWarpProxyOptions): Promise<WarpProxyOptions | null> {
  let cached = ensureCache.get(opts.port);
  if (!cached) {
    cached = decide(opts);
    ensureCache.set(opts.port, cached);
  }
  return cached;
}

export const tcpReachable = tcpProbe;
