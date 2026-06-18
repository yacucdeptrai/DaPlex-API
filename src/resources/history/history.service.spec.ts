import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';

import { HistoryService } from './history.service';
import { MediaService } from '../media/media.service';
import { MongooseConnection } from '../../enums';
import { History } from '../../schemas';

// Walks the built pipeline and pulls out the parts the inProgress filter touches.
function inspectPipeline(pipeline: any[]) {
  const matchStage = pipeline.find((stage) => stage.$match);
  const facetStage = pipeline.find((stage) => stage.$facet);
  const stage2: any[] = facetStage?.$facet?.stage2 ?? [];
  const hasGroupByDate = stage2.some((stage) => stage.$addFields?.groupByDate != undefined);
  return { filters: matchStage?.$match, hasGroupByDate };
}

describe('HistoryService', () => {
  let service: HistoryService;
  let aggregate: jest.Mock;
  let exec: jest.Mock;

  const headers: any = { acceptLanguage: ['en'] };
  const authUser: any = { _id: BigInt(1) };

  beforeEach(async () => {
    exec = jest.fn().mockResolvedValue([undefined]);
    aggregate = jest.fn().mockReturnValue({ exec });
    const historyModel = { aggregate };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HistoryService,
        { provide: getModelToken(History.name, MongooseConnection.DATABASE_A), useValue: historyModel },
        { provide: MediaService, useValue: {} }
      ]
    }).compile();

    service = module.get<HistoryService>(HistoryService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('findAll inProgress filter', () => {
    it('excludes finished (watched >= 1) and not-started (time === 0) via doc filters', async () => {
      await service.findAll({ inProgress: true } as any, headers, authUser);

      const { filters } = inspectPipeline(aggregate.mock.calls[0][0]);
      // watched is a finish COUNT in the schema; < 1 means not yet finished.
      expect(filters.watched).toEqual({ $lt: 1 });
      // time > 0 means the user actually started watching.
      expect(filters.time).toEqual({ $gt: 0 });
      expect(filters.user).toBe(authUser._id);
    });

    it('returns a flat recency-sorted list (omits the date-grouping stage)', async () => {
      await service.findAll({ inProgress: true } as any, headers, authUser);

      const pipeline = aggregate.mock.calls[0][0];
      const { hasGroupByDate } = inspectPipeline(pipeline);
      expect(hasGroupByDate).toBe(false);
      const sortStage = pipeline.find((stage: any) => stage.$sort);
      expect(sortStage.$sort).toEqual({ date: -1 });
    });

    it('leaves the default (no inProgress) list unchanged — still date-grouped, no extra filters', async () => {
      await service.findAll({} as any, headers, authUser);

      const { filters, hasGroupByDate } = inspectPipeline(aggregate.mock.calls[0][0]);
      expect(filters.watched).toBeUndefined();
      expect(filters.time).toBeUndefined();
      expect(filters.user).toBe(authUser._id);
      expect(hasGroupByDate).toBe(true);
    });
  });
});
