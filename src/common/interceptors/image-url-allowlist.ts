import { isIP } from 'net';

// Hosts the server is allowed to fetch provider images from. Exact-equality only —
// never suffix/substring/regex (those admit evil-tmdb.org / image.tmdb.org.evil.com).
// TMDB host is hardcoded by the scanner; TVDB passes the provider's absolute URL through.
export const IMAGE_URL_ALLOWED_HOSTS: ReadonlySet<string> = Object.freeze(
  new Set<string>([
    'image.tmdb.org',
    'artworks.thetvdb.com'
  ])
);

const MAX_URL_LENGTH = 2048;

/** Reasons a candidate URL is refused; all surface as URL_HOST_NOT_ALLOWED. */
export type UrlRejectReason =
  | 'not-string'
  | 'too-long'
  | 'parse-failed'
  | 'not-https'
  | 'has-credentials'
  | 'idn-or-punycode'
  | 'bad-port'
  | 'host-not-allowed';

// A flat shape (not a discriminated union) so callers can read `parsed`/`reason`
// without union narrowing — this codebase compiles with strictNullChecks off,
// where boolean-discriminant narrowing does not apply.
export interface UrlValidationResult {
  ok: boolean;
  parsed?: URL;
  reason?: UrlRejectReason;
}

/** True for any IP that must never be the target of a server-side fetch (SSRF). */
export function isBlockedIp(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isBlockedIpv4(address);
  if (version === 6) return isBlockedIpv6(address);
  // Not a literal IP (or unparseable) — treat as unsafe.
  return true;
}

function isBlockedIpv4(address: string): boolean {
  const parts = address.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true;
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10/8 private
  if (a === 127) return true; // 127/8 loopback
  if (a === 169 && b === 254) return true; // 169.254/16 link-local (incl. 169.254.169.254 metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 192 && b === 0 && parts[2] === 0) return true; // 192.0.0/24 IETF
  if (a === 192 && b === 0 && parts[2] === 2) return true; // 192.0.2/24 TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
  if (a >= 224) return true; // 224/4 multicast + 240/4 reserved + 255.255.255.255 broadcast
  return false;
}

function isBlockedIpv6(address: string): boolean {
  const ip = address.toLowerCase();
  // IPv4-mapped (::ffff:a.b.c.d) — decode and re-check against the v4 rules so
  // ::ffff:169.254.169.254 cannot slip through.
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1]);
  if (ip === '::1') return true; // loopback
  if (ip === '::') return true; // unspecified
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // fc00::/7 ULA
  if (ip.startsWith('fe80') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb'))
    return true; // fe80::/10 link-local
  if (ip.startsWith('ff')) return true; // ff00::/8 multicast
  if (ip.startsWith('64:ff9b:')) return true; // NAT64 — can map to internal v4
  return false;
}

/**
 * Validate the inbound provider URL before any DNS/network touch. Returns the
 * parsed URL on success or a reject reason. The host-equality allowlist + scheme
 * + credential/port checks are the real SSRF boundary (the body has no DTO).
 */
export function validateImageUrl(
  url: unknown,
  allowedHosts: ReadonlySet<string> = IMAGE_URL_ALLOWED_HOSTS
): UrlValidationResult {
  if (typeof url !== 'string') return { ok: false, reason: 'not-string' };
  if (url.length > MAX_URL_LENGTH) return { ok: false, reason: 'too-long' };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'parse-failed' };
  }
  if (parsed.protocol !== 'https:') return { ok: false, reason: 'not-https' };
  if (parsed.username || parsed.password) return { ok: false, reason: 'has-credentials' };
  const hostname = parsed.hostname.toLowerCase();
  if (/[^a-z0-9.-]/.test(hostname) || hostname.startsWith('xn--') || hostname.includes('.xn--'))
    return { ok: false, reason: 'idn-or-punycode' };
  if (parsed.port && parsed.port !== '443') return { ok: false, reason: 'bad-port' };
  if (!allowedHosts.has(hostname)) return { ok: false, reason: 'host-not-allowed' };
  return { ok: true, parsed };
}
