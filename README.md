# DaPlex API

Main backend service for DaPlex, built with NestJS (Fastify adapter).

## What This Service Handles

- Authentication and user management
- Media/catalog APIs
- Caching and queue orchestration
- WebSocket communication
- Integration points for transcoding/media workflows

## Stack

- NestJS 10
- Fastify
- Mongoose (MongoDB)
- BullMQ + Redis
- Socket.IO
- Swagger support

## Prerequisites

- Node.js 18+ (20 LTS recommended)
- npm 10+
- Redis instance
- MongoDB instance

## Install

```bash
npm install
```

## Run

```bash
# development
npm run start:dev

# debug watch
npm run start:debug

# production
npm run build
npm run start:prod
```

## Tests

```bash
npm run test
npm run test:e2e
npm run test:cov
```

## Lint and Format

```bash
npm run lint
npm run format
```

## Project Scripts (Summary)

- `start` - run Nest application
- `start:dev` - watch mode for local development
- `build` - compile to `dist/`
- `start:prod` - run compiled app

## Environment Configuration

This service expects environment variables for:

- database connection
- Redis/queue configuration
- JWT/auth secrets
- storage provider settings (for blob/media flows)

Create your local `.env` based on your team conventions before starting.

## Relationship to Other Projects

- Consumed by: `../daplex-dune-v2`
- Works with: `../DaPlex-Transcoder`
- Requires: `../Redis` runtime (or external Redis)
