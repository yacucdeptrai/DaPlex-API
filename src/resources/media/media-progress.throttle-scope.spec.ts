import 'reflect-metadata';

import { MediaVideoController } from './media-video.controller';

// @nestjs/throttler keys its per-named-throttler metadata under these stable string
// prefixes (THROTTLER:SKIP<name> / THROTTLER:LIMIT<name>) — the same keys the guard
// resolves. Hardcoded to avoid depending on the package's deep dist constants path.
const THROTTLER_SKIP = 'THROTTLER:SKIP';
const THROTTLER_LIMIT = 'THROTTLER:LIMIT';

/**
 * SEC-W1.2-1 regression — the route-scoped throttle must NOT leak onto sibling
 * routes. @SkipThrottle()/@Throttle() are NAMED per throttler; a name mismatch
 * (e.g. a bare @SkipThrottle() that only skips 'default' while the module registers
 * 'progress') silently lets the class-level ThrottlerGuard throttle EVERY route —
 * including the two anonymous public stream reads the player polls, which would 429
 * legit playback under shared/NAT IPs.
 *
 * The pure-metadata ratelimit spec missed this because it reads decorator presence,
 * not the runtime skip/limit resolution the guard actually performs. Here we resolve
 * exactly what ThrottlerGuard does for the registered 'progress' throttler:
 *   skip  = getAllAndOverride(THROTTLER_SKIP  + name, [handler, class])
 *   limit = getAllAndOverride(THROTTLER_LIMIT + name, [handler, class])
 */
const NAME = 'progress'; // matches ThrottlerModule.forRoot([{ name: 'progress', ... }])
const proto = MediaVideoController.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;

// Mirror ThrottlerGuard's resolution: prefer the handler's metadata, fall back to the
// controller class (handler-level @SkipThrottle({progress:false}) overrides the class).
const resolveOverride = (key: string, handler: (...a: unknown[]) => unknown): unknown => {
  const onHandler = Reflect.getMetadata(key, handler);
  return onHandler !== undefined ? onHandler : Reflect.getMetadata(key, MediaVideoController);
};
const resolveSkip = (handler: (...a: unknown[]) => unknown): unknown => resolveOverride(THROTTLER_SKIP + NAME, handler);
const resolveLimit = (handler: (...a: unknown[]) => unknown): unknown =>
  resolveOverride(THROTTLER_LIMIT + NAME, handler);

describe('GET media/:id/progress throttle scoping (SEC-W1.2-1, runtime resolution)', () => {
  it('throttles ONLY the progress route (skip=false, finite limit)', () => {
    expect(resolveSkip(proto['getTranscodeProgress'])).toBe(false);
    const limit = resolveLimit(proto['getTranscodeProgress']);
    expect(typeof limit).toBe('number');
    expect(limit as number).toBeGreaterThan(0);
  });

  it('does NOT throttle the anonymous public movie stream read (must skip)', () => {
    expect(resolveSkip(proto['findAllMovieStreams'])).toBe(true);
    expect(resolveLimit(proto['findAllMovieStreams'])).toBeUndefined();
  });

  it('does NOT throttle the anonymous public tv episode stream read (must skip)', () => {
    expect(resolveSkip(proto['findAllTVEpisodeStreams'])).toBe(true);
    expect(resolveLimit(proto['findAllTVEpisodeStreams'])).toBeUndefined();
  });

  it('does NOT throttle a representative admin write route (must skip)', () => {
    expect(resolveSkip(proto['addMediaVideo'])).toBe(true);
    expect(resolveLimit(proto['addMediaVideo'])).toBeUndefined();
  });
});
