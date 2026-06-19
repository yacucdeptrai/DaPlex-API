/**
 * The ONE shared Redis key builder + TTL for the live transcode-progress snapshot.
 * Both the result consumer (writer) and the polled GET handler (reader) must use
 * this so their keys never drift. The store round-trip spec enforces agreement.
 */

// cache-manager v5 takes TTL in milliseconds; a stalled/crashed job auto-expires
// to idle after this window.
export const PROGRESS_TTL = 60_000;

export function buildProgressKey(mediaId: string | number | bigint, episodeId?: string | number | bigint): string {
  const base = `progress:${mediaId}`;
  return episodeId != null ? `${base}:${episodeId}` : base;
}
