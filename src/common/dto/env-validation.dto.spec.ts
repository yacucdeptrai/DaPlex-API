/**
 * Env validation — characterization that the existing env still validates, plus TDD for
 * the two NEW scanner auto-WARP flags.
 *
 * The "valid base" case (no SCANNER_AUTO_WARP / SCANNER_WARP_PORT) is CHARACTERIZATION:
 * it passes on the unchanged DTO today and must keep passing after the additive fields
 * land (they are @IsOptional, so an existing .env without them still validates).
 *
 * RED-PENDING-SURGEON: the two assertions that read back validated.SCANNER_AUTO_WARP /
 * SCANNER_WARP_PORT, and the "non-int port is rejected" case, require the surgeon to add:
 *   @IsOptional() @IsString() SCANNER_AUTO_WARP: string;
 *   @IsOptional() @IsInt()    SCANNER_WARP_PORT: number;
 * to EnvironmentVariables. Until then SCANNER_WARP_PORT is an unknown key (no @IsInt), so
 * the non-int-rejection case is RED. Optionality and string passthrough may already appear
 * to pass because unknown keys are ignored by validateSync — that is fine; the surgeon's
 * field additions make the intent explicit and the non-int guard real.
 */
// class-validator decorators need the metadata reflection shim loaded before validate()
// runs. The Jest config has no global setupFile for it, so import it here (the same pattern
// the media-progress specs use).
import 'reflect-metadata';

import { validate } from './env-validation.dto';

// A minimal config that satisfies every @IsNotEmpty / @IsUrl field in EnvironmentVariables,
// so we can isolate the scanner-WARP flags. enableImplicitConversion coerces numeric strings.
function baseEnv(): Record<string, unknown> {
  return {
    NODE_ENV: 'production',
    DATABASE_URL: 'mongodb+srv://u:p@cluster.example.net/db',
    DATABASE_URL_B: 'mongodb+srv://u:p@cluster.example.net/dbB',
    ACCESS_TOKEN_SECRET: 'access-secret',
    REFRESH_TOKEN_SECRET: 'refresh-secret',
    COOKIE_SECRET: 'cookie-secret',
    COOKIE_DOMAIN: 'localhost',
    REDIS_URL: 'redis://localhost:6379',
    REDIS_2ND_URL: 'redis://localhost:6379',
    REDIS_QUEUE_URL: 'redis://localhost:6379',
    REDIS_IO_URL: 'redis://localhost:6379',
    EMAIL_SENDER: 'sender@example.com',
    EMAIL_FROM: 'from@example.com',
    SENDGRID_API_KEY: 'sg-key',
    WEBSITE_URL: 'https://daplex.example',
    ORIGIN_URL: 'https://daplex.example',
    TMDB_ACCESS_TOKEN: 'tmdb-token',
    CRYPTO_SECRET_KEY: 'crypto-key',
    AZURE_STORAGE_URL: 'https://azure.example',
    AZURE_STORAGE_CONNECTION_STRING: 'azure-conn',
    IMAGE_PROXY_URL: 'https://img.example',
    RECAPTCHA_SECRET: 'recaptcha'
  };
}

describe('env validation — scanner auto-WARP flags', () => {
  // CHARACTERIZATION — an existing .env WITHOUT the new flags still validates (they are
  // optional / additive; no existing deployment breaks).
  it('validates a complete env that omits SCANNER_AUTO_WARP and SCANNER_WARP_PORT', () => {
    expect(() => validate(baseEnv())).not.toThrow();
  });

  // NEW / RED — SCANNER_AUTO_WARP accepts the disabling string 'false' (mirrors
  // MONGO_AUTO_WARP). Read through a loose view so the file COMPILES against the current
  // DTO (the field does not exist yet); behavioral-RED today (reads undefined), green once
  // the surgeon adds `@IsOptional() @IsString() SCANNER_AUTO_WARP`.
  it('accepts SCANNER_AUTO_WARP="false" as a string', () => {
    const validated = validate({ ...baseEnv(), SCANNER_AUTO_WARP: 'false' }) as unknown as Record<string, unknown>;
    expect(validated.SCANNER_AUTO_WARP).toBe('false');
  });

  // NEW / RED — SCANNER_WARP_PORT is coerced to an integer (enableImplicitConversion), like
  // MONGO_WARP_PORT, so the factory can `Number()` it for the proxy endpoint. Behavioral-RED
  // until the surgeon adds `@IsOptional() @IsInt() SCANNER_WARP_PORT`.
  it('coerces a numeric SCANNER_WARP_PORT string to an int', () => {
    const validated = validate({ ...baseEnv(), SCANNER_WARP_PORT: '40000' }) as unknown as Record<string, unknown>;
    expect(validated.SCANNER_WARP_PORT).toBe(40000);
  });

  // NEW / RED — a non-numeric SCANNER_WARP_PORT is rejected by @IsInt (argument-injection
  // hardening: the port arg passed to warp-cli must stay an int).
  it('rejects a non-numeric SCANNER_WARP_PORT', () => {
    expect(() => validate({ ...baseEnv(), SCANNER_WARP_PORT: 'not-a-port' })).toThrow();
  });
});
