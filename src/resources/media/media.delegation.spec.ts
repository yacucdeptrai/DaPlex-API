import { resolveDelegations, MediaServiceKey, MEDIA_SERVICE_KEYS } from './media-routes.fixture';

// Characterization net for the Phase 7.2 controller split, delegation half.
// media.routes.spec.ts pins the HTTP surface (method/path/guards/options); this
// spec pins the OTHER contract the split can silently break: which injected
// service.method each handler forwards to. The brief flags this as the highest
// drift risk (R8) — when handlers move into MediaVideoController/MovieController
// etc. and a controller injects several services, a moved handler can compile
// while now calling the wrong service (e.g. updateTVEpisode delegates to
// mediaService, NOT mediaTVEpisodesService, even though addTVEpisode uses
// mediaTVEpisodesService). Each handler is invoked with sentinel args against
// recording-proxy services, so this is controller-shape-agnostic: it reads from
// MEDIA_CONTROLLERS and survives the split unchanged.

interface Expected {
  service: MediaServiceKey;
  method: string;
}

// One row per handler = the exact (injected service, method) it delegates to on
// the unchanged controller at branch master @ 5eaf3bc. Sourced from the 52
// `return this.<service>.<method>(...)` lines in media.controller.ts.
const EXPECTED: Record<string, Expected> = {
  // media CRUD -> mediaService
  create: { service: 'mediaService', method: 'create' },
  findAll: { service: 'mediaService', method: 'findAll' },
  findAllCursor: { service: 'mediaService', method: 'findAllCursor' },
  findOne: { service: 'mediaService', method: 'findOne' },
  update: { service: 'mediaService', method: 'update' },
  remove: { service: 'mediaService', method: 'remove' },
  // media videos -> mediaVideosService
  addMediaVideo: { service: 'mediaVideosService', method: 'addMediaVideo' },
  findAllMediaVideos: { service: 'mediaVideosService', method: 'findAllMediaVideos' },
  updateMediaVideo: { service: 'mediaVideosService', method: 'updateMediaVideo' },
  deleteMediaVideo: { service: 'mediaVideosService', method: 'deleteMediaVideo' },
  deleteMediaVideos: { service: 'mediaVideosService', method: 'deleteMediaVideos' },
  // poster + backdrop images -> mediaImagesService (NOT mediaService)
  updatePoster: { service: 'mediaImagesService', method: 'uploadMediaPoster' },
  deletePoster: { service: 'mediaImagesService', method: 'deleteMediaPoster' },
  updateBackdrop: { service: 'mediaImagesService', method: 'uploadMediaBackdrop' },
  deleteBackdrop: { service: 'mediaImagesService', method: 'deleteMediaBackdrop' },
  // movie subtitles -> mediaSubtitlesService
  updateMovieSubtitle: { service: 'mediaSubtitlesService', method: 'uploadMovieSubtitle' },
  findAllMovieSubtitles: { service: 'mediaSubtitlesService', method: 'findAllMovieSubtitles' },
  deleteMovieSubtitle: { service: 'mediaSubtitlesService', method: 'deleteMovieSubtitle' },
  deleteMovieSubtitles: { service: 'mediaSubtitlesService', method: 'deleteMovieSubtitles' },
  // movie source + streams -> mediaService (NOT a videos/source service)
  addMovieSource: { service: 'mediaService', method: 'uploadMovieSource' },
  addLinkedMovieSource: { service: 'mediaService', method: 'addLinkedMovieSource' },
  encodeMovieSource: { service: 'mediaService', method: 'encodeMovieSource' },
  saveMovieSource: { service: 'mediaService', method: 'saveMovieSource' },
  deleteMovieSource: { service: 'mediaService', method: 'deleteMovieSource' },
  findAllMovieStreams: { service: 'mediaService', method: 'findAllMovieStreams' },
  // movie chapters -> mediaChaptersService
  addMovieChapter: { service: 'mediaChaptersService', method: 'addMovieChapter' },
  findAllMovieChapters: { service: 'mediaChaptersService', method: 'findAllMovieChapters' },
  updateMovieChapter: { service: 'mediaChaptersService', method: 'updateMovieChapter' },
  deleteMovieChapter: { service: 'mediaChaptersService', method: 'deleteMovieChapter' },
  deleteMovieChapters: { service: 'mediaChaptersService', method: 'deleteMovieChapters' },
  // TV episodes CRUD -> SPLIT: add/findAll/findOne use mediaTVEpisodesService,
  // but update/delete use mediaService. This asymmetry is the exact trap.
  addTVEpisode: { service: 'mediaTVEpisodesService', method: 'addTVEpisode' },
  findAllTVEpisodes: { service: 'mediaTVEpisodesService', method: 'findAllTVEpisodes' },
  findOneTVEpisode: { service: 'mediaTVEpisodesService', method: 'findOneTVEpisode' },
  updateTVEpisode: { service: 'mediaService', method: 'updateTVEpisode' },
  deleteTVEpisode: { service: 'mediaService', method: 'deleteTVEpisode' },
  // TV episode still images -> mediaImagesService
  updateTVEpisodeStill: { service: 'mediaImagesService', method: 'uploadTVEpisodeStill' },
  deleteTVEpisodeStill: { service: 'mediaImagesService', method: 'deleteTVEpisodeStill' },
  // TV episode subtitles -> mediaSubtitlesService
  updateTVEpisodeSubtitle: { service: 'mediaSubtitlesService', method: 'uploadTVEpisodeSubtitle' },
  findAllTVEpisodeSubtitles: { service: 'mediaSubtitlesService', method: 'findAllTVEpisodeSubtitles' },
  deleteTVSubtitle: { service: 'mediaSubtitlesService', method: 'deleteTVEpisodeSubtitle' },
  deleteTVSubtitles: { service: 'mediaSubtitlesService', method: 'deleteTVEpisodeSubtitles' },
  // TV episode source + streams -> mediaService
  addTVEpisodeSource: { service: 'mediaService', method: 'uploadTVEpisodeSource' },
  addLinkedTVEpisodeSource: { service: 'mediaService', method: 'addLinkedTVEpisodeSource' },
  encodeTVEpisodeSource: { service: 'mediaService', method: 'encodeTVEpisodeSource' },
  saveTVEpisodeSource: { service: 'mediaService', method: 'saveTVEpisodeSource' },
  deleteTVEpisodeSource: { service: 'mediaService', method: 'deleteTVEpisodeSource' },
  findAllTVEpisodeStreams: { service: 'mediaService', method: 'findAllTVEpisodeStreams' },
  // TV episode chapters -> mediaChaptersService
  addTVEpisodeChapter: { service: 'mediaChaptersService', method: 'addTVEpisodeChapter' },
  findAllTVEpisodeChapters: { service: 'mediaChaptersService', method: 'findAllTVEpisodeChapters' },
  updateTVEpisodeChapter: { service: 'mediaChaptersService', method: 'updateTVEpisodeChapter' },
  deleteTVEpisodeChapter: { service: 'mediaChaptersService', method: 'deleteTVEpisodeChapter' },
  deleteTVEpisodeChapters: { service: 'mediaChaptersService', method: 'deleteTVEpisodeChapters' }
};

