import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { mock, test } from "node:test";
import vm from "node:vm";

// The repository build normally supplies .js siblings under dist. This narrow
// fallback lets the checkpoint's source-only tests run with pinned Node when
// dependencies and compiled output are intentionally absent.
registerHooks({resolve(specifier, context, nextResolve) {
  try {
    return nextResolve(specifier, context);
  } catch (error) {
    if (specifier.startsWith("./") && specifier.endsWith(".js")) {
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    }
    throw error;
  }
}});

const intrinsicFill = Uint8Array.prototype.fill;
let capturedClears: Uint8Array[] | undefined;
const observedFill = mock.method(Uint8Array.prototype, "fill",
  function(this: Uint8Array, value: number): Uint8Array {
    if (value === 0) {capturedClears?.push(this);}
    return Reflect.apply(intrinsicFill, this, [value]);
  });
const {
  PREPARED_HTTP_REQUEST_V1_LIMITS: LIMITS,
  PreparedHttpRequestV1Error,
  createPreparedHttpRequestV1,
} = await import("../../../src/features/contained-agent-turn/adapters/outbound/host-custody/egress/prepared-http-request-v1.ts");
observedFill.mock.restore();

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytes = (value: string): Uint8Array => encoder.encode(value);

const baseInput = (overrides: Record<string, unknown> = {}) => {
  const input = {
    methodBytes: bytes("POST"),
    targetBytes: bytes("/v1/messages"),
    hostBytes: bytes("api.provider.example"),
    presentationFields: [
      {name: "content-type", valueBytes: bytes("application/json")},
      {name: "accept", valueBytes: bytes("application/json")},
    ],
    credentialFields: [{name: "Authorization", valueBytes: bytes("Bearer synthetic-secret")}],
    bodyBytes: bytes('{"prompt":"hi"}'),
    ...overrides,
  };
  return {
    credentialHeaderNameAllowlist: ["authorization"],
    ...input,
    ...overrides,
  };
};

const slice = (source: Uint8Array, offset: number, length: number): Uint8Array => {
  const result = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {result[index] = source[offset + index] as number;}
  return result;
};

const allZero = (source: Uint8Array): boolean => {
  for (let index = 0; index < source.byteLength; index += 1) {
    if (source[index] !== 0) {return false;}
  }
  return true;
};

const u32be = (value: number): Uint8Array => new Uint8Array([
  (value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff,
]);

const join = (parts: readonly Uint8Array[]): Uint8Array => {
  let length = 0;
  for (const part of parts) {length += part.byteLength;}
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    for (let index = 0; index < part.byteLength; index += 1) {result[offset + index] = part[index] as number;}
    offset += part.byteLength;
  }
  return result;
};

const expectedProjection = (lines: readonly string[]): Uint8Array => join([
  u32be(lines.length),
  ...lines.flatMap(line => {
    const encoded = bytes(line);
    return [u32be(encoded.byteLength), encoded];
  }),
]);

const assertRejected = (overrides: Record<string, unknown>): void => {
  assert.throws(() => createPreparedHttpRequestV1(baseInput(overrides) as never), PreparedHttpRequestV1Error);
};

const consumePreparedHttpRequestV1 = (input: ReturnType<typeof baseInput>) => {
  const pending = createPreparedHttpRequestV1(input);
  const custody = pending.consume();
  assert.ok(custody);
  return custody;
};

