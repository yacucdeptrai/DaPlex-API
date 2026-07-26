import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';

import { CreateUserDto } from './create-user.dto';
import { UsernameExistConstraint } from '../../../decorators/username-exist.decorator';
import { EmailExistConstraint } from '../../../decorators/email-exist.decorator';
import { StatusCode } from '../../../enums';

/**
 * W4.3 — `CreateUserDto` becomes live input for POST /users. It exists today but is
 * referenced NOWHERE, so nothing has ever exercised it.
 *
 * IT IS CURRENTLY A SIGN-UP DTO, and that shape contradicts the locked invite decision.
 * `password` + `confirmPassword` + `@PropertyMatches` only make sense when the person
 * filling the form owns the account. On an admin-create route they hand the admin a way
 * to set — and therefore know — someone else's credential. The tests below repurpose the
 * class into a genuine admin-create shape: identity fields only, no password fields at
 * all, so "the admin never learns the password" is enforced by the type, not by
 * convention. Removing them also retires `@PropertyMatches`, `@ValidateIf`, `Matches`
 * and the `RegexPattern` import from this file.
 *
 * These run the REAL class-validator pipeline (not a decorator-metadata read). The two
 * async constraints that need AuthService are stubbed at the prototype, so the default
 * class-validator container can still construct them.
 *
 * In production those two resolve through `useContainer(app.select(AppModule),
 * { fallbackOnErrors: true })` (main.ts:85) — and `fallbackOnErrors` silently builds a
 * bare instance with `authService === undefined` on a resolution miss, which surfaces
 * as a 500 rather than a clear error. No unit test can prove that wiring; the live
 * duplicate-username "400 not 500" check stays on the QA list.
 */

const TAKEN_USERNAME = 'takenuser';
const TAKEN_EMAIL = 'taken@daplex.test';

const VALID = {
  username: 'freshuser',
  nickname: 'Fresh',
  email: 'fresh@daplex.test',
  birthdate: { day: 2, month: 3, year: 1995 }
};

const run = (payload: Record<string, unknown>) => validate(plainToInstance(CreateUserDto, payload));

const errorFor = (errors: ValidationError[], property: string) => errors.find((e) => e.property === property);

/** The StatusCode carried in a failed constraint's `context` — what the API returns as `code`. */
const codeOf = (error?: ValidationError) => Object.values<{ code?: number }>(error?.contexts ?? {})[0]?.code;

beforeAll(() => {
  jest
    .spyOn(UsernameExistConstraint.prototype, 'validate')
    .mockImplementation(async (value: unknown) => String(value) !== TAKEN_USERNAME);
  jest
    .spyOn(EmailExistConstraint.prototype, 'validate')
    .mockImplementation(async (value: unknown) => String(value) !== TAKEN_EMAIL);
});

describe('CreateUserDto — defects to fix before POST /users goes live (RED)', () => {
  it('does not run the username-uniqueness check against nickname', async () => {
    // create-user.dto.ts:37 applies @UsernameExist to `nickname`. Nicknames are not
    // unique (user.schema.ts has no unique index on nickname), so this rejects a
    // perfectly legal display name that happens to match somebody's login.
    const errors = await run({ ...VALID, nickname: TAKEN_USERNAME });

    expect(errorFor(errors, 'nickname')).toBeUndefined();
  });

  it('rejects an empty body', async () => {
    // Every field is @IsOptional() today, so `{}` validates clean and the service
    // would be handed a user with no username and no email.
    const errors = await run({});

    expect(errors.map((e) => e.property).sort()).toEqual(expect.arrayContaining(['email', 'username']));
  });

  it('declares no password fields at all', async () => {
    // The locked decision is invite-style: the service generates the credential and
    // emails a set-password link. If `password`/`confirmPassword` stay on the class,
    // an admin can set another person's password from the create form — the exact
    // thing the invite flow exists to prevent. whitelist:true only strips what the
    // class does not declare, so removing them from the DTO IS the enforcement.
    const errors = await validate(
      plainToInstance(CreateUserDto, { ...VALID, password: 'ValidPass1', confirmPassword: 'ValidPass1' }),
      { whitelist: true, forbidNonWhitelisted: true }
    );

    expect(errors.map((e) => e.property).sort()).toEqual(['confirmPassword', 'password']);
  });
});

