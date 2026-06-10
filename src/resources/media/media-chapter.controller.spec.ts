import { Test, TestingModule } from '@nestjs/testing';
import { MediaChapterController } from './media-chapter.controller';
import { MediaService } from './media.service';

describe('MediaChapterController', () => {
  let controller: MediaChapterController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MediaChapterController],
      providers: [MediaService]
    })
      .useMocker(() => ({}))
      .compile();

    controller = module.get<MediaChapterController>(MediaChapterController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
