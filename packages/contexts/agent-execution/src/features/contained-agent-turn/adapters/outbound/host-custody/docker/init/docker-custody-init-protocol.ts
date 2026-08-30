export const DOCKER_CUSTODY_INIT_PROTOCOL = "ar.docker-custody-init/v1" as const;
export const DOCKER_CUSTODY_INIT_MAX_FRAME_BYTES = 65_536;

const MAX_IDENTITY_BYTES = 256;
const MAX_ARGUMENTS = 128;
const MAX_ENVIRONMENT = 128;
const MAX_VALUE_BYTES = 8_192;
const SHA256 = /^[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9._:@+-]{1,256}$/u;

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

export interface DockerCustodyEnvironmentEntry {
  readonly name: string;
  readonly value: string;
}

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
  readonly signal: "SIGABRT" | "SIGKILL" | "SIGTERM" | null;
  readonly treeEmptyClaim: "not-claimed";
}

export type DockerCustodyHostMessage = DockerCustodyHostHandshake | DockerCustodyProviderExecRequest;
export type DockerCustodyInitMessage =
  | DockerCustodyContainmentRequest
  | DockerCustodyInitReady
  | DockerCustodyProviderExecAcknowledgement
  | DockerCustodyProviderObservation;
export type DockerCustodyProtocolMessage = DockerCustodyHostMessage | DockerCustodyInitMessage;

export class DockerCustodyProtocolError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DockerCustodyProtocolError";
  }
}

type JsonObject = Record<string, unknown>;