describe('CreateUserDto — behaviour that must survive the fix (green)', () => {
  it('accepts a minimal invite payload with no password', async () => {
    // Invite flow: the admin supplies no credential at all.
    const errors = await run({ username: VALID.username, email: VALID.email, birthdate: VALID.birthdate });

    expect(errors).toEqual([]);
  });

  it('accepts a full identity payload', async () => {
    const errors = await run({ ...VALID });

    expect(errors).toEqual([]);
  });

  it('treats nickname as optional', async () => {
    const errors = await run({ username: VALID.username, email: VALID.email, birthdate: VALID.birthdate });

    expect(errorFor(errors, 'nickname')).toBeUndefined();
  });

  it('rejects a duplicate username with USERNAME_EXIST', async () => {
    const errors = await run({ ...VALID, username: TAKEN_USERNAME });

    expect(codeOf(errorFor(errors, 'username'))).toBe(StatusCode.USERNAME_EXIST);
  });

  it('rejects a duplicate email with EMAIL_EXIST', async () => {
    const errors = await run({ ...VALID, email: TAKEN_EMAIL });

    expect(codeOf(errorFor(errors, 'email'))).toBe(StatusCode.EMAIL_EXIST);
  });

  it('rejects a too-short username with LENGTH', async () => {
    const errors = await run({ ...VALID, username: 'ab' });

    expect(codeOf(errorFor(errors, 'username'))).toBe(StatusCode.LENGTH);
  });

  it('rejects a malformed email with IS_EMAIL', async () => {
    const errors = await run({ ...VALID, email: 'not-an-email' });

    expect(codeOf(errorFor(errors, 'email'))).toBe(StatusCode.IS_EMAIL);
  });

  it('rejects a future birthdate with MAX_SHORT_DATE', async () => {
    const errors = await run({ ...VALID, birthdate: { day: 1, month: 1, year: new Date().getFullYear() + 1 } });

    expect(codeOf(errorFor(errors, 'birthdate'))).toBe(StatusCode.MAX_SHORT_DATE);
  });

  it('declares no privilege fields, so whitelist:true strips them', async () => {
    // main.ts:55 runs ValidationPipe with whitelist:true, which only helps because
    // roles/owner/banned/verified are genuinely absent from the class. If any of them
    // is ever added, POST /users becomes a privilege-escalation primitive for a caller
    // holding nothing but MANAGE_USERS.
    const errors = await validate(
      plainToInstance(CreateUserDto, { ...VALID, roles: [1], owner: true, banned: false, verified: true }),
      {
        whitelist: true,
        forbidNonWhitelisted: true
      }
    );

    expect(errors.map((e) => e.property).sort()).toEqual(['banned', 'owner', 'roles', 'verified']);
  });

  it('keeps exactly the four identity fields and nothing else', async () => {
    // Belt and braces on the two whitelist tests above: enumerate the declared surface
    // so any future addition has to be a deliberate edit here.
    const errors = await validate(
      plainToInstance(CreateUserDto, {
        username: VALID.username,
        nickname: VALID.nickname,
        email: VALID.email,
        birthdate: VALID.birthdate,
        password: 'ValidPass1',
        confirmPassword: 'ValidPass1',
        roles: [1],
        owner: true,
        banned: false,
        verified: true,
        activationCode: 'x',
        recoveryCode: 'y'
      }),
      { whitelist: true, forbidNonWhitelisted: true }
    );

    expect(errors.map((e) => e.property).sort()).toEqual([
      'activationCode',
      'banned',
      'confirmPassword',
      'owner',
      'password',
      'recoveryCode',
      'roles',
      'verified'
    ]);
  });
});
