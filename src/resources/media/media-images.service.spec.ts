import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken, getConnectionToken } from '@nestjs/mongoose';

import { MediaImagesService } from './media-images.service';
import { CloudflareR2Service } from '../../common/modules/cloudflare-r2';
import { AuditLogService } from '../audit-log/audit-log.service';
import { WsAdminGateway } from '../ws-admin';
import { Media, TVEpisode } from '../../schemas';
import { CloudflareR2Container, MongooseConnection } from '../../enums';

// fs is imported at module scope in the service today only AFTER the surgeon's
// Change 4 (temp-file unlink). We spread the REAL fs (nodejs-snowflake calls
// fs.readFileSync at import time, transitively pulled in via createSnowFlakeId)
// and override only promises.unlink with a spy so the unlink TDD can observe it
// without breaking unrelated fs usage.
import fs from 'fs';
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  const unlink = jest.fn().mockResolvedValue(undefined);
  return {
    ...actual,
    __esModule: true,
    default: { ...actual, promises: { ...actual.promises, unlink } },
    promises: { ...actual.promises, unlink }
  };
});

/**
 * Characterization tests for the dependency-light branching piece of the image
 * group, deleteMediaImage. The poster / backdrop / still upload+delete methods
 * are I/O-heavy and were moved verbatim from MediaService; deleteMediaImage is
 * the one method with an observable branch (skip vs delete), so it is pinned
 * here. DI of the full service is covered by the smoke test plus the controller
 * and module specs that compile against the real wiring.
 */
describe('MediaImagesService (characterization)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let target: any;
  let cloudflareR2Service: { delete: jest.Mock; upload: jest.Mock };

  beforeEach(async () => {
    cloudflareR2Service = { delete: jest.fn(), upload: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({ providers: [MediaImagesService] })
      .useMocker((token) => {
        if (token === CloudflareR2Service) return cloudflareR2Service;
        return {};
      })
      .compile();
    target = module.get<MediaImagesService>(MediaImagesService);
  });

  it('is defined', () => expect(target).toBeDefined());

  describe('deleteMediaImage', () => {
    it('does nothing when the image is falsy', async () => {
      await target.deleteMediaImage(undefined, CloudflareR2Container.POSTERS);
      expect(cloudflareR2Service.delete).not.toHaveBeenCalled();
    });

    it('deletes the image at "<id>/<name>" in the given container', async () => {
      const image = { _id: BigInt(123), name: 'poster.jpg' };
      await target.deleteMediaImage(image, CloudflareR2Container.POSTERS);
      expect(cloudflareR2Service.delete).toHaveBeenCalledTimes(1);
      expect(cloudflareR2Service.delete).toHaveBeenCalledWith(CloudflareR2Container.POSTERS, '123/poster.jpg');
    });

    it('uses the container argument it is given (backdrops / stills)', async () => {
      const image = { _id: BigInt(456), name: 'still.png' };
      await target.deleteMediaImage(image, CloudflareR2Container.STILLS);
      expect(cloudflareR2Service.delete).toHaveBeenCalledWith(CloudflareR2Container.STILLS, '456/still.png');
    });
  });
});