test("emits one exact HTTP/1.1 wire product and exact immutable spans", () => {
  const prepared = consumePreparedHttpRequestV1(baseInput());
  const expectedLines = [
    "accept: application/json\r\n",
    "content-type: application/json\r\n",
    "Host: api.provider.example\r\n",
    "authorization: Bearer synthetic-secret\r\n",
    "Content-Length: 15\r\n",
  ];
  const expectedWire = "POST /v1/messages HTTP/1.1\r\n"
    + expectedLines.join("") + '\r\n{"prompt":"hi"}';
  assert.deepEqual(prepared.wireBytes, bytes(expectedWire));
  assert.equal(decoder.decode(slice(prepared.wireBytes, prepared.targetSpan.offset,
    prepared.targetSpan.length)), "/v1/messages");
  assert.equal(decoder.decode(slice(prepared.wireBytes, prepared.bodySpan.offset,
    prepared.bodySpan.length)), '{"prompt":"hi"}');
  assert.equal(prepared.headerLineSpans.length, expectedLines.length);
  for (let index = 0; index < expectedLines.length; index += 1) {
    const span = prepared.headerLineSpans[index]!;
    assert.equal(decoder.decode(slice(prepared.wireBytes, span.offset, span.length)), expectedLines[index]);
    assert.equal(decoder.decode(slice(prepared.wireBytes, span.offset + span.length - 2, 2)), "\r\n");
    assert.equal(Object.isFrozen(span), true);
  }
  assert.deepEqual(prepared.headerProjectionBytes, expectedProjection(expectedLines));
  assert.equal(Object.isFrozen(prepared.headerLineSpans), true);
  assert.equal(Object.isFrozen(prepared.credentialValueSpans), true);
  assert.equal(Object.isFrozen(prepared.targetSpan), true);
  assert.equal(Object.isFrozen(prepared.bodySpan), true);
  prepared.dispose();
});

test("sorts normalized credential names and spans only their emitted values", () => {
  const prepared = consumePreparedHttpRequestV1(baseInput({
    presentationFields: [],
    credentialHeaderNameAllowlist: ["authorization", "x-api-key", "x-zeta"],
    credentialFields: [
      {name: "X-Zeta", valueBytes: bytes("z one two")},
      {name: "Authorization", valueBytes: bytes("Bearer a")},
      {name: "X-Api-Key", valueBytes: bytes("key-value")},
    ],
    bodyBytes: new Uint8Array(),
  }));
  assert.deepEqual(prepared.credentialValueSpans.map(span => span.name), ["authorization", "x-api-key", "x-zeta"]);
  assert.deepEqual(prepared.credentialValueSpans.map(span =>
    decoder.decode(slice(prepared.wireBytes, span.offset, span.length))),
    ["Bearer a", "key-value", "z one two"]);
  assert.equal(decoder.decode(prepared.wireBytes),
    "POST /v1/messages HTTP/1.1\r\nHost: api.provider.example\r\n"
    + "authorization: Bearer a\r\nx-api-key: key-value\r\nx-zeta: z one two\r\n"
    + "Content-Length: 0\r\n\r\n");
  prepared.dispose();
});

test("private prepared bytes survive source mutation until their one-shot custody transfer", () => {
  const method = bytes("POST");
  const target = bytes("/stable");
  const host = bytes("stable.example:8443");
  const presentationValue = bytes("application/json");
  const credentialValue = bytes("Bearer caller-owned");
  const body = bytes("abc");
  const credentialOriginal = credentialValue.slice();
  const pending = createPreparedHttpRequestV1({
    methodBytes: method, targetBytes: target, hostBytes: host,
    presentationFields: [{name: "accept", valueBytes: presentationValue}],
    credentialHeaderNameAllowlist: ["authorization"],
    credentialFields: [{name: "Authorization", valueBytes: credentialValue}], bodyBytes: body,
  });
  assert.deepEqual(Reflect.ownKeys(pending), ["consume", "dispose"]);
  method.fill(88); target.fill(88); host.fill(88); presentationValue.fill(88);
  credentialValue.fill(88); body.fill(88);
  const prepared = pending.consume();
  assert.ok(prepared);
  assert.equal(pending.consume(), undefined);
  assert.equal(decoder.decode(prepared.wireBytes),
    "POST /stable HTTP/1.1\r\naccept: application/json\r\nHost: stable.example:8443\r\n"
    + "authorization: Bearer caller-owned\r\nContent-Length: 3\r\n\r\nabc");
  prepared.dispose();
  assert.deepEqual(credentialOriginal, bytes("Bearer caller-owned"));
  assert.equal(allZero(credentialValue), false, "dispose must not clear caller-owned input");
});

test("dispose clears every owned result buffer through hostile instance overrides and is idempotent", () => {
  const prepared = consumePreparedHttpRequestV1(baseInput());
  let calls = 0;
  for (const owned of [prepared.wireBytes, prepared.headerProjectionBytes]) {
    Object.defineProperties(owned, {
      fill: {value: () => {calls += 1; throw new Error("must not call own fill");}},
      set: {value: () => {calls += 1; throw new Error("must not call own set");}},
    });
  }
  prepared.dispose();
  prepared.dispose();
  assert.equal(allZero(prepared.wireBytes), true);
  assert.equal(allZero(prepared.headerProjectionBytes), true);
  assert.equal(calls, 0);
});

