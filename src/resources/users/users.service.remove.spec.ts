import { HttpStatus } from '@nestjs/common';

import { StatusCode, UserPermission, CloudflareR2Container } from '../../enums';
import { buildUsersService, captureHttpError, makeSession, queryChain, SessionMock } from './users-admin.fixture-spec';

/**
 * W4.3 — `UsersService.remove` (hard delete + cascade). RED until implemented.
 *
 * The shape being locked, per the user-locked decision:
 *
 *   phase 1 — ONE DATABASE_A transaction: delete the user, cascade
 *             history / ratings / playlists / drive-sessions, `$pull` the user out
 *             of every role.
 *   phase 2 — BEST-EFFORT, AFTER COMMIT: notification delete + audit log (both on
 *             DATABASE_B, a separate mongoose connection that physically cannot
 *             join the phase-1 transaction), `clearCachedAuthUser`, and the R2
 *             avatar/banner objects.
 *
 * A phase-2 failure must not fail the request and must not roll the delete back.
 * That is the assertion set most likely to be quietly broken by a refactor, so the
 * transaction boundary is asserted by CALL ORDER, not just call counts.
 *
 * Session handling is deliberately tolerant: the surgeon may start the session from
 * `mongooseConnection` (roles.service.ts:119) or from `userModel` (the existing
 * deleteAvatar at users.service.ts:294), and may pass it as `{ session }` or via
 * `.session(session)`. Both are accepted; what is pinned is that the phase-1 writes
 * really are inside a transaction and the phase-2 writes really are not.
 */

// StatusCode members appended by the surgeon. Referenced numerically so this file
// type-checks before the enum grows; users.admin-crud.codes.spec.ts pins the names.
const DELETE_USER_RESTRICTED = 307;
const OWNER_DELETE_RESTRICTED = 308;
// AuditLogType.USER_DELETE, likewise appended.
const AUDIT_USER_DELETE = 6002;

const TARGET_ID = BigInt(55);
const ADMIN_ID = BigInt(10);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const makeAdmin = (overrides: Record<string, any> = {}) => ({
  _id: ADMIN_ID,
  owner: false,
  isAnonymous: false,
  hasPermission: true,
  granted: [UserPermission.MANAGE_USERS],
  roles: [{ _id: BigInt(1), position: 2, permissions: UserPermission.MANAGE_USERS }],
  ...overrides
});

// Lower position number = higher rank (permissions.service.ts:58-65). The admin above
// sits at 2, so a target at 5 is deletable and a target at 2 is not.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const makeTarget = (overrides: Record<string, any> = {}) => ({
  _id: TARGET_ID,
  username: 'target',
  email: 'target@daplex.test',
  owner: false,
  roles: [{ _id: BigInt(2), position: 5, permissions: 0 }],
  avatar: { _id: BigInt(71), name: 'avatar.png' },
  banner: { _id: BigInt(72), name: 'banner.png' },
  ...overrides
});

/** True when the mock was handed a session, either as an option object or via `.session()`. */
const usedSession = (mock: jest.Mock): boolean => {
  const asOption = mock.mock.calls.some((args: unknown[]) =>
    args.some((arg: unknown) => !!arg && typeof arg === 'object' && 'session' in (arg as Record<string, unknown>))
  );
  const asChain = mock.mock.results.some((result) => {
    const chain = result.value as { session?: jest.Mock } | undefined;
    return !!chain?.session?.mock?.calls?.length;
  });
  return asOption || asChain;
};

