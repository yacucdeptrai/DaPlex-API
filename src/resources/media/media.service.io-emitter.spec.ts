import { Test, TestingModule } from '@nestjs/testing';
import { MediaService } from './media.service';

/**
 * Characterization tests for resolveIoEmitter (Phase 6.3).
 *
 * 32 call sites duplicated the expression
 *   (headers.socketId && this.wsAdminGateway.server.sockets.get(headers.socketId))
 *     || this.wsAdminGateway.server
 * to pick a socket.io emitter target. These tests pin the resolution semantics
 * before that expression is extracted into a single private helper.
 */
describe('MediaService.resolveIoEmitter (characterization)', () => {
  let service: MediaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [MediaService]
    })
      .useMocker(() => ({}))
      .compile();

    service = module.get<MediaService>(MediaService);
  });

  const installGateway = () => {
    const socket = { id: 'sock-1', kind: 'socket' };
    const server = { kind: 'server', sockets: new Map<string, unknown>([['sock-1', socket]]) };
    (service as any).wsAdminGateway = { server };
    return { server, socket };
  };

  it('returns the full server when no socketId is provided', () => {
    const { server } = installGateway();
    expect((service as any).resolveIoEmitter(undefined)).toBe(server);
  });

  it('returns the targeted socket when the socketId is connected', () => {
    const { socket } = installGateway();
    expect((service as any).resolveIoEmitter('sock-1')).toBe(socket);
  });

  it('falls back to the full server when the socketId is unknown', () => {
    const { server } = installGateway();
    expect((service as any).resolveIoEmitter('ghost')).toBe(server);
  });

  it('falls back to the full server for an empty socketId', () => {
    const { server } = installGateway();
    expect((service as any).resolveIoEmitter('')).toBe(server);
  });
});
