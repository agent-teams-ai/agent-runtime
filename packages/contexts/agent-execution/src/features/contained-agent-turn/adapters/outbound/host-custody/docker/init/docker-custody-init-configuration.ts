import { posix } from "node:path";

import { parseStrictJson } from "../serialization/strict-json.js";
import { boundedInteger } from "./docker-custody-init-guards.js";
import { parseDockerCustodyIdentity } from "./docker-custody-init-protocol.js";
import type { NodeDockerCustodyInitDriverOptions } from "./node-docker-custody-init-driver.js";

export const DOCKER_CUSTODY_INIT_CONFIGURATION_ENVIRONMENT = "AR_CUSTODY_INIT_CONFIGURATION";
// Include the environment key and '=' in the existing image verifier's 32 KiB bound.
export const DOCKER_CUSTODY_INIT_CONFIGURATION_MAX_BYTES =
  32_768 - new TextEncoder().encode(`${DOCKER_CUSTODY_INIT_CONFIGURATION_ENVIRONMENT}=`).byteLength;

const FIELDS = [
  "allowedEnvironmentNames", "executablePath", "executableSha256", "maximumStderrBytes",
  "maximumStdinBytes", "maximumStdoutBytes", "maximumProviderRuntimeMs", "shutdownGraceMs", "observedIdentity",
] as const;

export type DockerCustodyInitConfiguration = Readonly<Pick<NodeDockerCustodyInitDriverOptions, typeof FIELDS[number]>>;

const invalid = (): never => {throw new Error("invalid custody init configuration");};

const positiveInteger = (value: unknown): number => {
  if (typeof value !== "number") {return invalid();}
  return boundedInteger(value, "configuration limit");
};

const environmentNames = (value: unknown): readonly string[] => {
  if (!Array.isArray(value) || value.length > 128) {return invalid();}
  const names = value.map((name: unknown) => {
    if (typeof name !== "string" || !/^[A-Z_][A-Z0-9_]{0,127}$/u.test(name)) {return invalid();}
    return name;
  });
  if (new Set(names).size !== names.length) {return invalid();}
  return Object.freeze(names);
};

const decodeConfiguration = (source: unknown): unknown => {
  if (typeof source !== "string" || source.length === 0 ||
      source.length > DOCKER_CUSTODY_INIT_CONFIGURATION_MAX_BYTES ||
      !source.isWellFormed() || source.startsWith("\uFEFF")) {return invalid();}
  const bytes = new TextEncoder().encode(source);
  if (bytes.byteLength > DOCKER_CUSTODY_INIT_CONFIGURATION_MAX_BYTES) {return invalid();}
  // The existing strict parser rejects duplicate keys, invalid Unicode and excessive depth.
  return parseStrictJson(bytes);
};

/** Import-safe, bounded data decoding. Configured identity is not measurement evidence. */
export const parseDockerCustodyInitConfiguration = (source: unknown): DockerCustodyInitConfiguration => {
  try {
    const parsed = decodeConfiguration(source);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {return invalid();}
    const value = parsed as Record<string, unknown>;
    const keys = Object.keys(value);
    if (keys.length !== FIELDS.length || FIELDS.some(field => !Object.hasOwn(value, field))) {return invalid();}
    const executablePath = value.executablePath;
    if (typeof executablePath !== "string" || executablePath.includes("\0") ||
        new TextEncoder().encode(executablePath).byteLength > 4_096 || !posix.isAbsolute(executablePath) ||
        posix.resolve(executablePath) !== executablePath || posix.basename(executablePath) !== "provider-entrypoint") {
      return invalid();
    }
    const executableSha256 = value.executableSha256;
    if (typeof executableSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(executableSha256)) {return invalid();}
    return Object.freeze({
      allowedEnvironmentNames: environmentNames(value.allowedEnvironmentNames), executablePath, executableSha256,
      maximumStderrBytes: positiveInteger(value.maximumStderrBytes),
      maximumStdinBytes: positiveInteger(value.maximumStdinBytes),
      maximumStdoutBytes: positiveInteger(value.maximumStdoutBytes),
      maximumProviderRuntimeMs: positiveInteger(value.maximumProviderRuntimeMs),
      shutdownGraceMs: positiveInteger(value.shutdownGraceMs),
      observedIdentity: parseDockerCustodyIdentity(value.observedIdentity),
    });
  } catch {return invalid();}
};
