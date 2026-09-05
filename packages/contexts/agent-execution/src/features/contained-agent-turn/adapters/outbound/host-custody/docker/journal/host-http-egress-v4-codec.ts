import { createHash } from "node:crypto";
import { types } from "node:util";
import type { DockerContainerAuthority } from "../engine/docker-engine-port.js";
import { parseStrictJson } from "../serialization/strict-json.js";
import {
  canonicalDockerCustodyJson, dockerCustodyAuthoritySha256, validateDockerCustodyAttemptKey,
} from "./docker-custody-journal-codec.js";
import {
  HOST_HTTP_EGRESS_V4_LIMITS as LIMITS, HostHttpEgressV4Error,
  type HostHttpEgressV4Event, type HostHttpEgressV4Observation, type HostHttpEgressV4Record,
  type HostHttpEgressV4Subject, type HostHttpEgressV4Tombstone,
} from "./host-http-egress-v4-types.js";

export const v4Hash = (value: unknown): string =>
  createHash("sha256").update(canonicalDockerCustodyJson(value)).digest("hex");
export const v4Digest = (value: unknown): string => {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) { throw new HostHttpEgressV4Error("conflict"); }
  return value;
};
export const v4Exact: (value: unknown, keys: readonly string[]) => asserts value is Record<string, unknown> = (value, keys) => {
  if (value === null || typeof value !== "object" || types.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key)) ||
      Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !("value" in d) || !d.enumerable)) {
    throw new HostHttpEgressV4Error("conflict");
  }
};
const fixed = (value: unknown, prefix: string): string => {
  if (typeof value !== "string" || !value.startsWith(`${prefix}:`)) { throw new HostHttpEgressV4Error("conflict"); }
  v4Digest(value.slice(prefix.length + 1)); return value;
};
export const v4Subject = (value: unknown): HostHttpEgressV4Subject => {
  v4Exact(value, ["attempt", "effectId", "workspaceId", "executionGenerationId", "scopeSha256",
    "acceptedAuthoritySha256", "committedClaimSha256", "observerSha256", "imageDigest",
    "networkHandle", "listenerHandle", "routeHandle"]);
  const attempt = validateDockerCustodyAttemptKey(value.attempt);
  // V4 requires disjoint fixed namespaces even though the V2 reader accepts older IDs.
  for (const [key, prefix] of Object.entries({ operationId: "operation", attemptId: "attempt", custodyId: "custody",
    hostInstanceId: "host-instance", hostBootId: "host-boot", tenantId: "tenant", projectId: "project" })) {
    fixed(attempt[key as keyof typeof attempt], prefix);
  }
  return Object.freeze({ attempt, effectId: fixed(value.effectId, "effect"), workspaceId: fixed(value.workspaceId, "workspace"),
    executionGenerationId: fixed(value.executionGenerationId, "execution-generation"), scopeSha256: v4Digest(value.scopeSha256),
    acceptedAuthoritySha256: v4Digest(value.acceptedAuthoritySha256), committedClaimSha256: v4Digest(value.committedClaimSha256),
    observerSha256: v4Digest(value.observerSha256), imageDigest: fixed(value.imageDigest, "sha256"),
    networkHandle: fixed(value.networkHandle, "network"), listenerHandle: fixed(value.listenerHandle, "listener"),
    routeHandle: fixed(value.routeHandle, "route") });
};
// Stable operation locator intentionally omits boot/attempt/generation: they cannot reopen authority.
export const v4Locator = (s: HostHttpEgressV4Subject): string => v4Hash({ version: 4,
  tenantId: s.attempt.tenantId, projectId: s.attempt.projectId, operationId: s.attempt.operationId });
export const v4Intents = Object.freeze(["network_intent", "listener_intent", "route_intent", "inbound_intent",
  "upstream_intent", "sockets_close", "cutoff", "listener_release", "network_release", "uncertain", "retired"] as const);
const observed = Object.freeze(["network_allocated", "listener_allocated", "container_attached", "route_installed",
  "inbound_allocated", "upstream_allocated", "sockets_closed", "cutoff_observed", "container_absent",
  "listener_absent", "network_absent"] as const);
