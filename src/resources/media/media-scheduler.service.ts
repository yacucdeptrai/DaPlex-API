import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Cron } from '@nestjs/schedule';

import { Media, MediaDocument, DriveSession, DriveSessionDocument } from '../../schemas';
import { OnedriveService } from '../../common/modules/onedrive/onedrive.service';
import { FilerService } from '../../common/modules/filer/filer.service';
import { S3Service } from '../../common/modules/s3/s3.service';
import { MongooseConnection, CloudStorage } from '../../enums';

/**
 * Scheduled maintenance jobs for media: prunes expired upload sessions (and their
 * orphaned storage folders) and zeroes the daily/weekly/monthly view counters.
 * Carries its own resolveStorageService copy, reading the same injected storage
 * services as MediaService so routing is identical.
 */
@Injectable()
export class MediaSchedulerService {
  constructor(
    @InjectModel(Media.name, MongooseConnection.DATABASE_A) private mediaModel: Model<MediaDocument>,
    @InjectModel(DriveSession.name, MongooseConnection.DATABASE_A)
    private driveSessionModel: Model<DriveSessionDocument>,
    private onedriveService: OnedriveService,
    private filerService: FilerService,
    private s3Service: S3Service
  ) {}

  /**
   * Resolves the cloud-storage service for a storage kind:
   * `FILER → filer / S3 → s3 / else → onedrive`. Each service keeps its own
   * findId / findPath / deleteFolder retry defaults since its own method is invoked.
   */
  private resolveStorageService(kind: number): FilerService | S3Service | OnedriveService {
    if (kind === CloudStorage.FILER) return this.filerService;
    if (kind === CloudStorage.S3) return this.s3Service;
    return this.onedriveService;
  }

  @Cron('0 0 0 * * *')
  async removeOldUploadSessionsCron() {
    const uploadSessions = await this.driveSessionModel
      .find({ expiry: { $lte: new Date() } })
      .populate('storage')
      .lean()
      .exec();
    await this.driveSessionModel.deleteMany({ expiry: { $lte: new Date() } }).exec();
    for (let i = 0; i < uploadSessions.length; i++) {
      const session = uploadSessions[i];
      await this.resolveStorageService(session.storage.kind).deleteFolder(session._id, session.storage);
    }
  }

  @Cron('0 0 * * *')
  async resetDailyViewsCron() {
    await this.mediaModel.updateMany({ dailyViews: { $gt: 0 } }, { dailyViews: 0 }).exec();
  }

  @Cron('0 0 * * 1')
  async resetWeeklyViewsCron() {
    await this.mediaModel.updateMany({ weeklyViews: { $gt: 0 } }, { weeklyViews: 0 }).exec();
  }

  @Cron('0 0 1 * *')
  async resetMonthlyViewsCron() {
    await this.mediaModel.updateMany({ monthlyViews: { $gt: 0 } }, { monthlyViews: 0 }).exec();
  }
}
