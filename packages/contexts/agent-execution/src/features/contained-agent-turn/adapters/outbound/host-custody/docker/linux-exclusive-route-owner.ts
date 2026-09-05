import { types } from "node:util";
import { linuxExclusiveRouteRulesMatch, linuxExclusiveRouteTransaction,
  validateLinuxExclusiveRouteEndpoint, type LinuxExclusiveRouteEndpoint } from "./linux-exclusive-route-policy.js";

export interface LinuxExclusiveRouteBinding {
  readonly tenantId: string;
  readonly projectId: string;
  readonly scopeDigest: string;
  readonly operationId: string;
  readonly attemptId: string;
  readonly custodyId: string;
  readonly sourceRevision: string;
  readonly binaryRevision: string;
  readonly adapterRevision: string;
  readonly capabilityManifestRevision: string;
  readonly authorityVectorDigest: string;
  readonly hostBootId: string;
  readonly executionGenerationId: string;
  readonly providerRouteRef: string;
  readonly providerAccountRef: string;
  readonly accessRef: string;
  readonly routeRevision: string;
  readonly bindingRevision: number;
  readonly credentialBindingRef: string;
  /** Provider Access's opaque non-secret owner digest, never a file inventory hash. */
  readonly credentialBindingDigest: string;
  readonly credentialGeneration: number;
}

const BINDING_KEYS = ["tenantId", "projectId", "scopeDigest", "operationId", "attemptId", "custodyId",
  "sourceRevision", "binaryRevision", "hostBootId", "executionGenerationId", "providerRouteRef",
  "routeRevision", "credentialBindingDigest", "credentialGeneration", "adapterRevision",
  "capabilityManifestRevision", "authorityVectorDigest", "providerAccountRef", "accessRef",
  "bindingRevision", "credentialBindingRef"] as const;

const snapshotBinding = (input: LinuxExclusiveRouteBinding): LinuxExclusiveRouteBinding => {
  if (input === null || typeof input !== "object" || types.isProxy(input) ||
      Reflect.ownKeys(input).length !== BINDING_KEYS.length) {throw new TypeError("invalid exact route binding");}
  const fields = Object.getOwnPropertyDescriptors(input);
  for (const key of BINDING_KEYS) {
    const field = fields[key];
    if (field === undefined || !("value" in field) || !field.enumerable) {throw new TypeError("invalid exact route binding");}
    if (key === "credentialGeneration" || key === "bindingRevision") {
      if (typeof field.value !== "number" || !Number.isSafeInteger(field.value) || field.value < 1) {
        throw new TypeError("invalid credential generation");
      }
    } else if (typeof field.value !== "string" || field.value.length < 1 || field.value.length > 256 ||
        /[\p{Cc}\s]/u.test(field.value)) {throw new TypeError("invalid exact route binding");}
  }
  const binding = Object.freeze(Object.fromEntries(BINDING_KEYS.map(key => [key, fields[key]!.value]))) as unknown as LinuxExclusiveRouteBinding;
  if (!/^[a-f0-9]{40}$/u.test(binding.sourceRevision) ||
      binding.binaryRevision !== "@openai/codex:0.150.1+linux-x64") {
    throw new TypeError("exclusive route requires the exact Linux Codex candidate and source revision");
  }
  return binding;
};

/** Adapter-local kernel I/O. No provider, feature, or ordinary caller receives it. */
export interface LinuxExclusiveRouteKernel {
  transact(transaction: string): void;
  readRules(): unknown;
  /** Must inspect the exact created Docker authority; timeout/not_found is not sufficient. */
  containerRemoved(): Promise<boolean>;
  releaseNamespace(): void;
}

export interface LinuxExclusiveFirstWrite {
  /** Invoked synchronously adjacent to application-byte emission, after signed HTTP authorization. */
  consume(): boolean;
}

export interface LinuxExclusiveRouteOwner {
  reserveFirstWrite(expected: LinuxExclusiveRouteBinding, requestId: string): LinuxExclusiveFirstWrite;
  revoke(): "closed" | "quarantined";
  releaseAfterContainerRemoval(): Promise<"closed" | "quarantined">;
}

/**
 * Internal deterministic seam for adapter tests. The production constructor
 * opens the namespace and pinned tools itself. This function is not exported by
 * feature/package composition and must never be used to mint campaign authority
 * from caller callbacks. This lease proves only its own installed route cut;
 * PA, RS, provider launch, and campaign teardown retain their separate owners.
 */
