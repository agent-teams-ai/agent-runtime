import type { HostHttpEgressSessionDependencies } from "@agent-teams/agent-execution/composition";
import { types } from "node:util";

type HostAuthorization = HostHttpEgressSessionDependencies["providerAccess"];
type HostOutcome = Awaited<ReturnType<HostAuthorization["authorize"]>>;
type HostReceipt = Extract<HostOutcome, {receipt: unknown}>["receipt"];

export interface ContainedTurnHttpProviderAccessOwner {
  /** Native async capabilities; ordinary Promise-returning functions are unsupported.
   * Owner response data is inspected before projection into AE's consumer contract.
   */
  readonly authorization: Readonly<{
    authorize(input: Parameters<HostAuthorization["authorize"]>[0]): Promise<unknown>;
    observe(input: Parameters<HostAuthorization["observe"]>[0]): Promise<unknown>;
  }>;
  readonly createRequestDigest: HostAuthorization["createRequestDigest"];
}

const invalidOwner = (): TypeError => new TypeError("Invalid HTTP Provider Access owner");
const unavailable = (): HostOutcome => Object.freeze({kind: "indeterminate"});

/** Inspect ordinary data without invoking getters, proxy traps or serialization. */
const dataRecord = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || types.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {throw invalidOwner();}
  const result: Record<string, unknown> = Object.create(null);
  const keys = Reflect.ownKeys(value);
  if (keys.length > 19) {throw invalidOwner();}
  for (const key of keys) {
    if (typeof key !== "string") {throw invalidOwner();}
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {throw invalidOwner();}
    result[key] = descriptor.value;
  }
  return result;
};

const exact = (value: Record<string, unknown>, keys: readonly string[]): void => {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) {throw invalidOwner();}
};

const method = <T extends (...args: never[]) => unknown>(value: unknown): T => {
  // Validate before invocation: discarding an unsupported returned Promise can
  // leave its rejection unhandled. A native async call creates its own Promise,
  // so the boundary never has to inspect a caller-supplied then/constructor.
  if (types.isProxy(value) || !types.isAsyncFunction(value) || types.isGeneratorFunction(value)) {throw invalidOwner();}
  return value as T;
};

const commandKeys = ["accessRef", "authorizationRequestId", "availability", "bindingRevision", "credentialBindingDigest",
  "credentialBindingRef", "credentialGeneration", "projectId", "provider", "providerAccountRef", "providerRouteRef",
  "purpose", "requestDigest", "revocation", "schemaVersion", "scopeDigest", "tenantId"] as const;
const selectorKeys = ["authorizationRequestId", "projectId", "provider", "requestDigest", "scopeDigest", "tenantId"] as const;
const receiptKeys = [...commandKeys, "decision", "rejectionReason"];
const reasons = ["access_changed", "access_not_available", "account_changed", "availability_changed", "binding_revision_changed",
  "credential_binding_changed", "credential_generation_changed", "revoked", "route_changed"];

