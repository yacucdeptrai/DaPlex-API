import { UserPermission } from '../../enums';
import { MEDIA_CONTROLLERS, resolveClassPrefixes, resolveRoutes, RouteRecord } from './media-routes.fixture';

// Characterization net for the Phase 7.2 controller split. These assertions
// pin the CURRENT route surface of MediaController (53 handlers) so that moving
// handlers into 5 domain controllers is provably behavior-preserving: any drift
// in HTTP method, declared path, guard set/order, @RolesGuardOptions,
// @AuthGuardOptions, or @HttpCode fails loudly. All expectations are read from
// reflected metadata via the fixture, so they survive the split unchanged once
// MEDIA_CONTROLLERS is repointed to the 5 new classes.

const MANAGE = [UserPermission.MANAGE_MEDIA];

type Expected = Pick<RouteRecord, 'method' | 'path' | 'guards' | 'httpCode' | 'rolesGuardOptions' | 'authGuardOptions'>;

// One row per handler, keyed by method name. Values are the exact reflected
// metadata of the unchanged controller at branch master @ 5eaf3bc.
const EXPECTED: Record<string, Expected> = {
  create: { method: 'POST', path: '/', guards: ['AuthGuard', 'RolesGuard'], httpCode: null, rolesGuardOptions: { permissions: MANAGE, optional: false, requireOwner: false }, authGuardOptions: null },
  findAll: { method: 'GET', path: '/', guards: ['AuthGuard', 'RolesGuard'], httpCode: null, rolesGuardOptions: { permissions: MANAGE, optional: true, requireOwner: false }, authGuardOptions: { anonymous: true } },
  findAllCursor: { method: 'GET', path: 'cursor', guards: ['AuthGuard', 'RolesGuard'], httpCode: null, rolesGuardOptions: { permissions: MANAGE, optional: true, requireOwner: false }, authGuardOptions: { anonymous: true } },
  findOne: { method: 'GET', path: ':id', guards: ['AuthGuard', 'RolesGuard'], httpCode: null, rolesGuardOptions: { permissions: MANAGE, optional: true, requireOwner: false }, authGuardOptions: { anonymous: true } },
  update: { method: 'PATCH', path: ':id', guards: ['AuthGuard', 'RolesGuard'], httpCode: null, rolesGuardOptions: { permissions: MANAGE, optional: false, requireOwner: false }, authGuardOptions: null },
  remove: { method: 'DELETE', path: ':id', guards: ['AuthGuard', 'RolesGuard'], httpCode: 204, rolesGuardOptions: { permissions: MANAGE, optional: false, requireOwner: false }, authGuardOptions: null },
  addMediaVideo: { method: 'POST', path: ':id/videos', guards: ['AuthGuard', 'RolesGuard'], httpCode: null, rolesGuardOptions: { permissions: MANAGE, optional: false, requireOwner: false }, authGuardOptions: null },
  findAllMediaVideos: { method: 'GET', path: ':id/videos', guards: ['AuthGuard', 'RolesGuard'], httpCode: null, rolesGuardOptions: { permissions: MANAGE, optional: true, requireOwner: false }, authGuardOptions: { anonymous: true } },
  updateMediaVideo: { method: 'PATCH', path: ':id/videos/:video_id', guards: ['AuthGuard', 'RolesGuard'], httpCode: null, rolesGuardOptions: { permissions: MANAGE, optional: false, requireOwner: false }, authGuardOptions: null },
  deleteMediaVideo: { method: 'DELETE', path: ':id/videos/:video_id', guards: ['AuthGuard', 'RolesGuard'], httpCode: 204, rolesGuardOptions: { permissions: MANAGE, optional: false, requireOwner: false }, authGuardOptions: null },
  deleteMediaVideos: { method: 'DELETE', path: ':id/videos', guards: ['AuthGuard', 'RolesGuard'], httpCode: 204, rolesGuardOptions: { permissions: MANAGE, optional: false, requireOwner: false }, authGuardOptions: null },
  updatePoster: { method: 'PATCH', path: ':id/poster', guards: ['AuthGuard', 'RolesGuard'], httpCode: null, rolesGuardOptions: { permissions: MANAGE, optional: false, requireOwner: false }, authGuardOptions: null },
  deletePoster: { method: 'DELETE', path: ':id/poster', guards: ['AuthGuard', 'RolesGuard'], httpCode: 204, rolesGuardOptions: { permissions: MANAGE, optional: false, requireOwner: false }, authGuardOptions: null },
  // Tightened to match the poster + backdrop DELETE: admin-only image store.
  updateBackdrop: { method: 'PATCH', path: ':id/backdrop', guards: ['AuthGuard', 'RolesGuard'], httpCode: null, rolesGuardOptions: { permissions: MANAGE, optional: false, requireOwner: false }, authGuardOptions: null },
  deleteBackdrop: { method: 'DELETE', path: ':id/backdrop', guards: ['AuthGuard', 'RolesGuard'], httpCode: 204, rolesGuardOptions: { permissions: MANAGE, optional: false, requireOwner: false }, authGuardOptions: null },
  updateMovieSubtitle: { method: 'POST', path: ':id/movie/subtitles', guards: ['AuthGuard', 'RolesGuard'], httpCode: null, rolesGuardOptions: { permissions: MANAGE, optional: false, requireOwner: false }, authGuardOptions: null },
  findAllMovieSubtitles: { method: 'GET', path: ':id/movie/subtitles', guards: ['AuthGuard', 'RolesGuard'], httpCode: null, rolesGuardOptions: { permissions: MANAGE, optional: true, requireOwner: false }, authGuardOptions: { anonymous: true } },
  deleteMovieSubtitle: { method: 'DELETE', path: ':id/movie/subtitles/:subtitle_id', guards: ['AuthGuard', 'RolesGuard'], httpCode: 200, rolesGuardOptions: { permissions: MANAGE, optional: false, requireOwner: false }, authGuardOptions: null },
  deleteMovieSubtitles: { method: 'DELETE', path: ':id/movie/subtitles', guards: ['AuthGuard', 'RolesGuard'], httpCode: 200, rolesGuardOptions: { permissions: MANAGE, optional: false, requireOwner: false }, authGuardOptions: null },
  addMovieSource: { method: 'POST', path: ':id/movie/source', guards: ['AuthGuard', 'RolesGuard'], httpCode: null, rolesGuardOptions: { permissions: MANAGE, optional: false, requireOwner: false }, authGuardOptions: null },
  addLinkedMovieSource: { method: 'POST', path: ':id/movie/linked-source', guards: ['AuthGuard', 'RolesGuard'], httpCode: 204, rolesGuardOptions: { permissions: MANAGE, optional: false, requireOwner: false }, authGuardOptions: null },
  encodeMovieSource: { method: 'PATCH', path: ':id/movie/source', guards: ['AuthGuard', 'RolesGuard'], httpCode: 204, rolesGuardOptions: { permissions: MANAGE, optional: false, requireOwner: false }, authGuardOptions: null },
  saveMovieSource: { method: 'POST', path: ':id/movie/source/:session_id', guards: ['AuthGuard', 'RolesGuard'], httpCode: 204, rolesGuardOptions: { permissions: MANAGE, optional: false, requireOwner: false }, authGuardOptions: null },
  deleteMovieSource: { method: 'DELETE', path: ':id/movie/source', guards: ['AuthGuard', 'RolesGuard'], httpCode: 204, rolesGuardOptions: { permissions: MANAGE, optional: false, requireOwner: false }, authGuardOptions: null },
  findAllMovieStreams: { method: 'GET', path: ':id/movie/streams', guards: ['AuthGuard', 'RolesGuard'], httpCode: null, rolesGuardOptions: { permissions: MANAGE, optional: true, requireOwner: false }, authGuardOptions: { anonymous: true } },
  addMovieChapter: { method: 'POST', path: ':id/movie/chapters', guards: ['AuthGuard', 'RolesGuard'], httpCode: null, rolesGuardOptions: { permissions: MANAGE, optional: false, requireOwner: false }, authGuardOptions: null },
  findAllMovieChapters: { method: 'GET', path: ':id/movie/chapters', guards: ['AuthGuard', 'RolesGuard'], httpCode: null, rolesGuardOptions: { permissions: MANAGE, optional: true, requireOwner: false }, authGuardOptions: { anonymous: true } },
  updateMovieChapter: { method: 'PATCH', path: ':id/movie/chapters/:chapter_id', guards: ['AuthGuard', 'RolesGuard'], httpCode: null, rolesGuardOptions: { permissions: MANAGE, optional: false, requireOwner: false }, authGuardOptions: null },
  deleteMovieChapter: { method: 'DELETE', path: ':id/movie/chapters/:chapter_id', guards: ['AuthGuard', 'RolesGuard'], httpCode: 204, rolesGuardOptions: { permissions: MANAGE, optional: false, requireOwner: false }, authGuardOptions: null },
  deleteMovieChapters: { method: 'DELETE', path: ':id/movie/chapters', guards: ['AuthGuard', 'RolesGuard'], httpCode: 204, rolesGuardOptions: { permissions: MANAGE, optional: false, requireOwner: false }, authGuardOptions: null },
  addTVEpisode: { method: 'POST', path: ':id/tv/episodes', guards: ['AuthGuard', 'RolesGuard'], httpCode: null, rolesGuardOptions: { permissions: MANAGE, optional: false, requireOwner: false }, authGuardOptions: null },
  findAllTVEpisodes: { method: 'GET', path: ':id/tv/episodes', guards: ['AuthGuard', 'RolesGuard'], httpCode: null, rolesGuardOptions: { permissions: MANAGE, optional: true, requireOwner: false }, authGuardOptions: { anonymous: true } },
  findOneTVEpisode: { method: 'GET', path: ':id/tv/episodes/:episode_id', guards: ['AuthGuard', 'RolesGuard'], httpCode: null, rolesGuardOptions: { permissions: MANAGE, optional: true, requireOwner: false }, authGuardOptions: { anonymous: true } },
  updateTVEpisode: { method: 'PATCH', path: ':id/tv/episodes/:episode_id', guards: ['AuthGuard', 'RolesGuard'], httpCode: null, rolesGuardOptions: { permissions: MANAGE, optional: false, requireOwner: false }, authGuardOptions: null },
  deleteTVEpisode: { method: 'DELETE', path: ':id/tv/episodes/:episode_id', guards: ['AuthGuard', 'RolesGuard'], httpCode: 204, rolesGuardOptions: { permissions: MANAGE, optional: false, requireOwner: false }, authGuardOptions: null },
  updateTVEpisodeStill: { method: 'PATCH', path: ':id/tv/episodes/:episode_id/still', guards: ['AuthGuard', 'RolesGuard'], httpCode: null, rolesGuardOptions: { permissions: MANAGE, optional: false, requireOwner: false }, authGuardOptions: null },
  deleteTVEpisodeStill: { method: 'DELETE', path: ':id/tv/episodes/:episode_id/still', guards: ['AuthGuard', 'RolesGuard'], httpCode: 204, rolesGuardOptions: { permissions: MANAGE, optional: false, requireOwner: false }, authGuardOptions: null },
  updateTVEpisodeSubtitle: { method: 'POST', path: ':id/tv/episodes/:episode_id/subtitles', guards: ['AuthGuard', 'RolesGuard'], httpCode: null, rolesGuardOptions: { permissions: MANAGE, optional: false, requireOwner: false }, authGuardOptions: null },
  findAllTVEpisodeSubtitles: { method: 'GET', path: ':id/tv/episodes/:episode_id/subtitles', guards: ['AuthGuard', 'RolesGuard'], httpCode: null, rolesGuardOptions: { permissions: MANAGE, optional: true, requireOwner: false }, authGuardOptions: { anonymous: true } },
  deleteTVSubtitle: { method: 'DELETE', path: ':id/tv/episodes/:episode_id/subtitles/:subtitle_id', guards: ['AuthGuard', 'RolesGuard'], httpCode: 200, rolesGuardOptions: { permissions: MANAGE, optional: false, requireOwner: false }, authGuardOptions: null },
  deleteTVSubtitles: { method: 'DELETE', path: ':id/tv/episodes/:episode_id/subtitles', guards: ['AuthGuard', 'RolesGuard'], httpCode: 200, rolesGuardOptions: { permissions: MANAGE, optional: false, requireOwner: false }, authGuardOptions: null },
  addTVEpisodeSource: { method: 'POST', path: ':id/tv/episodes/:episode_id/source', guards: ['AuthGuard', 'RolesGuard'], httpCode: null, rolesGuardOptions: { permissions: MANAGE, optional: false, requireOwner: false }, authGuardOptions: null },
  addLinkedTVEpisodeSource: { method: 'POST', path: ':id/tv/episodes/:episode_id/linked-source', guards: ['AuthGuard', 'RolesGuard'], httpCode: 204, rolesGuardOptions: { permissions: MANAGE, optional: false, requireOwner: false }, authGuardOptions: null },
  encodeTVEpisodeSource: { method: 'PATCH', path: ':id/tv/episodes/:episode_id/source', guards: ['AuthGuard', 'RolesGuard'], httpCode: 204, rolesGuardOptions: { permissions: MANAGE, optional: false, requireOwner: false }, authGuardOptions: null },
  saveTVEpisodeSource: { method: 'POST', path: ':id/tv/episodes/:episode_id/source/:session_id', guards: ['AuthGuard', 'RolesGuard'], httpCode: 204, rolesGuardOptions: { permissions: MANAGE, optional: false, requireOwner: false }, authGuardOptions: null },
  deleteTVEpisodeSource: { method: 'DELETE', path: ':id/tv/episodes/:episode_id/source', guards: ['AuthGuard', 'RolesGuard'], httpCode: 204, rolesGuardOptions: { permissions: MANAGE, optional: false, requireOwner: false }, authGuardOptions: null },
  findAllTVEpisodeStreams: { method: 'GET', path: ':id/tv/episodes/:episode_number/streams', guards: ['AuthGuard', 'RolesGuard'], httpCode: null, rolesGuardOptions: { permissions: MANAGE, optional: true, requireOwner: false }, authGuardOptions: { anonymous: true } },
  addTVEpisodeChapter: { method: 'POST', path: ':id/tv/episodes/:episode_id/chapters', guards: ['AuthGuard', 'RolesGuard'], httpCode: null, rolesGuardOptions: { permissions: MANAGE, optional: false, requireOwner: false }, authGuardOptions: null },
  findAllTVEpisodeChapters: { method: 'GET', path: ':id/tv/episodes/:episode_id/chapters', guards: ['AuthGuard', 'RolesGuard'], httpCode: null, rolesGuardOptions: { permissions: MANAGE, optional: true, requireOwner: false }, authGuardOptions: { anonymous: true } },
  updateTVEpisodeChapter: { method: 'PATCH', path: ':id/tv/episodes/:episode_id/chapters/:chapter_id', guards: ['AuthGuard', 'RolesGuard'], httpCode: null, rolesGuardOptions: { permissions: MANAGE, optional: false, requireOwner: false }, authGuardOptions: null },
  deleteTVEpisodeChapter: { method: 'DELETE', path: ':id/tv/episodes/:episode_id/chapters/:chapter_id', guards: ['AuthGuard', 'RolesGuard'], httpCode: 204, rolesGuardOptions: { permissions: MANAGE, optional: false, requireOwner: false }, authGuardOptions: null },
  deleteTVEpisodeChapters: { method: 'DELETE', path: ':id/tv/episodes/:episode_id/chapters', guards: ['AuthGuard', 'RolesGuard'], httpCode: 204, rolesGuardOptions: { permissions: MANAGE, optional: false, requireOwner: false }, authGuardOptions: null },
  // Added after the split: the polled live transcode-progress endpoint. Admin-only
  // GET (AuthGuard+RolesGuard+MANAGE_MEDIA), not anonymous; the 'progress' throttler
  // it toggles is class/method metadata the fixture does not reflect.
  getTranscodeProgress: { method: 'GET', path: ':id/progress', guards: ['AuthGuard', 'RolesGuard'], httpCode: null, rolesGuardOptions: { permissions: MANAGE, optional: false, requireOwner: false }, authGuardOptions: null }
};

