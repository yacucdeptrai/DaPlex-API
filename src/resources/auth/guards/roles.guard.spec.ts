import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { RolesGuard } from './roles.guard';
import { RolesGuardOptions, PermissionOptions } from '../../../decorators/roles-guard-options.decorator';
import { UserPermission } from '../../../enums';

/**
 * Characterization tests pinning every RolesGuard.canActivate branch. The
 * `optional` flag replaced the former `throwError` flag with inverted polarity
 * (optional: true === old throwError: false); these expected outcomes are the
 * same booleans the guard produced before the rename.
 */
describe('RolesGuard', () => {
  const run = (options: PermissionOptions | undefined, user: unknown) => {
    const reflector = { get: jest.fn().mockReturnValue(options) } as unknown as Reflector;
    const context = {
      getHandler: () => (): void => undefined,
      switchToHttp: () => ({ getRequest: () => ({ user }) })
    } as unknown as ExecutionContext;
    const guard = new RolesGuard(reflector);
    return { guard, context };
  };

  describe('RolesGuardOptions decorator default merge', () => {
    it('fills permissions/optional/requireOwner defaults', () => {
      class Dummy {
        @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA] })
        method() {}
      }
      const meta = new Reflector().get<PermissionOptions>('rolesGuardOptions', Dummy.prototype.method);
      expect(meta).toEqual({ permissions: [UserPermission.MANAGE_MEDIA], optional: false, requireOwner: false });
    });

    it('keeps an explicit optional: true', () => {
      class Dummy {
        @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA], optional: true })
        method() {}
      }
      const meta = new Reflector().get<PermissionOptions>('rolesGuardOptions', Dummy.prototype.method);
      expect(meta).toEqual({ permissions: [UserPermission.MANAGE_MEDIA], optional: true, requireOwner: false });
    });
  });

  describe('canActivate', () => {
    it('allows the route when no options metadata is set', async () => {
      const { guard, context } = run(undefined, undefined);
      await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it('denies when options are set but there is no user', async () => {
      const { guard, context } = run(
        { permissions: [UserPermission.MANAGE_MEDIA], optional: false, requireOwner: false },
        undefined
      );
      await expect(guard.canActivate(context)).resolves.toBe(false);
    });

    it('allows anonymous users through', async () => {
      const user = { isAnonymous: true, hasPermission: undefined } as Record<string, unknown>;
      const { guard, context } = run(
        { permissions: [UserPermission.MANAGE_MEDIA], optional: false, requireOwner: false },
        user
      );
      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(user.hasPermission).toBe(false);
    });

    it('always allows the owner and marks hasPermission true', async () => {
      const user = { owner: true, granted: [], isAnonymous: false } as Record<string, unknown>;
      const { guard, context } = run(
        { permissions: [UserPermission.MANAGE_MEDIA], optional: false, requireOwner: false },
        user
      );
      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(user.hasPermission).toBe(true);
    });

    it('denies a non-owner when requireOwner is set and the route is not optional', async () => {
      const user = { owner: false, granted: [], isAnonymous: false } as Record<string, unknown>;
      const { guard, context } = run({ permissions: [], optional: false, requireOwner: true }, user);
      await expect(guard.canActivate(context)).resolves.toBe(false);
    });

    it('falls through to the permission check for a non-owner when requireOwner is set but the route is optional', async () => {
      const user = { owner: false, granted: [], isAnonymous: false } as Record<string, unknown>;
      const { guard, context } = run(
        { permissions: [UserPermission.MANAGE_MEDIA], optional: true, requireOwner: true },
        user
      );
      // No matching permission, but optional: true lets the request through.
      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(user.hasPermission).toBe(false);
    });

    it('grants ADMINISTRATOR regardless of the required permission', async () => {
      const user = { owner: false, granted: [UserPermission.ADMINISTRATOR], isAnonymous: false } as Record<
        string,
        unknown
      >;
      const { guard, context } = run(
        { permissions: [UserPermission.MANAGE_MEDIA], optional: false, requireOwner: false },
        user
      );
      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(user.hasPermission).toBe(true);
    });

    it('grants a user holding the exact required permission', async () => {
      const user = { owner: false, granted: [UserPermission.MANAGE_MEDIA], isAnonymous: false } as Record<
        string,
        unknown
      >;
      const { guard, context } = run(
        { permissions: [UserPermission.MANAGE_MEDIA], optional: false, requireOwner: false },
        user
      );
      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(user.hasPermission).toBe(true);
    });

    it('denies a user lacking the permission when the route is not optional', async () => {
      const user = { owner: false, granted: [], isAnonymous: false } as Record<string, unknown>;
      const { guard, context } = run(
        { permissions: [UserPermission.MANAGE_MEDIA], optional: false, requireOwner: false },
        user
      );
      await expect(guard.canActivate(context)).resolves.toBe(false);
      expect(user.hasPermission).toBe(false);
    });

    it('allows a user lacking the permission through when the route is optional', async () => {
      const user = { owner: false, granted: [], isAnonymous: false } as Record<string, unknown>;
      const { guard, context } = run(
        { permissions: [UserPermission.MANAGE_MEDIA], optional: true, requireOwner: false },
        user
      );
      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(user.hasPermission).toBe(false);
    });
  });
});
