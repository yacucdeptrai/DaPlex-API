import { Test, TestingModule } from '@nestjs/testing';

import { MediaSchedulerService } from './media-scheduler.service';
import { CloudStorage } from '../../enums';

/**
 * Characterization tests for the 4 @Cron scheduled jobs that currently live on
 * MediaService: removeOldUploadSessionsCron, resetDailyViewsCron,
 * resetWeeklyViewsCron, resetMonthlyViewsCron. These pin the exact Mongoose
 * calls (filter+update pairs, the $gt:0 guard, the expiry $lte filter, the
 * per-session deleteFolder routing) so an extraction into MediaSchedulerService
 * cannot drift the observable behaviour.
 *
 * Capture-then-repoint: behaviour is pinned against MediaService now; after the
 * surgeon moves the methods, the same assertions repoint to MediaSchedulerService
 * unchanged (import + the `target = module.get(...)` line are the only edits).
 */
describe('Media scheduled jobs (characterization)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let target: any;
  let mediaModel: { updateMany: jest.Mock };
  let driveSessionModel: { find: jest.Mock; deleteMany: jest.Mock };
  let filerService: { deleteFolder: jest.Mock };
  let s3Service: { deleteFolder: jest.Mock };
  let onedriveService: { deleteFolder: jest.Mock };

  // Mongoose chain that ends in `.exec()`.
  const execChain = () => ({ exec: jest.fn().mockResolvedValue(undefined) });
  // driveSessionModel.find(...).populate('storage').lean().exec() chain.
  const findChain = (result: unknown[]) => ({
    populate: jest.fn().mockReturnValue({
      lean: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(result) })
    })
  });

  beforeEach(async () => {
    mediaModel = { updateMany: jest.fn().mockReturnValue(execChain()) };
    driveSessionModel = {
      find: jest.fn().mockReturnValue(findChain([])),
      deleteMany: jest.fn().mockReturnValue(execChain())
    };
    filerService = { deleteFolder: jest.fn().mockResolvedValue(undefined) };
    s3Service = { deleteFolder: jest.fn().mockResolvedValue(undefined) };
    onedriveService = { deleteFolder: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({ providers: [MediaSchedulerService] })
      .useMocker(() => ({}))
      .compile();
    target = module.get<MediaSchedulerService>(MediaSchedulerService);
    target.mediaModel = mediaModel;
    target.driveSessionModel = driveSessionModel;
    target.filerService = filerService;
    target.s3Service = s3Service;
    target.onedriveService = onedriveService;
  });

  it('is defined', () => expect(target).toBeDefined());

  describe('view-reset crons', () => {
    it('resetDailyViewsCron zeroes dailyViews where it is greater than 0', async () => {
      await target.resetDailyViewsCron();
      expect(mediaModel.updateMany).toHaveBeenCalledTimes(1);
      expect(mediaModel.updateMany).toHaveBeenCalledWith({ dailyViews: { $gt: 0 } }, { dailyViews: 0 });
    });

    it('resetWeeklyViewsCron zeroes weeklyViews where it is greater than 0', async () => {
      await target.resetWeeklyViewsCron();
      expect(mediaModel.updateMany).toHaveBeenCalledTimes(1);
      expect(mediaModel.updateMany).toHaveBeenCalledWith({ weeklyViews: { $gt: 0 } }, { weeklyViews: 0 });
    });

    it('resetMonthlyViewsCron zeroes monthlyViews where it is greater than 0', async () => {
      await target.resetMonthlyViewsCron();
      expect(mediaModel.updateMany).toHaveBeenCalledTimes(1);
      expect(mediaModel.updateMany).toHaveBeenCalledWith({ monthlyViews: { $gt: 0 } }, { monthlyViews: 0 });
    });
  });

  describe('removeOldUploadSessionsCron', () => {
    it('finds and deletes expired sessions and deletes each orphaned folder via the routed storage service', async () => {
      const sessionA = { _id: BigInt(11), storage: { kind: CloudStorage.FILER } };
      const sessionB = { _id: BigInt(22), storage: { kind: CloudStorage.S3 } };
      driveSessionModel.find.mockReturnValue(findChain([sessionA, sessionB]));

      await target.removeOldUploadSessionsCron();

      // Find the expired set, populating the storage ref, as a lean read.
      expect(driveSessionModel.find).toHaveBeenCalledTimes(1);
      expect(driveSessionModel.find).toHaveBeenCalledWith({ expiry: { $lte: expect.any(Date) } });
      const findReturn = driveSessionModel.find.mock.results[0].value;
      expect(findReturn.populate).toHaveBeenCalledWith('storage');

      // Delete the same expired set.
      expect(driveSessionModel.deleteMany).toHaveBeenCalledTimes(1);
      expect(driveSessionModel.deleteMany).toHaveBeenCalledWith({ expiry: { $lte: expect.any(Date) } });

      // Per-session folder cleanup routed by storage kind.
      expect(filerService.deleteFolder).toHaveBeenCalledTimes(1);
      expect(filerService.deleteFolder).toHaveBeenCalledWith(sessionA._id, sessionA.storage);
      expect(s3Service.deleteFolder).toHaveBeenCalledTimes(1);
      expect(s3Service.deleteFolder).toHaveBeenCalledWith(sessionB._id, sessionB.storage);
      expect(onedriveService.deleteFolder).not.toHaveBeenCalled();
    });

    it('routes a non-FILER/non-S3 storage kind to onedriveService', async () => {
      const session = { _id: BigInt(33), storage: { kind: CloudStorage.ONEDRIVE } };
      driveSessionModel.find.mockReturnValue(findChain([session]));

      await target.removeOldUploadSessionsCron();

      expect(onedriveService.deleteFolder).toHaveBeenCalledTimes(1);
      expect(onedriveService.deleteFolder).toHaveBeenCalledWith(session._id, session.storage);
      expect(filerService.deleteFolder).not.toHaveBeenCalled();
      expect(s3Service.deleteFolder).not.toHaveBeenCalled();
    });

    it('still issues the deleteMany but calls no deleteFolder when no sessions are expired', async () => {
      driveSessionModel.find.mockReturnValue(findChain([]));

      await target.removeOldUploadSessionsCron();

      expect(driveSessionModel.deleteMany).toHaveBeenCalledTimes(1);
      expect(filerService.deleteFolder).not.toHaveBeenCalled();
      expect(s3Service.deleteFolder).not.toHaveBeenCalled();
      expect(onedriveService.deleteFolder).not.toHaveBeenCalled();
    });
  });

  describe('resolveStorageService routing', () => {
    it('maps FILER to filerService, S3 to s3Service, and any other kind to onedriveService', () => {
      expect(target.resolveStorageService(CloudStorage.FILER)).toBe(filerService);
      expect(target.resolveStorageService(CloudStorage.S3)).toBe(s3Service);
      expect(target.resolveStorageService(CloudStorage.ONEDRIVE)).toBe(onedriveService);
      expect(target.resolveStorageService(CloudStorage.GOOGLE_DRIVE)).toBe(onedriveService);
    });
  });
});