test("empty body emits exact zero Content-Length and a zero-length terminal span", () => {
  const prepared = consumePreparedHttpRequestV1(baseInput({presentationFields: [], credentialFields: [],
    bodyBytes: new Uint8Array()}));
  assert.equal(decoder.decode(prepared.wireBytes),
    "POST /v1/messages HTTP/1.1\r\nHost: api.provider.example\r\nContent-Length: 0\r\n\r\n");
  assert.equal(prepared.bodySpan.length, 0);
  assert.equal(prepared.bodySpan.offset, prepared.wireBytes.byteLength);
  prepared.dispose();
});

test("Content-Length comes from the intrinsic body byte count", () => {
  const body = bytes("12345");
  Object.defineProperty(body, "byteLength", {get: () => 999_999});
  const prepared = consumePreparedHttpRequestV1(baseInput({bodyBytes: body, presentationFields: [], credentialFields: []}));
  assert.match(decoder.decode(prepared.wireBytes), /Content-Length: 5\r\n\r\n12345$/);
  prepared.dispose();
});

for (const [name, overrides] of [
  ["method CR", {methodBytes: bytes("PO\rST")}],
  ["method LF", {methodBytes: bytes("PO\nST")}],
  ["CONNECT", {methodBytes: bytes("CONNECT")}],
  ["absolute target", {targetBytes: bytes("https://provider.example/x")}],
  ["authority target", {targetBytes: bytes("//provider.example/x")}],
  ["target query", {targetBytes: bytes("/x?admin=true")}],
  ["target fragment", {targetBytes: bytes("/x#fragment")}],
  ["target CRLF", {targetBytes: bytes("/x\r\nHost: evil")}],
  ["target backslash", {targetBytes: bytes("/x\\admin")}],
  ["target raw brackets", {targetBytes: bytes("/x[admin]")}],
  ["target raw braces", {targetBytes: bytes("/x{admin}")}],
  ["target raw angle", {targetBytes: bytes("/x<admin>")}],
  ["target raw quote", {targetBytes: bytes('/x"admin')}],
  ["target truncated escape", {targetBytes: bytes("/x%2")}],
  ["target malformed escape", {targetBytes: bytes("/x%ZZ")}],
  ["host CRLF", {hostBytes: bytes("good.example\r\nX-Evil: yes")}],
  ["host userinfo", {hostBytes: bytes("user@good.example")}],
  ["host invalid port", {hostBytes: bytes("good.example:65536")}],
] as const) {
  test(`fails closed for ${name}`, () => assertRejected(overrides));
}

for (const value of [new Uint8Array(), new Uint8Array([0]), new Uint8Array([10]), new Uint8Array([13]),
  new Uint8Array([31]), new Uint8Array([127]), new Uint8Array([128])]) {
  test(`rejects empty/control credential value ${Array.from(value).join("-")}`, () => {
    assertRejected({credentialFields: [{name: "authorization", valueBytes: value}]});
  });
}

test("allows horizontal tab and visible ASCII in a credential value", () => {
  const value = new Uint8Array([65, 9, 32, 126]);
  const prepared = consumePreparedHttpRequestV1(baseInput({presentationFields: [],
    credentialHeaderNameAllowlist: ["x-token"],
    credentialFields: [{name: "x-token", valueBytes: value}]}));
  const span = prepared.credentialValueSpans[0]!;
  assert.deepEqual(slice(prepared.wireBytes, span.offset, span.length), value);
  prepared.dispose();
});

test("accepts RFC pchar and well-formed percent escapes in an absolute path", () => {
  const target = "/a%2Fb:@!$&'()*+,;=._~-";
  const prepared = consumePreparedHttpRequestV1(baseInput({targetBytes: bytes(target)}));
  assert.equal(decoder.decode(slice(prepared.wireBytes, prepared.targetSpan.offset,
    prepared.targetSpan.length)), target);
  prepared.dispose();
});

for (const name of ["host", "HOST", "content-length", "Connection", "keep-alive", "proxy-authenticate",
  "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade",
  "expect", "accept", "content-type"]) {
  test(`credential name cannot collide with ${name}`, () => {
    assertRejected({credentialFields: [{name, valueBytes: bytes("x")}]});
  });
}

