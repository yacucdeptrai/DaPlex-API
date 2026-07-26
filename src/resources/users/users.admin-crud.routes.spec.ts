import 'reflect-metadata';
import { GUARDS_METADATA, HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { UsersController } from './users.controller';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AuthOptions } from '../../decorators/auth-guard-options.decorator';
import { PermissionOptions } from '../../decorators/roles-guard-options.decorator';
import { UserPermission } from '../../enums';

/**
 * W4.3 — HTTP surface of the two NEW admin routes: POST /users and DELETE /users/:id.
 *
 * RED until the surgeon adds the handlers. Written against a by-name lookup on the
 * prototype so the file still TYPE-checks today (`npm run typecheck` includes
 * src/**\/*.ts) — a missing handler fails at runtime with a clear message instead
 * of breaking the typecheck gate for everyone.
 *
 * Decorator metadata alone is false assurance (see the @SkipThrottle named-throttler
 * trap this repo already got burned by), so every metadata assertion is paired with a
 * real RolesGuard.canActivate behaviour spec, exactly as users.list-guard.spec.ts does
 * for GET /users.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const proto = UsersController.prototype as any as Record<string, (...args: any[]) => any>;

const handlerFor = (name: string) => {
  const fn = proto[name];
  if (typeof fn !== 'function') throw new Error(`UsersController.${name} is not implemented yet (W4.3 RED)`);
  return fn;
};

const guardNames = (fn: unknown) =>
  ((Reflect.getMetadata(GUARDS_METADATA, fn as object) ?? []) as { name?: string }[]).map((g) => g?.name ?? String(g));

const ctxFor = (handler: unknown, request: unknown) =>
  ({
    getHandler: () => handler,
    getClass: () => UsersController,
    switchToHttp: () => ({ getRequest: () => request })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

describe('W4.3 admin user CRUD — route surface', () => {
  const reflector = new Reflector();

  describe('POST /users', () => {
    it('is declared as a POST handler named `create` on the empty-prefix controller', () => {
      const fn = handlerFor('create');

      expect(Reflect.getMetadata(METHOD_METADATA, fn)).toBe(RequestMethod.POST);
      expect(Reflect.getMetadata(PATH_METADATA, fn)).toBe('/');
    });

    it('is guarded by AuthGuard + RolesGuard', () => {
      expect(guardNames(handlerFor('create'))).toEqual(['AuthGuard', 'RolesGuard']);
    });

    it('requires MANAGE_USERS mandatorily (optional must be false, not just absent)', () => {
      // `optional: true` here would silently make account creation available to any
      // logged-in user — RolesGuard line 33 returns true for the unqualified case.
      const options = reflector.get<PermissionOptions>('rolesGuardOptions', handlerFor('create'));

      expect(options).toBeDefined();
      expect(options.permissions).toContain(UserPermission.MANAGE_USERS);
      expect(options.optional).toBe(false);
    });

    it('does not opt into anonymous auth', () => {
      const options = reflector.get<AuthOptions>('authGuardOptions', handlerFor('create'));

      expect(options?.anonymous).toBeFalsy();
    });
  });

  describe('DELETE /users/:id', () => {
    it('is declared as a DELETE :id handler named `remove`', () => {
      const fn = handlerFor('remove');

      expect(Reflect.getMetadata(METHOD_METADATA, fn)).toBe(RequestMethod.DELETE);
      expect(Reflect.getMetadata(PATH_METADATA, fn)).toBe(':id');
    });

    it('responds 204 No Content', () => {
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handlerFor('remove'))).toBe(204);
    });

    it('is guarded by AuthGuard + RolesGuard', () => {
      expect(guardNames(handlerFor('remove'))).toEqual(['AuthGuard', 'RolesGuard']);
    });

    it('requires MANAGE_USERS mandatorily (optional must be false, not just absent)', () => {
      const options = reflector.get<PermissionOptions>('rolesGuardOptions', handlerFor('remove'));

      expect(options).toBeDefined();
      expect(options.permissions).toContain(UserPermission.MANAGE_USERS);
      expect(options.optional).toBe(false);
    });

    it('does not opt into anonymous auth', () => {
      const options = reflector.get<AuthOptions>('authGuardOptions', handlerFor('remove'));

      expect(options?.anonymous).toBeFalsy();
    });
  });

  describe('PATCH /users/:id/roles', () => {
    it('is declared as a PATCH :id/roles handler named `updateRoles`', () => {
      const fn = handlerFor('updateRoles');

      expect(Reflect.getMetadata(METHOD_METADATA, fn)).toBe(RequestMethod.PATCH);
      expect(Reflect.getMetadata(PATH_METADATA, fn)).toBe(':id/roles');
    });

    it('is guarded by AuthGuard + RolesGuard', () => {
      expect(guardNames(handlerFor('updateRoles'))).toEqual(['AuthGuard', 'RolesGuard']);
    });

    it('requires MANAGE_ROLES, NOT MANAGE_USERS', () => {
      // Granting and revoking roles is a roles operation whichever resource path it
      // hangs off. The inverse endpoint `PATCH /roles/:id/users` requires MANAGE_ROLES
      // (roles.controller.ts:128) and the authority rails are role-position based, so
      // gating this one on MANAGE_USERS would open a back door around that check.
      const options = reflector.get<PermissionOptions>('rolesGuardOptions', handlerFor('updateRoles'));

      expect(options).toBeDefined();
      expect(options.permissions).toEqual([UserPermission.MANAGE_ROLES]);
      expect(options.permissions).not.toContain(UserPermission.MANAGE_USERS);
      expect(options.optional).toBe(false);
    });

    it('does not opt into anonymous auth', () => {
      expect(reflector.get<AuthOptions>('authGuardOptions', handlerFor('updateRoles'))?.anonymous).toBeFalsy();
    });

    it('rejects a MANAGE_USERS-only caller', async () => {
      const rolesGuard = new RolesGuard(reflector);

      await expect(
        rolesGuard.canActivate(
          ctxFor(handlerFor('updateRoles'), { user: { isAnonymous: false, owner: false, granted: [UserPermission.MANAGE_USERS] } })
        )
      ).resolves.toBe(false);
    });

    it('allows a MANAGE_ROLES caller', async () => {
      const rolesGuard = new RolesGuard(reflector);

      await expect(
        rolesGuard.canActivate(
          ctxFor(handlerFor('updateRoles'), { user: { isAnonymous: false, owner: false, granted: [UserPermission.MANAGE_ROLES] } })
        )
      ).resolves.toBe(true);
    });
  });

  // Behaviour half. Metadata says "MANAGE_USERS required"; only canActivate proves it.
  describe.each(['create', 'remove'])('RolesGuard behaviour on %s', (handlerName) => {
    const rolesGuard = new RolesGuard(reflector);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const canActivate = (user: any) => rolesGuard.canActivate(ctxFor(handlerFor(handlerName), { user }));

    it('denies an authenticated user without the permission', async () => {
      await expect(canActivate({ isAnonymous: false, owner: false, granted: [] })).resolves.toBe(false);
    });

    it('denies a request with no resolved user', async () => {
      await expect(canActivate(undefined)).resolves.toBe(false);
    });

    it('denies a user holding an unrelated permission', async () => {
      await expect(
        canActivate({ isAnonymous: false, owner: false, granted: [UserPermission.MANAGE_MEDIA] })
      ).resolves.toBe(false);
    });

    it('allows a user granted MANAGE_USERS', async () => {
      await expect(
        canActivate({ isAnonymous: false, owner: false, granted: [UserPermission.MANAGE_USERS] })
      ).resolves.toBe(true);
    });

    it('allows an administrator', async () => {
      await expect(
        canActivate({ isAnonymous: false, owner: false, granted: [UserPermission.ADMINISTRATOR] })
      ).resolves.toBe(true);
    });

    it('allows the owner', async () => {
      await expect(canActivate({ isAnonymous: false, owner: true, granted: [] })).resolves.toBe(true);
    });
  });

  /**
   * GREEN TODAY, on purpose. `@RolesGuardOptions({ permissions: [MANAGE_USERS], optional: true })`
   * is copy-pasteable from the three self-service routes right above the new ones, and
   * `optional: true` turns a mandatory permission into a no-op. This pins the exact set of
   * handlers allowed to be optional, so a stray copy-paste onto create/remove fails here
   * even if someone deletes the two `optional` assertions above.
   */
  describe('optional-permission regression sweep', () => {
    it('only the three pre-existing self-service routes may declare optional: true', () => {
      const optionalHandlers = Object.getOwnPropertyNames(proto)
        .filter((name) => name !== 'constructor' && typeof proto[name] === 'function')
        .filter((name) => reflector.get<PermissionOptions>('rolesGuardOptions', proto[name])?.optional === true)
        .sort();

      expect(optionalHandlers).toEqual(['findOne', 'update', 'updateSettings']);
    });
  });
});