const fail = (message: string): never => {throw new DockerCustodyProtocolError(message);};
const object = (value: unknown, label: string): JsonObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {return fail(`${label} must be an object`);}
  return value as JsonObject;
};
const exactKeys = (value: JsonObject, keys: readonly string[], label: string): void => {
  const actual = Object.keys(value).toSorted();
  const expected = [...keys].toSorted();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} has unknown or missing keys`);
  }
};
const string = (value: unknown, label: string, maximum = MAX_IDENTITY_BYTES): string => {
  if (typeof value !== "string" || Buffer.byteLength(value) > maximum || value.length === 0) {
    return fail(`${label} must be a bounded non-empty string`);
  }
  return value;
};
const boundedText = (value: unknown, label: string, maximum: number): string => {
  if (typeof value !== "string" || Buffer.byteLength(value) > maximum) {
    return fail(`${label} must be a bounded string`);
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
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    return fail(`${label} must be a bounded integer`);
  }
  return value as number;
};
const literal = <Value extends string>(value: unknown, allowed: readonly Value[], label: string): Value => {
  if (typeof value !== "string" || !allowed.includes(value as Value)) {return fail(`${label} is unsupported`);}
  return value as Value;
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
  if (!Array.isArray(input) || input.length > MAX_ENVIRONMENT) {return fail("environment must be a bounded array");}
  const seen = new Set<string>();
  const entries = input.map((item, index) => {
    const value = object(item, `environment[${index}]`);
    exactKeys(value, ["name", "value"], `environment[${index}]`);
    const name = string(value.name, `environment[${index}].name`, 128);
    if (!/^[A-Z_][A-Z0-9_]{0,127}$/u.test(name) || seen.has(name)) {return fail("environment names must be unique allowlist keys");}
    seen.add(name);
    return Object.freeze({ name, value: boundedText(value.value, `environment[${index}].value`, MAX_VALUE_BYTES) });
  });
  return Object.freeze(entries);
};

const argumentsList = (input: unknown): readonly string[] => {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_ARGUMENTS) {return fail("argv must be a bounded non-empty array");}
  return Object.freeze(input.map((item, index) => boundedText(item, `argv[${index}]`, MAX_VALUE_BYTES)));
};

export const parseDockerCustodyProtocolMessage = (input: unknown): DockerCustodyProtocolMessage => {
  const value = object(input, "frame");
  const kind = string(value.kind, "frame.kind");
  switch (kind) {
    case "host-handshake":
      exactKeys(value, ["expectedIdentity", "kind", "launchFingerprintSha256", "nonce", "protocol"], kind);
      return Object.freeze({
        expectedIdentity: parseDockerCustodyIdentity(value.expectedIdentity, "expectedIdentity"), kind,
        launchFingerprintSha256: digest(value.launchFingerprintSha256, "launchFingerprintSha256"),
        nonce: token(value.nonce, "nonce"),
        protocol: literal(value.protocol, [DOCKER_CUSTODY_INIT_PROTOCOL], "protocol"),
      });
    case "init-ready":
      exactKeys(value, ["kind", "launchFingerprintSha256", "nonce", "observedIdentity", "protocol"], kind);
      return Object.freeze({ kind,
        launchFingerprintSha256: digest(value.launchFingerprintSha256, "launchFingerprintSha256"),
        nonce: token(value.nonce, "nonce"), observedIdentity: parseDockerCustodyIdentity(value.observedIdentity, "observedIdentity"),
        protocol: literal(value.protocol, [DOCKER_CUSTODY_INIT_PROTOCOL], "protocol"),
      });
    case "provider-exec":
      exactKeys(value, ["argv", "environment", "executableSha256", "executableSlot", "gid", "handshakeNonce", "kind", "launchFingerprintSha256", "requestId", "uid", "wallDeadlineUnixMs"], kind);
      return Object.freeze({ argv: argumentsList(value.argv), environment: environment(value.environment),
        executableSha256: digest(value.executableSha256, "executableSha256"),
        executableSlot: literal(value.executableSlot, ["provider-entrypoint"], "executableSlot"),
        gid: integer(value.gid, "gid", 1, 2_147_483_647),
        handshakeNonce: token(value.handshakeNonce, "handshakeNonce"), kind,
        launchFingerprintSha256: digest(value.launchFingerprintSha256, "launchFingerprintSha256"),
        requestId: token(value.requestId, "requestId"), uid: integer(value.uid, "uid", 1, 2_147_483_647),
        wallDeadlineUnixMs: integer(value.wallDeadlineUnixMs, "wallDeadlineUnixMs", 1, Number.MAX_SAFE_INTEGER),
      });
    case "provider-exec-ack":
      exactKeys(value, ["kind", "observation", "requestId"], kind);
      return Object.freeze({ kind, observation: literal(value.observation, ["acceptance-unknown", "not-started", "started"], "observation"), requestId: token(value.requestId, "requestId") });
    case "container-containment-request":
      exactKeys(value, ["kind", "reason", "requestId"], kind);
      return Object.freeze({ kind, reason: literal(value.reason, ["cancelled", "deadline", "init-failure", "input-limit", "output-limit", "shutdown-timeout"], "reason"), requestId: token(value.requestId, "requestId") });
    case "provider-observation":
      exactKeys(value, ["exitCode", "kind", "observation", "requestId", "signal", "treeEmptyClaim"], kind);
      return Object.freeze({
        exitCode: value.exitCode === null ? null : integer(value.exitCode, "exitCode", 0, 255), kind,
        observation: literal(value.observation, ["acceptance-unknown", "exec-acknowledgement-lost", "root-exited", "spawn-failed"], "observation"),
        requestId: token(value.requestId, "requestId"),
        signal: value.signal === null ? null : literal(value.signal, ["SIGABRT", "SIGKILL", "SIGTERM"], "signal"),
        treeEmptyClaim: literal(value.treeEmptyClaim, ["not-claimed"], "treeEmptyClaim"),
      });
    default: return fail("frame kind is unsupported");
  }
};

const compareKeys = ([left]: readonly [string, unknown], [right]: readonly [string, unknown]): number =>
  left < right ? -1 : left > right ? 1 : 0;

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) {return value.map(canonical);}
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).toSorted(compareKeys).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
};

export const encodeDockerCustodyFrame = (message: DockerCustodyProtocolMessage): Uint8Array => {
  const detached = parseDockerCustodyProtocolMessage(JSON.parse(JSON.stringify(message)) as unknown);
  const payload = Buffer.from(JSON.stringify(canonical(detached)), "utf8");
  if (payload.byteLength > DOCKER_CUSTODY_INIT_MAX_FRAME_BYTES) {return fail("frame exceeds the protocol bound");}
  const frame = Buffer.allocUnsafe(payload.byteLength + 4);
  frame.writeUInt32BE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
};

export class DockerCustodyFrameDecoder {
  #buffer = Buffer.alloc(0);

  public push(bytes: Uint8Array): readonly DockerCustodyProtocolMessage[] {
    if (this.#buffer.byteLength + bytes.byteLength > 4 * (DOCKER_CUSTODY_INIT_MAX_FRAME_BYTES + 4)) {
      return fail("incomplete frame exceeds the protocol bound");
    }
    this.#buffer = Buffer.concat([this.#buffer, bytes]);
    const messages: DockerCustodyProtocolMessage[] = [];
    while (this.#buffer.byteLength >= 4) {
      const size = this.#buffer.readUInt32BE(0);
      if (size === 0 || size > DOCKER_CUSTODY_INIT_MAX_FRAME_BYTES) {return fail("frame length is invalid");}
      if (this.#buffer.byteLength < size + 4) {break;}
      const payload = this.#buffer.subarray(4, size + 4);
      this.#buffer = this.#buffer.subarray(size + 4);
      try {
        const message = parseDockerCustodyProtocolMessage(JSON.parse(payload.toString("utf8")) as unknown);
        const canonicalPayload = Buffer.from(JSON.stringify(canonical(message)), "utf8");
        if (!payload.equals(canonicalPayload)) {return fail("frame payload is not canonical");}
        messages.push(message);
      }
      catch (error) {if (error instanceof DockerCustodyProtocolError) {throw error;} return fail("frame JSON is malformed");}
    }
    return Object.freeze(messages);
  }

  public finish(): void {
    if (this.#buffer.byteLength !== 0) {fail("control channel ended with a partial frame");}
  }
}
