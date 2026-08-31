export const DOCKER_CUSTODY_INIT_PROTOCOL = "ar.docker-custody-init/v1" as const;
export const DOCKER_CUSTODY_INIT_MAX_FRAME_BYTES = 65_536;

const MAX_IDENTITY_BYTES = 256;
const MAX_ARGUMENTS = 128;
const MAX_ENVIRONMENT = 128;
const MAX_VALUE_BYTES = 8_192;
export const DOCKER_CUSTODY_PROVIDER_IO_MAX_BYTES = 48_000;
const SHA256 = /^[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9._:@+-]{1,256}$/u;

export const DOCKER_CUSTODY_CHILD_SIGNALS = Object.freeze([
  "SIGABRT", "SIGALRM", "SIGBUS", "SIGCHLD", "SIGCONT", "SIGFPE", "SIGHUP", "SIGILL",
  "SIGEMT", "SIGINFO", "SIGINT", "SIGIO", "SIGIOT", "SIGKILL", "SIGLOST", "SIGPIPE",
  "SIGPOLL", "SIGPROF", "SIGPWR", "SIGQUIT", "SIGSEGV", "SIGSTKFLT", "SIGSTOP", "SIGSYS",
  "SIGTERM", "SIGTRAP", "SIGTSTP", "SIGTTIN", "SIGTTOU", "SIGURG", "SIGUSR1", "SIGUSR2",
  "SIGVTALRM", "SIGWINCH", "SIGXCPU", "SIGXFSZ",
] as const);
export type DockerCustodyChildSignal = typeof DOCKER_CUSTODY_CHILD_SIGNALS[number];
export const DOCKER_CUSTODY_HOST_SIGNALS = Object.freeze([
  "SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM", "SIGUSR1", "SIGUSR2",
] as const);
export type DockerCustodyHostSignal = typeof DOCKER_CUSTODY_HOST_SIGNALS[number];

export interface DockerCustodyIdentity {
  readonly containerImageSha256: string;
  readonly initBinarySha256: string;
  readonly privateRootIdentity: string;
  readonly protocol: typeof DOCKER_CUSTODY_INIT_PROTOCOL;
  readonly securityProfileIdentity: string;
  readonly workspaceIdentity: string;
}

export interface DockerCustodyHostHandshake {
  readonly expectedIdentity: DockerCustodyIdentity;
  readonly kind: "host-handshake";
  readonly launchFingerprintSha256: string;
  readonly nonce: string;
  readonly protocol: typeof DOCKER_CUSTODY_INIT_PROTOCOL;
}

export interface DockerCustodyInitReady {
  readonly kind: "init-ready";
  readonly launchFingerprintSha256: string;
  readonly nonce: string;
  readonly observedIdentity: DockerCustodyIdentity;
  readonly protocol: typeof DOCKER_CUSTODY_INIT_PROTOCOL;
}

export interface DockerCustodyEnvironmentEntry {readonly name: string; readonly value: string;}

export interface DockerCustodyProviderExecRequest {
  readonly argv: readonly string[];
  readonly environment: readonly DockerCustodyEnvironmentEntry[];
  readonly executableSha256: string;
  readonly executableSlot: "provider-entrypoint";
  readonly gid: number;
  readonly handshakeNonce: string;
  readonly kind: "provider-exec";
  readonly launchFingerprintSha256: string;
  readonly requestId: string;
  readonly uid: number;
  readonly wallDeadlineUnixMs: number;
}

export interface DockerCustodyProviderExecAcknowledgement {
  readonly kind: "provider-exec-ack";
  readonly observation: "acceptance-unknown" | "not-started" | "started";
  readonly requestId: string;
}

export interface DockerCustodyProviderInput {
  readonly bytesBase64: string;
  readonly kind: "provider-input";
  readonly requestId: string;
}

export interface DockerCustodyProviderInputEof {
  readonly kind: "provider-input-eof";
  readonly requestId: string;
}

export interface DockerCustodyHostSignalRequest {
  readonly kind: "host-signal";
  readonly requestId: string;
  readonly signal: DockerCustodyHostSignal;
}

export interface DockerCustodyProviderOutput {
  readonly bytesBase64: string;
  readonly kind: "provider-output";
  readonly requestId: string;
  readonly stream: "stderr" | "stdout";
}

export interface DockerCustodyContainmentRequest {
  readonly kind: "container-containment-request";
  readonly reason: "cancelled" | "deadline" | "init-failure" | "input-limit" | "output-limit" | "shutdown-timeout";
  readonly requestId: string;
}

