import { HttpService } from '@nestjs/axios';
import { HttpException, HttpStatus, Inject, Injectable, forwardRef } from '@nestjs/common';
import { createHmac, createHash } from 'crypto';
import { firstValueFrom } from 'rxjs';
import path from 'path';

import { StatusCode } from '../../../enums';
import { ExternalStorage } from '../../../resources/external-storages';
import { ExternalStoragesService } from '../../../resources/external-storages/external-storages.service';
import { SettingsService } from '../../../resources/settings/settings.service';

@Injectable()
export class S3Service {
  cachedSignatureKey: Buffer | null = null;
  cachedSignatureDate: string | null = null;

  constructor(private httpService: HttpService,
    @Inject(forwardRef(() => SettingsService)) private settingsService: SettingsService,
    @Inject(forwardRef(() => ExternalStoragesService)) private externalStoragesService: ExternalStoragesService) { }

  async findInStorages(filePath: string, storages: ExternalStorage[], retry: number = 3, retryTimeout: number = 0) {
    for (let i = 0; i < storages.length; i++) {
      const storage = storages[i];
      await this.externalStoragesService.decryptToken(storage);
      for (let j = 0; j < retry; j++) {
        try {
          const fileInfo = await this.headObject(storage, filePath);
          return { storage: storage, file: { id: filePath, name: filePath.split('/').pop(), size: fileInfo.contentLength, file: { mimeType: fileInfo.contentType } } };
        } catch (e) {
          if (j < retry - 1)
            await new Promise(r => setTimeout(r, retryTimeout));
          else if (e.response?.status === 404)
            break;
          else {
            console.error(e.response);
            throw new HttpException({ code: StatusCode.THRID_PARTY_REQUEST_FAILED, message: `Received ${e.response.status} ${e.response.statusText} error from third party api` }, HttpStatus.SERVICE_UNAVAILABLE);
          }
        }
      }
    }
    return null;
  }

  async findPath(path: string, storageId: bigint, retry: number = 3, retryTimeout: number = 0) {
    const storage = await this.externalStoragesService.findStorageById(storageId);
    await this.externalStoragesService.decryptToken(storage);
    for (let i = 0; i < retry; i++) {
      try {
        const fileInfo = await this.headObject(storage, path);
        return { id: path, name: path.split('/').pop(), size: fileInfo.contentLength, file: { mimeType: fileInfo.contentType } };
      } catch (e) {
        if (i < retry - 1) {
          await new Promise(r => setTimeout(r, retryTimeout));
        } else {
          console.error(e.response);
          throw new HttpException({ code: StatusCode.THRID_PARTY_REQUEST_FAILED, message: `Received ${e.response.status} ${e.response.statusText} error from third party api` }, HttpStatus.SERVICE_UNAVAILABLE);
        }
      }
    }
  }

  async findId(fileId: string, storage: ExternalStorage, retry: number = 3, retryTimeout: number = 0) {
    await this.externalStoragesService.decryptToken(storage);
    for (let i = 0; i < retry; i++) {
      try {
        const fileInfo = await this.headObject(storage, fileId);
        return { id: fileId, name: fileId.split('/').pop(), size: fileInfo.contentLength, file: { mimeType: fileInfo.contentType } };
      } catch (e) {
        if (e.response?.status === 404)
          throw new HttpException({ code: StatusCode.DRIVE_FILE_NOT_FOUND, message: 'File not found' }, HttpStatus.NOT_FOUND);
        if (i < retry - 1) {
          await new Promise(r => setTimeout(r, retryTimeout));
        } else {
          console.error(e.response);
          throw new HttpException({ code: StatusCode.THRID_PARTY_REQUEST_FAILED, message: `Received ${e.response.status} ${e.response.statusText} error from third party api` }, HttpStatus.SERVICE_UNAVAILABLE);
        }
      }
    }
  }

  async deleteFolder(folder: bigint | string, storage: ExternalStorage, retry: number = 5, retryTimeout: number = 3000) {
    const path = folder.toString();
    await this.externalStoragesService.decryptToken(storage);
    for (let i = 0; i < retry; i++) {
      try {
        await this.deleteObject(storage, path);
        return;
      } catch (e) {
        if (e.response?.status === 404)
          return;
        if (i < retry - 1) {
          await new Promise(r => setTimeout(r, retryTimeout));
        } else {
          console.error(e.response);
          throw new HttpException({ code: StatusCode.THRID_PARTY_REQUEST_FAILED, message: `Received ${e.response.status} ${e.response.statusText} error from third party api` }, HttpStatus.SERVICE_UNAVAILABLE);
        }
      }
    }
  }