export const installLinuxExclusiveRoute = (input: Readonly<{
  binding: LinuxExclusiveRouteBinding;
  endpoint: LinuxExclusiveRouteEndpoint;
  lifetimeMs: number;
  kernel: LinuxExclusiveRouteKernel;
  monotonicNow(): number;
}>): LinuxExclusiveRouteOwner => {
  const binding = snapshotBinding(input.binding);
  const endpoint = Object.freeze({address: input.endpoint.address, port: input.endpoint.port});
  validateLinuxExclusiveRouteEndpoint(endpoint);
  const lifetimeMs = input.lifetimeMs;
  if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1 || lifetimeMs > 120_000) {
    throw new TypeError("route lease must be bounded to at most two minutes");
  }
  const kernel = input.kernel; const now = input.monotonicNow;
  const startedAt = now(); let highWater = startedAt;
  if (!Number.isFinite(startedAt) || startedAt < 0) {throw new TypeError("invalid route control time");}
  let revoked = false; let released = false; let quarantined = false; let installed = false;
  let releaseFlight: Promise<"closed" | "quarantined"> | undefined;
  const requests = new Set<string>();
  const readTime = (): number => {
    const observed = now();
    if (!Number.isFinite(observed) || observed < highWater || observed - startedAt >= lifetimeMs) {
      throw new TypeError("route lease expired or control time changed");
    }
    highWater = observed; return observed;
  };
  const verify = (permit: boolean): void => {
    try {
      if (!linuxExclusiveRouteRulesMatch(kernel.readRules(), endpoint, permit)) {
        throw new TypeError("kernel exclusive route differs from the installed policy");
      }
    } catch (error) {
      // An unobserved or changed cut leaves uncertainty about earlier traffic.
      // Record it before any deny transaction; later cleanup cannot erase it.
      quarantined = true; throw error;
    }
  };
  const revoke = (): "closed" | "quarantined" => {
    revoked = true;
    if (released) {return quarantined ? "quarantined" : "closed";}
    try {
      kernel.transact(linuxExclusiveRouteTransaction(endpoint, installed, false));
      installed = true; verify(false);
    } catch {quarantined = true;}
    return quarantined ? "quarantined" : "closed";
  };
  try {
    // Fresh namespace admission fails if a previous campaign's table already exists.
    kernel.transact(linuxExclusiveRouteTransaction(endpoint, false, true));
    installed = true; verify(true); readTime();
  } catch (error) {
    // An acknowledgement loss may have installed the table. Replacement only
    // reduces authority; preserve the original failure and always attempt it.
    installed = true; revoke(); throw error;
  }
  return Object.freeze({
    reserveFirstWrite(expected: LinuxExclusiveRouteBinding, requestId: string): LinuxExclusiveFirstWrite {
      const captured = snapshotBinding(expected);
      if (revoked || released || BINDING_KEYS.some(key => captured[key] !== binding[key]) ||
          typeof requestId !== "string" || !/^[A-Za-z0-9:._-]{1,192}$/u.test(requestId) ||
          requests.has(requestId) || requests.size >= 256) {throw new TypeError("exact route first-write authority unavailable");}
      let issuedAt: number;
      try {issuedAt = readTime();} catch (error) {revoke(); throw error;}
      requests.add(requestId);
      let used = false;
      return Object.freeze({consume(): boolean {
        if (used) {return false;} used = true;
        try {
          if (revoked || released || readTime() - issuedAt >= 1_000) {return false;}
          verify(true);
          // Kernel inspection may take time; expiry must be checked after it.
          return !revoked && !released && readTime() - issuedAt < 1_000;
        } catch {revoke(); return false;}
      }});
    },
    revoke,
    releaseAfterContainerRemoval(): Promise<"closed" | "quarantined"> {
      releaseFlight ??= (async () => {
        revoke();
        try {
          if (!await kernel.containerRemoved()) {quarantined = true; return "quarantined";}
          kernel.releaseNamespace(); released = true;
        } catch {quarantined = true;}
        return quarantined ? "quarantined" : "closed";
      })();
      const flight = releaseFlight;
      // Retained namespace descriptors still need removal on a later successful
      // independent observation; quarantine never authorizes promotion or reuse.
      void flight.then(result => {
        if (!released && releaseFlight === flight) {releaseFlight = undefined;}
        return result;
      });
      return releaseFlight;
    },
  });
};
