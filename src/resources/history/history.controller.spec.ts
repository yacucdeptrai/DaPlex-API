import { Test, TestingModule } from '@nestjs/testing';
import { PATH_METADATA, METHOD_METADATA, GUARDS_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';

import { HistoryController } from './history.controller';
import { HistoryService } from './history.service';
import { AuthGuard } from '../auth/guards/auth.guard';

// Reflect the route metadata of a controller handler: declared sub-path, HTTP
// method, and the guard class names applied to it. Lets the route-surface specs
// assert the contract without a running Fastify server.
function routeMeta(handler: (...args: any[]) => any) {
  const path = Reflect.getMetadata(PATH_METADATA, handler);
  const method: number = Reflect.getMetadata(METHOD_METADATA, handler);
  const guards: any[] = Reflect.getMetadata(GUARDS_METADATA, handler) ?? [];
  return { path, method, guards: guards.map((g) => (typeof g === 'function' ? g.name : g?.constructor?.name)) };
}

describe('HistoryController', () => {
  let controller: HistoryController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HistoryController],
      providers: [HistoryService]
    })
      .useMocker(() => ({}))
      .compile();

    controller = module.get<HistoryController>(HistoryController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // CHARACTERIZATION — existing route surface. Locks method/path/guards so the
  // W0.9 addition cannot silently drift an existing handler. The class-level
  // @Controller() prefix MUST stay empty (the /api/history prefix is applied by
  // RouterModule, exactly like media.routes.spec.ts documents for media).
  // ---------------------------------------------------------------------------
  describe('existing route metadata (characterization)', () => {
    it('keeps an empty (root) class-level prefix', () => {
      expect(Reflect.getMetadata(PATH_METADATA, HistoryController)).toBe('/');
    });

    it('findAll → GET / guarded by AuthGuard', () => {
      const m = routeMeta(HistoryController.prototype.findAll);
      expect(m.method).toBe(RequestMethod.GET);
      expect(m.path).toBe('/');
      expect(m.guards).toContain('AuthGuard');
    });

    it('update → PATCH :id guarded by AuthGuard', () => {
      const m = routeMeta(HistoryController.prototype.update);
      expect(m.method).toBe(RequestMethod.PATCH);
      expect(m.path).toBe(':id');
      expect(m.guards).toContain('AuthGuard');
    });

    it('findOneWatchTime → GET watch_time guarded by AuthGuard', () => {
      const m = routeMeta(HistoryController.prototype.findOneWatchTime);
      expect(m.method).toBe(RequestMethod.GET);
      expect(m.path).toBe('watch_time');
      expect(m.guards).toContain('AuthGuard');
    });

    it('updateWatchTime → PATCH watch_time guarded by AuthGuard', () => {
      const m = routeMeta(HistoryController.prototype.updateWatchTime);
      expect(m.method).toBe(RequestMethod.PATCH);
      expect(m.path).toBe('watch_time');
      expect(m.guards).toContain('AuthGuard');
    });

    it('remove → DELETE :id guarded by AuthGuard', () => {
      const m = routeMeta(HistoryController.prototype.remove);
      expect(m.method).toBe(RequestMethod.DELETE);
      expect(m.path).toBe(':id');
      expect(m.guards).toContain('AuthGuard');
    });
  });

  // ---------------------------------------------------------------------------
  // TDD — NEW route: markWatched. Expected RED until the surgeon adds the handler.
  // Locked shape (analyst brief): @Patch(':mediaId/watched'), AuthGuard, delegates
  // to historyService.markWatched(mediaId, dto, authUser).
  // ---------------------------------------------------------------------------
  describe('markWatched route (TDD — RED until surgeon)', () => {
    it('exposes a markWatched handler at PATCH :mediaId/watched guarded by AuthGuard', () => {
      const handler = (HistoryController.prototype as any).markWatched;
      expect(typeof handler).toBe('function');
      const m = routeMeta(handler);
      expect(m.method).toBe(RequestMethod.PATCH);
      // 2-segment path — collision-proof against :id and watch_time at every router level.
      expect(m.path).toBe(':mediaId/watched');
      expect(m.guards).toContain('AuthGuard');
    });

    it('delegates to historyService.markWatched(mediaId, dto, authUser)', async () => {
      const markWatched = jest.fn().mockResolvedValue({ watched: 1 });
      const localController = new HistoryController({ markWatched } as unknown as HistoryService);

      const authUser: any = { _id: BigInt(1) };
      const mediaId = BigInt(50);
      const dto: any = { episode: BigInt(60), watched: 1 };

      await (localController as any).markWatched(authUser, mediaId, dto);

      expect(markWatched).toHaveBeenCalledWith(mediaId, dto, authUser);
    });

    it('uses AuthGuard but no admin RolesGuard (standard user-scoped CRUD)', () => {
      const handler = (HistoryController.prototype as any).markWatched;
      expect(typeof handler).toBe('function');
      const m = routeMeta(handler);
      expect(m.guards).toContain('AuthGuard');
      expect(m.guards).not.toContain('RolesGuard');
    });
  });
});

// Reference the import so an unused-symbol lint does not strip it; AuthGuard is the
// class the metadata assertions match against by name.
void AuthGuard;
