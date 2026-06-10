import 'reflect-metadata';
import { GUARDS_METADATA, HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod, Type } from '@nestjs/common';
import { MovieController } from './movie.controller';
import { TVEpisodeController } from './tv-episode.controller';
import { MediaVideoController } from './media-video.controller';
import { MediaSubtitleController } from './media-subtitle.controller';
import { MediaChapterController } from './media-chapter.controller';
import { MediaService } from './media.service';
import { MediaSubtitlesService } from './media-subtitles.service';
import { MediaImagesService } from './media-images.service';
import { MediaVideosService } from './media-videos.service';
import { MediaChaptersService } from './media-chapters.service';
import { MediaTVEpisodesService } from './media-tv-episodes.service';

// REPOINT POINT (Phase 7.2 split):
// Today the media routes live on a single controller. After the split the
// surgeon replaces the one entry below with the 5 domain controllers, e.g.
//   export const MEDIA_CONTROLLERS = [
//     MovieController,
//     TVEpisodeController,
//     MediaVideoController,
//     MediaSubtitleController,
//     MediaChapterController
//   ];
// Nothing else in the fixture or the spec needs to change: routes are keyed by
// handler name, which stays unique across the 5 controllers.
export const MEDIA_CONTROLLERS: Type<unknown>[] = [
  MovieController,
  TVEpisodeController,
  MediaVideoController,
  MediaSubtitleController,
  MediaChapterController
];

export interface RouteRecord {
  /** The controller class the handler lives on (for diagnostics). */
  controller: string;
  /** HTTP verb as a RequestMethod name, e.g. 'GET'. */
  method: string;
  /** Per-handler @Get/@Post path metadata, exactly as declared (no class prefix). */
  path: string;
  /** Guard class names in declaration order. */
  guards: string[];
  /** @HttpCode value, or null when none is declared. */
  httpCode: number | null;
  /** @RolesGuardOptions payload, or null when absent. */
  rolesGuardOptions: unknown;
  /** @AuthGuardOptions payload, or null when absent. */
  authGuardOptions: unknown;
}

const guardName = (guard: unknown): string => (guard as { name?: string })?.name ?? String(guard);

const collectHandlers = (controller: Type<unknown>): string[] => {
  const proto = controller.prototype;
  return Object.getOwnPropertyNames(proto).filter(
    (name) => name !== 'constructor' && typeof (proto as Record<string, unknown>)[name] === 'function'
  );
};

/**
 * Walks every controller in MEDIA_CONTROLLERS and returns a flat map of
 * handlerName -> RouteRecord built purely from reflected route metadata.
 * Controller-shape-agnostic: works identically before and after the split.
 */
export const resolveRoutes = (): Record<string, RouteRecord> => {
  const map: Record<string, RouteRecord> = {};
  for (const controller of MEDIA_CONTROLLERS) {
    const proto = controller.prototype as Record<string, unknown>;
    for (const name of collectHandlers(controller)) {
      const fn = proto[name];
      const method = Reflect.getMetadata(METHOD_METADATA, fn) as RequestMethod;
      const path = Reflect.getMetadata(PATH_METADATA, fn) as string;
      const guards = (Reflect.getMetadata(GUARDS_METADATA, fn) ?? []).map(guardName);
      const httpCode = (Reflect.getMetadata(HTTP_CODE_METADATA, fn) as number) ?? null;
      const rolesGuardOptions = Reflect.getMetadata('rolesGuardOptions', fn) ?? null;
      const authGuardOptions = Reflect.getMetadata('authGuardOptions', fn) ?? null;
      map[name] = {
        controller: controller.name,
        method: RequestMethod[method],
        path,
        guards,
        httpCode,
        rolesGuardOptions,
        authGuardOptions
      };
    }
  }
  return map;
};

/** Class-level @Controller() prefix for each registered controller. */
export const resolveClassPrefixes = (): Record<string, unknown> => {
  const prefixes: Record<string, unknown> = {};
  for (const controller of MEDIA_CONTROLLERS) {
    prefixes[controller.name] = Reflect.getMetadata(PATH_METADATA, controller) ?? null;
  }
  return prefixes;
};

// The 6 services any media handler can delegate to. Each split controller
// injects only the subset it needs (brief §2 minimal-DI table). The fixture is
// constructor-shape-agnostic: it reads `design:paramtypes` off each controller
// and supplies exactly one recording proxy per declared parameter, matched to
// its TYPE — so neither the number nor the order of injected services is
// assumed. This survives the surgeon trimming padded constructors to minimal DI.
export const MEDIA_SERVICE_KEYS = [
  'mediaService',
  'mediaSubtitlesService',
  'mediaImagesService',
  'mediaVideosService',
  'mediaChaptersService',
  'mediaTVEpisodesService'
] as const;
export type MediaServiceKey = (typeof MEDIA_SERVICE_KEYS)[number];

