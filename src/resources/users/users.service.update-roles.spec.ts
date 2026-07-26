import { HttpStatus } from '@nestjs/common';

import { StatusCode, AuditLogType } from '../../enums';
import { buildUsersService, captureHttpError, makeSession, queryChain, SessionMock } from './users-admin.fixture-spec';

/**
 * W4.3 — `UsersService.updateRoles`, backing the new `PATCH /users/:id/roles`.
 * RED until implemented.
 *
 * This is the INVERSE of `PATCH /roles/:id/users`. The existing endpoint replaces a
 * role's entire member list (`roles.service.ts:165` writes `{ users: userIds }`), which
 * is a read-modify-write over an array two UIs now write to — a textbook lost update.
 * W4.1b routes member management exclusively through this endpoint, so the whole design
 * rests on this one being diff-based and atomic.
 *
 * Two things are therefore non-negotiable and each gets a dedicated test:
 *   1. DIFF, not replacement — only the roles that actually changed are written.
 *   2. ATOMIC operators — `$addToSet` / `$pull`, never a whole-array assignment. The
 *      last block proves this behaviourally: two concurrent assignments to the same role
 *      run against an in-memory model that really applies the operators, and both must
 *      survive. A read-modify-write implementation loses one and fails there.
 *
 * Authority is `permissionsService.canEditRole` — the SAME rule `roles.service.ts:155`
 * uses. No second authority rule is invented here. The fixture injects a real
 * PermissionsService, so these are behaviour-true, not stub-true.
 */

const USER_ID = BigInt(40);
const ADMIN_ID = BigInt(10);
// Lower position = higher rank. The admin below sits at 5.
const ROLE_BELOW_A = { _id: BigInt(101), name: 'below-a', position: 8, permissions: 0 };
const ROLE_BELOW_B = { _id: BigInt(102), name: 'below-b', position: 9, permissions: 0 };
const ROLE_BELOW_C = { _id: BigInt(103), name: 'below-c', position: 7, permissions: 0 };
const ROLE_EQUAL = { _id: BigInt(104), name: 'equal', position: 5, permissions: 0 };
const ROLE_ABOVE = { _id: BigInt(105), name: 'above', position: 1, permissions: 0 };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const makeAdmin = (overrides: Record<string, any> = {}) => ({
  _id: ADMIN_ID,
  owner: false,
  isAnonymous: false,
  hasPermission: true,
  granted: [] as number[],
  roles: [{ _id: BigInt(1), position: 5, permissions: 0 }],
  ...overrides
});

/** Does this update document assign a plain array rather than using an atomic operator? */
const isWholeArrayWrite = (update: unknown, field: string): boolean => {
  if (!update || typeof update !== 'object') return false;
  const doc = update as Record<string, unknown>;
  if (Array.isArray(doc[field])) return true;
  const set = doc.$set as Record<string, unknown> | undefined;
  return Array.isArray(set?.[field]);
};

