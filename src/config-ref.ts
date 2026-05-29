import { ConfigService } from '@nestjs/config';

/**
 * Holds the application's ConfigService singleton so non-DI contexts — pure
 * utility functions and entity getters — can read configuration without
 * importing main.ts. Importing main.ts would pull in app.module.ts and trigger
 * the entire application bootstrap during module load, which produces circular
 * dependencies (e.g. "Class extends value undefined") whenever a base class is
 * still being defined further up the import chain.
 *
 * Assigned exactly once during startup via setConfigService() in main.ts.
 */
export let configService: ConfigService<unknown, boolean>;

export function setConfigService(service: ConfigService<unknown, boolean>): void {
  configService = service;
}