const token = (data: Record<string, unknown>, key: string): string => {
  const value = data[key];
  if (typeof value !== "string" || value.length < 1 || value.length > 512) {throw invalidOwner();}
  return value;
};
const positive = (data: Record<string, unknown>, key: string): number => {
  const value = data[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {throw invalidOwner();}
  return value;
};

/** This is a detached contract projection; PA remains the decision and digest owner. */
const receipt = (value: unknown): HostReceipt => {
  const data = dataRecord(value); exact(data, receiptKeys);
  if (data.schemaVersion !== 1 || data.purpose !== "contained-turn.credential-materialization-authorization/v1" ||
      (data.provider !== "codex" && data.provider !== "claude") ||
      (data.availability !== "available" && data.availability !== "unavailable") ||
      (data.revocation !== "active" && data.revocation !== "revoked") ||
      (data.decision !== "authorized" && data.decision !== "rejected")) {throw invalidOwner();}
  const reason = data.rejectionReason;
  if (data.decision === "authorized" ? reason !== null : typeof reason !== "string" || !reasons.includes(reason)) {throw invalidOwner();}
  return Object.freeze({schemaVersion: 1, purpose: data.purpose, provider: data.provider,
    availability: data.availability, revocation: data.revocation, decision: data.decision,
    rejectionReason: reason as string | null, accessRef: token(data, "accessRef"),
    authorizationRequestId: token(data, "authorizationRequestId"), bindingRevision: positive(data, "bindingRevision"),
    credentialBindingDigest: token(data, "credentialBindingDigest"), credentialBindingRef: token(data, "credentialBindingRef"),
    credentialGeneration: positive(data, "credentialGeneration"), projectId: token(data, "projectId"),
    providerAccountRef: token(data, "providerAccountRef"), providerRouteRef: token(data, "providerRouteRef"),
    requestDigest: token(data, "requestDigest"), scopeDigest: token(data, "scopeDigest"), tenantId: token(data, "tenantId")});
};

const denialOutcome = (data: Record<string, unknown>, observation: boolean): HostOutcome => {
  switch (data.kind) {
    case "conflict":
      exact(data, ["kind", "reason"]);
      return !observation && data.reason === "authorization_request_digest_conflict" ? Object.freeze({kind: "conflict"}) : unavailable();
    case "invalid":
      exact(data, ["kind", "reason"]);
      return !observation && data.reason === "invalid_request" ? Object.freeze({kind: "invalid"}) : unavailable();
    case "unsupported":
      exact(data, ["kind", "reason"]);
      return data.reason === "unsupported_provider" || (!observation && data.reason === "unsupported_version")
        ? Object.freeze({kind: "unsupported"}) : unavailable();
    case "indeterminate": exact(data, ["kind"]); return unavailable();
    default: return unavailable();
  }
};

const outcome = (value: unknown, observation: boolean): HostOutcome => {
  const data = dataRecord(value);
  switch (data.kind) {
    case "authorized":
    case "observed":
    case "rejected": {
      if (observation && data.kind === "authorized") {return unavailable();}
      exact(data, data.kind === "rejected" ? ["kind", "receipt", "reason"] : ["kind", "receipt"]);
      const detached = receipt(data.receipt);
      if (data.kind === "authorized" && detached.decision !== "authorized") {return unavailable();}
      // PA can reject a formerly authorized receipt after revocation. Preserve
      // its historical decision; only the current outcome controls admission.
      if (data.kind === "rejected" && (typeof data.reason !== "string" || !reasons.includes(data.reason))) {return unavailable();}
      return Object.freeze({kind: data.kind, receipt: detached});
    }
    default: return denialOutcome(data, observation);
  }
};

const inputSnapshot = <T extends object>(value: T, keys: readonly string[]): T => {
  const data = dataRecord(value); exact(data, keys);
  if (Object.values(data).some(item => typeof item !== "string" && typeof item !== "number")) {throw invalidOwner();}
  return Object.freeze({...data}) as T;
};

const invoke = <T>(capability: (...args: never[]) => unknown, input: object, project: (value: unknown) => T): Promise<T> => {
  const pending: unknown = Reflect.apply(capability, undefined, [input]);
  return new Promise<T>((resolve, reject) => {
    Reflect.apply(Promise.prototype.then, pending, [(value: unknown) => {
      try {resolve(project(value));} catch (error) {reject(error);}
    }, reject]);
  });
};

/**
 * Private outer-composition binding. Construction captures capabilities without
 * calling PA. No receipt replay is promoted to fresh authorization, no current
 * authority is cached, and no credentials, storage or Host lifecycle are owned here.
 */
export const createContainedTurnHttpProviderAccessAuthorization = (
  owner: ContainedTurnHttpProviderAccessOwner,
): HostAuthorization => {
  const outer = dataRecord(owner); exact(outer, ["authorization", "createRequestDigest"]);
  const authorization = dataRecord(outer.authorization); exact(authorization, ["authorize", "observe"]);
  const authorize = method<ContainedTurnHttpProviderAccessOwner["authorization"]["authorize"]>(authorization.authorize);
  const observe = method<ContainedTurnHttpProviderAccessOwner["authorization"]["observe"]>(authorization.observe);
  const digest = method<ContainedTurnHttpProviderAccessOwner["createRequestDigest"]>(outer.createRequestDigest);
  return Object.freeze<HostAuthorization>({
    async createRequestDigest(input) {
      try {
        return await invoke(digest, inputSnapshot(input, commandKeys.filter(key => key !== "requestDigest")), value => token({digest: value}, "digest"));
      } catch {throw new TypeError("HTTP Provider Access request digest unavailable");}
    },
    async authorize(input) {
      try {return await invoke(authorize, inputSnapshot(input, commandKeys), value => outcome(value, false));}
      catch {return unavailable();}
    },
    async observe(input) {
      try {return await invoke(observe, inputSnapshot(input, selectorKeys), value => outcome(value, true));}
      catch {return unavailable();}
    },
  });
};