test("rejects case-normalized credential duplicates", () => {
  assertRejected({credentialHeaderNameAllowlist: ["x-api-key"], credentialFields: [
    {name: "X-Api-Key", valueBytes: bytes("one")},
    {name: "x-api-key", valueBytes: bytes("two")},
  ]});
});

test("credential names require the authority's exact normalized allowlist", () => {
  const allowed = consumePreparedHttpRequestV1(baseInput({presentationFields: [],
    credentialHeaderNameAllowlist: ["authorization", "x-api-key"],
    credentialFields: [
      {name: "Authorization", valueBytes: bytes("Bearer one")},
      {name: "X-Api-Key", valueBytes: bytes("two")},
    ]}));
  assert.deepEqual(allowed.credentialValueSpans.map(span => span.name), ["authorization", "x-api-key"]);
  allowed.dispose();

  for (const name of ["cookie", "x-unapproved"]) {
    assertRejected({credentialHeaderNameAllowlist: ["authorization"],
      credentialFields: [{name, valueBytes: bytes("secret")}]});
  }
});

test("rejects non-normalized, duplicate, colliding, and malformed authority allowlists", () => {
  for (const credentialHeaderNameAllowlist of [
    ["Authorization"], ["authorization", "authorization"], ["host"], ["bad name"],
  ]) {
    assertRejected({credentialHeaderNameAllowlist, credentialFields: []});
  }
});

test("a late validation failure clears every acquired private snapshot", () => {
  const callerValue = bytes("caller-retained");
  capturedClears = [];
  try {
    assertRejected({credentialFields: [
      {name: "X-First", valueBytes: callerValue},
      {name: "x-first", valueBytes: bytes("duplicate")},
    ], credentialHeaderNameAllowlist: ["x-first"]});
    assert.ok(capturedClears.length >= 6);
    assert.equal(capturedClears.every(value => allZero(value)), true);
    assert.equal(capturedClears.includes(callerValue), false);
    assert.deepEqual(callerValue, bytes("caller-retained"));
  } finally {
    capturedClears = undefined;
  }
});

for (const name of ["", "bad name", "bad:name", "x-ü", "x\r\ny"]) {
  test(`rejects malformed credential name ${JSON.stringify(name)}`, () => {
    assertRejected({credentialFields: [{name, valueBytes: bytes("value")}]});
  });
}

test("presentation fields remain the narrow explicit lowercase mapping", () => {
  for (const name of ["Accept", "authorization", "x-custom", "connection", "host"]) {
    assertRejected({presentationFields: [{name, valueBytes: bytes("value")}], credentialFields: []});
  }
  assertRejected({presentationFields: [
    {name: "accept", valueBytes: bytes("one")},
    {name: "accept", valueBytes: bytes("two")},
  ], credentialFields: []});
});

test("rejects accessors without invoking them at the root or field boundary", () => {
  let calls = 0;
  const root = baseInput();
  Object.defineProperty(root, "hostBytes", {enumerable: true, get: () => {calls += 1; return bytes("evil");}});
  assert.throws(() => createPreparedHttpRequestV1(root as never), PreparedHttpRequestV1Error);
  const field = Object.defineProperty({name: "authorization"}, "valueBytes",
    {enumerable: true, get: () => {calls += 1; return bytes("evil");}});
  assertRejected({credentialFields: [field]});
  assert.equal(calls, 0);
});

test("rejects proxy-shaped root, arrays, and field records without consulting traps", () => {
  let calls = 0;
  const traps = {get: (target: object, property: PropertyKey, receiver: unknown) => {
    calls += 1; return Reflect.get(target, property, receiver);
  }};
  const rootProxy = new Proxy(baseInput(), traps);
  assert.throws(() => createPreparedHttpRequestV1(rootProxy as never), PreparedHttpRequestV1Error);
  const arrayProxy = new Proxy([{name: "authorization", valueBytes: bytes("x")}], traps);
  assertRejected({credentialFields: arrayProxy});
  const fieldProxy = new Proxy({name: "authorization", valueBytes: bytes("x")}, traps);
  assertRejected({credentialFields: [fieldProxy]});
  assert.equal(calls, 0);
});