/**
 * Delegation half — which service method each new handler forwards to, and in which
 * argument order. A handler can compile while calling the wrong overload; the arg
 * order here mirrors the roles controller (`create(dto, authUser)`, `remove(id, authUser)`).
 */
describe('W4.3 admin user CRUD — controller delegation', () => {
  interface Call {
    method: string;
    args: unknown[];
  }

  const buildController = () => {
    const calls: Call[] = [];
    const recording = new Proxy(
      {},
      {
        get:
          (_t, method: string) =>
          (...args: unknown[]) => {
            calls.push({ method, args });
            return Promise.resolve(undefined);
          }
      }
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const instance = new UsersController(recording as any) as any as Record<string, (...args: unknown[]) => unknown>;
    return { instance, calls };
  };

  const AUTH_USER = { __sentinel: 'authUser' };
  const BODY = { __sentinel: 'createUserDto' };
  const ID = { __sentinel: 'id' };

  it('create() forwards to usersService.create(createUserDto, authUser)', () => {
    handlerFor('create');
    const { instance, calls } = buildController();

    instance.create(AUTH_USER, BODY);

    expect(calls).toEqual([{ method: 'create', args: [BODY, AUTH_USER] }]);
  });

  it('remove() forwards to usersService.remove(id, authUser)', () => {
    handlerFor('remove');
    const { instance, calls } = buildController();

    instance.remove(AUTH_USER, ID);

    expect(calls).toEqual([{ method: 'remove', args: [ID, AUTH_USER] }]);
  });

  it('updateRoles() forwards to usersService.updateRoles(id, dto, authUser)', () => {
    // Arg order mirrors the sibling updateSettings handler (users.controller.ts:149).
    handlerFor('updateRoles');
    const { instance, calls } = buildController();

    instance.updateRoles(AUTH_USER, ID, BODY);

    expect(calls).toEqual([{ method: 'updateRoles', args: [ID, BODY, AUTH_USER] }]);
  });
});
