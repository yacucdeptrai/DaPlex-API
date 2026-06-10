import { Test, TestingModule } from '@nestjs/testing';
import { TVEpisodeController } from './tv-episode.controller';
import { MediaService } from './media.service';

describe('TVEpisodeController', () => {
  let controller: TVEpisodeController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TVEpisodeController],
      providers: [MediaService]
    })
      .useMocker(() => ({}))
      .compile();

    controller = module.get<TVEpisodeController>(TVEpisodeController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
