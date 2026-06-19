import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken, getConnectionToken } from '@nestjs/mongoose';

import { TagsService } from './tags.service';
import { MediaTag, MediaTagSchema } from '../../schemas';
import { AuditLogService } from '../audit-log/audit-log.service';
import { MediaService } from '../media/media.service';
import { WsAdminGateway } from '../ws-admin';
import { MongooseConnection } from '../../enums';

// The case-insensitive collation FU18 must thread onto the dedup upsert.
const EXPECTED_COLLATION = { locale: 'en', strength: 2 };

describe('TagsService', () => {
  let service: TagsService;
  // createMany() dedups via mediaTagModel.findOneAndUpdate(...). We capture its options
  // object to assert the collation, returning a raw result shaped like Mongoose's
  // { lastErrorObject, value } so createMany completes.
  let mediaTagModel: { findOneAndUpdate: jest.Mock };

  beforeEach(async () => {
    let nextId = 1;
    mediaTagModel = {
      findOneAndUpdate: jest.fn().mockImplementation(() =>
        Promise.resolve({ lastErrorObject: { updatedExisting: false }, value: { _id: BigInt(nextId++), name: 'x' } })
      )
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [TagsService]
    })
      .useMocker((token): any => {
        if (token === getModelToken(MediaTag.name, MongooseConnection.DATABASE_A)) return mediaTagModel;
        if (token === getConnectionToken(MongooseConnection.DATABASE_A)) return {};
        if (token === AuditLogService) return { createManyLogs: jest.fn().mockResolvedValue(undefined) };
        if (token === MediaService) return {};
        if (token === WsAdminGateway) return { server: { sockets: { get: () => undefined }, to: () => ({ emit: () => undefined }) } };
        return {};
      })
      .compile();

    service = module.get<TagsService>(TagsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // FU18 — case-insensitive dedup normalization (same rationale as GenresService spec):
  // a hand mock can't honor collation, so the strongest unit-level proxy is (a) the
  // runtime findOneAndUpdate option AND (b) the compiled `name` index collation. Both
  // RED on the unchanged collation-less code; integration-level one-document collapse
  // is noted as a gap in the baseline.
  describe('FU18 case-insensitive dedup', () => {
    it('createMany passes collation { locale: en, strength: 2 } to findOneAndUpdate', async () => {
      await service.createMany([{ name: 'Time Travel' }], BigInt(1));

      expect(mediaTagModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
      const options = mediaTagModel.findOneAndUpdate.mock.calls[0][2];
      expect(options).toEqual(expect.objectContaining({ collation: EXPECTED_COLLATION }));
    });

    it('still upserts each name (upsert option preserved alongside collation)', async () => {
      await service.createMany([{ name: 'Time Travel' }, { name: 'Dystopia' }], BigInt(1));

      expect(mediaTagModel.findOneAndUpdate).toHaveBeenCalledTimes(2);
      const options = mediaTagModel.findOneAndUpdate.mock.calls[0][2];
      expect(options).toEqual(expect.objectContaining({ upsert: true }));
    });

    it('compiled `name` unique index declares the same collation', () => {
      const nameIndex = MediaTagSchema.indexes().find(([keys]) => (keys as Record<string, unknown>)['name'] === 1);
      expect(nameIndex).toBeDefined();
      const [, options] = nameIndex!;
      expect(options).toEqual(expect.objectContaining({ collation: EXPECTED_COLLATION }));
    });
  });
});
