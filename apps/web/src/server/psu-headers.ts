import { isIP } from 'node:net';
import type { PsuHeaders } from '@arfolio/connectors';
import { clientIp } from '../lib/rate-limit';

const MAX_USER_AGENT = 200;

function isPrivateV4(ip: string): boolean {
  const [a = 0, b = 0] = ip.split('.').map(Number);
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

/** Private, loopback or link-local: an address the bank cannot use to identify the person. */
function isNonPublic(ip: string): boolean {
  if (isIP(ip) === 4) return isPrivateV4(ip);
  const lower = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped?.[1]) return isPrivateV4(mapped[1]);
  if (lower === '::1') return true;
  const first = Number.parseInt(lower.split(':')[0] ?? '', 16);
  if (Number.isNaN(first)) return false;
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

/**
 * What the bank needs to treat a manual refresh as made with the person present: their address
 * (from the trusted proxy header, the same one rate limiting uses) and their browser's
 * User-Agent. Both come from a request, so both are checked: an address that is not an IP, or
 * is private, loopback or link-local, is dropped, and the User-Agent is cut to printable ASCII (a stray control character would make
 * the outgoing request invalid) and a sane length. Missing values are simply left out.
 */
export function psuHeadersFrom(headers: Headers): PsuHeaders {
  const ip = clientIp(headers)?.trim();
  const userAgent = (headers.get('user-agent') ?? '')
    .replace(/[^\x20-\x7e]/g, '')
    .trim()
    .slice(0, MAX_USER_AGENT);
  return {
    ...(ip !== undefined && isIP(ip) !== 0 && !isNonPublic(ip) ? { ipAddress: ip } : {}),
    ...(userAgent !== '' ? { userAgent } : {}),
  };
}
