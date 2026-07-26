import { Test, TestingModule } from '@nestjs/testing';
import { instanceToPlain } from 'class-transformer';

import { AuthService } from '../auth/auth.service';
import { UserDetails } from './entities';
import { buildUsersService, queryChain } from './users-admin.fixture-spec';

/**
 * W4.3 — `UsersService.create` (admin invite-style account creation).
 *
 * RED until implemented, EXCEPT the final `reused creation path` block, which
 * characterizes today's `AuthService.createUser` and must stay green.
 *
 * Locked decisions this spec encodes:
 *  - invite, not admin-chosen password: the service generates the password, persists
 *    it hashed, and emails a set-password link. The admin never learns the credential.
 *  - the link uses the confirm-email URL SHAPE (`?id=<userId>&code=<code>`); the
 *    existing restoreAccount link (users.service.ts:173) omits `id`, which
 *    `AuthService.resetPassword` requires in its query — reusing it verbatim ships a
 *    dead link.
 *  - creation must not be a privilege-escalation primitive: roles/owner/banned/verified
 *    are never taken from the request body.
 */

// AuditLogType.USER_CREATE — appended by the surgeon. Referenced numerically so the
// spec type-checks before the enum member exists; users.admin-crud.codes.spec.ts
// separately asserts the member is added with this exact value.
const AUDIT_USER_CREATE = 6001;

const ADMIN = {
  _id: BigInt(10),
  hasPermission: true,
  owner: false,
  granted: [] as number[],
  roles: [] as unknown[],
  isAnonymous: false
};
const NEW_USER_ID = BigInt(990);

const DTO = {
  username: 'invitee',
  nickname: 'Invitee',
  email: 'invitee@daplex.test',
  birthdate: { day: 2, month: 3, year: 1995 }
};

/** JSON.stringify blows up on the bigint `_id`s these payloads carry. */
const stringifySafe = (value: unknown) => JSON.stringify(value, (_key, val) => (typeof val === 'bigint' ? val.toString() : val));

/** Recursively hunts a key in a set of recorded call arguments (order-insensitive). */
const findValueByKey = (source: unknown, key: string): unknown => {
  if (!source || typeof source !== 'object') return undefined;
  const record = source as Record<string, unknown>;
  if (record[key] !== undefined) return record[key];
  for (const value of Object.values(record)) {
    const found = findValueByKey(value, key);
    if (found !== undefined) return found;
  }
  return undefined;
};

