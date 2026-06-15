import '../test/bootstrap-env';

// Inert the network layer so app.init() runs every lifecycle hook without a
// datastore: bullmq's Queue and ioredis would otherwise open (and block on)
// real sockets. Scoped to this spec — other specs are unaffected.
jest.mock('bullmq');
jest.mock('ioredis');

import { getConnectionToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppModule } from './app.module';
import { MongooseConnection } from './enums';

// Connectivity-independent bootstrap smoke. Resolving the full AppModule provider
// graph is what catches the runtime DI failures `nest build` cannot: an
// UnknownDependenciesException or an unbroken circular dependency only throws
// when Nest actually instantiates the graph. The real Mongo/Redis connections
// are replaced with inert fakes so this runs with no datastore (per
// daplex-build-verify), yet every provider is still constructed for real.

// A chainable no-op stand-in for a mongoose Connection.
function fakeConnection() {
  const conn: any = {
    readyState: 1,
    models: {},
    on: () => conn,
    once: () => conn,
    model: () => ({}),
    collection: () => ({}),
    close: () => Promise.resolve(),
    db: { admin: () => ({ ping: () => Promise.resolve() }) }
  };
  return conn;
}

describe('AppModule bootstrap', () => {
  let app: NestFastifyApplication;

  afterAll(async () => {
    if (app) await app.close();
  });

  it('resolves every provider and initialises with no datastore', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(getConnectionToken(MongooseConnection.DATABASE_A))
      .useValue(fakeConnection())
      .overrideProvider(getConnectionToken(MongooseConnection.DATABASE_B))
      .useValue(fakeConnection())
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();

    expect(app).toBeDefined();
  });
});
