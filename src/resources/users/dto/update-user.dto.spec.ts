import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';

import { UpdateUserDto } from './update-user.dto';
import { StatusCode } from '../../../enums';

/**
 * W4.3 — the `banned` coercion bug on the existing PATCH /users/:id body.
 *
 * `update-user.dto.ts:111-118` gives `banned` a coercing `@Transform` and `@IsOptional()`
 * but NO `@IsBoolean()`, unlike `restoreAccount` two fields up (`:102-103`). The transform
 * is `value != undefined ? [true, 'true'].indexOf(value) > -1 : value` and runs
 * `toClassOnly`, i.e. BEFORE validation — so any unrecognised value collapses to `false`
 * and the request succeeds with 200, silently UNBANNING a banned user.
 *
 * The important part: **adding `@IsBoolean()` alone does not fix this.** By the time the
 * validator runs, `'yes'` has already become the boolean `false`, which `@IsBoolean()`
 * happily accepts. The transform itself has to stop swallowing unrecognised input — pass
 * it through unchanged so `@IsBoolean()` can reject it:
 *
 *   @Transform(({ value }) => (value === true || value === 'true' ? true
 *                            : value === false || value === 'false' ? false
 *                            : value), { toClassOnly: true })
 *   @IsOptional()
 *   @IsBoolean({ context: { code: StatusCode.IS_BOOLEAN } })
 *
 * That is exactly why these assert transformed VALUES and validation OUTCOMES rather than
 * decorator presence: a `@IsBoolean()`-is-present check would pass while the bug lives on.
 * `restoreAccount` proves the point — it already has `@IsBoolean()` and is still broken.
 */

const run = (payload: Record<string, unknown>) => validate(plainToInstance(UpdateUserDto, payload));

const errorFor = (errors: ValidationError[], property: string) => errors.find((e) => e.property === property);

const bannedValue = (input: unknown) => (plainToInstance(UpdateUserDto, { banned: input }) as UpdateUserDto).banned;

describe('UpdateUserDto.banned — silent-unban coercion (RED)', () => {
  it.each([['yes'], [1], [0], ['on'], [{}], [[]], ['TRUE']])('rejects the malformed value %p instead of coercing it', async (input) => {
    // Every one of these currently lands as `banned: false` with zero validation errors,
    // so a typo'd or hostile PATCH lifts a ban and returns 200.
    const errors = await run({ banned: input });

    expect(errorFor(errors, 'banned')).toBeDefined();
  });

  it('never turns an unrecognised value into a boolean', async () => {
    expect(bannedValue('yes')).not.toBe(false);
    expect(bannedValue(1)).not.toBe(false);
  });

  it('rejects a malformed value with the IS_BOOLEAN status code', async () => {
    const errors = await run({ banned: 'yes' });

    expect(Object.values<{ code?: number }>(errorFor(errors, 'banned')?.contexts ?? {})[0]?.code).toBe(StatusCode.IS_BOOLEAN);
  });
});

describe('UpdateUserDto.restoreAccount — same lossy transform (RED)', () => {
  it('rejects a malformed value rather than silently skipping the restore', async () => {
    // `restoreAccount` already carries @IsBoolean() and is STILL broken, because the
    // transform coerces before the validator sees the value. Both fields need the
    // transform fixed, not just the missing decorator added.
    const errors = await run({ restoreAccount: 'yes' });

    expect(errorFor(errors, 'restoreAccount')).toBeDefined();
  });
});

describe('UpdateUserDto — boolean handling that must survive the fix (green)', () => {
  it.each([
    [true, true],
    ['true', true],
    [false, false],
    ['false', false]
  ])('coerces the recognised value %p to %p', (input, expected) => {
    expect(bannedValue(input)).toBe(expected);
  });

  it.each([[true], ['true'], [false], ['false']])('accepts the recognised value %p', async (input) => {
    const errors = await run({ banned: input });

    expect(errorFor(errors, 'banned')).toBeUndefined();
  });

  it('leaves banned undefined when the field is absent', async () => {
    expect(bannedValue(undefined)).toBeUndefined();
    expect(errorFor(await run({ nickname: 'Someone' }), 'banned')).toBeUndefined();
  });

  it('applies the same recognised-value coercion to restoreAccount', async () => {
    expect((plainToInstance(UpdateUserDto, { restoreAccount: 'true' }) as UpdateUserDto).restoreAccount).toBe(true);
    expect(errorFor(await run({ restoreAccount: true }), 'restoreAccount')).toBeUndefined();
  });
});