  async createMultipartUpload(name: string, mimeType: string) {
    const storage = await this.settingsService.findMediaSourceStorage();
    await this.externalStoragesService.decryptToken(storage);
    const key = path.posix.join(storage.folderId || '', name).replace(/^\/+/, '');
    const { host, bucket } = this.parsePublicUrl(storage.publicUrl);
    const canonicalUri = this.encodeCanonicalUri(`/${bucket}/${key}`);
    const canonicalQuerystring = 'uploads=';
    const payloadHash = this.hash('');

    const authHeader = this.getAuthorizationHeader(
      storage.clientId, storage.clientSecret, host, canonicalUri,
      'POST', canonicalQuerystring, payloadHash,
      { 'content-type': mimeType }
    );

    try {
      const response = await firstValueFrom(this.httpService.post(
        `https://${host}${canonicalUri}?${canonicalQuerystring}`,
        '',
        {
          headers: {
            'Content-Type': mimeType,
            ...authHeader
          }
        }
      ));
      const uploadId = this.getXmlValue(response.data, 'UploadId');
      if (!uploadId) {
        throw new HttpException({ code: StatusCode.THRID_PARTY_REQUEST_FAILED, message: 'Failed to create multipart upload' }, HttpStatus.INTERNAL_SERVER_ERROR);
      }
      return {
        url: `https://${host}${canonicalUri}`,
        uploadId: uploadId,
        key: key,
        storage: storage._id
      };
    } catch (e) {
      if (e.response) {
        console.error(e.response);
        throw new HttpException({ code: StatusCode.THRID_PARTY_REQUEST_FAILED, message: `Received ${e.response.status} ${e.response.statusText} error from third party api` }, HttpStatus.SERVICE_UNAVAILABLE);
      }
      console.error(e);
      throw new HttpException({ code: StatusCode.THRID_PARTY_REQUEST_FAILED, message: 'Error during creating multipart upload' }, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  async getPresignedPartUrl(storage: ExternalStorage, key: string, uploadId: string, partNumber: number) {
    await this.externalStoragesService.decryptToken(storage);
    const { host, bucket } = this.parsePublicUrl(storage.publicUrl);
    const now = new Date();
    const amzDate = this.toAmzDate(now);
    const dateStamp = this.toDateStamp(now);
    const region = 'auto';
    const service = 's3';
    const expiresIn = 3600;

    const canonicalUri = this.encodeCanonicalUri(`/${bucket}/${key}`);
    const algorithm = 'AWS4-HMAC-SHA256';
    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const credential = encodeURIComponent(`${storage.clientId}/${credentialScope}`);

    const canonicalQuerystring = `X-Amz-Algorithm=${algorithm}&X-Amz-Credential=${credential}&X-Amz-Date=${amzDate}&X-Amz-Expires=${expiresIn}&X-Amz-SignedHeaders=host&partNumber=${partNumber}&uploadId=${encodeURIComponent(uploadId)}`;
    const canonicalHeaders = `host:${host}\n`;
    const signedHeaders = 'host';
    const payloadHash = 'UNSIGNED-PAYLOAD';
    const canonicalRequest = `PUT\n${canonicalUri}\n${canonicalQuerystring}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

    const stringToSign = `${algorithm}\n${amzDate}\n${credentialScope}\n${this.hash(canonicalRequest)}`;
    const signingKey = this.getSignatureKey(storage.clientSecret, dateStamp, region, service);
    const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

    return `https://${host}${canonicalUri}?${canonicalQuerystring}&X-Amz-Signature=${signature}`;
  }

  async completeMultipartUpload(storage: ExternalStorage, key: string, uploadId: string, parts: { partNumber: number; etag: string }[]) {
    await this.externalStoragesService.decryptToken(storage);
    const { host, bucket } = this.parsePublicUrl(storage.publicUrl);
    const canonicalUri = this.encodeCanonicalUri(`/${bucket}/${key}`);
    const canonicalQuerystring = `uploadId=${encodeURIComponent(uploadId)}`;
    const body = `<CompleteMultipartUpload>${parts.map(p => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
    const payloadHash = this.hash(body);

    const authHeader = this.getAuthorizationHeader(
      storage.clientId, storage.clientSecret, host, canonicalUri,
      'POST', canonicalQuerystring, payloadHash,
      { 'content-type': 'application/xml' }
    );

    try {
      await firstValueFrom(this.httpService.post(
        `https://${host}${canonicalUri}?${canonicalQuerystring}`,
        body,
        {
          headers: {
            'Content-Type': 'application/xml',
            ...authHeader
          }
        }
      ));
    } catch (e) {
      console.error(e.response);
      throw new HttpException({ code: StatusCode.THRID_PARTY_REQUEST_FAILED, message: `Received ${e.response.status} ${e.response.statusText} error from third party api` }, HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  async abortMultipartUpload(storage: ExternalStorage, key: string, uploadId: string) {
    await this.externalStoragesService.decryptToken(storage);
    const { host, bucket } = this.parsePublicUrl(storage.publicUrl);
    const canonicalUri = this.encodeCanonicalUri(`/${bucket}/${key}`);
    const canonicalQuerystring = `uploadId=${encodeURIComponent(uploadId)}`;
    const payloadHash = this.hash('');

    const authHeader = this.getAuthorizationHeader(
      storage.clientId, storage.clientSecret, host, canonicalUri,
      'DELETE', canonicalQuerystring, payloadHash
    );

    try {
      await firstValueFrom(this.httpService.delete(
        `https://${host}${canonicalUri}?${canonicalQuerystring}`,
        { headers: authHeader }
      ));
    } catch (e) {
      if (e.response?.status !== 404) {
        console.error(e.response);
        throw new HttpException({ code: StatusCode.THRID_PARTY_REQUEST_FAILED, message: `Received ${e.response.status} ${e.response.statusText} error from third party api` }, HttpStatus.SERVICE_UNAVAILABLE);
      }
    }
  }

  private async headObject(storage: ExternalStorage, key: string) {
    const { host, bucket } = this.parsePublicUrl(storage.publicUrl);
    const fullKey = path.posix.join(storage.folderId || '', key).replace(/^\/+/, '');
    const canonicalUri = this.encodeCanonicalUri(`/${bucket}/${fullKey}`);
    const payloadHash = this.hash('');

    const authHeader = this.getAuthorizationHeader(
      storage.clientId, storage.clientSecret, host, canonicalUri,
      'HEAD', '', payloadHash
    );

    const response = await firstValueFrom(this.httpService.head(
      `https://${host}${canonicalUri}`,
      { headers: authHeader }
    ));
    return {
      contentLength: parseInt(response.headers['content-length'] || '0', 10),
      contentType: response.headers['content-type'] || 'application/octet-stream'
    };
  }

  private async deleteObject(storage: ExternalStorage, key: string) {
    const { host, bucket } = this.parsePublicUrl(storage.publicUrl);
    const fullKey = path.posix.join(storage.folderId || '', key).replace(/^\/+/, '');
    const canonicalUri = this.encodeCanonicalUri(`/${bucket}/${fullKey}`);
    const payloadHash = this.hash('');

    const authHeader = this.getAuthorizationHeader(
      storage.clientId, storage.clientSecret, host, canonicalUri,
      'DELETE', '', payloadHash
    );

    await firstValueFrom(this.httpService.delete(
      `https://${host}${canonicalUri}`,
      { headers: authHeader }
    ));
  }

  private getAuthorizationHeader(
    accessKey: string, secretKey: string, host: string, canonicalUri: string,
    method: string, queryString: string, payloadHash: string,
    extraHeaders: Record<string, string> = {}
  ): Record<string, string> {
    const now = new Date();
    const amzDate = this.toAmzDate(now);
    const dateStamp = this.toDateStamp(now);
    const region = 'auto';
    const service = 's3';
    const algorithm = 'AWS4-HMAC-SHA256';

    const allHeaders: Record<string, string> = {
      'host': host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...extraHeaders
    };

    const sortedHeaderKeys = Object.keys(allHeaders).sort();
    const signedHeaders = sortedHeaderKeys.join(';');
    const canonicalHeaders = sortedHeaderKeys.map(k => `${k}:${allHeaders[k]}`).join('\n') + '\n';

    const canonicalRequest = `${method}\n${canonicalUri}\n${queryString}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = `${algorithm}\n${amzDate}\n${credentialScope}\n${this.hash(canonicalRequest)}`;

    const signingKey = this.getSignatureKey(secretKey, dateStamp, region, service);
    const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

    return {
      'Host': host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      'Authorization': `${algorithm} Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
    };
  }

  private getSignatureKey(secretKey: string, dateStamp: string, region: string, service: string): Buffer {
    if (this.cachedSignatureKey !== null && this.cachedSignatureDate === dateStamp)
      return this.cachedSignatureKey;
    const kDate = createHmac('sha256', 'AWS4' + secretKey).update(dateStamp, 'utf8').digest();
    const kRegion = createHmac('sha256', kDate).update(region, 'utf8').digest();
    const kService = createHmac('sha256', kRegion).update(service, 'utf8').digest();
    const kSigning = createHmac('sha256', kService).update('aws4_request', 'utf8').digest();
    this.cachedSignatureKey = kSigning;
    this.cachedSignatureDate = dateStamp;
    return kSigning;
  }

  private getXmlValue(xml: string, ...keys: string[]): string | null {
    let current = xml;
    for (const key of keys) {
      const match = current.match(new RegExp(`<${key}>([\\s\\S]*?)</${key}>`));
      if (!match) return null;
      current = match[1];
    }
    return current;
  }

  resolvePublicUrl(url: string) {
    return url.replace(':service_path', 's3');
  }

  private encodeCanonicalUri(uri: string): string {
    return '/' + uri.replace(/^\//, '').split('/').map(segment => encodeURIComponent(segment).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())).join('/');
  }

  private parsePublicUrl(publicUrl: string): { host: string; bucket: string } {
    const resolvedUrl = this.resolvePublicUrl(publicUrl);
    const url = new URL(resolvedUrl.replace(':path', ''));
    const pathParts = url.pathname.split('/').filter(Boolean);
    return { host: url.host, bucket: pathParts[0] || '' };
  }

  private toAmzDate(date: Date): string {
    return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  }

  private toDateStamp(date: Date): string {
    return date.toISOString().slice(0, 10).replace(/-/g, '');
  }

  private hash(data: string): string {
    return createHash('sha256').update(data, 'utf8').digest('hex');
  }
}
