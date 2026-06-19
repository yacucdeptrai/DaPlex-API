import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken, getConnectionToken } from '@nestjs/mongoose';

import { GenresService } from './genres.service';
import { Genre, GenreSchema } from '../../schemas';
import { AuditLogService } from '../audit-log/audit-log.service';
import { MediaService } from '../media/media.service';
import { WsAdminGateway } from '../ws-admin';
import { MongooseConnection } from '../../enums';

// The case-insensitive collation FU18 must thread onto the dedup upsert.
const EXPECTED_COLLATION = { locale: 'en', strength: 2 };

describe('GenresService', () => {
  let service: GenresService;
  // createMany() dedups via genreModel.findOneAndUpdate(...). We capture the options
  // object it passes so we can assert the collation FU18 adds, and we return a raw
  // result shaped like Mongoose's { lastErrorObject, value } so createMany completes.
  let genreModel: { findOneAndUpdate: jest.Mock };

  beforeEach(async () => {
    let nextId = 1;
    genreModel = {
      findOneAndUpdate: jest.fn().mockImplementation(() =>
        Promise.resolve({ lastErrorObject: { updatedExisting: false }, value: { _id: BigInt(nextId++), name: 'x' } })
      )
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [GenresService]
    })
      .useMocker((token): any => {
        if (token === getModelToken(Genre.name, MongooseConnection.DATABASE_A)) return genreModel;
        if (token === getConnectionToken(MongooseConnection.DATABASE_A)) return {};
        if (token === AuditLogService) return { createManyLogs: jest.fn().mockResolvedValue(undefined) };
        if (token === MediaService) return {};
        if (token === WsAdminGateway) return { server: { sockets: { get: () => undefined }, to: () => ({ emit: () => undefined }) } };
        return {};
      })
      .compile();

    service = module.get<GenresService>(GenresService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // FU18 — case-insensitive dedup normalization. The repo's service specs use plain
  // jest mocks (no mongodb-memory-server), so a hand mock cannot honor collation to
  // prove `Action`/`action` collapse to one document at the DB level. The strongest
  // unit-level proxy is therefore two-pronged: (a) createMany passes the collation
  // option to findOneAndUpdate (the runtime query — Mongoose does NOT propagate index
  // collation to it), and (b) the compiled schema `name` index declares the same
  // collation (the index — required because the runtime option alone won't dedup if
  // the unique index is still case-sensitive). Both are RED on the unchanged
  // (collation-less) code. The end-to-end one-document collapse is an integration gap
  // noted in the baseline.
  describe('FU18 case-insensitive dedup', () => {
    it('createMany passes collation { locale: en, strength: 2 } to findOneAndUpdate', async () => {
      await service.createMany([{ name: 'Action' }], BigInt(1));

      expect(genreModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
      const options = genreModel.findOneAndUpdate.mock.calls[0][2];
      expect(options).toEqual(expect.objectContaining({ collation: EXPECTED_COLLATION }));
    });

    it('still upserts each name (upsert option preserved alongside collation)', async () => {
      await service.createMany([{ name: 'Action' }, { name: 'Drama' }], BigInt(1));

      expect(genreModel.findOneAndUpdate).toHaveBeenCalledTimes(2);
      const options = genreModel.findOneAndUpdate.mock.calls[0][2];
      expect(options).toEqual(expect.objectContaining({ upsert: true }));
    });

    it('compiled `name` unique index declares the same collation', () => {
      const nameIndex = GenreSchema.indexes().find(([keys]) => (keys as Record<string, unknown>)['name'] === 1);
      expect(nameIndex).toBeDefined();
      const [, options] = nameIndex!;
      expect(options).toEqual(expect.objectContaining({ collation: EXPECTED_COLLATION }));
    });
  });
});