export interface DockerCustodyProviderObservation {
  readonly exitCode: number | null;
  readonly kind: "provider-observation";
  readonly observation: "acceptance-unknown" | "exec-acknowledgement-lost" | "root-exited" | "spawn-failed";
  readonly requestId: string;
  readonly signal: DockerCustodyChildSignal | null;
  readonly treeEmptyClaim: "not-claimed";
}

export interface DockerCustodySignalObservation {
  readonly action: "forward-host" | "stop-kill" | "stop-term";
  readonly kind: "provider-signal-observation";
  readonly requestId: string;
  readonly result: "absent" | "failed" | "sent";
  readonly signal: DockerCustodyHostSignal | "SIGKILL";
}

/** Direct-child observation proves only provider exit plus pipe EOF. The outer Docker adapter adds exact residue evidence. */
export interface DockerCustodyProviderDrainComplete {
  readonly kind: "provider-drain-complete";
  readonly outerContainmentClaim: "unproven";
  readonly requestId: string;
  readonly rootExit: "observed";
  readonly stderr: "eof";
  readonly stdout: "eof";
}

export interface DockerCustodyProviderDrainFailed {
  readonly kind: "provider-drain-failed";
  readonly outerContainmentClaim: "unproven";
  readonly reason: "stderr-overflow" | "stdout-overflow";
  readonly requestId: string;
}

export type DockerCustodyProviderDrainResult = DockerCustodyProviderDrainComplete | DockerCustodyProviderDrainFailed;

export interface DockerCustodyInitClosureSubresult {
  readonly outerContainmentClaim: "unproven";
  readonly providerDrain: DockerCustodyProviderDrainResult;
}

export type DockerCustodyHostMessage = DockerCustodyHostHandshake | DockerCustodyHostSignalRequest |
  DockerCustodyProviderExecRequest | DockerCustodyProviderInput | DockerCustodyProviderInputEof;
export type DockerCustodyInitMessage =
  | DockerCustodyContainmentRequest | DockerCustodyInitReady | DockerCustodyProviderDrainComplete | DockerCustodyProviderDrainFailed
  | DockerCustodyProviderExecAcknowledgement | DockerCustodyProviderObservation | DockerCustodyProviderOutput | DockerCustodySignalObservation;
export type DockerCustodyProtocolMessage = DockerCustodyHostMessage | DockerCustodyInitMessage;

export class DockerCustodyProtocolError extends Error {
  public constructor(message: string) {super(message); this.name = "DockerCustodyProtocolError";}
}

type JsonObject = Record<string, unknown>;
const fail = (message: string): never => {throw new DockerCustodyProtocolError(message);};
const nodeProxyInspection = process.getBuiltinModule("node:util") as {
  readonly types: {readonly isProxy: (value: object) => boolean};
};

const assertDataContainer = (value: object, label: string, array: boolean): void => {
  if (nodeProxyInspection.types.isProxy(value)) {fail(`${label} must not be a Proxy`);}
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null) {
    fail(`${label} must be a plain data ${array ? "array" : "object"}`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {fail(`${label} must not have symbol keys`);}
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) {fail(`${label} property must have a descriptor`);}
    const dataDescriptor = descriptor as PropertyDescriptor;
    if (!("value" in dataDescriptor)) {fail(`${label} must not contain accessors`);}
    if (dataDescriptor.value === undefined || typeof dataDescriptor.value === "function" || typeof dataDescriptor.value === "symbol") {
      fail(`${label} contains a non-JSON value`);
    }
  }
  if (array) {
    const values = value as readonly unknown[];
    for (let index = 0; index < values.length; index += 1) {
      if (!Object.hasOwn(values, index)) {fail(`${label} must not be sparse`);}
    }
    const allowedKeys = new Set(["length", ...values.map((_, index) => String(index))]);
    if (Reflect.ownKeys(value).some(key => typeof key !== "string" || !allowedKeys.has(key))) {
      fail(`${label} must not be augmented`);
    }
  }
};

