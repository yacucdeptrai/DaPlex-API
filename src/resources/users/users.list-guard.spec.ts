import { Reflector } from '@nestjs/core';
import { HttpException, HttpStatus } from '@nestjs/common';

import { UsersController } from './users.controller';
import { AuthGuard } from '../auth/guards/auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AuthOptions } from '../../decorators/auth-guard-options.decorator';
import { PermissionOptions } from '../../decorators/roles-guard-options.decorator';
import { UserPermission, StatusCode } from '../../enums';

// The user list returns every account plus each account's roles, and roles carry
// `permissions` and `position` - so it must stay admin-only. Decorator metadata alone
// does not prove that: RolesGuard returns true for anonymous users, so the anonymous
// block comes from AuthGuard. Both halves are asserted here.

const ctxFor = (handler: (...args: any[]) => any, request: any) =>
  ({
    getHandler: () => handler,
    getClass: () => UsersController,
    switchToHttp: () => ({ getRequest: () => request })
  }) as any;

describe('GET /users access control', () => {
  const reflector = new Reflector();
  const handler = UsersController.prototype.findAll;

  describe('route metadata', () => {
    it('requires the MANAGE_USERS permission, not optionally', () => {
      const options = reflector.get<PermissionOptions>('rolesGuardOptions', handler);

      expect(options).toBeDefined();
      expect(options.permissions).toContain(UserPermission.MANAGE_USERS);
      expect(options.optional).toBeFalsy();
    });

    it('does not opt into anonymous auth', () => {
      // RolesGuard short-circuits to true on isAnonymous, so opting in here would
      // re-open the directory even with the permission still declared.
      const options = reflector.get<AuthOptions>('authGuardOptions', handler);

      expect(options?.anonymous).toBeFalsy();
    });
  });

  describe('AuthGuard', () => {
    const authGuard = new AuthGuard(reflector, {} as any);

    it('rejects a request carrying no access token', async () => {
      expect.assertions(2);

      try {
        await authGuard.canActivate(ctxFor(handler, { headers: {} }));
      } catch (e) {
        expect((e as HttpException).getStatus()).toBe(HttpStatus.UNAUTHORIZED);
        expect((e as HttpException).getResponse()).toMatchObject({ code: StatusCode.NULL_AUTHORIZATION });
      }
    });
  });

  describe('RolesGuard', () => {
    const rolesGuard = new RolesGuard(reflector);
    const canActivate = (user: any) => rolesGuard.canActivate(ctxFor(handler, { user }));

    it('denies an authenticated user without the permission', async () => {
      await expect(canActivate({ isAnonymous: false, owner: false, granted: [] })).resolves.toBe(false);
    });

    it('denies a request with no resolved user', async () => {
      await expect(canActivate(undefined)).resolves.toBe(false);
    });

    it('allows a user granted MANAGE_USERS', async () => {
      await expect(canActivate({ isAnonymous: false, owner: false, granted: [UserPermission.MANAGE_USERS] })).resolves.toBe(true);
    });

    it('allows an administrator', async () => {
      await expect(canActivate({ isAnonymous: false, owner: false, granted: [UserPermission.ADMINISTRATOR] })).resolves.toBe(true);
    });

    it('allows the owner', async () => {
      await expect(canActivate({ isAnonymous: false, owner: true, granted: [] })).resolves.toBe(true);
    });
  });
});