describe('UsersService.create — admin invite (RED until W4.3 lands)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let service: any;
  let authService: { createUser: jest.Mock; clearCachedAuthUser: jest.Mock };
  let userModel: { updateOne: jest.Mock; findOneAndUpdate: jest.Mock };
  let auditLogService: { createLog: jest.Mock; createLogFromBuilder: jest.Mock };
  let httpEmailService: { sendEmailSendGrid: jest.Mock };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let createdUser: any;

  beforeEach(async () => {
    createdUser = {
      _id: NEW_USER_ID,
      username: DTO.username,
      nickname: DTO.nickname,
      email: DTO.email,
      birthdate: DTO.birthdate,
      verified: false,
      banned: false,
      roles: [],
      activationCode: 'act12345',
      password: 'hashed:will-be-overwritten'
    };

    authService = {
      // Mirrors the real createUser: hashes whatever password it is handed and
      // returns the persisted lean document.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createUser: jest.fn(async (dto: any) => ({ ...createdUser, password: `hashed:${dto.password}` })),
      clearCachedAuthUser: jest.fn().mockResolvedValue(undefined)
    };
    userModel = {
      updateOne: jest.fn(() => queryChain({ modifiedCount: 1 })),
      findOneAndUpdate: jest.fn(() => queryChain(createdUser))
    };
    auditLogService = {
      createLog: jest.fn().mockResolvedValue(undefined),
      createLogFromBuilder: jest.fn().mockResolvedValue(undefined)
    };
    httpEmailService = { sendEmailSendGrid: jest.fn().mockResolvedValue(undefined) };

    service = await buildUsersService();
    service.authService = authService;
    service.userModel = userModel;
    service.auditLogService = auditLogService;
    service.httpEmailService = httpEmailService;
    service.configService = {
      get: jest.fn((key: string) => (key === 'WEBSITE_URL' ? 'https://daplex.test' : undefined))
    };
  });

  /** The single sendGrid call the invite makes. */
  const inviteEmail = () => {
    expect(httpEmailService.sendEmailSendGrid).toHaveBeenCalled();
    const [email, name, subject, templateId, params] = httpEmailService.sendEmailSendGrid.mock.calls[0];
    return { email, name, subject, templateId, params: params as Record<string, unknown> };
  };

  /** The password the service handed to the reused creation path. */
  const generatedPassword = () => authService.createUser.mock.calls[0][0].password as string;

  /**
   * The recovery code the service persisted, wherever it chose to persist it:
   * passed into createUser, or written back with updateOne/findOneAndUpdate.
   */
  const persistedRecoveryCode = () => {
    const sources: unknown[] = [
      ...authService.createUser.mock.calls,
      ...userModel.updateOne.mock.calls,
      ...userModel.findOneAndUpdate.mock.calls
    ];
    for (const source of sources) {
      const found = findValueByKey(source, 'recoveryCode');
      if (found !== undefined) return found as string;
    }
    return undefined;
  };

  it('is implemented as UsersService.create(createUserDto, authUser)', () => {
    expect(typeof service.create).toBe('function');
  });

  describe('reuses the existing creation path', () => {
    it('delegates account persistence to authService.createUser exactly once', async () => {
      await service.create({ ...DTO }, ADMIN);

      expect(authService.createUser).toHaveBeenCalledTimes(1);
      expect(authService.createUser.mock.calls[0][0]).toMatchObject({
        username: DTO.username,
        email: DTO.email,
        birthdate: DTO.birthdate
      });
    });

    it('never hashes or persists the password itself (no duplicated bcrypt/snowflake logic)', async () => {
      await service.create({ ...DTO }, ADMIN);

      // A hand-rolled creation path would have to write the user document directly.
      expect(userModel.updateOne.mock.calls.every((call) => findValueByKey(call, 'password') === undefined)).toBe(true);
      expect(
        userModel.findOneAndUpdate.mock.calls.every((call) => findValueByKey(call, 'password') === undefined)
      ).toBe(true);
    });
  });

  describe('password handling', () => {
    it('generates a password when the admin supplies none', async () => {
      await service.create({ ...DTO }, ADMIN);

      const password = generatedPassword();
      expect(typeof password).toBe('string');
      expect(password.length).toBeGreaterThan(0);
      expect(password).not.toBe(DTO.username);
      expect(password).not.toBe(DTO.email);
    });

    it('never echoes the generated password in the response', async () => {
      const result = await service.create({ ...DTO }, ADMIN);

      expect(stringifySafe(instanceToPlain(result))).not.toContain(generatedPassword());
    });

    it('never emails the generated password', async () => {
      await service.create({ ...DTO }, ADMIN);

      // Invite security posture: the credential exists only as a bcrypt hash. The
      // recipient sets their own password through the link.
      expect(stringifySafe(inviteEmail())).not.toContain(generatedPassword());
    });
  });

  describe('invite email', () => {
    it('is sent to the created account', async () => {
      await service.create({ ...DTO }, ADMIN);

      expect(inviteEmail().email).toBe(DTO.email);
      expect(httpEmailService.sendEmailSendGrid).toHaveBeenCalledTimes(1);
    });

    it('carries a set-password link with BOTH id and code', async () => {
      await service.create({ ...DTO }, ADMIN);

      const buttonUrl = String(inviteEmail().params.button_url);
      // AuthService.resetPassword queries { _id: dto.id, recoveryCode } — a link
      // without `id` (the users.service.ts:173 shape) can never resolve.
      expect(buttonUrl).toContain(`id=${NEW_USER_ID}`);
      expect(buttonUrl).toContain(`code=${persistedRecoveryCode()}`);
      expect(buttonUrl).toContain('https://daplex.test');
    });

    it('persists the recovery code that the link carries', async () => {
      await service.create({ ...DTO }, ADMIN);

      const code = persistedRecoveryCode();
      expect(typeof code).toBe('string');
      expect((code as string).length).toBeGreaterThan(0);
    });
  });

  describe('privilege escalation guard', () => {
    it('never forwards roles, owner, banned or verified from the request body', async () => {
      // ValidationPipe whitelist:true strips unknown props in production, but only
      // because these fields are genuinely absent from CreateUserDto. This asserts the
      // service does not re-introduce them from a caller-supplied object.
      const hostileDto = { ...DTO, roles: [BigInt(1)], owner: true, banned: false, verified: true };

      await service.create(hostileDto, ADMIN);

      const forwarded = authService.createUser.mock.calls[0][0] as Record<string, unknown>;
      expect(forwarded.roles).toBeUndefined();
      expect(forwarded.owner).toBeUndefined();
      expect(forwarded.banned).toBeUndefined();
      expect(forwarded.verified).toBeUndefined();
    });

    it('ignores an admin-supplied password even if one reaches the service', async () => {
      // CreateUserDto no longer declares password/confirmPassword, so whitelist:true
      // strips them at the pipe. This is the defence in depth: if one ever arrives —
      // a direct service call, a future DTO edit — the invite credential must still be
      // the generated one, so the admin cannot choose another person's password.
      await service.create({ ...DTO, password: 'AdminChosen1', confirmPassword: 'AdminChosen1' }, ADMIN);

      expect(generatedPassword()).not.toBe('AdminChosen1');
      const forwarded = authService.createUser.mock.calls[0][0] as Record<string, unknown>;
      expect(forwarded.confirmPassword).toBeUndefined();
    });

    it('leaves the account unverified, matching self sign-up', async () => {
      const result = await service.create({ ...DTO }, ADMIN);

      expect(instanceToPlain(result).verified).toBe(false);
    });
  });

  describe('audit log', () => {
    const auditEntry = () => {
      if (auditLogService.createLog.mock.calls.length) {
        const [user, target, targetRef, type] = auditLogService.createLog.mock.calls[0];
        return { user, target, targetRef, type, changes: [] as unknown[] };
      }
      const builder = auditLogService.createLogFromBuilder.mock.calls[0]?.[0];
      return builder as { user: bigint; target: bigint; targetRef: string; type: number; changes: unknown[] };
    };

    it('records a USER_CREATE entry against the created account', async () => {
      await service.create({ ...DTO }, ADMIN);

      const entry = auditEntry();
      expect(entry).toBeDefined();
      expect(entry.type).toBe(AUDIT_USER_CREATE);
      expect(entry.user).toBe(ADMIN._id);
      expect(entry.target).toBe(NEW_USER_ID);
      expect(entry.targetRef).toBe('User');
    });

    it('records no PII in the change list', async () => {
      await service.create({ ...DTO }, ADMIN);

      // AuditLogBuilder.appendChange stores old/new values verbatim; email, password,
      // recoveryCode and activationCode must never land there.
      const serialized = stringifySafe(auditEntry().changes ?? []);
      expect(serialized).not.toContain(DTO.email);
      expect(serialized).not.toContain(generatedPassword());
      expect(serialized).not.toContain(String(persistedRecoveryCode()));
      expect(serialized).not.toContain(createdUser.activationCode);
    });
  });

  describe('response shape', () => {
    it('returns a UserDetails instance', async () => {
      const result = await service.create({ ...DTO }, ADMIN);

      expect(result).toBeInstanceOf(UserDetails);
    });

    it('excludes password, activationCode and recoveryCode when serialized', async () => {
      const result = await service.create({ ...DTO }, ADMIN);
      const plain = instanceToPlain(result);

      expect(plain.password).toBeUndefined();
      expect(plain.activationCode).toBeUndefined();
      expect(plain.recoveryCode).toBeUndefined();
      expect(plain.username).toBe(DTO.username);
      expect(plain.email).toBe(DTO.email);
    });
  });
});