const object = (value: unknown, label: string): JsonObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {return fail(`${label} must be an object`);}
  assertDataContainer(value, label, false);
  return value as JsonObject;
};
const array = (value: unknown, label: string): readonly unknown[] => {
  if (!Array.isArray(value)) {return fail(`${label} must be an array`);}
  assertDataContainer(value, label, true);
  return value;
};
const exactKeys = (value: JsonObject, keys: readonly string[], label: string): void => {
  const actual = Reflect.ownKeys(value).map(key => {
    if (typeof key !== "string") {return fail(`${label} must not have symbol keys`);}
    return key;
  }).toSorted();
  const expected = [...keys].toSorted();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {fail(`${label} has unknown or missing keys`);}
};
const ownValue = (value: JsonObject, key: string, label: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor)) {return fail(`${label} must be an own data property`);}
  return descriptor.value;
};
const string = (value: unknown, label: string, maximum = MAX_IDENTITY_BYTES): string => {
  if (typeof value !== "string" || Buffer.byteLength(value) > maximum || value.length === 0 || value.includes("\0")) {
    return fail(`${label} must be bounded, non-empty, and NUL-free`);
  }
  return value;
};
const boundedText = (value: unknown, label: string, maximum: number): string => {
  if (typeof value !== "string" || Buffer.byteLength(value) > maximum || value.includes("\0")) {
    return fail(`${label} must be a bounded NUL-free string`);
  }
  return value;
};
const token = (value: unknown, label: string): string => {
  const result = string(value, label);
  if (!TOKEN.test(result)) {return fail(`${label} must be a product identity token`);}
  return result;
};
const digest = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !SHA256.test(value)) {return fail(`${label} must be a lowercase SHA-256`);}
  return value;
};
const integer = (value: unknown, label: string, minimum: number, maximum: number): number => {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {return fail(`${label} must be a bounded integer`);}
  return value as number;
};
const literal = <Value extends string>(value: unknown, allowed: readonly Value[], label: string): Value => {
  if (typeof value !== "string" || !allowed.includes(value as Value)) {return fail(`${label} is unsupported`);}
  return value as Value;
};
const providerBytes = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > Math.ceil(DOCKER_CUSTODY_PROVIDER_IO_MAX_BYTES / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    return fail(`${label} must be bounded canonical base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength === 0 || decoded.byteLength > DOCKER_CUSTODY_PROVIDER_IO_MAX_BYTES || decoded.toString("base64") !== value) {
    return fail(`${label} must be bounded canonical base64`);
  }
  return value;
};

export const decodeDockerCustodyProviderBytes = (value: string): Uint8Array =>
  Uint8Array.from(Buffer.from(providerBytes(value, "bytesBase64"), "base64"));

const parseProviderIoMessage = (value: JsonObject, kind: string): DockerCustodyProtocolMessage | undefined => {
  switch (kind) {
    case "provider-input":
      exactKeys(value, ["bytesBase64", "kind", "requestId"], kind);
      return Object.freeze({bytesBase64: providerBytes(value.bytesBase64, "bytesBase64"), kind,
        requestId: token(value.requestId, "requestId")});
    case "provider-input-eof":
      exactKeys(value, ["kind", "requestId"], kind);
      return Object.freeze({kind, requestId: token(value.requestId, "requestId")});
    case "provider-output":
      exactKeys(value, ["bytesBase64", "kind", "requestId", "stream"], kind);
      return Object.freeze({bytesBase64: providerBytes(value.bytesBase64, "bytesBase64"), kind,
        requestId: token(value.requestId, "requestId"), stream: literal(value.stream, ["stderr", "stdout"], "stream")});
    case "host-signal":
      exactKeys(value, ["kind", "requestId", "signal"], kind);
      return Object.freeze({kind, requestId: token(value.requestId, "requestId"),
        signal: literal(value.signal, DOCKER_CUSTODY_HOST_SIGNALS, "signal")});
    default: return undefined;
  }
};

export const parseDockerCustodyIdentity = (input: unknown, label = "identity"): DockerCustodyIdentity => {
  const value = object(input, label);
  exactKeys(value, ["containerImageSha256", "initBinarySha256", "privateRootIdentity", "protocol", "securityProfileIdentity", "workspaceIdentity"], label);
  return Object.freeze({
    containerImageSha256: digest(value.containerImageSha256, `${label}.containerImageSha256`),
    initBinarySha256: digest(value.initBinarySha256, `${label}.initBinarySha256`),
    privateRootIdentity: token(value.privateRootIdentity, `${label}.privateRootIdentity`),
    protocol: literal(value.protocol, [DOCKER_CUSTODY_INIT_PROTOCOL], `${label}.protocol`),
    securityProfileIdentity: token(value.securityProfileIdentity, `${label}.securityProfileIdentity`),
    workspaceIdentity: token(value.workspaceIdentity, `${label}.workspaceIdentity`),
  });
};

const environment = (input: unknown): readonly DockerCustodyEnvironmentEntry[] => {
  const items = array(input, "environment");
  if (items.length > MAX_ENVIRONMENT) {return fail("environment must be bounded");}
  const seen = new Set<string>();
  const entries = items.map((item, index) => {
    const value = object(item, `environment[${index}]`);
    exactKeys(value, ["name", "value"], `environment[${index}]`);
    const name = string(value.name, `environment[${index}].name`, 128);
    if (!/^[A-Z_][A-Z0-9_]{0,127}$/u.test(name) || seen.has(name)) {return fail("environment names must be unique allowlist keys");}
    seen.add(name);
    return Object.freeze({name, value: boundedText(value.value, `environment[${index}].value`, MAX_VALUE_BYTES)});
  });
  return Object.freeze(entries);
};
const argumentsList = (input: unknown): readonly string[] => {
  const items = array(input, "argv");
  if (items.length === 0 || items.length > MAX_ARGUMENTS) {return fail("argv must be bounded and non-empty");}
  return Object.freeze(items.map((item, index) => boundedText(item, `argv[${index}]`, MAX_VALUE_BYTES)));
};

export const parseDockerCustodyProtocolMessage = (input: unknown): DockerCustodyProtocolMessage => {
  const value = object(input, "frame");
  const kind = string(ownValue(value, "kind", "frame.kind"), "frame.kind");
  const providerIo = parseProviderIoMessage(value, kind);
  if (providerIo !== undefined) {return providerIo;}
  switch (kind) {
    case "host-handshake":
      exactKeys(value, ["expectedIdentity", "kind", "launchFingerprintSha256", "nonce", "protocol"], kind);
      return Object.freeze({expectedIdentity: parseDockerCustodyIdentity(value.expectedIdentity, "expectedIdentity"), kind,
        launchFingerprintSha256: digest(value.launchFingerprintSha256, "launchFingerprintSha256"), nonce: token(value.nonce, "nonce"),
        protocol: literal(value.protocol, [DOCKER_CUSTODY_INIT_PROTOCOL], "protocol")});
    case "init-ready":
      exactKeys(value, ["kind", "launchFingerprintSha256", "nonce", "observedIdentity", "protocol"], kind);
      return Object.freeze({kind, launchFingerprintSha256: digest(value.launchFingerprintSha256, "launchFingerprintSha256"),
        nonce: token(value.nonce, "nonce"), observedIdentity: parseDockerCustodyIdentity(value.observedIdentity, "observedIdentity"),
        protocol: literal(value.protocol, [DOCKER_CUSTODY_INIT_PROTOCOL], "protocol")});
    case "provider-exec":
      exactKeys(value, ["argv", "environment", "executableSha256", "executableSlot", "gid", "handshakeNonce", "kind", "launchFingerprintSha256", "requestId", "uid", "wallDeadlineUnixMs"], kind);
      return Object.freeze({argv: argumentsList(value.argv), environment: environment(value.environment),
        executableSha256: digest(value.executableSha256, "executableSha256"), executableSlot: literal(value.executableSlot, ["provider-entrypoint"], "executableSlot"),
        gid: integer(value.gid, "gid", 1, 2_147_483_647), handshakeNonce: token(value.handshakeNonce, "handshakeNonce"), kind,
        launchFingerprintSha256: digest(value.launchFingerprintSha256, "launchFingerprintSha256"), requestId: token(value.requestId, "requestId"),
        uid: integer(value.uid, "uid", 1, 2_147_483_647), wallDeadlineUnixMs: integer(value.wallDeadlineUnixMs, "wallDeadlineUnixMs", 1, Number.MAX_SAFE_INTEGER)});
    case "provider-exec-ack":
      exactKeys(value, ["kind", "observation", "requestId"], kind);
      return Object.freeze({kind, observation: literal(value.observation, ["acceptance-unknown", "not-started", "started"], "observation"), requestId: token(value.requestId, "requestId")});
    case "container-containment-request":
      exactKeys(value, ["kind", "reason", "requestId"], kind);
      return Object.freeze({kind, reason: literal(value.reason, ["cancelled", "deadline", "init-failure", "input-limit", "output-limit", "shutdown-timeout"], "reason"), requestId: token(value.requestId, "requestId")});
    case "provider-observation": {
      exactKeys(value, ["exitCode", "kind", "observation", "requestId", "signal", "treeEmptyClaim"], kind);
      const observation = literal(value.observation, ["acceptance-unknown", "exec-acknowledgement-lost", "root-exited", "spawn-failed"], "observation");
      const exitCode = value.exitCode === null ? null : integer(value.exitCode, "exitCode", 0, 255);
      const signal = value.signal === null ? null : literal(value.signal, DOCKER_CUSTODY_CHILD_SIGNALS, "signal");
      if (observation === "root-exited" ? (exitCode === null) === (signal === null) : exitCode !== null || signal !== null) {
        return fail("exitCode and signal do not match the observation");
      }
      return Object.freeze({exitCode, kind, observation, requestId: token(value.requestId, "requestId"), signal,
        treeEmptyClaim: literal(value.treeEmptyClaim, ["not-claimed"], "treeEmptyClaim")});
    }
    case "provider-signal-observation": {
      exactKeys(value, ["action", "kind", "requestId", "result", "signal"], kind);
      const action = literal(value.action, ["forward-host", "stop-kill", "stop-term"], "action");
      const signal = literal(value.signal, [...DOCKER_CUSTODY_HOST_SIGNALS, "SIGKILL"], "signal");
      if ((action === "stop-kill") !== (signal === "SIGKILL") || action === "stop-term" && signal !== "SIGTERM") {return fail("signal does not match action");}
      return Object.freeze({action, kind, requestId: token(value.requestId, "requestId"), result: literal(value.result, ["absent", "failed", "sent"], "result"), signal});
    }
    case "provider-drain-complete":
      exactKeys(value, ["kind", "outerContainmentClaim", "requestId", "rootExit", "stderr", "stdout"], kind);
      return Object.freeze({kind, outerContainmentClaim: literal(value.outerContainmentClaim, ["unproven"], "outerContainmentClaim"),
        requestId: token(value.requestId, "requestId"), rootExit: literal(value.rootExit, ["observed"], "rootExit"),
        stderr: literal(value.stderr, ["eof"], "stderr"), stdout: literal(value.stdout, ["eof"], "stdout")});
    case "provider-drain-failed":
      exactKeys(value, ["kind", "outerContainmentClaim", "reason", "requestId"], kind);
      return Object.freeze({kind, outerContainmentClaim: literal(value.outerContainmentClaim, ["unproven"], "outerContainmentClaim"),
        reason: literal(value.reason, ["stderr-overflow", "stdout-overflow"], "reason"), requestId: token(value.requestId, "requestId")});
    default: return fail("frame kind is unsupported");
  }
};

const compareKeys = ([left]: readonly [string, unknown], [right]: readonly [string, unknown]): number => left < right ? -1 : left > right ? 1 : 0;
const canonical = (value: unknown): unknown => Array.isArray(value)
  ? value.map(canonical)
  : value !== null && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).toSorted(compareKeys).map(([key, item]) => [key, canonical(item)]))
    : value;

export const encodeDockerCustodyFrame = (message: DockerCustodyProtocolMessage): Uint8Array => {
  const detached = parseDockerCustodyProtocolMessage(message);
  const payload = Buffer.from(JSON.stringify(canonical(detached)), "utf8");
  if (payload.byteLength > DOCKER_CUSTODY_INIT_MAX_FRAME_BYTES) {return fail("frame exceeds the protocol bound");}
  const frame = Buffer.allocUnsafe(payload.byteLength + 4);
  frame.writeUInt32BE(payload.byteLength, 0); payload.copy(frame, 4); return frame;
};

export class DockerCustodyFrameDecoder {
  #buffer = Buffer.alloc(0);
  #sealed = false;

  public push(bytes: Uint8Array): readonly DockerCustodyProtocolMessage[] {
    if (this.#sealed) {return fail("control channel is sealed after EOF");}
    try {
      if (this.#buffer.byteLength + bytes.byteLength > 4 * (DOCKER_CUSTODY_INIT_MAX_FRAME_BYTES + 4)) {return fail("incomplete frame exceeds the protocol bound");}
      this.#buffer = Buffer.concat([this.#buffer, bytes]);
      const messages: DockerCustodyProtocolMessage[] = [];
      while (this.#buffer.byteLength >= 4) {
        const size = this.#buffer.readUInt32BE(0);
        if (size === 0 || size > DOCKER_CUSTODY_INIT_MAX_FRAME_BYTES) {return fail("frame length is invalid");}
        if (this.#buffer.byteLength < size + 4) {break;}
        const payload = this.#buffer.subarray(4, size + 4); this.#buffer = this.#buffer.subarray(size + 4);
        const message = parseDockerCustodyProtocolMessage(JSON.parse(payload.toString("utf8")) as unknown);
        const canonicalPayload = Buffer.from(JSON.stringify(canonical(message)), "utf8");
        if (!payload.equals(canonicalPayload)) {return fail("frame payload is not canonical");}
        messages.push(message);
      }
      return Object.freeze(messages);
    } catch (error) {
      this.#buffer = Buffer.alloc(0); this.#sealed = true;
      if (error instanceof DockerCustodyProtocolError) {throw error;}
      return fail("frame JSON is malformed");
    }
  }

  public finish(): void {
    if (this.#sealed) {return;}
    this.#sealed = true;
    if (this.#buffer.byteLength !== 0) {fail("control channel ended with a typed malformed partial frame");}
  }
}