// Module-level @Controller() prefix MUST stay empty: the /api/media prefix is
// applied by RouterModule binding, not the controller. Nest normalizes an empty
// @Controller() to '/'. If a split controller is given @Controller('media'),
// its prefix here becomes 'media' and this assertion fails (catches risk R1).
const EXPECTED_CLASS_PREFIX = '/';

describe('Media route metadata (Phase 7.2 characterization)', () => {
  const routes = resolveRoutes();
  const expectedNames = Object.keys(EXPECTED);

  it('exposes exactly the 53 expected handlers, no more no less', () => {
    expect(Object.keys(routes).sort()).toEqual(expectedNames.sort());
  });

  it.each(expectedNames)('%s pins its method, path, guards, http code, and guard options', (name) => {
    const actual = routes[name];
    expect(actual).toBeDefined();
    const { method, path, guards, httpCode, rolesGuardOptions, authGuardOptions } = actual;
    expect({ method, path, guards, httpCode, rolesGuardOptions, authGuardOptions }).toEqual(EXPECTED[name]);
  });

  it('keeps an empty (root) class-level prefix on every media controller', () => {
    const prefixes = resolveClassPrefixes();
    for (const controller of MEDIA_CONTROLLERS) {
      expect(prefixes[controller.name]).toBe(EXPECTED_CLASS_PREFIX);
    }
  });

  it('protects every write route with [AuthGuard, RolesGuard] and MANAGE_MEDIA', () => {
    for (const [name, exp] of Object.entries(EXPECTED)) {
      const isWrite = exp.method !== 'GET';
      if (!isWrite) continue;
      expect(routes[name].guards).toEqual(['AuthGuard', 'RolesGuard']);
      expect(routes[name].rolesGuardOptions).toMatchObject({ permissions: MANAGE, optional: false });
    }
  });

  it('keeps both opt-auth flags on every public-readable route', () => {
    for (const [name, exp] of Object.entries(EXPECTED)) {
      if (exp.authGuardOptions === null) continue;
      expect(routes[name].authGuardOptions).toEqual({ anonymous: true });
      expect(routes[name].rolesGuardOptions).toMatchObject({ optional: true });
    }
  });

  it('preserves the exact effective route list for the post-split route-map diff', () => {
    const effective = Object.values(EXPECTED)
      .map((r) => `${r.method} /api/media${r.path === '/' ? '' : '/' + r.path}`)
      .sort();
    const actual = Object.values(routes)
      .map((r) => `${r.method} /api/media${r.path === '/' ? '' : '/' + r.path}`)
      .sort();
    expect(actual).toEqual(effective);
  });
});
