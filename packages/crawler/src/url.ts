import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export function normalizeUrl(input: string | URL, base?: string | URL): string {
  const url = base ? new URL(String(input), base) : new URL(String(input));
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('UNSUPPORTED_PROTOCOL');
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  if (
    (url.protocol === 'http:' && url.port === '80') ||
    (url.protocol === 'https:' && url.port === '443')
  )
    url.port = '';
  return url.toString();
}

export function isSameSite(candidate: string, base: string) {
  return new URL(candidate).hostname === new URL(base).hostname;
}

function blockedIpv4(address: string) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4) return true;
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    a! >= 224
  );
}

function blockedIpv6(address: string) {
  const value = address.toLowerCase().split('%')[0]!;
  return (
    value === '::' ||
    value === '::1' ||
    value.startsWith('fc') ||
    value.startsWith('fd') ||
    value.startsWith('fe8') ||
    value.startsWith('fe9') ||
    value.startsWith('fea') ||
    value.startsWith('feb') ||
    value.startsWith('::ffff:127.') ||
    value.startsWith('::ffff:10.') ||
    value.startsWith('::ffff:192.168.')
  );
}

export function isForbiddenAddress(address: string) {
  const version = isIP(address);
  return version === 4 ? blockedIpv4(address) : version === 6 ? blockedIpv6(address) : true;
}

export function testFixtureModeAllowed(requested: boolean) {
  return requested && process.env.NODE_ENV === 'test';
}

export async function assertSafeTarget(input: string | URL, allowPrivateNetworkForTests = false) {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error('UNSAFE_URL');
  if (testFixtureModeAllowed(allowPrivateNetworkForTests)) return;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || (!host.includes('.') && !isIP(host)))
    throw new Error('SSRF_BLOCKED');
  const addresses = isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((entry) => isForbiddenAddress(entry.address)))
    throw new Error('SSRF_BLOCKED');
}

export function safeDiscoveredUrl(raw: string, base: string) {
  if (!raw || /^(mailto|tel|javascript|data):/i.test(raw)) return null;
  try {
    const value = normalizeUrl(raw, base);
    return value.length <= 2048 ? value : null;
  } catch {
    return null;
  }
}

export function isLikelyCrawlTrap(input: string) {
  const url = new URL(input);
  if (
    [...url.searchParams.keys()].some((key) =>
      /^(sid|session|sessionid|phpsessid|jsessionid)$/i.test(key),
    )
  )
    return true;
  const counts = new Map<string, number>();
  for (const segment of url.pathname.split('/').filter(Boolean)) {
    const count = (counts.get(segment) ?? 0) + 1;
    if (count > 4) return true;
    counts.set(segment, count);
  }
  return /\/(?:19|20)\d{2}\/\d{1,2}\/\d{1,2}\/(?:19|20)\d{2}\//.test(url.pathname);
}
