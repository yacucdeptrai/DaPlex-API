import { Test, TestingModule } from '@nestjs/testing';
import { PlaylistsController } from './playlists.controller';
import { PlaylistsService } from './playlists.service';

describe('PlaylistsController', () => {
  let controller: PlaylistsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PlaylistsController],
      providers: [PlaylistsService]
    }).useMocker(() => ({})).compile();

    controller = module.get<PlaylistsController>(PlaylistsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