test("rejects sparse arrays, array accessors, symbols, and extra record properties", () => {
  const sparse: unknown[] = [];
  sparse.length = 1;
  assertRejected({credentialFields: sparse});
  const accessor: unknown[] = [];
  Object.defineProperty(accessor, "0", {get: () => ({name: "x", valueBytes: bytes("x")})});
  Object.defineProperty(accessor, "length", {value: 1});
  assertRejected({credentialFields: accessor});
  const symbolArray = [{name: "x", valueBytes: bytes("x")}];
  Object.defineProperty(symbolArray, Symbol("extra"), {value: true});
  assertRejected({credentialFields: symbolArray});
  assertRejected({credentialFields: [{name: "x", valueBytes: bytes("x"), extra: true}]});
});

test("hostile Uint8Array methods and claimed instance lengths are never invoked", () => {
  const sources = [bytes("POST"), bytes("/safe"), bytes("safe.example"), bytes("Bearer safe"), bytes("body")];
  let calls = 0;
  for (const source of sources) {
    Object.defineProperties(source, {
      byteLength: {get: () => {calls += 1; return 0;}},
      every: {value: () => {calls += 1; throw new Error("every");}},
      fill: {value: () => {calls += 1; throw new Error("fill");}},
      set: {value: () => {calls += 1; throw new Error("set");}},
      slice: {value: () => {calls += 1; throw new Error("slice");}},
      subarray: {value: () => {calls += 1; throw new Error("subarray");}},
    });
  }
  const prepared = consumePreparedHttpRequestV1({methodBytes: sources[0]!, targetBytes: sources[1]!,
    hostBytes: sources[2]!, presentationFields: [],
    credentialHeaderNameAllowlist: ["authorization"],
    credentialFields: [{name: "authorization", valueBytes: sources[3]!}], bodyBytes: sources[4]!});
  assert.equal(decoder.decode(prepared.wireBytes),
    "POST /safe HTTP/1.1\r\nHost: safe.example\r\nauthorization: Bearer safe\r\nContent-Length: 4\r\n\r\nbody");
  assert.equal(calls, 0);
  prepared.dispose();
});

test("accepts genuine cross-realm Uint8Array inputs", () => {
  const crossRealm = vm.runInNewContext(`({
    methodBytes: new Uint8Array([80,79,83,84]),
    targetBytes: new Uint8Array([47,120]),
    hostBytes: new Uint8Array([104,46,101]),
    credential: new Uint8Array([116,111,107,101,110]),
    bodyBytes: new Uint8Array([120])
  })`) as Record<string, Uint8Array>;
  const prepared = consumePreparedHttpRequestV1({methodBytes: crossRealm.methodBytes!,
    targetBytes: crossRealm.targetBytes!, hostBytes: crossRealm.hostBytes!, presentationFields: [],
    credentialHeaderNameAllowlist: ["x-key"],
    credentialFields: [{name: "x-key", valueBytes: crossRealm.credential!}], bodyBytes: crossRealm.bodyBytes!});
  assert.equal(decoder.decode(prepared.wireBytes),
    "POST /x HTTP/1.1\r\nHost: h.e\r\nx-key: token\r\nContent-Length: 1\r\n\r\nx");
  prepared.dispose();
});

test("detached byte inputs fail closed", () => {
  const detached = bytes("POST");
  structuredClone(detached, {transfer: [detached.buffer]});
  assertRejected({methodBytes: detached});
});

test("rejects SharedArrayBuffer-backed inputs instead of taking tearable snapshots", () => {
  const shared = new Uint8Array(new SharedArrayBuffer(4));
  shared.set(bytes("POST"));
  assertRejected({methodBytes: shared});
});

test("rejects resizable ArrayBuffer-backed inputs before snapshotting", () => {
  const backing = new ArrayBuffer(4, {maxByteLength: 8});
  const resizable = new Uint8Array(backing);
  resizable.set(bytes("POST"));
  assert.equal(backing.resizable, true);
  assertRejected({methodBytes: resizable});
});

