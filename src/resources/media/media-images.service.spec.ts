import { Test, TestingModule } from '@nestjs/testing';

import { MediaImagesService } from './media-images.service';
import { CloudflareR2Service } from '../../common/modules/cloudflare-r2';
import { CloudflareR2Container } from '../../enums';

/**
 * Characterization tests for the dependency-light branching piece of the image
 * group, deleteMediaImage. The poster / backdrop / still upload+delete methods
 * are I/O-heavy and were moved verbatim from MediaService; deleteMediaImage is
 * the one method with an observable branch (skip vs delete), so it is pinned
 * here. DI of the full service is covered by the smoke test plus the controller
 * and module specs that compile against the real wiring.
 */
describe('MediaImagesService (characterization)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let target: any;
  let cloudflareR2Service: { delete: jest.Mock; upload: jest.Mock };

  beforeEach(async () => {
    cloudflareR2Service = { delete: jest.fn(), upload: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({ providers: [MediaImagesService] })
      .useMocker((token) => {
        if (token === CloudflareR2Service) return cloudflareR2Service;
        return {};
      })
      .compile();
    target = module.get<MediaImagesService>(MediaImagesService);
  });

  it('is defined', () => expect(target).toBeDefined());

  describe('deleteMediaImage', () => {
    it('does nothing when the image is falsy', async () => {
      await target.deleteMediaImage(undefined, CloudflareR2Container.POSTERS);
      expect(cloudflareR2Service.delete).not.toHaveBeenCalled();
    });

    it('deletes the image at "<id>/<name>" in the given container', async () => {
      const image = { _id: BigInt(123), name: 'poster.jpg' };
      await target.deleteMediaImage(image, CloudflareR2Container.POSTERS);
      expect(cloudflareR2Service.delete).toHaveBeenCalledTimes(1);
      expect(cloudflareR2Service.delete).toHaveBeenCalledWith(CloudflareR2Container.POSTERS, '123/poster.jpg');
    });

    it('uses the container argument it is given (backdrops / stills)', async () => {
      const image = { _id: BigInt(456), name: 'still.png' };
      await target.deleteMediaImage(image, CloudflareR2Container.STILLS);
      expect(cloudflareR2Service.delete).toHaveBeenCalledWith(CloudflareR2Container.STILLS, '456/still.png');
    });
  });
});
