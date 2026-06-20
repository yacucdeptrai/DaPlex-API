import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  HttpException,
  HttpStatus,
  Logger
} from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { SavedMultipartFile } from '@fastify/multipart';
import mimeTypes from 'mime-types';
import { Observable } from 'rxjs';
import sharp from 'sharp';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import dns from 'dns';
import { Agent, fetch } from 'undici';

import { appendToFilename, getScaledSizes, rgbToDec, rgbaToThumbHash, thumbHashToAverageRGBA } from '../../utils';
import { StatusCode } from '../../enums';
import { DEFAULT_UPLOAD_SIZE } from '../../config';
import { isBlockedIp, validateImageUrl } from './image-url-allowlist';

const FETCH_TIMEOUT_MS = 10000;
const MAX_REDIRECTS = 3;

@Injectable()
export class UploadImageInterceptor implements NestInterceptor {
  private readonly logger = new Logger(UploadImageInterceptor.name);
  private maxSize: number;
  private mimeTypes: string[];
  private maxWidth: number;
  private maxHeight: number;
  private minWidth: number;
  private minHeight: number;
  private ratio: number[];
  private allowUrl: boolean;
  private autoResize: boolean;

  constructor(options?: UploadImageOptions) {
    options = Object.assign(
      {},
      {
        maxSize: DEFAULT_UPLOAD_SIZE,
        mimeTypes: [],
        maxWidth: 0,
        maxHeight: 0,
        minWidth: 0,
        minHeight: 0,
        ratio: [],
        allowUrl: false,
        autoResize: false
      },
      options
    );
    this.maxSize = options.maxSize;
    this.mimeTypes = options.mimeTypes;
    this.maxWidth = options.maxWidth;
    this.maxHeight = options.maxHeight;
    this.minWidth = options.minWidth;
    this.minHeight = options.minHeight;
    this.ratio = options.ratio.length === 2 && options.ratio;
    this.allowUrl = options.allowUrl;
    this.autoResize = options.autoResize;
  }

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
    const req = context.switchToHttp().getRequest() as FastifyRequest;
    if (req.isMultipart()) {
      let file: SavedMultipartFile;
      try {
        const files = await req.saveRequestFiles({ limits: { files: 1, fileSize: this.maxSize } });
        file = files[0];
      } catch (e) {
        if (e.code === 'FST_REQ_FILE_TOO_LARGE')
          throw new HttpException(
            { code: StatusCode.FILE_TOO_LARGE, message: 'File is too large' },
            HttpStatus.BAD_REQUEST
          );
        else if (e.code === 'FST_FILES_LIMIT')
          throw new HttpException(
            { code: StatusCode.FILES_LIMIT_REACHED, message: 'Files limit reached' },
            HttpStatus.BAD_REQUEST
          );
        else throw e;
      }
      if (!file)
        throw new HttpException({ code: StatusCode.REQUIRE_FILE, message: 'File is required' }, HttpStatus.BAD_REQUEST);
      // We don't need this stream
      file.file.destroy();
      if (this.mimeTypes?.length) {
        if (!this.mimeTypes.includes(file.mimetype))
          throw new HttpException(
            { code: StatusCode.FILE_UNSUPPORTED, message: 'Unsupported file type' },
            HttpStatus.UNSUPPORTED_MEDIA_TYPE
          );
      }
      try {
        //const result = await getAverageColor(file.filepath);
        var info = await sharp(file.filepath, { pages: 1 }).metadata();
      } catch (e) {
        this.logger.error(e);
        throw new HttpException(
          { code: StatusCode.FILE_DETECTION, message: 'Failed to detect file type' },
          HttpStatus.UNPROCESSABLE_ENTITY
        );
      }
      const detectedMimetype = mimeTypes.lookup(info.format) || 'application/octet-stream';
      if (this.mimeTypes?.length && file.mimetype !== detectedMimetype)
        throw new HttpException(
          { code: StatusCode.FILE_UNSUPPORTED, message: 'Unsupported file type' },
          HttpStatus.UNSUPPORTED_MEDIA_TYPE
        );
      if ((this.maxHeight && info.height > this.maxHeight) || (this.maxWidth && info.width > this.maxWidth))
        throw new HttpException(
          { code: StatusCode.IMAGE_MAX_DIMENSIONS, message: 'Image dimensions are too high' },
          HttpStatus.BAD_REQUEST
        );
      if ((this.minHeight && info.height < this.minHeight) || (this.minWidth && info.width < this.minWidth))
        throw new HttpException(
          { code: StatusCode.IMAGE_MIN_DIMENSIONS, message: 'Image dimensions are too low' },
          HttpStatus.BAD_REQUEST
        );
      const targetWidth = Math.ceil((info.height * this.ratio[0]) / this.ratio[1]);
      if (this.ratio && targetWidth !== info.width) {
        if (!this.autoResize)
          throw new HttpException(
            { code: StatusCode.IMAGE_RATIO, message: 'Invalid aspect ratio' },
            HttpStatus.BAD_REQUEST
          );
        const tempFilePath = appendToFilename(file.filepath, '_resized');
        await sharp(file.filepath, { pages: -1 })
          .resize({ width: targetWidth, height: info.height })
          .toFile(tempFilePath);
        await fs.promises.rename(tempFilePath, file.filepath);
        info = await sharp(file.filepath, { pages: 1 }).metadata();
      }
      const thumbhashResult = await this.createThumbhash(file.filepath, info.width, info.height);
      req.incomingFile = {
        filepath: file.filepath,
        fieldname: file.fieldname,
        filename: file.filename,
        encoding: file.encoding,
        mimetype: file.mimetype,
        fields: file.fields
      };
      req.incomingFile.detectedMimetype = detectedMimetype;
      req.incomingFile.color = thumbhashResult.averageColorDec;
      req.incomingFile.thumbhash = thumbhashResult.b64;
      req.incomingFile.isUrl = false;
    } else if (this.allowUrl && (<any>req.body)?.url) {
      const url = (<any>req.body).url;
      const imageBuffer = await this.getImageFromUrl(url);
      const filename = url.split('/').pop().split('#')[0].split('?')[0];
      req.incomingFile = {
        filepath: '',
        fieldname: 'file',
        filename,
        encoding: '7bit',
        mimetype: 'application/octet-stream',
        fields: {} as any
      };
      try {
        //const result = await getAverageColor(url);
        var info = await sharp(imageBuffer, { pages: 1 }).metadata();
      } catch (e) {
        throw new HttpException(
          { code: StatusCode.FILE_DETECTION, message: 'Failed to detect file type' },
          HttpStatus.UNPROCESSABLE_ENTITY
        );
      }
      const detectedMimetype = mimeTypes.lookup(info.format) || 'application/octet-stream';
      if (this.mimeTypes?.length) {
        if (!this.mimeTypes.includes(detectedMimetype))
          throw new HttpException(
            { code: StatusCode.FILE_UNSUPPORTED, message: 'Unsupported file type' },
            HttpStatus.UNSUPPORTED_MEDIA_TYPE
          );
      }
      if (info.size && info.size > this.maxSize)
        throw new HttpException(
          { code: StatusCode.FILE_TOO_LARGE, message: 'File is too large' },
          HttpStatus.BAD_REQUEST
        );
      if ((this.maxHeight && info.height > this.maxHeight) || (this.maxWidth && info.width > this.maxWidth))
        throw new HttpException(
          { code: StatusCode.IMAGE_MAX_DIMENSIONS, message: 'Image dimensions are too high' },
          HttpStatus.BAD_REQUEST
        );
      if ((this.minHeight && info.height < this.minHeight) || (this.minWidth && info.width < this.minWidth))
        throw new HttpException(
          { code: StatusCode.IMAGE_MIN_DIMENSIONS, message: 'Image dimensions are too low' },
          HttpStatus.BAD_REQUEST
        );
      if (this.ratio && (info.height * this.ratio[0]) / this.ratio[1] !== info.width)
        throw new HttpException(
          { code: StatusCode.IMAGE_RATIO, message: 'Invalid aspect ratio' },
          HttpStatus.BAD_REQUEST
        );
      const thumbhashResult = await this.createThumbhash(imageBuffer, info.width, info.height);
      // R2 reads a disk path (fs.stat + createReadStream), so write the validated
      // buffer to a random-named tmpdir file — never an attacker-influenced name.
      const tempFilePath = path.join(os.tmpdir(), `daplex-fetch-${randomUUID()}`);
      await fs.promises.writeFile(tempFilePath, imageBuffer);
      req.incomingFile.filepath = tempFilePath;
      req.incomingFile.mimetype = detectedMimetype;
      req.incomingFile.detectedMimetype = detectedMimetype;
      req.incomingFile.color = thumbhashResult.averageColorDec;
      req.incomingFile.thumbhash = thumbhashResult.b64;
      req.incomingFile.isUrl = true;
    } else {
      throw new HttpException(
        { code: StatusCode.REQUIRE_MULTIPART, message: 'Multipart/form-data is required' },
        HttpStatus.BAD_REQUEST
      );
    }
    return next.handle();
  }

  private async createThumbhash(input: string | Buffer, srcWidth: number, srcHeight: number) {
    const scaledSizes = getScaledSizes(srcWidth, srcHeight, 100, 100);
    const rgba = await sharp(input)
      .resize({ width: scaledSizes.width, height: scaledSizes.height })
      .ensureAlpha()
      .raw()
      .toBuffer();
    const thumbhash = rgbaToThumbHash(scaledSizes.width, scaledSizes.height, rgba);
    const b64 = Buffer.from(thumbhash).toString('base64').replace(/\=+$/, '');
    const averageColorRBGA = thumbHashToAverageRGBA(thumbhash);
    const averageColorDec = rgbToDec(averageColorRBGA.r, averageColorRBGA.g, averageColorRBGA.b);
    return { b64, averageColorDec };
  }

  private async getImageFromUrl(url: string): Promise<Buffer> {
    let current = this.validateOrReject(url);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const { dispatcher, address } = await this.pinDispatcher(current.hostname);
        let response: Awaited<ReturnType<typeof fetch>>;
        try {
          response = await fetch(current.href, { dispatcher, signal: controller.signal, redirect: 'manual' });
        } catch (e) {
          this.logger.warn(`Provider image fetch failed: ${(e as Error).message}`);
          throw new HttpException(
            { code: StatusCode.THRID_PARTY_REQUEST_FAILED, message: 'Failed to fetch the image' },
            HttpStatus.BAD_GATEWAY
          );
        }
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (!location) break;
          // Re-run the FULL allowlist + scheme + IP validation on the hop target;
          // never auto-follow to an unvalidated host.
          current = this.validateOrReject(new URL(location, current.href).href);
          continue;
        }
        const contentLength = Number(response.headers.get('content-length'));
        if (Number.isFinite(contentLength) && contentLength > this.maxSize)
          throw new HttpException(
            { code: StatusCode.FILE_TOO_LARGE, message: 'File is too large' },
            HttpStatus.BAD_REQUEST
          );
        this.logger.debug(`Fetching provider image from ${current.hostname} (${address})`);
        return await this.readCappedBody(response);
      }
      this.reject('host-not-allowed');
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Parse + allowlist-check the URL; throw URL_HOST_NOT_ALLOWED on any rejection. */
  private validateOrReject(url: string): URL {
    const result = validateImageUrl(url);
    if (!result.ok) this.reject(result.reason);
    return result.parsed;
  }

  private reject(reason: string): never {
    this.logger.warn(`Rejected provider image URL (${reason})`);
    throw new HttpException(
      { code: StatusCode.URL_HOST_NOT_ALLOWED, message: 'URL host is not allowed' },
      HttpStatus.BAD_REQUEST
    );
  }

  /**
   * Resolve the host ONCE, reject if any address is private/loopback/link-local/
   * metadata, and pin the validated IP onto an undici Agent so fetch dials that
   * exact address (no second resolution → no DNS-rebinding/TOCTOU).
   */
  private async pinDispatcher(hostname: string): Promise<{ dispatcher: Agent; address: string }> {
    const addresses = await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
      dns.lookup(hostname, { all: true }, (err, addrs) => (err ? reject(err) : resolve(addrs as any)));
    }).catch(() => [] as Array<{ address: string; family: number }>);
    const safe = addresses.find((a) => !isBlockedIp(a.address));
    if (!safe) this.reject('private-ip');
    const dispatcher = new Agent({
      connect: {
        // undici's connect.lookup wants the array form, not Node-core's (addr, family).
        lookup: (_host, _opts, cb: any) => cb(null, [{ address: safe.address, family: safe.family }])
      }
    });
    return { dispatcher, address: safe.address };
  }

  /** Stream the body with a running-byte cap; never buffers past maxSize. */
  private async readCappedBody(response: Awaited<ReturnType<typeof fetch>>): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let total = 0;
    // undici ReadableStreams are async-iterable at runtime; the type omits the
    // iterator, so iterate through a widened reference.
    const body = response.body as unknown as AsyncIterable<Uint8Array> | null;
    if (!body) return Buffer.alloc(0);
    for await (const chunk of body) {
      total += chunk.byteLength;
      if (total > this.maxSize)
        throw new HttpException(
          { code: StatusCode.FILE_TOO_LARGE, message: 'File is too large' },
          HttpStatus.BAD_REQUEST
        );
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
}

interface UploadImageOptions {
  maxSize?: number;
  mimeTypes?: string[];
  maxWidth?: number;
  maxHeight?: number;
  minWidth?: number;
  minHeight?: number;
  ratio?: number[];
  allowUrl?: boolean;
  autoResize?: boolean;
}
