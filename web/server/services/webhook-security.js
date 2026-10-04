import crypto from 'node:crypto';
import dns from 'node:dns';
import net from 'node:net';

export const MAX_WEBHOOK_URL = 500;

/** A webhookUrl the server will not call; the message is safe to return to the API caller. */
export class WebhookUrlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WebhookUrlError';
  }
}

/** Dotted-quad IPv4 -> 4 bytes, or null. net.isIPv4 rejects short forms (127.1) and leading zeros. */
function parseIPv4(text) {
  return net.isIPv4(text) ? text.split('.').map(Number) : null;
}

/** IPv6 text -> 16 bytes, or null. Zone ids (fe80::1%eth0) are refused: only link-local scopes carry them. */
function parseIPv6(text) {
  if (!net.isIPv6(text) || text.includes('%')) return null;
  let s = text;
  const tail = s.slice(s.lastIndexOf(':') + 1);
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);
    if (!v4) return null;
    s = `${s.slice(0, s.length - tail.length)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = s.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  const groups = halves.length > 1 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  if (groups.length !== 8) return null;
  return groups.flatMap((g) => {
    const n = parseInt(g, 16);
    return [n >> 8, n & 0xff];
  });
}

function cidr(text) {
  const [prefix, bits] = text.split('/');
  return { bytes: parseIPv4(prefix) ?? parseIPv6(prefix), bits: Number(bits) };
}

function inRange(bytes, { bytes: prefix, bits }) {
  if (bytes.length !== prefix.length) return false;
  for (let i = 0; i < bits; i += 8) {
    const mask = bits - i >= 8 ? 0xff : (0xff << (8 - (bits - i))) & 0xff;
    if ((bytes[i / 8] & mask) !== (prefix[i / 8] & mask)) return false;
  }
  return true;
}

/** IPv4 ranges that are not the public internet (IANA special-purpose registry). */
const BLOCKED_V4 = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24',
  '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24',
  '224.0.0.0/4', '240.0.0.0/4',
].map(cidr);

/** IPv4-mapped ::ffff:0:0/96: the embedded IPv4 decides. */
const MAPPED_V6 = cidr('::ffff:0:0/96');
/**
 * Only global unicast 2000::/3 can be public. That alone refuses ::, ::1, IPv4-compatible ::/96, SIIT ::ffff:0:0:0/96,
 * NAT64 64:ff9b::/96 and 64:ff9b:1::/48, discard 100::/64, SRv6 5f00::/16, ULA fc00::/7, link-local fe80::/10,
 * site-local fec0::/10 and multicast ff00::/8.
 */
const GLOBAL_V6 = cidr('2000::/3');
/** Inside 2000::/3: IETF protocol assignments (Teredo 2001::/32, benchmarking 2001:2::/48, ORCHID), docs, 6to4. */
const BLOCKED_V6 = ['2001::/23', '2001:db8::/32', '2002::/16', '3fff::/20'].map(cidr);

const publicV4 = (bytes) => !BLOCKED_V4.some((range) => inRange(bytes, range));

/** True only for addresses on the public internet; anything that is not an IP literal is false. */
export function isPublicAddress(address) {
  const ip = String(address).toLowerCase();
  const v4 = parseIPv4(ip);
  if (v4) return publicV4(v4);
  const v6 = parseIPv6(ip);
  if (!v6) return false;
  if (inRange(v6, MAPPED_V6)) return publicV4(v6.slice(12));
  return inRange(v6, GLOBAL_V6) && !BLOCKED_V6.some((range) => inRange(v6, range));
}

const LOOPBACK_V4 = cidr('127.0.0.0/8');
const LOOPBACK_V6 = cidr('::1/128');

function isLoopback(address) {
  const ip = String(address).toLowerCase();
  const v4 = parseIPv4(ip);
  if (v4) return inRange(v4, LOOPBACK_V4);
  const v6 = parseIPv6(ip);
  if (!v6) return false;
  return inRange(v6, LOOPBACK_V6) || (inRange(v6, MAPPED_V6) && inRange(v6.slice(12), LOOPBACK_V4));
}

/** Bound on one webhook DNS answer; a slower one counts as a host that does not resolve. */
export const LOOKUP_TIMEOUT_MS = 5000;

// c-ares, not getaddrinfo: a stalled server cannot pin a libuv threadpool thread.
const resolver = new dns.promises.Resolver({ timeout: 2000, tries: 2 });

/** Every A then AAAA record of host; a family with no records (or a failed query) contributes nothing. */
export async function lookupAll(host) {
  const [v4, v6] = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
  return [
    ...(v4.status === 'fulfilled' ? v4.value.map((address) => ({ address, family: 4 })) : []),
    ...(v6.status === 'fulfilled' ? v6.value.map((address) => ({ address, family: 6 })) : []),
  ];
}

function withTimeout(promise, ms) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('lookup timed out')), ms);
    timer.unref?.();
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

/**
 * Checks a webhook URL and resolves its host, at create time and again before every delivery: https, port 443, no
 * user info, at most MAX_WEBHOOK_URL characters, and every resolved address public. With allowLoopback (local e2e
 * only, config.webhookAllowLoopback) a URL whose every address is loopback may also use http and any port.
 * Answers the address the delivery must connect to, so a second DNS answer can never redirect it.
 */
export async function resolveWebhookUrl(raw, { allowLoopback = false, lookup = lookupAll } = {}) {
  const tooLong = `webhookUrl must be a URL of at most ${MAX_WEBHOOK_URL} characters`;
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_WEBHOOK_URL) throw new WebhookUrlError(tooLong);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new WebhookUrlError('webhookUrl is not a valid URL');
  }
  // Percent-encoding and punycode can grow the input several-fold; url.href is what gets stored and called.
  if (url.href.length > MAX_WEBHOOK_URL) throw new WebhookUrlError(tooLong);
  const httpOk = allowLoopback && url.protocol === 'http:';
  if (url.protocol !== 'https:' && !httpOk) throw new WebhookUrlError('webhookUrl must use https');
  if (!allowLoopback && url.port !== '' && url.port !== '443') throw new WebhookUrlError('webhookUrl must use port 443');
  if (url.username || url.password) throw new WebhookUrlError('webhookUrl must not contain a user name or password');
  // WHATWG URL has already normalised numeric hosts (0x7f.1, 2130706433) to dotted quads and brackets IPv6.
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  let addresses;
  if (net.isIP(host)) {
    addresses = [{ address: host, family: net.isIP(host) }];
  } else {
    try {
      addresses = await withTimeout(Promise.resolve().then(() => lookup(host)), LOOKUP_TIMEOUT_MS);
    } catch {
      addresses = [];
    }
    if (!addresses?.length) throw new WebhookUrlError('webhookUrl host does not resolve');
  }
  if (!(allowLoopback && addresses.every((a) => isLoopback(a.address)))) {
    if (url.protocol !== 'https:') throw new WebhookUrlError('webhookUrl must use https');
    if (url.port !== '' && url.port !== '443') throw new WebhookUrlError('webhookUrl must use port 443');
    if (!addresses.every((a) => isPublicAddress(a.address))) throw new WebhookUrlError('webhookUrl must point to a public address');
  }
  return { url: url.href, address: addresses[0].address, family: addresses[0].family };
}

/** `LQTTS-Signature` value: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>. */
export function signWebhook(secret, body, timestamp = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}
