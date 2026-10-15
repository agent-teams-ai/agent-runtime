import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

interface JsonCursor { index: number }
interface JsonStringToken { raw: string; value: string }
export interface InstallationJson { value: Record<string, unknown>; keys: JsonStringToken[] }

function skipWhitespace(source: string, cursor: JsonCursor): void {
  while (cursor.index < source.length && [0x09, 0x0a, 0x0d, 0x20].includes(source.charCodeAt(cursor.index))) {cursor.index++;}
}

function parseString(source: string, cursor: JsonCursor): JsonStringToken {
  assert.equal(source[cursor.index], '"', 'installed metadata string expected');
  const start = cursor.index++;
  while (cursor.index < source.length) {
    const code = source.charCodeAt(cursor.index++);
    if (code === 0x22) {
      const raw = source.slice(start, cursor.index); return { raw, value: JSON.parse(raw) as string };
    }
    if (code !== 0x5c) {
      assert.ok(code >= 0x20, 'installed metadata string contains an unescaped control character'); continue;
    }
    assert.ok(cursor.index < source.length, 'installed metadata string escape is incomplete');
    const escape = source[cursor.index++]!;
    if (escape !== 'u') {
      assert.ok('"\\/bfnrt'.includes(escape), 'installed metadata string escape is invalid'); continue;
    }
    assert.ok(cursor.index + 4 <= source.length, 'installed metadata Unicode escape is incomplete');
    for (const digit of source.slice(cursor.index, cursor.index + 4)) {
      assert.ok((digit >= '0' && digit <= '9') || (digit >= 'a' && digit <= 'f') || (digit >= 'A' && digit <= 'F'),
        'installed metadata Unicode escape is invalid');
    }
    cursor.index += 4;
  }
  throw new Error('installed metadata string is incomplete');
}

function scanValue(source: string, cursor: JsonCursor, keys: JsonStringToken[]): unknown {
  skipWhitespace(source, cursor);
  const value = source[cursor.index];
  assert.ok(value !== undefined, 'installed metadata value is incomplete');
  if (value === '{') {
    cursor.index++; skipWhitespace(source, cursor);
    const object = Object.create(null) as Record<string, unknown>, seen = new Set<string>();
    if (source[cursor.index] === '}') {cursor.index++; return object;}
    while (true) {
      skipWhitespace(source, cursor); const key = parseString(source, cursor); keys.push(key);
      assert.ok(!seen.has(key.value), 'installed metadata duplicate key drift'); seen.add(key.value);
      skipWhitespace(source, cursor); assert.equal(source[cursor.index], ':', 'installed metadata property separator'); cursor.index++;
      object[key.value] = scanValue(source, cursor, keys); skipWhitespace(source, cursor);
      const separator = source[cursor.index];
      assert.ok(separator === ',' || separator === '}', 'installed metadata object is incomplete'); cursor.index++;
      if (separator === '}') {return object;}
    }
  }
  if (value === '[') {
    cursor.index++; skipWhitespace(source, cursor);
    const array: unknown[] = [];
    if (source[cursor.index] === ']') {cursor.index++; return array;}
    while (true) {
      array.push(scanValue(source, cursor, keys)); skipWhitespace(source, cursor);
      const separator = source[cursor.index];
      assert.ok(separator === ',' || separator === ']', 'installed metadata array is incomplete'); cursor.index++;
      if (separator === ']') {return array;}
    }
  }
  if (value === '"') {return parseString(source, cursor).value;}
  const start = cursor.index;
  while (cursor.index < source.length && !',]}'.includes(source[cursor.index]!) && ![0x09, 0x0a, 0x0d, 0x20].includes(source.charCodeAt(cursor.index))) {cursor.index++;}
  assert.ok(cursor.index > start, 'installed metadata value is empty');
  const raw = source.slice(start, cursor.index), parsed = JSON.parse(raw) as unknown;
  if (typeof parsed === 'number') {
    assert.ok(Number.isFinite(parsed), 'installed metadata number is lossy or non-canonical');
    assert.equal(JSON.stringify(parsed), raw, 'installed metadata number is lossy or non-canonical');
  }
  return parsed;
}

export function parseInstallationJson(bytes: Buffer): InstallationJson {
  const source = bytes.toString('utf8');
  assert.ok(Buffer.from(source, 'utf8').equals(bytes), 'installed metadata is not exact UTF-8');
  const cursor: JsonCursor = { index: 0 }, keys: JsonStringToken[] = [];
  const value = scanValue(source, cursor, keys);
  skipWhitespace(source, cursor); assert.equal(cursor.index, source.length, 'installed metadata has trailing content');
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), 'installed metadata is not a JSON object');
  return { value: value as Record<string, unknown>, keys };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {return `[${value.map(canonicalJson).join(',')}]`;}
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).toSorted(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  assert.ok(serialized !== undefined, 'canonical JSON value');
  return serialized;
}

export function installationStateDigest(bytes: Buffer): string {
  const { value: state } = parseInstallationJson(bytes);
  assert.equal(typeof state.lastValidatedTimestamp, 'number', 'installed workspace state timestamp');
  const { lastValidatedTimestamp: volatileTimestamp, ...stable } = state;
  assert.ok(Number.isFinite(volatileTimestamp), 'installed workspace state timestamp');
  return createHash('sha256').update(canonicalJson(stable)).digest('hex');
}