// ---------------------------------------------------------------------------
// TDD — URL temp-file unlink (Change 4). RED on UNCHANGED code: no unlink exists
// today (only an R2 compensating delete in catch). After the surgeon's fix,
// uploadMediaPoster/Backdrop must `fs.promises.unlink(file.filepath)` in a
// `finally` WHEN `file.isUrl` is truthy — on BOTH the success path and the
// R2/mongo-failure path — and must NOT unlink when `file.isUrl` is falsy
// (never delete a non-temp multipart path).
//
// HARNESS CONSTRAINT FOR THE SURGEON: use `fs.promises.unlink(file.filepath)`
// (matches the existing fs.promises.stat/rename idiom). If you use the callback
// `fs.unlink`, update this mock+assertion to match.
// ---------------------------------------------------------------------------
describe('MediaImagesService — URL temp-file unlink (TDD)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let target: any;
  let cloudflareR2Service: { delete: jest.Mock; upload: jest.Mock };
  let mediaModel: { findOne: jest.Mock };
  let auditLogService: { createLog: jest.Mock };
  let unlinkMock: jest.Mock;

  const TEMP_PATH = '/tmp/daplex-fetch-abc123';

  /** A media doc whose save() resolves (success) or rejects (failure path). */
  function mediaDoc(opts: { saveRejects?: boolean } = {}) {
    const doc: any = {
      _id: BigInt(1),
      poster: undefined,
      backdrop: undefined,
      save: opts.saveRejects
        ? jest.fn().mockRejectedValue(new Error('mongo-down'))
        : jest.fn().mockResolvedValue(undefined),
      toObject: () => ({ _id: BigInt(1) })
    };
    return doc;
  }

  function urlFile(): Storage.MultipartFile {
    return {
      filepath: TEMP_PATH,
      fieldname: 'file',
      filename: 'poster.jpg',
      encoding: '7bit',
      mimetype: 'image/jpeg',
      detectedMimetype: 'image/jpeg',
      color: 123,
      thumbhash: 'abc',
      isUrl: true,
      fields: {} as any
    };
  }

  function multipartFile(): Storage.MultipartFile {
    return { ...urlFile(), filepath: '/var/tmp/multipart-upload-xyz', isUrl: false };
  }

  beforeEach(async () => {
    unlinkMock = (fs as any).promises.unlink as jest.Mock;
    unlinkMock.mockClear();
    unlinkMock.mockResolvedValue(undefined);

    cloudflareR2Service = {
      delete: jest.fn().mockResolvedValue(undefined),
      upload: jest.fn().mockResolvedValue({ size: 2048 })
    };
    mediaModel = { findOne: jest.fn() };
    auditLogService = { createLog: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MediaImagesService,
        { provide: getModelToken(Media.name, MongooseConnection.DATABASE_A), useValue: mediaModel },
        { provide: getModelToken(TVEpisode.name, MongooseConnection.DATABASE_A), useValue: { findOne: jest.fn() } },
        { provide: getConnectionToken(MongooseConnection.DATABASE_A), useValue: {} }
      ]
    })
      .useMocker((token) => {
        if (token === CloudflareR2Service) return cloudflareR2Service;
        if (token === AuditLogService) return auditLogService;
        if (token === WsAdminGateway)
          return { server: { to: () => ({ emit: jest.fn() }), sockets: { get: () => undefined } } };
        return {};
      })
      .compile();
    target = module.get<MediaImagesService>(MediaImagesService);
  });

  const headers = {} as any;
  const authUser = { _id: BigInt(2) } as any;

  it('uploadMediaPoster unlinks the temp file on the SUCCESS path when file.isUrl', async () => {
    mediaModel.findOne.mockReturnValue({ exec: () => Promise.resolve(mediaDoc()) });

    await target.uploadMediaPoster(BigInt(1), urlFile(), headers, authUser);

    expect(unlinkMock).toHaveBeenCalledWith(TEMP_PATH);
  });

  it('uploadMediaPoster unlinks the temp file even when the mongo save FAILS (finally), and rethrows', async () => {
    mediaModel.findOne.mockReturnValue({ exec: () => Promise.resolve(mediaDoc({ saveRejects: true })) });

    await expect(target.uploadMediaPoster(BigInt(1), urlFile(), headers, authUser)).rejects.toBeDefined();
    expect(unlinkMock).toHaveBeenCalledWith(TEMP_PATH);
  });

  it('uploadMediaPoster does NOT unlink when file.isUrl is falsy (multipart temp path is owned elsewhere)', async () => {
    mediaModel.findOne.mockReturnValue({ exec: () => Promise.resolve(mediaDoc()) });

    await target.uploadMediaPoster(BigInt(1), multipartFile(), headers, authUser);

    expect(unlinkMock).not.toHaveBeenCalled();
  });

  it('uploadMediaBackdrop unlinks the temp file on the SUCCESS path when file.isUrl', async () => {
    mediaModel.findOne.mockReturnValue({ exec: () => Promise.resolve(mediaDoc()) });

    await target.uploadMediaBackdrop(BigInt(1), urlFile(), headers, authUser);

    expect(unlinkMock).toHaveBeenCalledWith(TEMP_PATH);
  });

  it('uploadMediaBackdrop unlinks the temp file even when the mongo save FAILS (finally), and rethrows', async () => {
    mediaModel.findOne.mockReturnValue({ exec: () => Promise.resolve(mediaDoc({ saveRejects: true })) });

    await expect(target.uploadMediaBackdrop(BigInt(1), urlFile(), headers, authUser)).rejects.toBeDefined();
    expect(unlinkMock).toHaveBeenCalledWith(TEMP_PATH);
  });

  it('uploadMediaBackdrop does NOT unlink when file.isUrl is falsy', async () => {
    mediaModel.findOne.mockReturnValue({ exec: () => Promise.resolve(mediaDoc()) });

    await target.uploadMediaBackdrop(BigInt(1), multipartFile(), headers, authUser);

    expect(unlinkMock).not.toHaveBeenCalled();
  });
});