test("accepts exact field, target, and body limits", () => {
  const target = bytes("/" + "x".repeat(LIMITS.maximumTargetBytes - 1));
  const fieldValue = bytes("x".repeat(LIMITS.maximumFieldValueBytes));
  const body = new Uint8Array(LIMITS.maximumBodyBytes);
  const prepared = consumePreparedHttpRequestV1(baseInput({targetBytes: target, presentationFields: [],
    credentialHeaderNameAllowlist: ["x-limit"],
    credentialFields: [{name: "x-limit", valueBytes: fieldValue}], bodyBytes: body}));
  assert.equal(prepared.targetSpan.length, LIMITS.maximumTargetBytes);
  assert.equal(prepared.credentialValueSpans[0]?.length, LIMITS.maximumFieldValueBytes);
  assert.equal(prepared.bodySpan.length, LIMITS.maximumBodyBytes);
  prepared.dispose();
});

test("accepts exact method, Host, and field-name byte limits", () => {
  const methodBytes = bytes("M".repeat(LIMITS.maximumMethodBytes));
  const hostBytes = bytes(`${"h".repeat(LIMITS.maximumHostBytes - 6)}:65535`);
  const fieldName = `x${"n".repeat(LIMITS.maximumFieldNameBytes - 1)}`;
  const prepared = consumePreparedHttpRequestV1(baseInput({methodBytes, hostBytes, presentationFields: [],
    credentialHeaderNameAllowlist: [fieldName],
    credentialFields: [{name: fieldName, valueBytes: bytes("x")}]}));
  assert.equal(prepared.targetSpan.offset, LIMITS.maximumMethodBytes + 1);
  assert.equal(prepared.credentialValueSpans[0]?.name.length, LIMITS.maximumFieldNameBytes);
  assert.match(decoder.decode(prepared.wireBytes), new RegExp(`^M{${LIMITS.maximumMethodBytes}} /v1/messages HTTP/1\\.1`));
  prepared.dispose();
});

test("accepts the exact credential-field count limit", () => {
  const credentialFields = Array.from({length: LIMITS.maximumCredentialFields}, (_, index) =>
    ({name: `x-limit-${String(index).padStart(2, "0")}`, valueBytes: bytes("x")}));
  const credentialHeaderNameAllowlist = credentialFields.map(field => field.name);
  const prepared = consumePreparedHttpRequestV1(baseInput({presentationFields: [],
    credentialHeaderNameAllowlist, credentialFields}));
  assert.equal(prepared.credentialValueSpans.length, LIMITS.maximumCredentialFields);
  prepared.dispose();
});

test("aggregate wire bounds reject otherwise individually bounded inputs", () => {
  const value = bytes("x".repeat(LIMITS.maximumFieldValueBytes));
  const credentialFields = Array.from({length: LIMITS.maximumCredentialFields}, (_, index) =>
    ({name: `x-large-${String(index).padStart(2, "0")}`, valueBytes: value}));
  const credentialHeaderNameAllowlist = credentialFields.map(field => field.name);
  assertRejected({targetBytes: bytes("/" + "x".repeat(LIMITS.maximumTargetBytes - 1)),
    presentationFields: [
      {name: "accept", valueBytes: value}, {name: "content-type", valueBytes: value},
    ], credentialHeaderNameAllowlist, credentialFields, bodyBytes: new Uint8Array(LIMITS.maximumBodyBytes)});
});

test("rejects every one-byte oversize input before a wire product exists", () => {
  assertRejected({methodBytes: bytes("X".repeat(LIMITS.maximumMethodBytes + 1))});
  assertRejected({targetBytes: bytes("/" + "x".repeat(LIMITS.maximumTargetBytes))});
  assertRejected({hostBytes: bytes("h".repeat(LIMITS.maximumHostBytes + 1))});
  assertRejected({credentialHeaderNameAllowlist: ["x"],
    credentialFields: [{name: "x".repeat(LIMITS.maximumFieldNameBytes + 1), valueBytes: bytes("x")}]});
  assertRejected({credentialHeaderNameAllowlist: ["x"],
    credentialFields: [{name: "x", valueBytes: bytes("x".repeat(LIMITS.maximumFieldValueBytes + 1))}]});
  assertRejected({bodyBytes: new Uint8Array(LIMITS.maximumBodyBytes + 1)});
  assertRejected({presentationFields: [
    {name: "accept", valueBytes: bytes("x")}, {name: "content-type", valueBytes: bytes("x")},
    {name: "accept", valueBytes: bytes("x")},
  ]});
  const credentials = Array.from({length: LIMITS.maximumCredentialFields + 1}, (_, index) =>
    ({name: `x-${index}`, valueBytes: bytes("x")}));
  assertRejected({credentialFields: credentials});
});

