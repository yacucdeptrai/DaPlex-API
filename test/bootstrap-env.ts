// Complete fake env so ConfigModule's `validate` (env-validation.dto) passes
// without a real .env. Values are syntactically valid but point nowhere — the
// bootstrap smoke overrides the actual Mongo/Redis connections, so nothing here
// opens a socket. Import for side effect before AppModule is loaded.
const FAKE_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  PORT: '3000',
  ADDRESS: '0.0.0.0',
  TRUST_PROXY: 'false',
  DATABASE_URL: 'mongodb://127.0.0.1:27017/daplex_test_a',
  DATABASE_URL_B: 'mongodb://127.0.0.1:27017/daplex_test_b',
  MONGO_AUTO_WARP: 'false',
  REDIS_2ND_URL: 'redis://127.0.0.1:6379',
  REDIS_QUEUE_URL: 'redis://127.0.0.1:6379',
  REDIS_IO_URL: 'redis://127.0.0.1:6379',
  EMAIL_SENDER: 'noreply@example.com',
  EMAIL_FROM: 'DaPlex',
  SENDGRID_API_KEY: 'SG.fake',
  WEBSITE_URL: 'https://example.com',
  ORIGIN_URL: 'https://example.com',
  TMDB_ACCESS_TOKEN: 'fake-tmdb-token',
  CRYPTO_SECRET_KEY: '0123456789abcdef0123456789abcdef',
  AZURE_STORAGE_URL: 'https://example.blob.core.windows.net',
  AZURE_STORAGE_CONNECTION_STRING:
    'DefaultEndpointsProtocol=https;AccountName=fake;AccountKey=ZmFrZQ==;EndpointSuffix=core.windows.net',
  IMAGE_PROXY_URL: 'https://example.com',
  RECAPTCHA_SECRET: 'fake-recaptcha-secret'
};

for (const [key, value] of Object.entries(FAKE_ENV)) {
  if (process.env[key] === undefined) process.env[key] = value;
}

// Jest forces NODE_ENV=test, but env-validation only accepts the `Environment`
// enum (development | production). Use development for the smoke; WARP is off
// (MONGO_AUTO_WARP=false) and the connections are overridden, so neither
// development-only branch (dns/Swagger, both in bootstrap() not app.init()) runs.
process.env.NODE_ENV = 'development';