/**
 * GREEN characterization of the path W4.3 reuses. If `AuthService.createUser` ever
 * stops hashing, the invite flow starts persisting plaintext — this is the assertion
 * that catches it, and it is deliberately independent of the RED block above.
 * `bcrypt` is mapped to test/mocks/bcrypt.js, which hashes as `hashed:<input>`.
 */
describe('AuthService.createUser — reused creation path (characterization, green today)', () => {
  it('persists a hashed password, a snowflake id and an activation code', async () => {
    const module: TestingModule = await Test.createTestingModule({ providers: [AuthService] })
      .useMocker(() => ({}))
      .compile();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const authService = module.get<AuthService>(AuthService) as any;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const saved: any[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function FakeUserModel(this: any, doc: any) {
      Object.assign(this, doc);
      this.save = jest.fn(async () => this);
      this.toObject = () => ({ ...this });
      saved.push(this);
    }
    authService.userModel = FakeUserModel;
    authService.httpEmailService = { sendEmailSendGrid: jest.fn().mockResolvedValue(undefined) };
    authService.configService = { get: jest.fn(() => 'https://daplex.test') };

    const result = await authService.createUser({
      username: 'invitee',
      email: 'invitee@daplex.test',
      password: 'PlainPass1',
      birthdate: DTO.birthdate
    });

    expect(saved).toHaveLength(1);
    expect(saved[0].password).toBe('hashed:PlainPass1');
    expect(saved[0].password).not.toBe('PlainPass1');
    expect(typeof saved[0]._id).toBe('bigint');
    expect(typeof saved[0].activationCode).toBe('string');
    expect(result.password).toBe('hashed:PlainPass1');
  });
});