export const v4Observation = (value: unknown): HostHttpEgressV4Observation => {
  v4Exact(value, ["kind", "subjectSha256", "observerSha256", "targetSha256", "actualSha256", "evidenceSha256", "container", "writeOutcome"]);
  if (!observed.includes(value.kind as never)) { throw new HostHttpEgressV4Error("conflict"); }
  let container: HostHttpEgressV4Observation["container"] = null;
  if (value.container !== null) {
    dockerCustodyAuthoritySha256(value.container as DockerContainerAuthority);
    container = Object.freeze({ ...value.container as DockerContainerAuthority });
    v4Digest(container.containerId); fixed(container.imageDigest, "sha256");
  }
  if (value.kind === "sockets_closed" ? !["settled", "unknown"].includes(value.writeOutcome as string) : value.writeOutcome !== null) {
    throw new HostHttpEgressV4Error("conflict");
  }
  return Object.freeze({ kind: value.kind as HostHttpEgressV4Observation["kind"],
    subjectSha256: v4Digest(value.subjectSha256), observerSha256: v4Digest(value.observerSha256),
    targetSha256: v4Digest(value.targetSha256), actualSha256: v4Digest(value.actualSha256),
    evidenceSha256: v4Digest(value.evidenceSha256), container, writeOutcome: value.writeOutcome as HostHttpEgressV4Observation["writeOutcome"] });
};
export const v4Event = (value: unknown): HostHttpEgressV4Event => {
  if (value === null || typeof value !== "object" || types.isProxy(value)) { throw new HostHttpEgressV4Error("conflict"); }
  const kind = Object.getOwnPropertyDescriptor(value, "kind")?.value as unknown;
  if (kind === "opened") {
    v4Exact(value, ["kind", "subject"]); return Object.freeze({ kind, subject: v4Subject(value.subject) });
  }
  if (v4Intents.includes(kind as never)) {
    v4Exact(value, ["kind", "targetSha256"]);
    return Object.freeze({ kind: kind as typeof v4Intents[number], targetSha256: v4Digest(value.targetSha256) });
  }
  v4Exact(value, ["kind", "observation"]);
  const observation = v4Observation(value.observation);
  if (kind !== observation.kind) { throw new HostHttpEgressV4Error("conflict"); }
  return Object.freeze({ kind: observation.kind, observation });
};
export const v4Record = (input: Omit<HostHttpEgressV4Record, "version" | "checksumSha256" | "commandSha256">): HostHttpEgressV4Record => {
  const event = v4Event(input.event);
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 0 || input.sequence >= LIMITS.maxRecords) {
    throw new HostHttpEgressV4Error("capacity");
  }
  const body = { version: 4 as const, sequence: input.sequence, subjectSha256: v4Digest(input.subjectSha256),
    commandId: fixed(input.commandId, "command"), event,
    previousSha256: input.previousSha256 === null ? null : v4Digest(input.previousSha256),
    commandSha256: v4Hash({ subjectSha256: input.subjectSha256, event }) };
  return Object.freeze({ ...body, checksumSha256: v4Hash(body) });
};
export const v4Encode = (value: HostHttpEgressV4Record | HostHttpEgressV4Tombstone): Uint8Array => {
  const bytes = Buffer.from(`${canonicalDockerCustodyJson(value)}\n`);
  if (bytes.length > LIMITS.maxRecordBytes) { throw new HostHttpEgressV4Error("capacity"); }
  return bytes;
};
const plain = (value: unknown): unknown => {
  if (Array.isArray(value)) { throw new HostHttpEgressV4Error("quarantined"); }
  if (value === null || typeof value !== "object") { return value; }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]));
};
export const v4Decode = (bytes: Uint8Array): readonly HostHttpEgressV4Record[] => {
  if (!bytes.length || bytes.length > LIMITS.maxBytes || bytes.at(-1) !== 10) { throw new HostHttpEgressV4Error("quarantined"); }
  const records: HostHttpEgressV4Record[] = []; let start = 0;
  try {
    for (let i = 0; i < bytes.length; i += 1) {
      if (i - start >= LIMITS.maxRecordBytes) { throw new HostHttpEgressV4Error("quarantined"); }
      if (bytes[i] !== 10) { continue; }
      if (records.length >= LIMITS.maxRecords) { throw new HostHttpEgressV4Error("quarantined"); }
      const value = plain(parseStrictJson(bytes.subarray(start, i))); start = i + 1;
      v4Exact(value, ["version", "sequence", "subjectSha256", "commandId", "commandSha256", "event", "previousSha256", "checksumSha256"]);
      const record = v4Record(value as unknown as HostHttpEgressV4Record);
      if (value.version !== 4 || value.commandSha256 !== record.commandSha256 || value.checksumSha256 !== record.checksumSha256 ||
          record.sequence !== records.length || record.previousSha256 !== (records.at(-1)?.checksumSha256 ?? null)) {
        throw new HostHttpEgressV4Error("quarantined");
      }
      records.push(record);
    }
    return Object.freeze(records);
  } catch { throw new HostHttpEgressV4Error("quarantined"); }
};
export const v4Tombstone = (input: Omit<HostHttpEgressV4Tombstone, "checksumSha256" | "version">): HostHttpEgressV4Tombstone => {
  const body = { version: 4 as const, subjectSha256: v4Digest(input.subjectSha256), tailSha256: v4Digest(input.tailSha256),
    uncertainAppendSha256: input.uncertainAppendSha256 === null ? null : v4Digest(input.uncertainAppendSha256),
    disposition: input.disposition, reconcileRequired: input.reconcileRequired };
  if (!["retired", "quarantined"].includes(body.disposition) || typeof body.reconcileRequired !== "boolean") {
    throw new HostHttpEgressV4Error("quarantined");
  }
  return Object.freeze({ ...body, checksumSha256: v4Hash(body) });
};
export const v4DecodeTombstone = (bytes: Uint8Array): HostHttpEgressV4Tombstone => {
  if (!bytes.length || bytes.length > LIMITS.maxRecordBytes || bytes.at(-1) !== 10) { throw new HostHttpEgressV4Error("quarantined"); }
  const value = plain(parseStrictJson(bytes));
  v4Exact(value, ["version", "subjectSha256", "tailSha256", "uncertainAppendSha256", "disposition", "reconcileRequired", "checksumSha256"]);
  const result = v4Tombstone(value as unknown as HostHttpEgressV4Tombstone);
  if (value.version !== 4 || result.checksumSha256 !== value.checksumSha256) { throw new HostHttpEgressV4Error("quarantined"); }
  return result;
};
