import { HttpException, HttpStatus, Logger } from '@nestjs/common';

import { StatusCode } from '../../enums';

/**
 * Maps a scanner HTTP failure to the shared THRID_PARTY_REQUEST_FAILED / 503 envelope.
 *
 * Axios errors carry `.response` only when an HTTP exchange completed; a socket-level
 * failure (ENOTFOUND/ETIMEDOUT/ECONNREFUSED/"socket hang up") is still an axios error
 * but has no `.response`. Both map to the same 503 so a network failure no longer falls
 * through to a raw 500. Non-axios errors (including the scanners' own EPISODE_NOT_FOUND
 * HttpException) are returned unchanged so the caller can re-throw them as-is.
 */
export function toScannerHttpException(e: any, logger: Logger): unknown {
  if (!e?.isAxiosError) return e;

  if (e.response) {
    logger.error(e.response);
    return new HttpException(
      {
        code: StatusCode.THRID_PARTY_REQUEST_FAILED,
        message: `Received ${e.response.status} ${e.response.statusText} error from third party api`
      },
      HttpStatus.SERVICE_UNAVAILABLE
    );
  }

  logger.error(e.message ?? e);
  return new HttpException(
    {
      code: StatusCode.THRID_PARTY_REQUEST_FAILED,
      message: `Could not reach third party api (${e.code ?? 'network error'})`
    },
    HttpStatus.SERVICE_UNAVAILABLE
  );
}
