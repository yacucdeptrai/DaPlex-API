import { Test, TestingModule } from '@nestjs/testing';
import { MediaVideoController } from './media-video.controller';
import { MediaService } from './media.service';

describe('MediaVideoController', () => {
  let controller: MediaVideoController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MediaVideoController],
      providers: [MediaService]
    })
      .useMocker(() => ({}))
      .compile();

    controller = module.get<MediaVideoController>(MediaVideoController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
