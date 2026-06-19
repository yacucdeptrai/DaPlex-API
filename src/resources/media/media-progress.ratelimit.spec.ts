import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';

import { MediaVideoController } from './media-video.controller';

/**
 * W1.2 TDD spec — route-scoped rate-limit on GET media/:id/progress.
 *
 * Mechanism (leader/user decision): `@nestjs/throttler`, applied ONLY to the
 * progress endpoint (route- or controller-scoped) — NOT a global APP_GUARD. The
 * polled chip hits this every few seconds, so the cap is generous (~30 req / 60s)
 * to allow normal polling while bounding abuse. Exact numbers are tuned with the
 * surgeon; this spec pins that a finite route-scoped throttle EXISTS.
 *
 * FORWARD feature — expected RED until the surgeon (a) adds the `@nestjs/throttler`
 * dependency, (b) decorates the handler with `@Throttle({ default: { limit, ttl } })`,
 * and (c) applies `ThrottlerGuard` at the route/controller level (NOT globally).
 *
 * Tested at the METADATA level: wiring a real ThrottlerStorage in the unit harness
 * to force a 429 is heavy and storage-dependent, so we assert the decorator + guard
 * are present and route-scoped with a finite limit+ttl. The live-429 burst behavior
 * is left to integration-qa against the running API (noted in 02_test_baseline.md).
 *
 * NOTE: `@nestjs/throttler` is NOT installed yet (the surgeon adds it). This spec
 * deliberately does NOT import from the package — it reads the reflected metadata by
 * its stable key — so the file compiles now and is RED on the assertion, not on a
 * missing-module import error.
 */
const HANDLER = 'getTranscodeProgress';

const getHandler = (): ((...args: unknown[]) => unknown) | undefined => {
  const proto = MediaVideoController.prototype as unknown as Record<string, unknown>;
  return proto[HANDLER] as ((...args: unknown[]) => unknown) | undefined;
};

// @nestjs/throttler stores its config under a key that contains "throttler".
// Some versions key it as a record `{ default: { limit, ttl } }`; v5/v6 emit flat
// per-named keys (THROTTLER:LIMIT<name> / THROTTLER:TTL<name>). We accept either by
// scanning the metadata keys — selecting the LIMIT key explicitly for the flat form.
const readThrottle = (target: object): { limit?: number; ttl?: number } | undefined => {
  const keys = Reflect.getMetadataKeys(target) as Array<string | symbol>;

  // Flat-key form (v5/v6): a THROTTLER:LIMIT<name> key holding the numeric limit,
  // paired with a THROTTLER:TTL<name> key. Select the LIMIT key regardless of order.
  const limitKey = keys.find(
    (k) => String(k).toLowerCase().includes('throttler') && String(k).toLowerCase().includes('limit')
  );
  if (limitKey) {
    const limit = Reflect.getMetadata(limitKey, target) as number;
    const ttlKey = keys.find(
      (k) => String(k).toLowerCase().includes('throttler') && String(k).toLowerCase().includes('ttl')
    );
    const ttl = ttlKey ? (Reflect.getMetadata(ttlKey, target) as number) : undefined;
    if (typeof limit === 'number') return { limit, ttl };
  }

  // Record form: { default: { limit, ttl }, ... }.
  const recordKey = keys.find((k) => String(k).toLowerCase().includes('throttler'));
  if (recordKey) {
    const raw = Reflect.getMetadata(recordKey, target) as unknown;
    if (raw && typeof raw === 'object') {
      const first = Object.values(raw as Record<string, { limit?: number; ttl?: number }>)[0];
      if (first && typeof first === 'object') return { limit: first.limit, ttl: first.ttl };
    }
  }
  return undefined;
};

const guardNames = (fn: unknown): string[] =>
  ((Reflect.getMetadata(GUARDS_METADATA, fn) as Array<{ name?: string }>) ?? []).map((g) => g?.name ?? String(g));

describe('GET media/:id/progress rate-limit — route-scoped @nestjs/throttler (W1.2, TDD)', () => {
  it('decorates the handler with a finite throttle limit and ttl', () => {
    const fn = getHandler();
    expect(fn).toBeDefined();
    const throttle = readThrottle(fn as object) ?? readThrottle(MediaVideoController);
    expect(throttle).toBeDefined();
    expect(typeof throttle!.limit).toBe('number');
    expect(throttle!.limit as number).toBeGreaterThan(0);
    expect(Number.isFinite(throttle!.limit as number)).toBe(true);
    expect(typeof throttle!.ttl).toBe('number');
    expect(throttle!.ttl as number).toBeGreaterThan(0);
  });

  it('applies ThrottlerGuard at the route/controller scope (NOT only the existing auth guards)', () => {
    const fn = getHandler();
    expect(fn).toBeDefined();
    // The throttle must be enforced for this route — either ThrottlerGuard is in the
    // handler's guard list, or it is applied at the controller class level.
    const handlerGuards = guardNames(fn);
    const classGuards = guardNames(MediaVideoController);
    const hasThrottlerGuard = [...handlerGuards, ...classGuards].some((g) => /throttler/i.test(g));
    expect(hasThrottlerGuard).toBe(true);
  });

  it('does NOT throttle globally — other media routes carry no throttle metadata', () => {
    // A route-scoped registration must not leak onto sibling handlers. addMediaVideo is
    // a representative non-progress route on the same controller; it must stay un-throttled.
    const sibling = (MediaVideoController.prototype as unknown as Record<string, unknown>)['addMediaVideo'];
    expect(typeof sibling).toBe('function');
    expect(readThrottle(sibling as object)).toBeUndefined();
  });
});
