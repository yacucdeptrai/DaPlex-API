import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken, getConnectionToken } from '@nestjs/mongoose';

import { ProductionsService } from './productions.service';
import { Production, ProductionSchema } from '../../schemas';
import { AuditLogService } from '../audit-log/audit-log.service';
import { MediaService } from '../media/media.service';
import { WsAdminGateway } from '../ws-admin';
import { MongooseConnection } from '../../enums';

// The case-insensitive collation FU18 must thread onto the dedup upsert.
const EXPECTED_COLLATION = { locale: 'en', strength: 2 };

describe('ProductionsService', () => {
  let service: ProductionsService;
  // createMany() dedups via productionModel.findOneAndUpdate(...). We capture its
  // options object to assert the collation, returning a raw result shaped like
  // Mongoose's { lastErrorObject, value } so createMany completes.
  let productionModel: { findOneAndUpdate: jest.Mock };

  beforeEach(async () => {
    let nextId = 1;
    productionModel = {
      findOneAndUpdate: jest.fn().mockImplementation(() =>
        Promise.resolve({ lastErrorObject: { updatedExisting: false }, value: { _id: BigInt(nextId++), name: 'x' } })
      )
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [ProductionsService]
    })
      .useMocker((token): any => {
        if (token === getModelToken(Production.name, MongooseConnection.DATABASE_A)) return productionModel;
        if (token === getConnectionToken(MongooseConnection.DATABASE_A)) return {};
        if (token === AuditLogService) return { createManyLogs: jest.fn().mockResolvedValue(undefined) };
        if (token === MediaService) return {};
        if (token === WsAdminGateway) return { server: { sockets: { get: () => undefined }, to: () => ({ emit: () => undefined }) } };
        return {};
      })
      .compile();

    service = module.get<ProductionsService>(ProductionsService);
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
      await service.createMany([{ name: 'Marvel Studios', country: 'US' }], BigInt(1));

      expect(productionModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
      const options = productionModel.findOneAndUpdate.mock.calls[0][2];
      expect(options).toEqual(expect.objectContaining({ collation: EXPECTED_COLLATION }));
    });

    it('still upserts each name (upsert option preserved alongside collation)', async () => {
      await service.createMany(
        [{ name: 'Marvel Studios', country: 'US' }, { name: 'Pixar', country: 'US' }],
        BigInt(1)
      );

      expect(productionModel.findOneAndUpdate).toHaveBeenCalledTimes(2);
      const options = productionModel.findOneAndUpdate.mock.calls[0][2];
      expect(options).toEqual(expect.objectContaining({ upsert: true }));
    });

    it('compiled `name` unique index declares the same collation', () => {
      const nameIndex = ProductionSchema.indexes().find(([keys]) => (keys as Record<string, unknown>)['name'] === 1);
      expect(nameIndex).toBeDefined();
      const [, options] = nameIndex!;
      expect(options).toEqual(expect.objectContaining({ collation: EXPECTED_COLLATION }));
    });
  });
});