describe('Media handler delegation (Phase 7.2 characterization)', () => {
  const delegations = resolveDelegations();
  const expectedNames = Object.keys(EXPECTED);

  it('drives delegation off the canonical 6-service constructor order', () => {
    // Guards the fixture contract the split must preserve: the per-controller
    // constructor still lists its injected services in this relative order.
    expect(MEDIA_SERVICE_KEYS).toEqual([
      'mediaService',
      'mediaSubtitlesService',
      'mediaImagesService',
      'mediaVideosService',
      'mediaChaptersService',
      'mediaTVEpisodesService'
    ]);
  });

  it('covers exactly the 52 route handlers, no more no less', () => {
    expect(Object.keys(delegations).sort()).toEqual(expectedNames.sort());
  });

  it.each(expectedNames)('%s delegates to exactly one service method', (name) => {
    const records = delegations[name];
    expect(records).toBeDefined();
    // Every handler today forwards to a single service method; >1 or 0 means a
    // handler body changed shape and the delegation contract drifted.
    expect(records).toHaveLength(1);
  });

  it.each(expectedNames)('%s delegates to the expected service.method', (name) => {
    const [record] = delegations[name];
    expect({ service: record.service, method: record.method }).toEqual(EXPECTED[name]);
  });

  it('forwards a non-empty positional argument list for every handler', () => {
    // Sanity: no handler is recorded calling its service with zero args. This is
    // not an exact-arg assertion (handler signatures bind params by decorator at
    // runtime, which we bypass here), but it catches a handler that stops
    // forwarding entirely after a move.
    for (const name of expectedNames) {
      expect(delegations[name][0].args.length).toBeGreaterThan(0);
    }
  });
});