// Maps each concrete service class to its recording label. `emitDecoratorMetadata`
// is on (tsconfig) and the services are concrete classes, so a controller's
// `design:paramtypes` yields these constructors and we can label proxies by type
// regardless of constructor position.
const SERVICE_TYPE_TO_KEY = new Map<unknown, MediaServiceKey>([
  [MediaService, 'mediaService'],
  [MediaSubtitlesService, 'mediaSubtitlesService'],
  [MediaImagesService, 'mediaImagesService'],
  [MediaVideosService, 'mediaVideosService'],
  [MediaChaptersService, 'mediaChaptersService'],
  [MediaTVEpisodesService, 'mediaTVEpisodesService']
]);

/** Records the single (service, method) a handler delegated to in one call. */
export interface DelegationRecord {
  /** Constructor-parameter name of the service that was called. */
  service: MediaServiceKey;
  /** Method name invoked on that service. */
  method: string;
  /** Positional arguments the handler forwarded to the service method. */
  args: unknown[];
}

// Sentinel argument values passed to every handler. They are opaque tokens so
// the delegation assertions can verify argument FORWARDING and ORDER without
// depending on real DTO/pipe behaviour. `@Req()`-style handlers read `.url` off
// the request, so the request sentinel exposes a `url` getter.
const REQ_SENTINEL = { url: '/api/media/req-sentinel' };
const HANDLER_ARG_SENTINELS: Record<string, unknown> = {
  authUser: { __sentinel: 'authUser' },
  headers: { __sentinel: 'headers' },
  id: { __sentinel: 'id' },
  body: { __sentinel: 'body' },
  query: { __sentinel: 'query' },
  param2: { __sentinel: 'param2' },
  param3: { __sentinel: 'param3' },
  file: { __sentinel: 'file' },
  req: REQ_SENTINEL
};
export const SENTINELS = HANDLER_ARG_SENTINELS;

/**
 * Builds a recording proxy for one service: every property access returns a
 * function that, when called, records the (service, method, args) tuple and
 * returns a resolved promise. This lets us invoke a handler and observe which
 * dependency it routed to without compiling the full Nest DI graph or touching
 * native addons.
 */
const makeRecordingService = (service: string, sink: DelegationRecord[]) =>
  new Proxy(
    {},
    {
      get:
        (_t, method: string) =>
        (...args: unknown[]) => {
          sink.push({ service: service as MediaServiceKey, method, args });
          return Promise.resolve(undefined);
        }
    }
  );

/**
 * Instantiates a controller, replacing each constructor parameter with a
 * recording proxy resolved by TYPE. Reads `design:paramtypes` (emitted because
 * emitDecoratorMetadata is on) and, for each param, supplies a proxy labelled
 * with the matching MediaServiceKey. This is constructor-shape-agnostic: it
 * works for a padded 6-service constructor and equally for a controller trimmed
 * to the brief's minimal-DI subset, in any parameter order. Any param whose type
 * is not one of the 6 known services gets a proxy labelled by its class name so
 * an unexpected dependency surfaces in the delegation record rather than being
 * silently mislabelled.
 */
const buildRecordingController = (controller: Type<unknown>) => {
  const sink: DelegationRecord[] = [];
  const paramTypes = (Reflect.getMetadata('design:paramtypes', controller) ?? []) as unknown[];
  const services = paramTypes.map((paramType) => {
    const key = SERVICE_TYPE_TO_KEY.get(paramType);
    const label = key ?? (paramType as { name?: string })?.name ?? 'unknown';
    return makeRecordingService(label, sink);
  });
  const instance = new (controller as new (...args: unknown[]) => Record<string, unknown>)(...services);
  return { instance, sink };
};

/**
 * Invokes every handler across MEDIA_CONTROLLERS with sentinel arguments and
 * returns handlerName -> the single DelegationRecord it produced. A handler that
 * calls zero or more than one service method is reported as-is (multiple records)
 * so the spec can flag it; today every handler delegates exactly once.
 */
export const resolveDelegations = (): Record<string, DelegationRecord[]> => {
  const result: Record<string, DelegationRecord[]> = {};
  for (const controller of MEDIA_CONTROLLERS) {
    const handlers = collectHandlers(controller).filter(
      (name) =>
        Reflect.getMetadata(METHOD_METADATA, (controller.prototype as Record<string, unknown>)[name]) !== undefined
    );
    for (const name of handlers) {
      const { instance, sink } = buildRecordingController(controller);
      const fn = instance[name] as (...args: unknown[]) => unknown;
      // Over-supply sentinel args (handlers ignore extras); covers the widest
      // signature (saveTVEpisodeSource takes 6 positional params).
      fn.call(
        instance,
        HANDLER_ARG_SENTINELS.authUser,
        HANDLER_ARG_SENTINELS.id,
        HANDLER_ARG_SENTINELS.param2,
        HANDLER_ARG_SENTINELS.param3,
        HANDLER_ARG_SENTINELS.headers,
        HANDLER_ARG_SENTINELS.body
      );
      result[name] = sink;
    }
  }
  return result;
};
