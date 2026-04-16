import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { plainToClassFromExist } from 'class-transformer';

import { AuditLog as AuditLogSchema, AuditLogDocument } from '../../schemas';
import { CursorPaginated } from '../../common/entities';
import { AuditLogBuilder, createSnowFlakeId, MongooseCursorPagination } from '../../utils';
import { MongooseConnection, StatusCode } from '../../enums';

import { CursorPageAuditLogDto } from './dto';
import { AuditLog as AuditLogEntity } from './entities';

@Injectable()
export class AuditLogService {
  constructor(@InjectModel(AuditLogSchema.name, MongooseConnection.DATABASE_B) private auditLogModel: Model<AuditLogDocument>) {}

  findAll() {
    return this.auditLogModel.find().sort({ _id: -1 }).limit(50).lean().exec();
  }

  async findAllCursor(cursorPageAuditLogsDto: CursorPageAuditLogDto) {
    const { pageToken, limit, sort, type, targetRef, target, user, startDate, endDate } = cursorPageAuditLogsDto;

    const sortEnum = ['_id', 'createdAt'];
    const sortQuery = sort || 'desc(_id)';

    const filters: { [key: string]: any } = {};
    type != undefined && (filters.type = type);
    targetRef != undefined && (filters.targetRef = targetRef);
    target != undefined && (filters.target = target);
    user != undefined && (filters.user = user);
    if (startDate != undefined || endDate != undefined) {
      filters.createdAt = {
        ...(startDate != undefined ? { $gte: startDate } : {}),
        ...(endDate != undefined ? { $lte: endDate } : {})
      };
    }

    const fields: { [key: string]: any } = { _id: 1, user: 1, target: 1, targetRef: 1, type: 1, changes: 1, createdAt: 1 };
    const typeMap = new Map<string, any>([
      ['_id', BigInt],
      ['createdAt', Date],
      ['user', BigInt],
      ['target', BigInt]
    ]);

    const aggregation = new MongooseCursorPagination({
      pageToken,
      limit,
      sortQuery,
      sortEnum,
      filters,
      fields,
      typeMap
    });

    const [data] = await this.auditLogModel.aggregate(aggregation.build()).exec();
    let logs = new CursorPaginated<AuditLogEntity>();
    if (data) {
      logs = plainToClassFromExist(new CursorPaginated<AuditLogEntity>({ type: AuditLogEntity }), {
        totalResults: data.totalResults,
        results: data.results,
        hasNextPage: data.hasNextPage,
        nextPageToken: data.nextPageToken,
        prevPageToken: data.prevPageToken
      });
    }
    return logs;
  }

  async findOne(id: bigint) {
    const auditLog = await this.auditLogModel.findOne({ _id: id }, { _id: 1, user: 1, target: 1, targetRef: 1, type: 1, changes: 1, createdAt: 1 }).lean().exec();

    if (!auditLog) throw new HttpException({ code: StatusCode.AUDIT_LOG_NOT_FOUND, message: 'Audit log not found' }, HttpStatus.NOT_FOUND);

    return auditLog;
  }

  async createLog(userId: bigint, targetId: bigint, targetRef: string, type: number) {
    const log = new this.auditLogModel();
    log._id = await createSnowFlakeId();
    log.user = <any>userId;
    log.target = targetId;
    log.targetRef = targetRef;
    log.type = type;
    await this.auditLogModel.create(log);
  }

  async createManyLogs(userId: bigint, targetIds: bigint[], targetRef: string, type: number) {
    const logs = [];
    for (let i = 0; i < targetIds.length; i++) {
      const log = new this.auditLogModel();
      log._id = await createSnowFlakeId();
      log.user = <any>userId;
      log.target = targetIds[i];
      log.targetRef = targetRef;
      log.type = type;
      logs.push(log);
    }
    await this.auditLogModel.insertMany(logs, { lean: true });
  }

  async createLogFromBuilder(builder: AuditLogBuilder) {
    const log = new this.auditLogModel();
    log._id = await createSnowFlakeId();
    log.user = <any>builder.user;
    log.target = builder.target;
    log.targetRef = builder.targetRef;
    log.type = builder.type;
    log.changes.push(...builder.changes);
    await this.auditLogModel.create(log);
  }

  async createManyLogsFromBuilder(builders: AuditLogBuilder[]) {
    const logs = [];
    for (let i = 0; i < builders.length; i++) {
      const builder = builders[i];
      const log = new this.auditLogModel();
      log._id = await createSnowFlakeId();
      log.user = <any>builder.user;
      log.target = builder.target;
      log.targetRef = builder.targetRef;
      log.type = builder.type;
      log.changes.push(...builder.changes);
      logs.push(log);
    }
    await this.auditLogModel.insertMany(logs, { lean: true });
  }
}
