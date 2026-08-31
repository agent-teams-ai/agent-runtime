import { createHash } from "node:crypto";

import type {
  ContainedTurnAdapterCapabilityManifest,
  ContainedTurnProviderExecutionOutcome,
  ContainedTurnProviderPort,
} from "../legacy/legacy-contained-turn-ports.js";
import {
  CODEX_APP_SERVER_ADAPTER_REVISION,
  CODEX_APP_SERVER_BINARY_REVISION,
  CODEX_CAPABILITY_MANIFEST_REVISION,
  canonicalCodexJson,
} from "./codex-app-server-permission-boundary.js";

type CodexExecutionInput = Parameters<ContainedTurnProviderPort["execute"]>[0];

interface RuntimeTypes {
  readonly isProxy: (value: unknown) => boolean;
}

const utilTypes = (process.getBuiltinModule("node:util") as { readonly types: RuntimeTypes }).types;

export interface CodexReceiptIdentity {
  readonly attemptId: string;
  readonly effectId: string;
  readonly operationId: string;
}

export const codexReceipt = (kind: string, identity: CodexReceiptIdentity, codes: readonly string[]): string =>
  `urn:agent-runtime:${kind}:${createHash("sha256").update(canonicalCodexJson({
    adapterRevision: CODEX_APP_SERVER_ADAPTER_REVISION,
    attemptId: identity.attemptId,
    binaryRevision: CODEX_APP_SERVER_BINARY_REVISION,
    codes,
    effectId: identity.effectId,
    kind,
    operationId: identity.operationId,
    protocolRevision: CODEX_CAPABILITY_MANIFEST_REVISION,
    provider: "codex",
    redaction: "product-owned-receipt-identity/v2",
  })).digest("hex")}`;

export const codexNotAccepted = (input: {
  readonly identity: CodexReceiptIdentity;
  readonly reason: "before-turn-protocol-error" | "pre-turn-error" | "unknown-error";
}): ContainedTurnProviderExecutionOutcome => ({
  effectReceiptRef: codexReceipt("codex-effect-not-committed", input.identity, [input.reason]),
  executionReceiptRef: codexReceipt("codex-execution-not-started", input.identity, [input.reason]),
  kind: "not_accepted",
  outputDrainReceiptRef: codexReceipt("codex-output-not-started", input.identity, [input.reason]),
  providerReceiptRef: codexReceipt("codex-provider-not-accepted", input.identity, [input.reason]),
});

export const completedCodexOutcome = (input: {
  readonly identity: CodexReceiptIdentity;
  readonly status: "completed" | "failed" | "interrupted";
}): ContainedTurnProviderExecutionOutcome => {
  const evidence = [input.status === "completed" ? "codex-protocol-terminal-completed-observed"
    : input.status === "interrupted" ? "codex-protocol-terminal-interrupted-observed"
      : "codex-protocol-terminal-failed-observed"];
  return {
    acceptanceReceiptRef: codexReceipt("codex-provider-accepted", input.identity, evidence),
    effectDisposition: "committed",
    effectReceiptRef: codexReceipt("codex-effect-resolved", input.identity, evidence),
    executionReceiptRef: codexReceipt("codex-execution-closed", input.identity, evidence),
    kind: "completed",
    outcome: input.status === "completed" ? "succeeded" : input.status === "interrupted" ? "cancelled" : "failed",
    outputDrainReceiptRef: codexReceipt("codex-output-drained", input.identity, evidence),
  };
};

const ownData = (record: object, name: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(record, name);
  if (descriptor === undefined || !("value" in descriptor)) {
    throw new TypeError(`Codex execution input ${name} must be an own data property`);
  }
  return descriptor.value;
};

const plainRecord = (value: unknown, name: string): object => {
  if (typeof value !== "object" || value === null) {throw new TypeError(`${name} must be a record`);}
  if (utilTypes.isProxy(value)) {throw new TypeError(`${name} must not be a Proxy`);}
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {throw new TypeError(`${name} must be a plain record`);}
  return value;
};

const exactDataSnapshot = (value: unknown, name: string, keys: readonly string[]): Readonly<Record<string, unknown>> => {
  const record = plainRecord(value, name);
  const descriptors = Object.getOwnPropertyDescriptors(record);
  const actualKeys = Reflect.ownKeys(descriptors);
  if (actualKeys.length !== keys.length || actualKeys.some(key => typeof key !== "string" || !keys.includes(key))) {
    throw new TypeError(`${name} has missing or unknown keys`);
  }
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`${name}.${key} must be an enumerable own data property`);
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
};

