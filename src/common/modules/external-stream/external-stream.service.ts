import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

import { FlixHQWatch, GogoanimeServer, ZoroWatch } from './interfaces';

@Injectable()
export class ExternalStreamService {
  constructor(
    private httpService: HttpService,
    private configService: ConfigService
  ) {}

  async fetchGogoStreamUrl(id: string) {
    try {
      const embedsReqUrl = this.configService.get<string>('CONSUMET_API_URL') + '/anime/gogoanime/servers/' + id;
      const embedsResponse = await firstValueFrom(this.httpService.get<GogoanimeServer[]>(embedsReqUrl));
      const vidstreamingUrl = embedsResponse.data.find((embed) => embed.name === 'Vidstreaming');
      if (!vidstreamingUrl) return null;
      const embedUrl = new URL(vidstreamingUrl.url);
      const embedId = embedUrl.searchParams.get('id');
      const pair1 = Buffer.from(embedId).toString('base64');
      const key = Buffer.from(embedId + 'LTXs3GrU8we9O' + pair1).toString('base64');
      const response = await firstValueFrom(
        this.httpService.get('https://animixplay.to/api/live' + key, {
          headers: {
            Accept: 'application/json, text/plain, */*',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/103.0.0.0 Safari/537.36'
          },
          maxRedirects: 0,
          validateStatus(status) {
            return status < 400;
          }
        })
      );
      const extractedUrl = response.headers.location;
      if (!extractedUrl) return null;
      const splitEmbedUrl = extractedUrl.split('#');
      const decodedUrl = Buffer.from(splitEmbedUrl[1], 'base64').toString('ascii');
      return decodedUrl;
    } catch (e) {
      return null;
    }
  }

  async fetchFlixHQStream(id: string) {
    try {
      const tagIndex = id.indexOf('#');
      const episodeId = id.substring(0, tagIndex);
      const mediaId = id.substring(tagIndex + 1);
      const url = this.configService.get<string>('CONSUMET_API_URL') + '/movies/flixhq/watch';
      const response = await firstValueFrom(
        this.httpService.get<FlixHQWatch>(url, {
          params: { mediaId, episodeId }
        })
      );
      const masterPlaylist = response.data.sources.find((source) => source.quality === 'auto');
      response.data.sources = [masterPlaylist];
      return response.data;
    } catch (e) {
      return null;
    }
  }

  async fetchZoroStream(episodeId: string) {
    try {
      const url = this.configService.get<string>('CONSUMET_API_URL') + '/anime/zoro/watch';
      const response = await firstValueFrom(
        this.httpService.get<ZoroWatch>(url, {
          params: { episodeId }
        })
      );
      const masterPlaylist = response.data.sources.find((source) => source.quality === 'auto');
      masterPlaylist.url = this.configService.get<string>('CONSUMET_PROXY_URL') + '/' + masterPlaylist.url;
      response.data.sources = [masterPlaylist];
      return response.data;
    } catch (e) {
      return null;
    }
  }
}