test("length-framed header ambiguity candidates produce distinct projections", () => {
  const first = consumePreparedHttpRequestV1(baseInput({presentationFields: [], bodyBytes: new Uint8Array(),
    credentialHeaderNameAllowlist: ["x-a", "x-d"],
    credentialFields: [{name: "x-a", valueBytes: bytes("bc")}, {name: "x-d", valueBytes: bytes("e")}] }));
  const second = consumePreparedHttpRequestV1(baseInput({presentationFields: [], bodyBytes: new Uint8Array(),
    credentialHeaderNameAllowlist: ["x-ab", "x-d"],
    credentialFields: [{name: "x-ab", valueBytes: bytes("c")}, {name: "x-d", valueBytes: bytes("e")}] }));
  assert.equal(["x-a", "bc", "x-d", "e"].join(""), ["x-ab", "c", "x-d", "e"].join(""),
    "the deliberately unframed name/value sequences collide");
  assert.notDeepEqual(first.headerProjectionBytes, second.headerProjectionBytes);
  assert.deepEqual(first.headerProjectionBytes, expectedProjection([
    "Host: api.provider.example\r\n", "x-a: bc\r\n", "x-d: e\r\n", "Content-Length: 0\r\n",
  ]));
  first.dispose(); second.dispose();
});

test("does not emit hop-by-hop, transfer, upgrade, or URL authority syntax", () => {
  const prepared = consumePreparedHttpRequestV1(baseInput());
  const wire = decoder.decode(prepared.wireBytes).toLowerCase();
  assert.equal(wire.includes("connection:"), false);
  assert.equal(wire.includes("transfer-encoding:"), false);
  assert.equal(wire.includes("upgrade:"), false);
  assert.equal(wire.startsWith("post /v1/messages http/1.1\r\n"), true);
  prepared.dispose();
});

test("prepared custody is atomic, one-shot, and unavailable after disposal", () => {
  const pending = createPreparedHttpRequestV1(baseInput());
  assert.equal("wireBytes" in pending, false);
  assert.equal("headerProjectionBytes" in pending, false);
  const custody = pending.consume();
  assert.ok(custody);
  assert.equal(pending.consume(), undefined);
  pending.dispose();
  assert.equal(allZero(custody.wireBytes), false, "ownership moved to the consumer");
  custody.dispose();

  const disposed = createPreparedHttpRequestV1(baseInput());
  capturedClears = [];
  try {
    disposed.dispose();
    disposed.dispose();
    assert.equal(disposed.consume(), undefined);
    assert.equal(capturedClears.length, 2);
    assert.equal(capturedClears.every(value => allZero(value)), true);
  } finally {
    capturedClears = undefined;
  }
});

test("transferred wire and projection custody have no caller-input or mutual backing aliases", () => {
  const credential = bytes("Bearer private");
  const body = bytes("private body");
  const custody = consumePreparedHttpRequestV1(baseInput({presentationFields: [],
    credentialFields: [{name: "authorization", valueBytes: credential}], bodyBytes: body}));
  assert.notEqual(custody.wireBytes.buffer, credential.buffer);
  assert.notEqual(custody.wireBytes.buffer, body.buffer);
  assert.notEqual(custody.wireBytes.buffer, custody.headerProjectionBytes.buffer);
  const projection = custody.headerProjectionBytes.slice();
  custody.wireBytes[custody.bodySpan.offset] = 88;
  assert.deepEqual(custody.headerProjectionBytes, projection);
  assert.deepEqual(body, bytes("private body"));
  custody.dispose();
});

test("the consuming owner may transfer custody and assumes zeroization ownership", () => {
  const pending = createPreparedHttpRequestV1(baseInput());
  const custody = pending.consume();
  assert.ok(custody);
  const transferred = structuredClone(custody.wireBytes, {transfer: [custody.wireBytes.buffer]});
  assert.equal(custody.wireBytes.byteLength, 0);
  custody.dispose();
  assert.equal(allZero(custody.headerProjectionBytes), true);
  assert.equal(allZero(transferred), false, "the transfer recipient now owns these bytes");
  transferred.fill(0);
  assert.equal(allZero(transferred), true);
  assert.equal(pending.consume(), undefined);
});
