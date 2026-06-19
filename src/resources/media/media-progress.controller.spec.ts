import 'reflect-metadata';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';

import { MediaVideoController } from './media-video.controller';
import { UserPermission } from '../../enums';

/**
 * W1.2 TDD spec — the polled `GET media/:id/progress` endpoint + its admin guard.
 *
 * FORWARD feature: there is no current behavior to characterize, so these tests
 * SPECIFY the desired contract and are expected to be RED until the surgeon adds
 * `getTranscodeProgress` to MediaVideoController. The guard assertions are the
 * load-bearing ones: roles.guard.ts returns `true` when no @RolesGuardOptions
 * metadata is present (:13-14) and `true` for anonymous users (:21), so the
 * endpoint is only admin-scoped if it carries the exact decoration below and
 * does NOT carry @AuthGuardOptions({ anonymous: true }) or `optional: true`.
 *
 * The handler name the surgeon must add:
 */
const HANDLER = 'getTranscodeProgress';

const MANAGE = [UserPermission.MANAGE_MEDIA];

const getHandler = (): ((...args: unknown[]) => unknown) | undefined => {
  const proto = MediaVideoController.prototype as unknown as Record<string, unknown>;
  return proto[HANDLER] as ((...args: unknown[]) => unknown) | undefined;
};

const guardNames = (fn: unknown): string[] =>
  ((Reflect.getMetadata(GUARDS_METADATA, fn) as Array<{ name?: string }>) ?? []).map((g) => g?.name ?? String(g));

describe('MediaVideoController GET :id/progress — route + guard metadata (W1.2, TDD)', () => {
  it('declares a getTranscodeProgress handler on MediaVideoController', () => {
    expect(typeof getHandler()).toBe('function');
  });

  it('is registered as a GET on the `:id/progress` path (empty class prefix preserved)', () => {
    const fn = getHandler();
    expect(fn).toBeDefined();
    const method = Reflect.getMetadata(METHOD_METADATA, fn) as RequestMethod;
    const path = Reflect.getMetadata(PATH_METADATA, fn) as string;
    expect(RequestMethod[method]).toBe('GET');
    expect(path).toBe(':id/progress');
  });

  it('guards the route with [AuthGuard, RolesGuard] in that order', () => {
    const fn = getHandler();
    expect(fn).toBeDefined();
    expect(guardNames(fn)).toEqual(['AuthGuard', 'RolesGuard']);
  });

  it('requires MANAGE_MEDIA via @RolesGuardOptions and is NOT optional', () => {
    const fn = getHandler();
    expect(fn).toBeDefined();
    const roles = Reflect.getMetadata('rolesGuardOptions', fn) as {
      permissions?: number[];
      optional?: boolean;
      requireOwner?: boolean;
    };
    expect(roles).toBeDefined();
    expect(roles.permissions).toEqual(MANAGE);
    // optional:true would let a non-permitted user through (roles.guard.ts:33-34).
    expect(roles.optional).toBe(false);
  });

  it('does NOT carry @AuthGuardOptions({ anonymous: true }) (would make the route public)', () => {
    const fn = getHandler();
    expect(fn).toBeDefined();
    // The decorator may be absent entirely (preferred) — assert it never grants anonymous.
    const auth = Reflect.getMetadata('authGuardOptions', fn) as { anonymous?: boolean } | undefined;
    expect(auth?.anonymous ?? false).toBe(false);
  });
});
