/**
 * Scanner auto-WARP egress — characterization + TDD specs for the NEW shared helper
 * `ensureWarpProxy` in ./warp-proxy.ts.
 *
 * RED-PENDING-SURGEON: ./warp-proxy.ts does NOT exist yet. The surgeon will extract the
 * generic WARP-ensure logic here (analyst brief §2 option (c)), mirroring the
 * battle-tested copy in mongo-connectivity.ts (:48-263). Until then this whole suite
 * FAILS TO COMPILE ("cannot find module './warp-proxy'") — that is the expected RED
 * baseline for the new unit. The mongo-connectivity.ts copy is intentionally left
 * untouched (and its existing spec stays green).
 *
 * Intended contract (analyst brief §2):
 *
 *   export interface WarpProxyOptions { proxyHost: string; proxyPort: number; }
 *
 *   export function ensureWarpProxy(opts: {
 *     port: number;
 *     warpCliPath?: string;
 *     probe: () => Promise<boolean>;   // true == target reachable DIRECTLY
 *   }): Promise<WarpProxyOptions | null>;
 *
 *   - probe() true  -> return null, NEVER spawn warp-cli (don't start WARP on a healthy host).
 *   - probe() false -> resolve warp-cli; if missing -> log + null (degrade to direct, no throw).
 *   -               -> else `mode proxy` / `proxy port <port>` / `connect` (execFileSync) then
 *                      poll until 127.0.0.1:<port> answers; on success -> { '127.0.0.1', port }.
 *   - enable throws -> null. waitForPort times out -> null.
 *   - Memoized per port via a module-level Map<number, Promise<...>> (ensure once per port).
 *
 * SAFETY: this spec NEVER spawns a real warp-cli and NEVER opens a real socket. It mocks
 * child_process.execFileSync (the spawn) and net.Socket (the tcp probe + waitForPort). Tests
 * that need an isolated per-port Map use jest.isolateModules so the module-level cache does
 * not bleed between cases.
 */
jest.mock('child_process');
jest.mock('net');
jest.mock('fs');

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';

const mockedExecFileSync = execFileSync as jest.Mock;
const mockedNet = net as jest.Mocked<typeof net>;
const mockedFs = fs as jest.Mocked<typeof fs>;

const WARP_CLI = '/usr/bin/warp-cli';
const PORT = 40000;

/**
 * Install a fake net.Socket whose `connect()` immediately emits the chosen outcome, so
 * tcpProbe / waitForPort resolve synchronously without touching the network.
 *   'connect' -> the port answers (reachable),
 *   'error'   -> refused/blocked,
 *   'timeout' -> never answers.
 */
function stubSocket(outcome: 'connect' | 'error' | 'timeout'): void {
  mockedNet.Socket.mockImplementation(() => {
    const handlers: Record<string, () => void> = {};
    const socket = {
      setTimeout: jest.fn(),
      once: jest.fn((event: string, cb: () => void) => {
        handlers[event] = cb;
        return socket;
      }),
      removeAllListeners: jest.fn(),
      destroy: jest.fn(),
      connect: jest.fn(() => {
        // Fire on the next microtask so the Promise wiring in tcpProbe is in place.
        Promise.resolve().then(() => handlers[outcome]?.());
      })
    };
    return socket as unknown as net.Socket;
  });
}

/** Load a fresh copy of the module so the per-port memoization Map starts empty. */
function freshHelper(): typeof import('./warp-proxy') {
  let mod: typeof import('./warp-proxy');
  jest.isolateModules(() => {
    mod = require('./warp-proxy');
  });
  return mod!;
}

