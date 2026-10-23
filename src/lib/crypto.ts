import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** Random URL-safe token for links and sessions (256 bits by default). */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

/** Tokens are stored only as SHA-256 hashes. */
export const hashToken = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

export const sha256 = (input: string | Buffer | Uint8Array) => createHash('sha256').update(input).digest('hex');

export function hmac(secret: string, value: string) {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

export function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Keyed hash of an IP address so rate limits and audit can correlate without storing it. */
export const hashIp = (secret: string, ip: string) => hmac(secret, `ip:${ip}`).slice(0, 32);

// Crockford base32 without I, L, O, U: unambiguous when read aloud or typed.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Human-friendly random reference such as "C-7K3M2Q9A". Not sequential, so it reveals no volume. */
export function makeReference(prefix: string, length = 8) {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return `${prefix}-${out}`;
}

/** Six-digit numeric verification code. */
export const makeNumericCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

/** Stable JSON for request hashing: object keys sorted recursively. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** Signed, expiring token: base64url(payload).signature */
export function signPayload(secret: string, payload: Record<string, unknown>) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${hmac(secret, body)}`;
}

export function verifySignedPayload<T extends { exp: number }>(secret: string, token: string, nowMs: number): T | null {
  const [body, signature] = token.split('.');
  if (!body || !signature || !safeEqual(signature, hmac(secret, body))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < nowMs) return null;
    return payload;
  } catch {
    return null;
  }
}
