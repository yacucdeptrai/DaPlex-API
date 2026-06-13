# DaPlex API

Backend REST API for the DaPlex streaming platform — NestJS on the **Fastify** adapter. Handles auth and users, the media catalog, streaming/link resolution, image processing, and WebSocket events, and produces the BullMQ jobs that `../DaPlex-Transcoder` consumes.

## Stack

- **NestJS 10** (`@nestjs/platform-fastify`)
- **MongoDB** via Mongoose 7
- **Redis** — cache (`cache-manager` + ioredis), BullMQ queues, Socket.IO adapter
- **Auth** — JWT (`@nestjs/jwt`) + bcrypt, cookie sessions (`@fastify/cookie`)
- **Validation** — class-validator / class-transformer
- **Media** — sharp (images), stream-mmmagic (MIME sniffing), fast-average-color
- **Storage providers** — Azure Blob, Cloudflare R2, OneDrive, ImageKit
- **Swagger** (`@nestjs/swagger`) in dev
- **Tests** — Jest + ts-jest

## Prerequisites

- **Node.js 20+** — this workspace runs Node 24; the `mmmagic` override in `package.json` exists so its native libmagic addon builds on Node 24.
- **npm 10+**
- A running **Redis** instance (see [`../Redis`](../Redis))
- A reachable **MongoDB** (Atlas or local)
- A build toolchain for native modules (`sharp`, `bcrypt`, `mmmagic`)

## Install

```bash
npm install
```

## Configure

Copy the template and fill it in:

```bash
cp .env.example .env
```

Key groups (see `.env.example` for the complete list):

| Group | Variables |
|-------|-----------|
| Server | `PORT` (dev: `3000`), `ADDRESS`, `NODE_ENV` (`development` enables Swagger + the dev DNS workaround), `TRUST_PROXY` |
| MongoDB | `DATABASE_URL`, `DATABASE_URL_B` |
| Mongo WARP fallback | `MONGO_AUTO_WARP`, `MONGO_WARP_PORT` (default `40000`), `WARP_CLI_PATH`, `MONGO_PROXY_HOST` / `MONGO_PROXY_PORT` |
| Redis | `REDIS_URL`, `REDIS_2ND_URL`, `REDIS_QUEUE_URL`, `REDIS_IO_URL` |
| Auth | `ACCESS_TOKEN_SECRET`, `REFRESH_TOKEN_SECRET`, `*_EXPIRY`, `COOKIE_SECRET`, `COOKIE_DOMAIN`, `CRYPTO_SECRET_KEY` |
| CORS | `ORIGIN_URL`, `EXTRA_ORIGIN_URLS` |
| Email | `EMAIL_SENDER`, `EMAIL_FROM`, `SENDGRID_API_KEY`, … |
| Storage | `AZURE_STORAGE_CONNECTION_STRING`, `CLOUDFLARE_R2_*`, `ONEDRIVE_*`, `IMAGEKIT_API_KEY` |
| External | `TMDB_ACCESS_TOKEN`, `CONSUMET_API_URL`, `RECAPTCHA_SECRET` |

> **MongoDB connectivity:** an automatic Cloudflare WARP SOCKS5 fallback kicks in on networks that block Atlas shards — the API probes the shards directly on startup and only routes Mongo through WARP if they're blocked. Leave `MONGO_AUTO_WARP` blank/`true` to keep it on; see the comments in `.env.example`.

Never commit your `.env`.

## Run

```bash
# dev (watch)
npm run start:dev

# dev with debugger attached
npm run start:debug

# production
npm run build        # nest build -> dist/
npm run start:prod   # node dist/main
```

- Listens on `ADDRESS:PORT` from your env. With `PORT=3000` the web client's default `apiUrl` (`http://localhost:3000/api`) lines up out of the box.
- When `NODE_ENV=development`, Swagger UI is served at **`/docs`** (e.g. `http://localhost:3000/docs`).

## Test

There is **no bare `test` script** — run Jest directly:

```bash
npx jest             # one-shot unit tests (*.spec.ts)
npm run test:cov     # with coverage
npm run test:watch   # watch mode
npm run test:e2e     # e2e (test/jest-e2e.json)
```

Unit tests mock the native deps (`sharp`, `bcrypt`, `stream-mmmagic`) via `test/mocks`, so they run without native builds or a live database.

## Lint & format

```bash
npm run lint     # eslint --fix
npm run format   # prettier
```

## Relationship to other services

- Consumed by the web client ([`../daplex-dune-v2`](../daplex-dune-v2)).
- Shares its MongoDB and Redis (BullMQ queues) with [`../DaPlex-Transcoder`](../DaPlex-Transcoder); the API enqueues transcoding jobs the worker consumes.
- Requires [`../Redis`](../Redis) (or any Redis 6+) running first.
