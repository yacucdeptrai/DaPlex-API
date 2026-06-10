import { Test, TestingModule } from '@nestjs/testing';
import { MediaSubtitleController } from './media-subtitle.controller';
import { MediaService } from './media.service';

describe('MediaSubtitleController', () => {
  let controller: MediaSubtitleController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MediaSubtitleController],
      providers: [MediaService]
    })
      .useMocker(() => ({}))
      .compile();

    controller = module.get<MediaSubtitleController>(MediaSubtitleController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
