import { BlockList, isIPv4 } from 'node:net';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Cidr, Config } from './config.ts';
import { HttpError } from './errors.ts';

/**
 * TRUST_PROXY for Fastify. A hop count becomes a function: trust the first `hops` addresses
 * counted from the socket (the proxies), so request.ip is the address the outermost proxy saw.
 * Fastify 5.12 itself treats a plain number as "trust nobody", because a client that can reach
 * the app directly could forge X-Forwarded-For. That is fine here: in production only the reverse
 * proxy can reach the app port. Prefer a hop count (usually 1) over `true` when
 * STAFF_ALLOWED_CIDRS is used, because `true` takes the left-most X-Forwarded-For entry, which a
 * client can set itself if the proxy appends to the header instead of replacing it.
 */
export function trustProxyOption(value: boolean | number): boolean | ((address: string, hop: number) => boolean) {
  if (typeof value === 'boolean') return value;
  if (value === 0) return false;
  return (_address, hop) => hop < value;
}

/**
 * Paths that stay reachable from anywhere when STAFF_ALLOWED_CIDRS is set: the health check for
 * monitoring, customer share pages (/v/<token>) and their API, and the static bundle and icons the
 * share page needs. Everything else is the staff app.
 */
const PUBLIC_PATH =
  /^\/(health$|v\/|api\/public\/|assets\/|(favicon|logo|apple-touch-icon)[\w.-]*\.(ico|svg|png|webp)$|robots\.txt$)/;

/** Dot segments, encoded slashes or backslashes never count as public, so /v/../api cannot sneak through. */
const SUSPICIOUS_PATH = /(^|\/)\.\.?(\/|$)|%2e|%2f|%5c|\\/i;

export function isPublicPath(url: string): boolean {
  const path = url.split('?', 1)[0] ?? '';
  return PUBLIC_PATH.test(path) && !SUSPICIOUS_PATH.test(path);
}

export function buildAllowList(cidrs: Cidr[]): BlockList {
  const list = new BlockList();
  for (const c of cidrs) list.addSubnet(c.address, c.prefix, c.family);
  return list;
}

/** Checks an address against the list. An IPv4-mapped IPv6 address (::ffff:1.2.3.4) is checked as IPv4. */
export function isAllowedAddress(list: BlockList, ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  if (mapped && isIPv4(mapped)) return list.check(mapped, 'ipv4');
  return isIPv4(ip) ? list.check(ip, 'ipv4') : list.check(ip, 'ipv6');
}

/** onRequest hook that limits the staff app to STAFF_ALLOWED_CIDRS. Returns null when no list is set. */
export function staffNetworkHook(config: Config) {
  if (config.staffAllowedCidrs.length === 0) return null;
  const list = buildAllowList(config.staffAllowedCidrs);
  return async (request: FastifyRequest) => {
    if (isPublicPath(request.url) || isAllowedAddress(list, request.ip)) return;
    throw new HttpError(403, 'forbidden');
  };
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * CSRF protection: every state-changing request must come from the app's own origin. It checks all
 * paths, not only /api/: the router decodes percent-escapes (/%61pi/... reaches /api/...), so a
 * path test on the raw URL could be bypassed, and the app has no other mutating routes anyway.
 * Browsers send Origin on every cross-origin request and on same-origin POSTs; when it is missing,
 * only Sec-Fetch-Site: same-origin is accepted. Non-browser clients must send Origin themselves.
 * The session cookie is SameSite=Lax and request bodies must be JSON, which closes the rest.
 */
export function originCheckHook(config: Config) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    if (!MUTATING.has(request.method)) return;
    const origin = request.headers.origin;
    const ok = origin !== undefined ? origin === config.appOrigin : request.headers['sec-fetch-site'] === 'same-origin';
    if (!ok) throw new HttpError(403, 'forbidden');
  };
}