describe('UsersService.remove — hard delete + cascade (RED until W4.3 lands)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let service: any;
  let callOrder: string[];
  let session: SessionMock;
  let userModel: { findOne: jest.Mock; findOneAndDelete: jest.Mock; startSession: jest.Mock };
  let historyModel: { deleteMany: jest.Mock };
  let ratingModel: { deleteMany: jest.Mock };
  let playlistModel: { deleteMany: jest.Mock };
  let driveSessionModel: { deleteMany: jest.Mock };
  let roleModel: { updateMany: jest.Mock };
  let notificationModel: { deleteMany: jest.Mock };
  let authService: { clearCachedAuthUser: jest.Mock };
  let auditLogService: { createLog: jest.Mock; createLogFromBuilder: jest.Mock };
  let cloudflareR2Service: { delete: jest.Mock };

  /** Wires the harness with `target` as the user being deleted (null = not found). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wire = async (target: any) => {
    callOrder = [];
    session = makeSession(callOrder);

    const trackedDelete = (label: string) =>
      jest.fn(() => {
        callOrder.push(label);
        return queryChain({ deletedCount: 1 });
      });

    userModel = {
      findOne: jest.fn(() => queryChain(target)),
      findOneAndDelete: jest.fn(() => {
        callOrder.push('user:delete');
        return queryChain(target);
      }),
      startSession: jest.fn().mockResolvedValue(session)
    };
    historyModel = { deleteMany: trackedDelete('history:delete') };
    ratingModel = { deleteMany: trackedDelete('rating:delete') };
    playlistModel = { deleteMany: trackedDelete('playlist:delete') };
    driveSessionModel = { deleteMany: trackedDelete('driveSession:delete') };
    roleModel = {
      updateMany: jest.fn(() => {
        callOrder.push('role:pull');
        return queryChain({ modifiedCount: 1 });
      })
    };
    notificationModel = { deleteMany: trackedDelete('notification:delete') };
    authService = {
      clearCachedAuthUser: jest.fn(() => {
        callOrder.push('cache:clear');
        return Promise.resolve(undefined);
      })
    };
    auditLogService = {
      createLog: jest.fn(() => {
        callOrder.push('auditLog:write');
        return Promise.resolve(undefined);
      }),
      createLogFromBuilder: jest.fn(() => {
        callOrder.push('auditLog:write');
        return Promise.resolve(undefined);
      })
    };
    cloudflareR2Service = {
      delete: jest.fn(() => {
        callOrder.push('r2:delete');
        return Promise.resolve(undefined);
      })
    };

    service = await buildUsersService();
    service.userModel = userModel;
    service.historyModel = historyModel;
    service.ratingModel = ratingModel;
    service.playlistModel = playlistModel;
    service.driveSessionModel = driveSessionModel;
    service.roleModel = roleModel;
    service.notificationModel = notificationModel;
    service.authService = authService;
    service.auditLogService = auditLogService;
    service.cloudflareR2Service = cloudflareR2Service;
    service.mongooseConnection = { startSession: jest.fn().mockResolvedValue(session) };
    service.configService = { get: jest.fn(() => undefined) };
    return service;
  };

  const auditType = () =>
    auditLogService.createLog.mock.calls[0]?.[3] ?? auditLogService.createLogFromBuilder.mock.calls[0]?.[0]?.type;

  beforeEach(async () => {
    await wire(makeTarget());
  });

  it('is implemented as UsersService.remove(id, authUser)', () => {
    expect(typeof service.remove).toBe('function');
  });

  // ---------------------------------------------------------------------------
  // Safety rails — each its own test, each proving nothing was deleted.
  // ---------------------------------------------------------------------------
  describe('safety rails', () => {
    it('404s USER_NOT_FOUND when the target does not exist', async () => {
      await wire(null);

      const error = await captureHttpError(() => service.remove(TARGET_ID, makeAdmin()));

      expect(error).toEqual({ status: HttpStatus.NOT_FOUND, code: StatusCode.USER_NOT_FOUND });
      expect(userModel.findOneAndDelete).not.toHaveBeenCalled();
    });

    it('blocks self-delete with DELETE_USER_RESTRICTED', async () => {
      // The target document is present, so this cannot pass by accidentally 404ing:
      // it proves the self-delete rail specifically.
      await wire(makeTarget({ _id: ADMIN_ID }));

      const error = await captureHttpError(() => service.remove(ADMIN_ID, makeAdmin()));

      expect(error).toEqual({ status: HttpStatus.FORBIDDEN, code: DELETE_USER_RESTRICTED });
      expect(userModel.findOneAndDelete).not.toHaveBeenCalled();
    });

    it('blocks deleting the instance owner with OWNER_DELETE_RESTRICTED', async () => {
      // setting.owner is required:true. Deleting the owner dangles the Setting
      // singleton and breaks the settings screen — this must be unconditional.
      await wire(makeTarget({ owner: true, roles: [] }));

      const error = await captureHttpError(() => service.remove(TARGET_ID, makeAdmin({ owner: true, _id: ADMIN_ID })));

      expect(error).toEqual({ status: HttpStatus.FORBIDDEN, code: OWNER_DELETE_RESTRICTED });
      expect(userModel.findOneAndDelete).not.toHaveBeenCalled();
    });

    it('blocks a target whose highest role ties the caller (userPosition >= targetPosition)', async () => {
      await wire(makeTarget({ roles: [{ _id: BigInt(3), position: 2, permissions: 0 }] }));

      const error = await captureHttpError(() => service.remove(TARGET_ID, makeAdmin()));

      expect(error).toEqual({ status: HttpStatus.FORBIDDEN, code: DELETE_USER_RESTRICTED });
      expect(userModel.findOneAndDelete).not.toHaveBeenCalled();
    });

    it('blocks a target who outranks the caller', async () => {
      await wire(makeTarget({ roles: [{ _id: BigInt(3), position: 1, permissions: 0 }] }));

      const error = await captureHttpError(() => service.remove(TARGET_ID, makeAdmin()));

      expect(error).toEqual({ status: HttpStatus.FORBIDDEN, code: DELETE_USER_RESTRICTED });
    });

    it('allows a lower-ranked target', async () => {
      await expect(service.remove(TARGET_ID, makeAdmin())).resolves.toBeUndefined();
      expect(userModel.findOneAndDelete).toHaveBeenCalled();
    });

    it('allows a target with no roles at all (position -1, matching the ban rule)', async () => {
      // permissions.service.ts:60 returns -1 for a roleless user and the ban path
      // gates on `targetPosition >= 0`. Keeping the same semantics here is deliberate.
      await wire(makeTarget({ roles: [] }));

      await expect(
        service.remove(TARGET_ID, makeAdmin({ roles: [{ _id: BigInt(9), position: 9, permissions: 0 }] }))
      ).resolves.toBeUndefined();
      expect(userModel.findOneAndDelete).toHaveBeenCalled();
    });

    it('allows the owner to delete any non-owner, whatever their rank', async () => {
      await wire(makeTarget({ roles: [{ _id: BigInt(3), position: 0, permissions: 0 }] }));

      await expect(service.remove(TARGET_ID, makeAdmin({ owner: true, roles: [] }))).resolves.toBeUndefined();
      expect(userModel.findOneAndDelete).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Phase 1 — the DATABASE_A transaction.
  // ---------------------------------------------------------------------------
  describe('phase 1: DATABASE_A transaction', () => {
    beforeEach(async () => {
      await service.remove(TARGET_ID, makeAdmin());
    });

    it('runs inside a transaction and always ends the session', () => {
      expect(session.withTransaction).toHaveBeenCalledTimes(1);
      expect(session.endSession).toHaveBeenCalled();
    });

    it('deletes the user document by id', () => {
      expect(userModel.findOneAndDelete.mock.calls[0][0]).toEqual({ _id: TARGET_ID });
    });

    it('cascades history, ratings, playlists and drive sessions', () => {
      expect(historyModel.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({ user: TARGET_ID }),
        expect.anything()
      );
      expect(ratingModel.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({ user: TARGET_ID }),
        expect.anything()
      );
      // playlist stores the owner as `author`, not `user`.
      expect(playlistModel.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({ author: TARGET_ID }),
        expect.anything()
      );
      expect(driveSessionModel.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({ user: TARGET_ID }),
        expect.anything()
      );
    });

    it('pulls the user out of every role rather than deleting roles', () => {
      expect(roleModel.updateMany).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ $pull: { users: TARGET_ID } }),
        expect.anything()
      );
    });

    it('gives every phase-1 write the transaction session', () => {
      expect(usedSession(userModel.findOneAndDelete)).toBe(true);
      expect(usedSession(historyModel.deleteMany)).toBe(true);
      expect(usedSession(ratingModel.deleteMany)).toBe(true);
      expect(usedSession(playlistModel.deleteMany)).toBe(true);
      expect(usedSession(driveSessionModel.deleteMany)).toBe(true);
      expect(usedSession(roleModel.updateMany)).toBe(true);
    });

    it('performs every phase-1 write between transaction start and commit', () => {
      const start = callOrder.indexOf('transaction:start');
      const commit = callOrder.indexOf('transaction:commit');

      expect(start).toBeGreaterThanOrEqual(0);
      expect(commit).toBeGreaterThan(start);
      for (const label of [
        'user:delete',
        'history:delete',
        'rating:delete',
        'playlist:delete',
        'driveSession:delete',
        'role:pull'
      ]) {
        const at = callOrder.indexOf(label);
        expect({ label, inside: at > start && at < commit }).toEqual({ label, inside: true });
      }
    });

    it('leaves media.addedBy dangling — authorship is not personal data', () => {
      // Locked decision: no media write on the delete path. The FE type is already
      // `addedBy?`, and reassigning it to the deleting admin would falsify the record.
      // Structural guard: UsersService must not acquire a Media model to rewrite it.
      expect(service.mediaModel).toBeUndefined();
      expect(service.mediaService).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Phase 2 — best-effort, post-commit, cross-connection.
  // ---------------------------------------------------------------------------
  describe('phase 2: post-commit best-effort work', () => {
    beforeEach(async () => {
      await service.remove(TARGET_ID, makeAdmin());
    });

    const after = (label: string) => callOrder.indexOf(label) > callOrder.indexOf('transaction:commit');

    it('deletes the user notifications on DATABASE_B, outside the transaction', () => {
      expect(notificationModel.deleteMany.mock.calls[0][0]).toEqual(expect.objectContaining({ user: TARGET_ID }));
      // DATABASE_B is a separate mongoose connection: handing it the DATABASE_A
      // session would throw at runtime, and a unit test is the only cheap guard.
      expect(usedSession(notificationModel.deleteMany)).toBe(false);
      expect(after('notification:delete')).toBe(true);
    });

    it('writes a USER_DELETE audit log after the commit and never inside it', () => {
      expect(auditType()).toBe(AUDIT_USER_DELETE);
      expect(after('auditLog:write')).toBe(true);
      expect(usedSession(auditLogService.createLog)).toBe(false);
    });

    it('keeps the audit trail of the deleted user intact', () => {
      // audit-log.user references the deleted account. Deleting those rows would
      // destroy exactly the evidence an admin delete needs. Structural guard: the
      // delete path must not acquire an audit-log model to delete through.
      expect(service.auditLogModel).toBeUndefined();
    });

    it('clears the cached auth user so the 300s USER_AUTH_GUARD entry cannot outlive the account', () => {
      expect(authService.clearCachedAuthUser).toHaveBeenCalledWith(TARGET_ID);
      expect(after('cache:clear')).toBe(true);
    });

    it('removes the avatar and banner objects from R2', () => {
      expect(cloudflareR2Service.delete).toHaveBeenCalledWith(CloudflareR2Container.AVATARS, '71/avatar.png');
      expect(cloudflareR2Service.delete).toHaveBeenCalledWith(CloudflareR2Container.BANNERS, '72/banner.png');
    });
  });

  it('does not touch R2 when the user had no avatar or banner', async () => {
    await wire(makeTarget({ avatar: undefined, banner: undefined }));

    await service.remove(TARGET_ID, makeAdmin());

    expect(cloudflareR2Service.delete).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Failure isolation — the reason phase 2 exists at all.
  // ---------------------------------------------------------------------------
  describe('phase 2 failure isolation', () => {
    const expectStillDeleted = () => {
      expect(userModel.findOneAndDelete).toHaveBeenCalledTimes(1);
      expect(session.withTransaction).toHaveBeenCalledTimes(1);
    };

    it('succeeds when the DATABASE_B notification delete rejects', async () => {
      notificationModel.deleteMany.mockRejectedValue(new Error('database-b unreachable'));

      await expect(service.remove(TARGET_ID, makeAdmin())).resolves.toBeUndefined();
      expectStillDeleted();
    });

    it('succeeds when the audit-log write rejects', async () => {
      auditLogService.createLog.mockRejectedValue(new Error('database-b unreachable'));
      auditLogService.createLogFromBuilder.mockRejectedValue(new Error('database-b unreachable'));

      await expect(service.remove(TARGET_ID, makeAdmin())).resolves.toBeUndefined();
      expectStillDeleted();
    });

    it('succeeds when the R2 object delete rejects', async () => {
      cloudflareR2Service.delete.mockRejectedValue(new Error('r2 unreachable'));

      await expect(service.remove(TARGET_ID, makeAdmin())).resolves.toBeUndefined();
      expectStillDeleted();
    });

    it('succeeds when clearing the auth cache rejects', async () => {
      authService.clearCachedAuthUser.mockRejectedValue(new Error('redis unreachable'));

      await expect(service.remove(TARGET_ID, makeAdmin())).resolves.toBeUndefined();
      expectStillDeleted();
    });

    it('still clears the auth cache when an earlier phase-2 step rejects', async () => {
      // The cache clear is the security-relevant one: a deleted user's access token
      // keeps working for up to 300s without it. It must not be skipped because the
      // notification delete happened to fail first.
      notificationModel.deleteMany.mockRejectedValue(new Error('database-b unreachable'));
      auditLogService.createLog.mockRejectedValue(new Error('database-b unreachable'));
      auditLogService.createLogFromBuilder.mockRejectedValue(new Error('database-b unreachable'));

      await service.remove(TARGET_ID, makeAdmin());

      expect(authService.clearCachedAuthUser).toHaveBeenCalledWith(TARGET_ID);
    });

    it('survives every phase-2 step rejecting at once', async () => {
      notificationModel.deleteMany.mockRejectedValue(new Error('down'));
      auditLogService.createLog.mockRejectedValue(new Error('down'));
      auditLogService.createLogFromBuilder.mockRejectedValue(new Error('down'));
      cloudflareR2Service.delete.mockRejectedValue(new Error('down'));
      authService.clearCachedAuthUser.mockRejectedValue(new Error('down'));

      await expect(service.remove(TARGET_ID, makeAdmin())).resolves.toBeUndefined();
      expectStillDeleted();
    });
  });

  // ---------------------------------------------------------------------------
  // Phase 1 failures, by contrast, MUST propagate.
  // ---------------------------------------------------------------------------
  describe('phase 1 failures propagate', () => {
    it('rejects when a cascade inside the transaction fails', async () => {
      historyModel.deleteMany.mockImplementation(() => Promise.reject(new Error('write conflict')));

      await expect(service.remove(TARGET_ID, makeAdmin())).rejects.toThrow('write conflict');
    });

    it('ends the session even when the transaction fails', async () => {
      historyModel.deleteMany.mockImplementation(() => Promise.reject(new Error('write conflict')));

      await expect(service.remove(TARGET_ID, makeAdmin())).rejects.toThrow();
      expect(session.endSession).toHaveBeenCalled();
    });
  });
});
