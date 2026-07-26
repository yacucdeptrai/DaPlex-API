import { Test, TestingModule } from '@nestjs/testing';

import { UsersService } from './users.service';
import { PermissionsService } from '../../common/modules/permissions/permissions.service';

/**
 * Shared harness for the W4.3 admin user specs (create + remove + updateRoles).
 *
 * The `.fixture-spec.ts` name is deliberate and load-bearing on BOTH sides:
 * tsconfig.build.json excludes `**\/*spec.ts` (a glob suffix match), so this file is
 * kept OUT of `dist` — while jest's testRegex `.*\.spec\.ts$` needs a literal `.spec.ts`,
 * so it is also NOT collected as a test. A plain `.fixture.ts` name compiles into `dist`
 * and becomes the only production artifact requiring @nestjs/testing (a devDependency),
 * which bites an `--omit=dev` install. Do not rename.
 *
 * Written test-first: `UsersService.create` / `UsersService.remove` do not exist
 * yet, so everything here is reached through an `any`-typed handle. The mocks are
 * deliberately chain-tolerant — a Mongoose query stub answers `populate/lean/
 * select/session/exec` in any order and is also thenable — so the specs pin the
 * observable behaviour (which collection was hit, with which filter, inside or
 * outside the transaction) rather than the exact fluent chain the surgeon picks.
 */

export interface QueryChainMock<T> {
  populate: jest.Mock;
  lean: jest.Mock;
  select: jest.Mock;
  session: jest.Mock;
  sort: jest.Mock;
  exec: jest.Mock;
  then: (onFulfilled?: (value: T) => unknown, onRejected?: (reason: unknown) => unknown) => Promise<unknown>;
}

/** A Mongoose query stub: chain methods return itself, `exec()`/`await` yield `result`. */
export const queryChain = <T>(result: T): QueryChainMock<T> => {
  const chain = {} as QueryChainMock<T>;
  chain.populate = jest.fn(() => chain);
  chain.lean = jest.fn(() => chain);
  chain.select = jest.fn(() => chain);
  chain.session = jest.fn(() => chain);
  chain.sort = jest.fn(() => chain);
  chain.exec = jest.fn(() => Promise.resolve(result));
  chain.then = (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected);
  return chain;
};

export interface SessionMock {
  withTransaction: jest.Mock;
  endSession: jest.Mock;
}

/**
 * A session whose `withTransaction` awaits the supplied callback, then records a
 * `commit` marker in `callOrder`. Post-commit work (DB-B, Redis, R2) must appear
 * in `callOrder` AFTER that marker — that ordering is the whole point of the
 * two-phase delete, and it cannot be asserted from call counts alone.
 */
export const makeSession = (callOrder: string[]): SessionMock => ({
  withTransaction: jest.fn(async (cb: () => Promise<void>) => {
    callOrder.push('transaction:start');
    await cb();
    callOrder.push('transaction:commit');
  }),
  endSession: jest.fn().mockResolvedValue(undefined)
});

/** Records `label` in `callOrder` and resolves. */
export const tracking = (callOrder: string[], label: string, result: unknown = undefined) =>
  jest.fn(() => {
    callOrder.push(label);
    return Promise.resolve(result);
  });

/**
 * Compiles UsersService with every constructor dependency mocked to `{}`, then
 * hands back an `any` handle so the spec can overwrite individual deps. Matches
 * the idiom used by media.service.crud-write.spec.ts / media-scheduler.service.spec.ts.
 *
 * PermissionsService is supplied REAL, not mocked: `getHighestRolePosition` is a
 * pure function and the role-hierarchy rails are the security-critical part of
 * the delete. Asserting them against a stub would only prove the stub works.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const buildUsersService = async (): Promise<any> => {
  const module: TestingModule = await Test.createTestingModule({ providers: [UsersService] })
    .useMocker(() => ({}))
    .compile();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = module.get<UsersService>(UsersService) as any;
  service.permissionsService = new PermissionsService();
  return service;
};

/** The error payload every DaPlex HttpException carries. */
export interface ErrorBody {
  code: number;
  message: string;
}

/** Runs `fn`, expecting it to reject with an HttpException, and returns {status, code}. */
export const captureHttpError = async (fn: () => Promise<unknown>): Promise<{ status: number; code: number }> => {
  try {
    await fn();
  } catch (e) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const error = e as any;
    if (typeof error?.getStatus !== 'function') throw e;
    return { status: error.getStatus(), code: (error.getResponse() as ErrorBody)?.code };
  }
  throw new Error('Expected the call to reject with an HttpException, but it resolved');
};
