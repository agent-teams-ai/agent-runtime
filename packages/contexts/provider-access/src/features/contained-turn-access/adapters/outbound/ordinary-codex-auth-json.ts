import { OrdinaryCodexAuthRefused } from './ordinary-codex-auth-contracts.js';

export function authRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) { throw new OrdinaryCodexAuthRefused(); }
  return value as Record<string, unknown>;
}
/** JSON.parse accepts duplicate keys; reject their decoded spelling before parsing. */
export function parseAuthFrame(bytes: Uint8Array): Record<string, unknown> {
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const stack: Array<Set<string> | null> = [];
  for (const match of source.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\]]/gs)) {
    const token = match[0];
    if (token === '{') { stack.push(new Set()); }
    else if (token === '[') { stack.push(null); }
    else if (token === '}' || token === ']') { stack.pop(); }
    else if (/^\s*:/.test(source.slice(match.index + token.length))) {
      const key: unknown = JSON.parse(token);
      const keys = stack.at(-1);
      if (typeof key !== 'string' || !keys || keys.has(key)) { throw new OrdinaryCodexAuthRefused(); }
      keys.add(key);
    }
    if (stack.length > 32) { throw new OrdinaryCodexAuthRefused(); }
  }
  return authRecord(JSON.parse(source));
}

export function conservativeTokenExpiry(token: Buffer, now: number): number {
  // JWT payload is used ONLY to shorten expiry; neither identity nor signature is inferred.
  const encoded = token.toString('ascii').split('.');
  if (encoded.length !== 3 || !encoded[1] || !/^[A-Za-z0-9_-]+$/.test(encoded[1])) { throw new OrdinaryCodexAuthRefused(); }
  const payload = Buffer.from(encoded[1], 'base64url');
  try {
    const exp = parseAuthFrame(payload).exp;
    if (typeof exp !== 'number' || !Number.isSafeInteger(exp) || exp <= 0 || exp * 1000 <= now) { throw new OrdinaryCodexAuthRefused(); }
    return Math.min(exp * 1000, now + 60_000);
  } finally { payload.fill(0); }
}