const exactModeArray = (value: unknown): readonly ("analysis" | "workspace-write")[] => {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError("Codex supported modes must be a non-Proxy plain array");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>;
  const lengthDescriptor = descriptors.length;
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor)
    || !Number.isSafeInteger(lengthDescriptor.value) || Number(lengthDescriptor.value) > 2) {
    throw new TypeError("Codex supported modes must be a bounded dense array");
  }
  const length = Number(lengthDescriptor.value);
  const keys = Reflect.ownKeys(descriptors);
  const expected = new Set(["length", ...Array.from({ length }, (_unused, index) => String(index))]);
  if (keys.length !== expected.size || keys.some(key => typeof key !== "string" ? true : !expected.has(key))) {
    throw new TypeError("Codex supported modes must not have holes or aggregate properties");
  }
  const modes: ("analysis" | "workspace-write")[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`Codex supported modes[${index}] must be an enumerable own data property`);
    }
    if (descriptor.value !== "analysis" && descriptor.value !== "workspace-write") {
      throw new TypeError("Codex capability manifest contains an invalid mode");
    }
    modes.push(descriptor.value);
  }
  if (new Set(modes).size !== modes.length) {throw new TypeError("Codex supported modes must not contain duplicates");}
  return Object.freeze(modes);
};

const identityString = (record: object, name: string): string => {
  const value = ownData(record, name);
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) {
    throw new TypeError(`Codex execution input ${name} must be a bounded non-empty string`);
  }
  return value;
};

const boundedIdentity = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) {
    throw new TypeError(`Codex ${name} must be a bounded non-empty string`);
  }
  return value;
};

export const detachCodexManifest = (
  input: ContainedTurnAdapterCapabilityManifest,
): ContainedTurnAdapterCapabilityManifest => {
  const manifest = exactDataSnapshot(input, "Codex capability manifest", ["effectClass", "providerBinding", "supportedModes"]);
  const binding = exactDataSnapshot(manifest.providerBinding, "Codex provider binding", [
    "adapterRevision", "binaryRevision", "capabilityManifestRevision", "credentialBindingDigest", "provider", "providerRouteRef",
  ]);
  const supportedModes = exactModeArray(manifest.supportedModes);
  const effectClass = manifest.effectClass; const provider = binding.provider;
  if (effectClass !== "contained_unmediated_effect" || provider !== "codex") {
    throw new TypeError("Codex capability manifest has an invalid provider or effect class");
  }
  return Object.freeze({
    effectClass,
    providerBinding: Object.freeze({
      adapterRevision: boundedIdentity(binding.adapterRevision, "adapterRevision"),
      binaryRevision: boundedIdentity(binding.binaryRevision, "binaryRevision"),
      capabilityManifestRevision: boundedIdentity(binding.capabilityManifestRevision, "capabilityManifestRevision"),
      credentialBindingDigest: boundedIdentity(binding.credentialBindingDigest, "credentialBindingDigest"),
      provider,
      providerRouteRef: boundedIdentity(binding.providerRouteRef, "providerRouteRef"),
    }),
    supportedModes,
  });
};

export const detachCodexExecutionInput = (input: CodexExecutionInput): CodexExecutionInput => {
  const record = plainRecord(input, "Codex execution input");
  const custody = plainRecord(ownData(record, "custody"), "Codex execution custody");
  const intent = plainRecord(ownData(record, "intent"), "Codex execution intent");
  const mode = ownData(intent, "mode"); const prompt = ownData(intent, "prompt");
  const emit = ownData(record, "emit"); const cancellation = ownData(record, "isCancellationRequested");
  if ((mode !== "analysis" && mode !== "workspace-write") || typeof prompt !== "string") {
    throw new TypeError("Codex execution input has an invalid intent");
  }
  if (typeof emit !== "function" || typeof cancellation !== "function") {
    throw new TypeError("Codex execution callbacks must be own data functions");
  }
  return Object.freeze({
    attemptId: identityString(record, "attemptId"),
    custody: Object.freeze({ custodyRef: identityString(custody, "custodyRef") }),
    effectId: identityString(record, "effectId"),
    emit: emit as CodexExecutionInput["emit"],
    intent: Object.freeze({ mode, prompt }),
    isCancellationRequested: cancellation as CodexExecutionInput["isCancellationRequested"],
    operationId: identityString(record, "operationId"),
    workspaceRef: identityString(record, "workspaceRef"),
  });
};