describe('ensureWarpProxy (scanner auto-WARP egress)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // warp-cli is "installed" by default: resolveWarpCli checks fs.existsSync.
    mockedFs.existsSync.mockReturnValue(true);
    // Silence the helper's Logger output so a clean console (no stray logs) is preserved.
    jest.spyOn(require('@nestjs/common').Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(require('@nestjs/common').Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(require('@nestjs/common').Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  // CRITICAL guarantee — a host that reaches the target directly must NEVER start WARP.
  it('returns null and never spawns warp-cli when the probe reports the target reachable', async () => {
    const { ensureWarpProxy } = freshHelper();
    const probe = jest.fn().mockResolvedValue(true);

    const result = await ensureWarpProxy({ port: PORT, warpCliPath: WARP_CLI, probe });

    expect(result).toBeNull();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  // NEW / RED — blocked target -> run the exact 3-command warp-cli enable sequence in order,
  // wait for the port, return the local SOCKS5 endpoint.
  it('enables WARP (mode proxy / proxy port N / connect) and returns 127.0.0.1:<port> when the target is blocked', async () => {
    stubSocket('connect'); // waitForPort sees the SOCKS port answer
    const { ensureWarpProxy } = freshHelper();
    const probe = jest.fn().mockResolvedValue(false);

    const result = await ensureWarpProxy({ port: PORT, warpCliPath: WARP_CLI, probe });

    expect(result).toEqual({ proxyHost: '127.0.0.1', proxyPort: PORT });
    // The three commands, exact args, in order. (Args mirror mongo-connectivity.ts:184-186.)
    expect(mockedExecFileSync).toHaveBeenCalledTimes(3);
    expect(mockedExecFileSync).toHaveBeenNthCalledWith(1, WARP_CLI, ['mode', 'proxy'], expect.anything());
    expect(mockedExecFileSync).toHaveBeenNthCalledWith(2, WARP_CLI, ['proxy', 'port', String(PORT)], expect.anything());
    expect(mockedExecFileSync).toHaveBeenNthCalledWith(3, WARP_CLI, ['connect'], expect.anything());
  });

  // MEMOIZE — two concurrent calls for the SAME port share one decision: the probe and the
  // enable sequence run ONCE (the §3 per-port guard).
  it('runs the probe + enable sequence ONCE for two concurrent calls on the same port', async () => {
    stubSocket('connect');
    const { ensureWarpProxy } = freshHelper();
    const probe = jest.fn().mockResolvedValue(false);

    const [a, b] = await Promise.all([
      ensureWarpProxy({ port: PORT, warpCliPath: WARP_CLI, probe }),
      ensureWarpProxy({ port: PORT, warpCliPath: WARP_CLI, probe })
    ]);

    expect(a).toEqual({ proxyHost: '127.0.0.1', proxyPort: PORT });
    expect(b).toEqual({ proxyHost: '127.0.0.1', proxyPort: PORT });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(mockedExecFileSync).toHaveBeenCalledTimes(3); // not 6
  });

  // MEMOIZE — a sequential second call on the same port also reuses the cached decision.
  it('reuses the cached decision on a sequential second call for the same port', async () => {
    stubSocket('connect');
    const { ensureWarpProxy } = freshHelper();
    const probe = jest.fn().mockResolvedValue(false);

    await ensureWarpProxy({ port: PORT, warpCliPath: WARP_CLI, probe });
    await ensureWarpProxy({ port: PORT, warpCliPath: WARP_CLI, probe });

    expect(probe).toHaveBeenCalledTimes(1);
    expect(mockedExecFileSync).toHaveBeenCalledTimes(3);
  });

  // DIFFERENT PORTS — independent ensures: each port gets its own probe + enable.
  it('ensures independently for different ports', async () => {
    stubSocket('connect');
    const { ensureWarpProxy } = freshHelper();
    const probe = jest.fn().mockResolvedValue(false);

    const r1 = await ensureWarpProxy({ port: 40000, warpCliPath: WARP_CLI, probe });
    const r2 = await ensureWarpProxy({ port: 40001, warpCliPath: WARP_CLI, probe });

    expect(r1).toEqual({ proxyHost: '127.0.0.1', proxyPort: 40000 });
    expect(r2).toEqual({ proxyHost: '127.0.0.1', proxyPort: 40001 });
    expect(probe).toHaveBeenCalledTimes(2);
    expect(mockedExecFileSync).toHaveBeenCalledTimes(6); // 3 per port
  });

  // GRACEFUL — warp-cli not installed (resolver finds nothing) -> null, NO spawn, NO throw.
  // The app must still boot; a blocked scanner then 503s on TMDB, it does not crash.
  it('returns null without spawning or throwing when warp-cli cannot be resolved', async () => {
    mockedFs.existsSync.mockReturnValue(false); // not at configured path / PATH / well-known
    const { ensureWarpProxy } = freshHelper();
    const probe = jest.fn().mockResolvedValue(false);

    await expect(ensureWarpProxy({ port: PORT, warpCliPath: undefined, probe })).resolves.toBeNull();
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  // DEGRADE — the warp-cli enable subprocess throws -> null (degrade to direct, no crash).
  it('returns null when the warp-cli enable sequence throws', async () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error('warp-cli connect failed');
    });
    const { ensureWarpProxy } = freshHelper();
    const probe = jest.fn().mockResolvedValue(false);

    await expect(ensureWarpProxy({ port: PORT, warpCliPath: WARP_CLI, probe })).resolves.toBeNull();
  });

  // DEGRADE — enable succeeds but the SOCKS port never comes up -> null (waitForPort timeout).
  // Fake timers drive waitForPort's poll/deadline loop to its end without a real wall-clock
  // wait (the internal WARP_READY_TIMEOUT_MS is ~25s in the Mongo copy). We mock Date.now so
  // the deadline is crossed deterministically as we flush each poll iteration.
  it('returns null when the WARP port never comes up after enabling', async () => {
    jest.useFakeTimers();
    try {
      stubSocket('error'); // tcpProbe always fails -> waitForPort never satisfied -> times out
      const { ensureWarpProxy } = freshHelper();
      const probe = jest.fn().mockResolvedValue(false);

      const pending = ensureWarpProxy({ port: PORT, warpCliPath: WARP_CLI, probe });

      // Run every queued timer (the poll-interval sleeps) until the deadline lapses and
      // waitForPort returns false. runOnlyPendingTimers + microtask flush, repeated, walks
      // the loop to completion without real time passing.
      for (let i = 0; i < 60; i++) {
        jest.runOnlyPendingTimers();
        await Promise.resolve();
      }

      await expect(pending).resolves.toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});
