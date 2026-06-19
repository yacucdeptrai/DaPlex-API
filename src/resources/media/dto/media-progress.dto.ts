/**
 * Live transcode-progress snapshot the result consumer writes to Redis and the
 * polled GET endpoint returns. Distinct from MediaQueueResultDto.progress (stream
 * metadata) — this carries the encode percent/eta the FE chip polls for. bigint
 * ids serialize as strings on the wire, so the snapshot stores strings.
 */
export class MediaProgressDto {
  mediaId: string;

  episodeId?: string;

  status: 'PROCESSING';

  percent: number;

  eta?: number;
}