describe('UsersService.updateRoles — diff-based role assignment (RED until W4.3 lands)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let service: any;
  let callOrder: string[];
  let session: SessionMock;
  let userModel: { findOne: jest.Mock; updateOne: jest.Mock; startSession: jest.Mock };
  let roleModel: { find: jest.Mock; updateMany: jest.Mock; countDocuments: jest.Mock };
  let authService: { clearCachedAuthUser: jest.Mock; clearCachedAuthUsers: jest.Mock };
  let auditLogService: { createLogFromBuilder: jest.Mock; createManyLogsFromBuilder: jest.Mock };

  /**
   * `heldRoles` = the roles the target user currently has; `knownRoles` = what exists.
   * The user document carries `roles` as bare bigint ids, not role objects: the lookup
   * projects `{ _id: 1, roles: 1 }` without populating, which is what mongo returns.
   */
  const wire = async (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    heldRoles: any[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    knownRoles: any[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    user: any = { _id: USER_ID, roles: heldRoles.map((role) => role._id) }
  ) => {
    callOrder = [];
    session = makeSession(callOrder);

    userModel = {
      findOne: jest.fn(() => queryChain(user)),
      updateOne: jest.fn(() => {
        callOrder.push('user:write');
        return queryChain({ modifiedCount: 1 });
      }),
      startSession: jest.fn().mockResolvedValue(session)
    };
    // `find` honours an `_id.$in` filter: the implementation is free to load only the
    // affected roles rather than all of them, and a filter-blind mock would make the
    // existence check ("did every requested id resolve?") fail spuriously.
    const matching = (filter?: { _id?: { $in?: bigint[] } }) => {
      const wanted = filter?._id?.$in;
      return wanted ? knownRoles.filter((role) => wanted.includes(role._id)) : knownRoles;
    };
    roleModel = {
      find: jest.fn((filter?: { _id?: { $in?: bigint[] } }) => queryChain(matching(filter))),
      updateMany: jest.fn(() => {
        callOrder.push('role:write');
        return queryChain({ modifiedCount: 1 });
      }),
      countDocuments: jest.fn((filter?: { _id?: { $in?: bigint[] } }) => queryChain(matching(filter).length))
    };
    authService = {
      clearCachedAuthUser: jest.fn(() => {
        callOrder.push('cache:clear');
        return Promise.resolve(undefined);
      }),
      clearCachedAuthUsers: jest.fn(() => {
        callOrder.push('cache:clear');
        return Promise.resolve(undefined);
      })
    };
    auditLogService = {
      createLogFromBuilder: jest.fn(() => {
        callOrder.push('auditLog:write');
        return Promise.resolve(undefined);
      }),
      createManyLogsFromBuilder: jest.fn(() => {
        callOrder.push('auditLog:write');
        return Promise.resolve(undefined);
      })
    };

    service = await buildUsersService();
    service.userModel = userModel;
    service.roleModel = roleModel;
    service.authService = authService;
    service.auditLogService = auditLogService;
    service.mongooseConnection = { startSession: jest.fn().mockResolvedValue(session) };
    return service;
  };

  /** Every audit entry the call produced, whether written singly or in bulk. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const auditEntries = (): any[] => [
    ...auditLogService.createLogFromBuilder.mock.calls.map((call) => call[0]),
    ...auditLogService.createManyLogsFromBuilder.mock.calls.flatMap((call) => call[0] ?? [])
  ];

  /** Role ids named in any `_id.$in` filter handed to roleModel.updateMany. */
  const touchedRoleIds = (): bigint[] =>
    roleModel.updateMany.mock.calls.flatMap((call) => {
      const filter = call[0] as { _id?: { $in?: bigint[] } };
      return filter?._id?.$in ?? [];
    });

  beforeEach(async () => {
    await wire([ROLE_BELOW_B, ROLE_BELOW_C], [ROLE_BELOW_A, ROLE_BELOW_B, ROLE_BELOW_C, ROLE_EQUAL, ROLE_ABOVE]);
  });

  it('is implemented as UsersService.updateRoles(id, updateUserRolesDto, authUser)', () => {
    expect(typeof service.updateRoles).toBe('function');
  });

  // ---------------------------------------------------------------------------
  describe('safety rails', () => {
    it('404s USER_NOT_FOUND when the target user does not exist', async () => {
      await wire([], [ROLE_BELOW_A], null);

      const error = await captureHttpError(() =>
        service.updateRoles(USER_ID, { roleIds: [ROLE_BELOW_A._id] }, makeAdmin())
      );

      expect(error).toEqual({ status: HttpStatus.NOT_FOUND, code: StatusCode.USER_NOT_FOUND });
      expect(roleModel.updateMany).not.toHaveBeenCalled();
    });

    it('400s ROLE_NOT_FOUND when any requested role id does not exist', async () => {
      // Mirrors the bulk-existence check at roles.service.ts:159-160. There is no plural
      // ROLES_NOT_FOUND code, so the singular 111 is reused rather than growing the enum.
      await wire([], [ROLE_BELOW_A]);

      const error = await captureHttpError(() =>
        service.updateRoles(USER_ID, { roleIds: [ROLE_BELOW_A._id, BigInt(999)] }, makeAdmin())
      );

      expect(error).toEqual({ status: HttpStatus.BAD_REQUEST, code: StatusCode.ROLE_NOT_FOUND });
      expect(roleModel.updateMany).not.toHaveBeenCalled();
    });

    it('403s ROLE_PRIORITY when granting a role at the callers own position', async () => {
      // THE privilege-escalation test. canEditRole denies when
      // `minPosition >= targetRole.position`, so an admin at 5 cannot hand out
      // position 5 — that would let them mint a peer and, transitively, themselves.
      const error = await captureHttpError(() =>
        service.updateRoles(USER_ID, { roleIds: [ROLE_BELOW_B._id, ROLE_BELOW_C._id, ROLE_EQUAL._id] }, makeAdmin())
      );

      expect(error).toEqual({ status: HttpStatus.FORBIDDEN, code: StatusCode.ROLE_PRIORITY });
      expect(roleModel.updateMany).not.toHaveBeenCalled();
    });

    it('403s ROLE_PRIORITY when granting a role above the caller', async () => {
      const error = await captureHttpError(() =>
        service.updateRoles(USER_ID, { roleIds: [ROLE_BELOW_B._id, ROLE_BELOW_C._id, ROLE_ABOVE._id] }, makeAdmin())
      );

      expect(error).toEqual({ status: HttpStatus.FORBIDDEN, code: StatusCode.ROLE_PRIORITY });
    });

    it('403s ROLE_PRIORITY when REMOVING a role above the caller', async () => {
      // Revoking a superior role is the same authority question as granting one.
      await wire([ROLE_ABOVE, ROLE_BELOW_B], [ROLE_ABOVE, ROLE_BELOW_A, ROLE_BELOW_B]);

      const error = await captureHttpError(() =>
        service.updateRoles(USER_ID, { roleIds: [ROLE_BELOW_B._id] }, makeAdmin())
      );

      expect(error).toEqual({ status: HttpStatus.FORBIDDEN, code: StatusCode.ROLE_PRIORITY });
    });

    it('allows a superior role the caller is not touching to stay', async () => {
      // Only the DIFF is authority-checked. Otherwise nobody below the top could ever
      // adjust a user who happens to hold one senior role, which is not the rule
      // roles.service.ts applies either.
      await wire([ROLE_ABOVE], [ROLE_ABOVE, ROLE_BELOW_A]);

      await expect(
        service.updateRoles(USER_ID, { roleIds: [ROLE_ABOVE._id, ROLE_BELOW_A._id] }, makeAdmin())
      ).resolves.toBeDefined();
    });

    it('denies a caller with no roles at all', async () => {
      // canEditRole returns false for a roleless non-owner, whatever permission bits
      // the guard let through.
      const error = await captureHttpError(() =>
        service.updateRoles(
          USER_ID,
          { roleIds: [ROLE_BELOW_A._id, ROLE_BELOW_B._id, ROLE_BELOW_C._id] },
          makeAdmin({ roles: [] })
        )
      );

      expect(error).toEqual({ status: HttpStatus.FORBIDDEN, code: StatusCode.ROLE_PRIORITY });
    });

    it('lets the owner assign anything', async () => {
      await expect(
        service.updateRoles(
          USER_ID,
          { roleIds: [ROLE_ABOVE._id, ROLE_BELOW_B._id, ROLE_BELOW_C._id] },
          makeAdmin({ owner: true, roles: [] })
        )
      ).resolves.toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  describe('diff semantics', () => {
    // Held: B, C. Requested: A, B. Expect: add A, remove C, leave B alone.
    beforeEach(async () => {
      await service.updateRoles(USER_ID, { roleIds: [ROLE_BELOW_A._id, ROLE_BELOW_B._id] }, makeAdmin());
    });

    it('adds only the newly requested role', () => {
      const additions = roleModel.updateMany.mock.calls.filter(
        (call) => !!(call[1] as Record<string, unknown>).$addToSet
      );
      expect(additions).toHaveLength(1);
      expect((additions[0][0] as { _id: { $in: bigint[] } })._id.$in).toEqual([ROLE_BELOW_A._id]);
      expect(additions[0][1]).toMatchObject({ $addToSet: { users: USER_ID } });
    });

    it('removes only the role that was dropped', () => {
      const removals = roleModel.updateMany.mock.calls.filter((call) => !!(call[1] as Record<string, unknown>).$pull);
      expect(removals).toHaveLength(1);
      expect((removals[0][0] as { _id: { $in: bigint[] } })._id.$in).toEqual([ROLE_BELOW_C._id]);
      expect(removals[0][1]).toMatchObject({ $pull: { users: USER_ID } });
    });

    it('never touches a role that was already held and still is', () => {
      expect(touchedRoleIds()).not.toContain(ROLE_BELOW_B._id);
    });

    it('never touches an unrelated role', () => {
      expect(touchedRoleIds()).not.toContain(ROLE_EQUAL._id);
      expect(touchedRoleIds()).not.toContain(ROLE_ABOVE._id);
    });

    it('mirrors the change onto the user document', () => {
      // Operator keys, not a stringified dump — these payloads carry bigint ids.
      const operators = userModel.updateOne.mock.calls.flatMap((call) =>
        Object.keys(call[1] as Record<string, unknown>)
      );

      expect(operators.some((op) => op === '$addToSet' || op === '$push')).toBe(true);
      expect(operators.some((op) => op === '$pull' || op === '$pullAll')).toBe(true);
    });

    it('returns the resulting role id list', async () => {
      const result = await service.updateRoles(USER_ID, { roleIds: [ROLE_BELOW_A._id, ROLE_BELOW_B._id] }, makeAdmin());

      expect(result).toEqual({ roles: [ROLE_BELOW_A._id, ROLE_BELOW_B._id] });
    });
  });

  it('writes nothing when the requested set matches what the user already has', async () => {
    await service.updateRoles(USER_ID, { roleIds: [ROLE_BELOW_B._id, ROLE_BELOW_C._id] }, makeAdmin());

    expect(roleModel.updateMany).not.toHaveBeenCalled();
    expect(auditEntries()).toHaveLength(0);
  });

  it('clears every role when handed an empty list', async () => {
    await service.updateRoles(USER_ID, { roleIds: [] }, makeAdmin());

    const removals = roleModel.updateMany.mock.calls.filter((call) => !!(call[1] as Record<string, unknown>).$pull);
    expect((removals[0][0] as { _id: { $in: bigint[] } })._id.$in.sort()).toEqual(
      [ROLE_BELOW_B._id, ROLE_BELOW_C._id].sort()
    );
  });

  // ---------------------------------------------------------------------------
  describe('atomicity of the array writes', () => {
    beforeEach(async () => {
      await service.updateRoles(USER_ID, { roleIds: [ROLE_BELOW_A._id, ROLE_BELOW_B._id] }, makeAdmin());
    });

    it('never assigns role.users as a whole array', () => {
      // `roles.service.ts:165` does exactly this (`{ users: userIds }`) and that is the
      // lost update this endpoint exists to avoid. Reintroducing it one layer down
      // would be invisible in a functional test.
      for (const [, update] of roleModel.updateMany.mock.calls) {
        expect({ update, wholeArray: isWholeArrayWrite(update, 'users') }).toEqual({ update, wholeArray: false });
      }
    });

    it('never assigns user.roles as a whole array', () => {
      for (const [, update] of userModel.updateOne.mock.calls) {
        expect({ update, wholeArray: isWholeArrayWrite(update, 'roles') }).toEqual({ update, wholeArray: false });
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe('transaction, cache and audit', () => {
    beforeEach(async () => {
      await service.updateRoles(USER_ID, { roleIds: [ROLE_BELOW_A._id, ROLE_BELOW_B._id] }, makeAdmin());
    });

    it('performs both sides of the write inside one transaction', () => {
      const start = callOrder.indexOf('transaction:start');
      const commit = callOrder.indexOf('transaction:commit');

      expect(session.withTransaction).toHaveBeenCalledTimes(1);
      expect(session.endSession).toHaveBeenCalled();
      for (const label of ['role:write', 'user:write']) {
        const at = callOrder.indexOf(label);
        expect({ label, inside: at > start && at < commit }).toEqual({ label, inside: true });
      }
    });

    it('clears the cached auth user so the permission change is not stale for 300s', () => {
      const cleared = authService.clearCachedAuthUsers.mock.calls
        .flatMap((call) => call[0] ?? [])
        .concat(authService.clearCachedAuthUser.mock.calls.map((call) => call[0]));

      expect(cleared).toContain(USER_ID);
    });

    it('records a ROLE_MEMBER_UPDATE entry per affected role', () => {
      const entries = auditEntries();

      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry.type).toBe(AuditLogType.ROLE_MEMBER_UPDATE);
        expect(entry.targetRef).toBe('Role');
      }
      expect(entries.map((entry) => entry.target).sort()).toEqual([ROLE_BELOW_A._id, ROLE_BELOW_C._id].sort());
    });

    it('records the user id as the changed value, matching RolesService', () => {
      const changes = auditEntries().flatMap((entry) => entry.changes ?? []);

      expect(changes).toContainEqual(expect.objectContaining({ key: 'users', newValue: USER_ID }));
      expect(changes).toContainEqual(expect.objectContaining({ key: 'users', oldValue: USER_ID }));
    });
  });

  it('propagates a mid-transaction failure so nothing is half-applied', async () => {
    roleModel.updateMany.mockImplementation(() => Promise.reject(new Error('write conflict')));

    await expect(service.updateRoles(USER_ID, { roleIds: [ROLE_BELOW_A._id] }, makeAdmin())).rejects.toThrow(
      'write conflict'
    );
    expect(session.endSession).toHaveBeenCalled();
  });
});

/**
 * The lost-update test the endpoint exists for. Unlike the mocks above, this model
 * really applies `$addToSet` / `$pull` / whole-array assignment, and its reads resolve
 * one macrotask late so two in-flight calls both read before either writes.
 *
 * An `$addToSet` implementation keeps both users. A read-modify-write implementation —
 * fetch `role.users`, splice in memory, write the array back, the `roles.service.ts:165`
 * shape — keeps only whichever wrote last, and fails here.
 */
describe('UsersService.updateRoles — concurrent assignment to the same role (RED)', () => {
  const USER_A = BigInt(41);
  const USER_B = BigInt(42);
  const ROLE = { _id: BigInt(101), name: 'shared', position: 8, permissions: 0 };

  const settle = () => new Promise((resolve) => setImmediate(resolve));

  /** Applies one mongo update operator against an in-memory bigint array. */
  const applyUpdate = (current: bigint[], update: Record<string, unknown>, field: string): bigint[] => {
    const valuesOf = (raw: unknown): bigint[] => {
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const wrapper = raw as Record<string, unknown>;
        if (Array.isArray(wrapper.$each)) return wrapper.$each as bigint[];
        if (Array.isArray(wrapper.$in)) return wrapper.$in as bigint[];
      }
      return Array.isArray(raw) ? (raw as bigint[]) : [raw as bigint];
    };
    let next = [...current];
    const addTo =
      (update.$addToSet as Record<string, unknown>)?.[field] ?? (update.$push as Record<string, unknown>)?.[field];
    if (addTo !== undefined) for (const value of valuesOf(addTo)) if (!next.includes(value)) next.push(value);
    const pull = (update.$pull as Record<string, unknown>)?.[field];
    if (pull !== undefined) {
      const removing = valuesOf(pull);
      next = next.filter((value) => !removing.includes(value));
    }
    // Also apply `$pullAll`, which is what the user-side removal uses.
    const pullAll = (update.$pullAll as Record<string, unknown>)?.[field];
    if (pullAll !== undefined) {
      const removing = valuesOf(pullAll);
      next = next.filter((value) => !removing.includes(value));
    }
    // The unsafe path, supported so the test can actually detect it.
    const replacement = update[field] ?? (update.$set as Record<string, unknown>)?.[field];
    if (Array.isArray(replacement)) next = [...(replacement as bigint[])];
    return next;
  };

  /**
   * Meta-test. An always-green concurrency test is worse than no test, so this proves the
   * harness above can actually SEE a lost update: the same interleave, driven by a
   * deliberately naive read-modify-write (the `roles.service.ts:165` shape), must drop one
   * of the two users. If this ever passes with both users present, the real test below has
   * stopped discriminating and both need rewriting.
   */
  it('the harness detects a lost update when the write is read-modify-write', async () => {
    const roleUsers = new Map<string, bigint[]>([[String(ROLE._id), []]]);
    const naiveAssign = async (userId: bigint) => {
      const snapshot = [...(roleUsers.get(String(ROLE._id)) ?? [])];
      await settle(); // both callers read before either writes
      roleUsers.set(String(ROLE._id), applyUpdate(snapshot, { users: [...snapshot, userId] }, 'users'));
    };

    await Promise.all([naiveAssign(USER_A), naiveAssign(USER_B)]);

    expect(roleUsers.get(String(ROLE._id))).toHaveLength(1);
  });

  it('keeps both users when two assignments to the same role interleave', async () => {
    const roleUsers = new Map<string, bigint[]>([[String(ROLE._id), []]]);
    const userRoles = new Map<string, bigint[]>([
      [String(USER_A), []],
      [String(USER_B), []]
    ]);

    // Reads resolve late; writes apply immediately. That is the interleave that turns a
    // read-modify-write into a lost update.
    const lateChain = <T>(produce: () => T) => ({
      populate: function () {
        return this;
      },
      lean: function () {
        return this;
      },
      select: function () {
        return this;
      },
      session: function () {
        return this;
      },
      exec: async () => {
        await settle();
        return produce();
      },
      then: (onFulfilled?: (value: T) => unknown) => settle().then(produce).then(onFulfilled)
    });

    const roleDocs = () => [{ ...ROLE, users: roleUsers.get(String(ROLE._id)) }];
    const roleModel = {
      find: jest.fn(() => lateChain(roleDocs)),
      findOne: jest.fn(() => lateChain(() => roleDocs()[0])),
      countDocuments: jest.fn(() => lateChain(() => 1)),
      updateMany: jest.fn((_filter: unknown, update: Record<string, unknown>) => {
        const key = String(ROLE._id);
        roleUsers.set(key, applyUpdate(roleUsers.get(key) ?? [], update, 'users'));
        return queryChain({ modifiedCount: 1 });
      })
    };

    const buildFor = async (userId: bigint) => {
      const callOrder: string[] = [];
      const service = await buildUsersService();
      service.userModel = {
        findOne: jest.fn(() => lateChain(() => ({ _id: userId, roles: [] }))),
        updateOne: jest.fn((_filter: unknown, update: Record<string, unknown>) => {
          const key = String(userId);
          userRoles.set(key, applyUpdate(userRoles.get(key) ?? [], update, 'roles'));
          return queryChain({ modifiedCount: 1 });
        }),
        startSession: jest.fn().mockResolvedValue(makeSession(callOrder))
      };
      service.roleModel = roleModel;
      service.authService = {
        clearCachedAuthUser: jest.fn().mockResolvedValue(undefined),
        clearCachedAuthUsers: jest.fn().mockResolvedValue(undefined)
      };
      service.auditLogService = {
        createLogFromBuilder: jest.fn().mockResolvedValue(undefined),
        createManyLogsFromBuilder: jest.fn().mockResolvedValue(undefined)
      };
      service.mongooseConnection = { startSession: jest.fn().mockResolvedValue(makeSession(callOrder)) };
      return service;
    };

    const [serviceA, serviceB] = await Promise.all([buildFor(USER_A), buildFor(USER_B)]);
    const admin = makeAdmin();

    await Promise.all([
      serviceA.updateRoles(USER_A, { roleIds: [ROLE._id] }, admin),
      serviceB.updateRoles(USER_B, { roleIds: [ROLE._id] }, admin)
    ]);

    expect([...(roleUsers.get(String(ROLE._id)) ?? [])].sort()).toEqual([USER_A, USER_B].sort());
  });
});
