import { HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { setConfigService } from '../../config-ref';
import { StatusCode, SendgridTemplate, AuditLogType, CloudflareR2Container } from '../../enums';
import { UserDetails } from './entities';
import { buildUsersService, captureHttpError, queryChain } from './users-admin.fixture-spec';

/**
 * W4.3 — GREEN baseline. Everything UsersService already does, pinned before the
 * surgeon adds `create` and `remove` to the same class.
 *
 * Both existing user specs are 18-20 line `toBeDefined()` stubs, so until now nothing
 * guarded these paths. The delete work touches shared plumbing (a new mongoose
 * Connection, five new models, possibly new module imports), and the highest-value
 * thing this file does is fail if that plumbing perturbs the self-service routes.
 *
 * Every assertion here describes behaviour as it exists at master f7a0c70 — including
 * the two oddities called out inline. Do not "fix" them in this slice.
 */

const SELF_ID = BigInt(20);
const OTHER_ID = BigInt(21);

// The R2 URL builders read the ConfigService singleton out of config-ref, which only
// main.ts assigns. Without this the avatar/banner helpers throw on `configService.get`.
beforeAll(() => {
  setConfigService({ get: (key: string) => `https://cdn.test/${key}` } as unknown as ConfigService);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const authUser = (overrides: Record<string, any> = {}) => ({
  _id: SELF_ID,
  isAnonymous: false,
  hasPermission: false,
  owner: false,
  granted: [] as number[],
  roles: [{ _id: BigInt(1), position: 2, permissions: 0 }],
  ...overrides
});

/** A Mongoose document stub: `save()` resolves itself, `toObject()` returns a shallow copy. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const userDoc = (overrides: Record<string, any> = {}) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doc: Record<string, any> = {
    _id: OTHER_ID,
    username: 'target',
    email: 'target@daplex.test',
    nickname: 'Target',
    about: '',
    password: 'hashed:old',
    birthdate: { day: 4, month: 5, year: 1990 },
    roles: [{ _id: BigInt(2), position: 5, permissions: 0 }],
    verified: true,
    banned: false,
    owner: false,
    settings: {
      player: { volume: 50 },
      subtitle: {},
      history: {},
      playlist: {},
      historyList: {},
      playlistList: {},
      ratingList: {}
    },
    ...overrides
  };
  doc.save = jest.fn(async () => doc);
  doc.toObject = jest.fn(() => ({ ...doc }));
  return doc;
};

describe('UsersService — existing behaviour (characterization, must stay green)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let service: any;
  let userModel: { findOne: jest.Mock; findOneAndUpdate: jest.Mock; aggregate: jest.Mock; startSession: jest.Mock };
  let authService: {
    hashPassword: jest.Mock;
    comparePassword: jest.Mock;
    clearCachedAuthUser: jest.Mock;
    findByUsername: jest.Mock;
    findByEmail: jest.Mock;
  };
  let auditLogService: { createLogFromBuilder: jest.Mock };
  let httpEmailService: { sendEmailSendGrid: jest.Mock };
  let cloudflareR2Service: { delete: jest.Mock; upload: jest.Mock };
  let session: { withTransaction: jest.Mock; endSession: jest.Mock };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wire = async (doc: any) => {
    session = {
      withTransaction: jest.fn(async (cb: () => Promise<void>) => {
        await cb();
      }),
      endSession: jest.fn().mockResolvedValue(undefined)
    };
    userModel = {
      findOne: jest.fn(() => queryChain(doc)),
      findOneAndUpdate: jest.fn(() => queryChain(doc)),
      aggregate: jest.fn(() => queryChain([])),
      startSession: jest.fn().mockResolvedValue(session)
    };
    authService = {
      hashPassword: jest.fn(async (password: string) => `hashed:${password}`),
      comparePassword: jest.fn().mockResolvedValue(true),
      clearCachedAuthUser: jest.fn().mockResolvedValue(undefined),
      findByUsername: jest.fn().mockResolvedValue(null),
      findByEmail: jest.fn().mockResolvedValue(null)
    };
    auditLogService = { createLogFromBuilder: jest.fn().mockResolvedValue(undefined) };
    httpEmailService = { sendEmailSendGrid: jest.fn().mockResolvedValue(undefined) };
    cloudflareR2Service = {
      delete: jest.fn().mockResolvedValue(undefined),
      upload: jest.fn().mockResolvedValue(undefined)
    };

    service = await buildUsersService();
    service.userModel = userModel;
    service.authService = authService;
    service.auditLogService = auditLogService;
    service.httpEmailService = httpEmailService;
    service.cloudflareR2Service = cloudflareR2Service;
    service.configService = {
      get: jest.fn((key: string) => (key === 'WEBSITE_URL' ? 'https://daplex.test' : undefined))
    };
    return service;
  };

  beforeEach(async () => {
    await wire(userDoc());
  });

  // ---------------------------------------------------------------------------
  describe('findAll', () => {
    it('returns an empty Paginated when the aggregation yields nothing', async () => {
      const result = await service.findAll({ page: 1, limit: 30 });

      expect(userModel.aggregate).toHaveBeenCalledTimes(1);
      expect(result.results).toEqual([]);
      expect(result.totalResults).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  describe('findOne', () => {
    it('projects email, birthdate and verified for the account owner', async () => {
      await service.findOne(SELF_ID, authUser());

      const projection = userModel.findOne.mock.calls[0][1];
      expect(projection.email).toBe(1);
      expect(projection.birthdate).toBe(1);
      expect(projection.verified).toBe(1);
    });

    it('projects email, birthdate and verified for a permissioned caller', async () => {
      await service.findOne(OTHER_ID, authUser({ hasPermission: true }));

      expect(userModel.findOne.mock.calls[0][1].email).toBe(1);
    });

    it('withholds email, birthdate and verified from everyone else', async () => {
      await service.findOne(OTHER_ID, authUser());

      const projection = userModel.findOne.mock.calls[0][1];
      expect(projection.email).toBeUndefined();
      expect(projection.birthdate).toBeUndefined();
      expect(projection.verified).toBeUndefined();
    });

    it('withholds them from anonymous callers even when hasPermission is set', async () => {
      await service.findOne(SELF_ID, authUser({ isAnonymous: true, hasPermission: true }));

      expect(userModel.findOne.mock.calls[0][1].email).toBeUndefined();
    });

    it('returns a UserDetails instance', async () => {
      await expect(service.findOne(OTHER_ID, authUser())).resolves.toBeInstanceOf(UserDetails);
    });

    it('404s USER_NOT_FOUND for a missing user', async () => {
      await wire(null);

      await expect(captureHttpError(() => service.findOne(OTHER_ID, authUser()))).resolves.toEqual({
        status: HttpStatus.NOT_FOUND,
        code: StatusCode.USER_NOT_FOUND
      });
    });
  });

  // ---------------------------------------------------------------------------
  describe('update', () => {
    it('403s ACCESS_DENIED when editing another user without the permission', async () => {
      await expect(captureHttpError(() => service.update(OTHER_ID, { nickname: 'x' }, authUser()))).resolves.toEqual({
        status: HttpStatus.FORBIDDEN,
        code: StatusCode.ACCESS_DENIED
      });
    });

    it('400s EMPTY_BODY for an empty patch', async () => {
      await expect(captureHttpError(() => service.update(SELF_ID, {}, authUser()))).resolves.toEqual({
        status: HttpStatus.BAD_REQUEST,
        code: StatusCode.EMPTY_BODY
      });
    });

    it('404s USER_NOT_FOUND for a missing user', async () => {
      await wire(null);

      await expect(captureHttpError(() => service.update(SELF_ID, { nickname: 'x' }, authUser()))).resolves.toEqual({
        status: HttpStatus.NOT_FOUND,
        code: StatusCode.USER_NOT_FOUND
      });
    });

    it('clears the cached auth user on every successful update', async () => {
      await service.update(SELF_ID, { nickname: 'Renamed' }, authUser());

      expect(authService.clearCachedAuthUser).toHaveBeenCalledWith(SELF_ID);
    });

    it('strips avatar and banner from the returned payload', async () => {
      const result = await service.update(SELF_ID, { nickname: 'Renamed' }, authUser());

      expect(result).toBeInstanceOf(UserDetails);
      expect(result.avatar).toBeUndefined();
      expect(result.banner).toBeUndefined();
    });

    describe('password', () => {
      it('403s PASSWORD_UPDATE_RESTRICTED when someone else tries to set it', async () => {
        await expect(
          captureHttpError(() =>
            service.update(
              OTHER_ID,
              { password: 'NewPass1', currentPassword: 'OldPass1' },
              authUser({ hasPermission: true })
            )
          )
        ).resolves.toEqual({ status: HttpStatus.FORBIDDEN, code: StatusCode.PASSWORD_UPDATE_RESTRICTED });
      });

      it('400s REQUIRE_PASSWORD when the owner omits the current password', async () => {
        await expect(
          captureHttpError(() => service.update(SELF_ID, { password: 'NewPass1' }, authUser()))
        ).resolves.toEqual({
          status: HttpStatus.BAD_REQUEST,
          code: StatusCode.REQUIRE_PASSWORD
        });
      });

      it('400s INCORRECT_PASSWORD when the current password does not match', async () => {
        authService.comparePassword.mockResolvedValue(false);

        await expect(
          captureHttpError(() =>
            service.update(SELF_ID, { password: 'NewPass1', currentPassword: 'wrong' }, authUser())
          )
        ).resolves.toEqual({ status: HttpStatus.BAD_REQUEST, code: StatusCode.INCORRECT_PASSWORD });
      });

      it('hashes the new password before saving', async () => {
        const doc = userDoc({ _id: SELF_ID });
        await wire(doc);

        await service.update(SELF_ID, { password: 'NewPass1', currentPassword: 'OldPass1' }, authUser());

        expect(authService.hashPassword).toHaveBeenCalledWith('NewPass1');
        expect(doc.password).toBe('hashed:NewPass1');
      });
    });

    describe('ban', () => {
      it('403s BAN_USER_RESTRICTED on self-ban', async () => {
        const doc = userDoc({ _id: SELF_ID });
        await wire(doc);

        await expect(
          captureHttpError(() => service.update(SELF_ID, { banned: true }, authUser({ hasPermission: true })))
        ).resolves.toEqual({ status: HttpStatus.FORBIDDEN, code: StatusCode.BAN_USER_RESTRICTED });
      });

      it('403s BAN_USER_RESTRICTED when the target ties or outranks the caller', async () => {
        await wire(userDoc({ roles: [{ _id: BigInt(2), position: 2, permissions: 0 }] }));

        await expect(
          captureHttpError(() => service.update(OTHER_ID, { banned: true }, authUser({ hasPermission: true })))
        ).resolves.toEqual({ status: HttpStatus.FORBIDDEN, code: StatusCode.BAN_USER_RESTRICTED });
      });

      it('bans a lower-ranked target and records the change in the audit log', async () => {
        const doc = userDoc();
        await wire(doc);

        await service.update(OTHER_ID, { banned: true }, authUser({ hasPermission: true }));

        expect(doc.banned).toBe(true);
        const builder = auditLogService.createLogFromBuilder.mock.calls[0][0];
        expect(builder.type).toBe(AuditLogType.USER_UPDATE);
        expect(builder.target).toBe(OTHER_ID);
        expect(builder.changes).toContainEqual({ key: 'banned', newValue: true, oldValue: false });
      });

      it('allows a roleless target to be banned by anyone with the permission', async () => {
        const doc = userDoc({ roles: [] });
        await wire(doc);

        await service.update(
          OTHER_ID,
          { banned: true },
          authUser({ hasPermission: true, roles: [{ _id: BigInt(1), position: 9, permissions: 0 }] })
        );

        expect(doc.banned).toBe(true);
      });
    });

    describe('restoreAccount', () => {
      it('403s RESTORE_ACCOUNT_RESTRICTED without the permission', async () => {
        const doc = userDoc({ _id: SELF_ID });
        await wire(doc);

        await expect(
          captureHttpError(() => service.update(SELF_ID, { restoreAccount: true }, authUser()))
        ).resolves.toEqual({
          status: HttpStatus.FORBIDDEN,
          code: StatusCode.RESTORE_ACCOUNT_RESTRICTED
        });
      });

      it('rerolls the password, stores a recovery code and emails the restore template', async () => {
        const doc = userDoc();
        await wire(doc);

        await service.update(OTHER_ID, { restoreAccount: true }, authUser({ hasPermission: true }));

        expect(doc.password).not.toBe('hashed:old');
        expect(typeof doc.recoveryCode).toBe('string');
        const [email, , , templateId, params] = httpEmailService.sendEmailSendGrid.mock.calls[0];
        expect(email).toBe(doc.email);
        expect(templateId).toBe(SendgridTemplate.ACCOUNT_MANAGE_RESTORED);
        expect(String(params.button_url)).toContain(`code=${doc.recoveryCode}`);
      });

      it('builds a reset-password link with NO id param — the W4.3 invite must not copy this', async () => {
        // users.service.ts:173. AuthService.resetPassword queries { _id: dto.id, recoveryCode },
        // so this link is unusable without the FE supplying `id` from somewhere else.
        // Pinned as a known defect so the invite flow is written against the
        // confirm-email shape (`?id=...&code=...`) instead of copying this line.
        const doc = userDoc();
        await wire(doc);

        await service.update(OTHER_ID, { restoreAccount: true }, authUser({ hasPermission: true }));

        const url = String(httpEmailService.sendEmailSendGrid.mock.calls[0][4].button_url);
        expect(url).not.toContain('id=');
      });
    });

    describe('username and email changes', () => {
      it('400s EMAIL_EXIST when the new username is taken (existing mislabel — code 101, not 100)', async () => {
        // users.service.ts:137 returns EMAIL_EXIST for a duplicate USERNAME. Wrong,
        // but it is the shipped contract; POST /users must not inherit the mistake.
        authService.findByUsername.mockResolvedValue({ _id: BigInt(99) });
        const doc = userDoc({ _id: SELF_ID });
        await wire(doc);
        authService.findByUsername.mockResolvedValue({ _id: BigInt(99) });

        await expect(
          captureHttpError(() =>
            service.update(SELF_ID, { username: 'taken', currentPassword: 'OldPass1' }, authUser())
          )
        ).resolves.toEqual({ status: HttpStatus.BAD_REQUEST, code: StatusCode.EMAIL_EXIST });
      });

      it('400s REQUIRE_PASSWORD when the owner changes their own email without confirming', async () => {
        const doc = userDoc({ _id: SELF_ID });
        await wire(doc);

        await expect(
          captureHttpError(() => service.update(SELF_ID, { email: 'new@daplex.test' }, authUser()))
        ).resolves.toEqual({ status: HttpStatus.BAD_REQUEST, code: StatusCode.REQUIRE_PASSWORD });
      });

      it('unverifies the account and issues a new activation code on an email change', async () => {
        const doc = userDoc();
        await wire(doc);

        await service.update(OTHER_ID, { email: 'new@daplex.test' }, authUser({ hasPermission: true }));

        expect(doc.verified).toBe(false);
        expect(typeof doc.activationCode).toBe('string');
        expect(httpEmailService.sendEmailSendGrid).toHaveBeenCalledWith(
          'new@daplex.test',
          doc.username,
          'Confirm your new email',
          SendgridTemplate.UPDATE_EMAIL,
          expect.objectContaining({ button_url: expect.stringContaining(`id=${OTHER_ID}`) })
        );
      });
    });
  });

  // ---------------------------------------------------------------------------
  describe('updateSettings', () => {
    it('403s ACCESS_DENIED for another user without the permission', async () => {
      await expect(
        captureHttpError(() => service.updateSettings(OTHER_ID, { player: { volume: 10 } }, authUser()))
      ).resolves.toEqual({ status: HttpStatus.FORBIDDEN, code: StatusCode.ACCESS_DENIED });
    });

    it('400s EMPTY_BODY for an empty patch', async () => {
      await expect(captureHttpError(() => service.updateSettings(SELF_ID, {}, authUser()))).resolves.toEqual({
        status: HttpStatus.BAD_REQUEST,
        code: StatusCode.EMPTY_BODY
      });
    });

    it('404s USER_NOT_FOUND for a missing user', async () => {
      await wire(null);

      await expect(
        captureHttpError(() => service.updateSettings(SELF_ID, { player: { volume: 10 } }, authUser()))
      ).resolves.toEqual({ status: HttpStatus.NOT_FOUND, code: StatusCode.USER_NOT_FOUND });
    });

    it('applies the patch and returns the settings sub-document', async () => {
      const doc = userDoc({ _id: SELF_ID });
      await wire(doc);

      const result = await service.updateSettings(SELF_ID, { player: { volume: 10 } }, authUser());

      expect(doc.settings.player.volume).toBe(10);
      expect(doc.save).toHaveBeenCalled();
      expect(result).toBe(doc.settings);
    });
  });

  // ---------------------------------------------------------------------------
  describe('avatar and banner', () => {
    it('findOneAvatar returns undefined when the user has no avatar', async () => {
      await wire(userDoc({ avatar: undefined }));

      await expect(service.findOneAvatar(OTHER_ID)).resolves.toBeUndefined();
    });

    it('findOneAvatar builds the four R2 urls plus colour and placeholder', async () => {
      await wire(userDoc({ avatar: { _id: BigInt(71), name: 'a.png', color: 3, placeholder: 'ph' } }));

      const avatar = await service.findOneAvatar(OTHER_ID);

      // The three sized urls go through the image proxy, so the object key is
      // percent-encoded inside a `url=` query param; only fullAvatarUrl is direct.
      expect(decodeURIComponent(avatar.avatarUrl)).toContain('71/a.png');
      expect(decodeURIComponent(avatar.thumbnailAvatarUrl)).toContain('71/a.png');
      expect(decodeURIComponent(avatar.smallAvatarUrl)).toContain('71/a.png');
      expect(avatar.fullAvatarUrl).toContain('71/a.png');
      expect(avatar.avatarColor).toBe(3);
      expect(avatar.avatarPlaceholder).toBe('ph');
    });

    it('updateAvatar 403s for anyone but the account owner — MANAGE_USERS does not help', async () => {
      await expect(
        captureHttpError(() => service.updateAvatar(OTHER_ID, { filename: 'a.png' }, authUser({ hasPermission: true })))
      ).resolves.toEqual({ status: HttpStatus.FORBIDDEN, code: StatusCode.ACCESS_DENIED });
    });

    it('deleteAvatar 403s for anyone but the account owner', async () => {
      await expect(
        captureHttpError(() => service.deleteAvatar(OTHER_ID, authUser({ hasPermission: true })))
      ).resolves.toEqual({
        status: HttpStatus.FORBIDDEN,
        code: StatusCode.ACCESS_DENIED
      });
    });

    it('deleteAvatar 404s AVATAR_NOT_FOUND inside its transaction when there is nothing to delete', async () => {
      await wire(userDoc({ _id: SELF_ID, avatar: undefined }));

      await expect(captureHttpError(() => service.deleteAvatar(SELF_ID, authUser()))).resolves.toEqual({
        status: HttpStatus.NOT_FOUND,
        code: StatusCode.AVATAR_NOT_FOUND
      });
      expect(session.endSession).toHaveBeenCalled();
    });

    it('deleteAvatar unsets the field and removes the R2 object', async () => {
      await wire(userDoc({ _id: SELF_ID, avatar: { _id: BigInt(71), name: 'a.png' } }));

      await service.deleteAvatar(SELF_ID, authUser());

      expect(userModel.findOneAndUpdate).toHaveBeenCalledWith({ _id: SELF_ID }, { $unset: { avatar: 1 } });
      expect(cloudflareR2Service.delete).toHaveBeenCalledWith(CloudflareR2Container.AVATARS, '71/a.png');
    });

    it('deleteBanner 404s BANNER_NOT_FOUND when there is nothing to delete', async () => {
      await wire(userDoc({ _id: SELF_ID, banner: undefined }));

      await expect(captureHttpError(() => service.deleteBanner(SELF_ID, authUser()))).resolves.toEqual({
        status: HttpStatus.NOT_FOUND,
        code: StatusCode.BANNER_NOT_FOUND
      });
    });

    it('deleteBanner unsets the field and removes the R2 object', async () => {
      await wire(userDoc({ _id: SELF_ID, banner: { _id: BigInt(72), name: 'b.png' } }));

      await service.deleteBanner(SELF_ID, authUser());

      expect(cloudflareR2Service.delete).toHaveBeenCalledWith(CloudflareR2Container.BANNERS, '72/b.png');
    });
  });

  // ---------------------------------------------------------------------------
  describe('role membership helpers (called by RolesService)', () => {
    it('deleteRoleUsers pulls the role from each listed user, inside the caller session', () => {
      const updateMany = jest.fn(() => queryChain({ modifiedCount: 2 }));
      service.userModel = { updateMany };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const callerSession = { id: 'session' } as any;

      service.deleteRoleUsers(BigInt(5), [BigInt(1), BigInt(2)], callerSession);

      expect(updateMany).toHaveBeenCalledWith(
        { _id: { $in: [BigInt(1), BigInt(2)] } },
        { $pull: { roles: BigInt(5) } }
      );
      expect(updateMany.mock.results[0].value.session).toHaveBeenCalledWith(callerSession);
    });

    it('deleteRoleUsers is a no-op for an empty user list', () => {
      const updateMany = jest.fn(() => queryChain({}));
      service.userModel = { updateMany };

      service.deleteRoleUsers(BigInt(5), [], undefined);

      expect(updateMany).not.toHaveBeenCalled();
    });
  });
});
