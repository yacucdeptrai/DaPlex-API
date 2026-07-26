import { AuditLogType, StatusCode } from '../../enums';

/**
 * W4.3 — the two enums the slice extends. Both are wire contracts: the FE switches on
 * StatusCode integers and AuditLogType integers are already persisted in DATABASE_B
 * audit rows, so these enums are APPEND-ONLY. Renumbering an existing member silently
 * relabels historical data.
 *
 * Mixed file on purpose: the "already exists" pins are green today and must stay green
 * through the surgeon's append; the two "is added" blocks are RED until the append lands.
 * New members are looked up by string key so this file type-checks before they exist.
 */

const valueOf = (enumObject: Record<string, string | number>, key: string) => enumObject[key];

/** Numeric enums carry a reverse mapping; keep only the forward (name -> number) half. */
const forwardEntries = (enumObject: Record<string, string | number>) =>
  Object.entries(enumObject).filter(([key]) => Number.isNaN(Number(key)));

describe('StatusCode — Users block', () => {
  it('keeps every pre-existing Users code at its current number', () => {
    expect(StatusCode.USER_NOT_FOUND).toBe(300);
    expect(StatusCode.USERS_NOT_FOUND).toBe(301);
    expect(StatusCode.AVATAR_NOT_FOUND).toBe(302);
    expect(StatusCode.PASSWORDS_NOT_MATCH).toBe(303);
    expect(StatusCode.BAN_USER_RESTRICTED).toBe(304);
    expect(StatusCode.USER_BANNED).toBe(305);
    expect(StatusCode.BANNER_NOT_FOUND).toBe(306);
  });

  it('keeps the codes the new endpoints reuse', () => {
    expect(StatusCode.ACCESS_DENIED).toBe(109);
    expect(StatusCode.NULL_AUTHORIZATION).toBe(104);
    expect(StatusCode.USERNAME_EXIST).toBe(100);
    expect(StatusCode.EMAIL_EXIST).toBe(101);
  });

  it('adds DELETE_USER_RESTRICTED = 307 for self-delete and outranked-target refusals', () => {
    expect(valueOf(StatusCode as unknown as Record<string, number>, 'DELETE_USER_RESTRICTED')).toBe(307);
  });

  it('adds OWNER_DELETE_RESTRICTED = 308 for the instance-owner refusal', () => {
    // The FE needs to tell "you cannot delete the owner, transfer ownership first"
    // apart from "you lack permission" — different toast, different remedy.
    expect(valueOf(StatusCode as unknown as Record<string, number>, 'OWNER_DELETE_RESTRICTED')).toBe(308);
  });

  it('assigns no duplicate numbers', () => {
    const values = forwardEntries(StatusCode as unknown as Record<string, number>).map(([, value]) => value);

    expect(new Set(values).size).toBe(values.length);
  });
});

describe('AuditLogType — Users block', () => {
  it('never renumbers USER_UPDATE', () => {
    // 6000 is already written into DATABASE_B rows. The x000/x001/x002
    // create/update/delete convention cannot be honoured here without corrupting
    // the meaning of every stored user audit entry, so the new members append
    // above it instead. That deviation is deliberate.
    expect(AuditLogType.USER_UPDATE).toBe(6000);
  });

  it('adds USER_CREATE = 6001', () => {
    expect(valueOf(AuditLogType as unknown as Record<string, number>, 'USER_CREATE')).toBe(6001);
  });

  it('adds USER_DELETE = 6002', () => {
    expect(valueOf(AuditLogType as unknown as Record<string, number>, 'USER_DELETE')).toBe(6002);
  });

  it('leaves the neighbouring blocks untouched', () => {
    expect(AuditLogType.SETTINGS_DELETE).toBe(5002);
    expect(AuditLogType.COLLECTION_CREATE).toBe(7000);
  });

  it('assigns no duplicate numbers', () => {
    const values = forwardEntries(AuditLogType as unknown as Record<string, number>).map(([, value]) => value);

    expect(new Set(values).size).toBe(values.length);
  });
});
