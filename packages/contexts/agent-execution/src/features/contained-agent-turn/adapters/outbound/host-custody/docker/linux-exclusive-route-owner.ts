import { types } from "node:util";
import { linuxExclusiveRouteReadback, linuxExclusiveRouteTransaction,
  LINUX_ROUTE_ACK_MS, LINUX_ROUTE_ROUNDING_MS, LINUX_ROUTE_MIN_LIFETIME_MS, LINUX_ROUTE_MAX_LIFETIME_MS,
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

// Private candidate admission, not a live qualification receipt. The Claude
// tuple matches the pinned Linux SDK launch plan; Darwin remains unsupported by
// this Linux namespace owner. Tests bind these literals to the provider tuple.
const supportedLinuxCandidate = (binding: LinuxExclusiveRouteBinding): boolean =>
  binding.binaryRevision === "@openai/codex:0.153.4+linux-x64" ||
  (binding.binaryRevision === "sha256:fd5f10ff0eb58daec04900466b143ea98aab50abf208a422bc008eaec13f61f7" &&
    binding.adapterRevision === "claude-agent-sdk-contained-turn:0.3.251" &&
    binding.capabilityManifestRevision === "claude-contained-turn-v1@1");

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
      !supportedLinuxCandidate(binding)) {
    throw new TypeError("exclusive route requires an exact supported Linux candidate and source revision");
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
  /** One-way observation of the first local deny attempt, not a containment receipt.
   * Later cleanup can add quarantine evidence, never revise this observation. */
  readonly cutoff: Promise<"closed" | "quarantined">;
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
  /** Original remaining operation lease at startedAtMs; never a fresh renewal.
   * At least 4000 ms must still remain when kernel installation begins. */
  lifetimeMs: number;
  /** Captured before Node namespace/tool preparation, in monotonicNow's domain. */
  startedAtMs: number;
  kernel: LinuxExclusiveRouteKernel;
  monotonicNow(): number;
  /** Adapter-private, one-shot scheduler; returns cancellation. Must not call inline. */
  scheduleCutoff(delayMs: number, callback: () => void): () => void;
}>): LinuxExclusiveRouteOwner => {
  const binding = snapshotBinding(input.binding);
  const endpoint = Object.freeze({address: input.endpoint.address, port: input.endpoint.port});
  validateLinuxExclusiveRouteEndpoint(endpoint);
  const lifetimeMs = input.lifetimeMs;
  if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < LINUX_ROUTE_MIN_LIFETIME_MS || lifetimeMs > LINUX_ROUTE_MAX_LIFETIME_MS) {
    throw new TypeError("route lease requires 4000..120000 integer milliseconds");
  }
  const kernel = input.kernel; const now = input.monotonicNow; const schedule = input.scheduleCutoff;
  if (typeof schedule !== "function") {throw new TypeError("autonomous route cutoff scheduler required");}
  const startedAt = input.startedAtMs; let highWater = startedAt;
  const deadline = startedAt + lifetimeMs;
  if (!Number.isFinite(startedAt) || startedAt < 0 || deadline > Number.MAX_SAFE_INTEGER || deadline <= startedAt) {throw new TypeError("invalid route control time");}
  let revoked = false; let released = false; let quarantined = false; let installed = false;
  const cutoff = Promise.withResolvers<"closed" | "quarantined">();
  let timerGeneration = 0; let cancelTimer: (() => void) | undefined;
  let releaseFlight: Promise<"closed" | "quarantined"> | undefined;
  const requests = new Set<string>();
  let timeoutSeconds = 0; let kernelCutoffMs = 0; let liveUntilMs = 0;
  const readTime = (): number => {
    let observed: number;
    try {observed = now();} catch (error) {quarantined = true; throw error;}
    if (!Number.isFinite(observed) || observed > Number.MAX_SAFE_INTEGER || observed < highWater) {
      quarantined = true;
      throw new TypeError("route control time changed");
    }
    highWater = observed;
    if (observed - startedAt >= lifetimeMs) {
      // A late observation cannot prove that the installed permission ended on time.
      if (observed - startedAt > lifetimeMs) {quarantined = true;}
      throw new TypeError("route lease expired or control time changed");
    }
    return observed;
  };
  const verify = (permit: boolean): void => {
    try {
      const beforeMs = permit ? readTime() : 0;
      const observed = kernel.readRules();
      const afterMs = permit ? readTime() : 0;
      const liveUntil = linuxExclusiveRouteReadback(observed, endpoint, permit ? {
        timeoutSeconds, beforeMs, afterMs, cutoffMs: kernelCutoffMs,
      } : false);
      if (liveUntil === undefined) {throw new TypeError("kernel exclusive route differs from the installed policy or expired");}
      if (permit) {liveUntilMs = liveUntil;}
    } catch (error) {
      // An unobserved or changed cut leaves uncertainty about earlier traffic.
      // Record it before any deny transaction; later cleanup cannot erase it.
      quarantined = true; throw error;
    }
  };
  const revoke = (): "closed" | "quarantined" => {
    const firstCut = !revoked;
    if (firstCut) {try {readTime();} catch { /* readTime records control-time uncertainty. */ }}
    revoked = true;
    timerGeneration += 1;
    const cancel = cancelTimer; cancelTimer = undefined;
    try {cancel?.();} catch {quarantined = true;}
    if (released) {return quarantined ? "quarantined" : "closed";}
    try {
      kernel.transact(linuxExclusiveRouteTransaction(endpoint, installed, false));
      installed = true; verify(false);
    } catch {quarantined = true;}
    if (firstCut) {try {readTime();} catch { /* Include delay/regression during the deny observation. */ }}
    cutoff.resolve(quarantined ? "quarantined" : "closed");
    return quarantined ? "quarantined" : "closed";
  };
  const arm = (delayMs: number): void => {
    const generation = ++timerGeneration;
    let scheduling = true;
    try {
      const cancel = schedule(delayMs, () => {
        if (revoked || released || generation !== timerGeneration) {return;}
        if (scheduling) {quarantined = true; revoke(); return;}
        cancelTimer = undefined;
        try {
          // Early wakeups do not extend the original deadline. Each arm fences
          // callbacks from earlier timers, including callbacks retained by a scheduler.
          arm(lifetimeMs - (readTime() - startedAt));
          readTime(); // A blocking rearm cannot defer an already-due cutoff.
        } catch {revoke();}
      });
      scheduling = false;
      if (typeof cancel !== "function") {throw new TypeError("route cutoff cancellation required");}
      if (revoked || generation !== timerGeneration) {
        cancel(); throw new TypeError("route cutoff fired during scheduling");
      }
      cancelTimer = cancel;
    } catch (error) {quarantined = true; throw error;}
  };
  try {
    const beforeInstall = readTime();
    // Whole seconds rounded DOWN, with explicit acknowledgement and rounding
    // reserves. Preparation time spends the original lease; it never restarts it.
    if (deadline - beforeInstall < LINUX_ROUTE_MIN_LIFETIME_MS) {throw new TypeError("unsupported remaining route lifetime");}
    timeoutSeconds = Math.floor((deadline - beforeInstall - LINUX_ROUTE_ACK_MS - LINUX_ROUTE_ROUNDING_MS) / 1_000);
    // Fresh namespace admission fails if a previous campaign's table already exists.
    kernel.transact(linuxExclusiveRouteTransaction(endpoint, false, timeoutSeconds));
    installed = true;
    const acknowledgedAt = readTime();
    kernelCutoffMs = acknowledgedAt + timeoutSeconds * 1_000 + LINUX_ROUTE_ROUNDING_MS;
    if (acknowledgedAt - beforeInstall > LINUX_ROUTE_ACK_MS || kernelCutoffMs > deadline) {
      throw new TypeError("kernel route installation exceeded acknowledgement margin");
    }
    verify(true);
    arm(lifetimeMs - (readTime() - startedAt));
    // A blocked scheduler must not publish a stale readback as live authority.
    if (readTime() >= liveUntilMs) {throw new TypeError("kernel route readback expired during scheduling");}
  } catch (error) {
    // An acknowledgement loss may have installed the table. Replacement only
    // reduces authority; preserve the original failure and always attempt it.
    installed = true; revoke(); throw error;
  }
  return Object.freeze({
    cutoff: cutoff.promise,
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
          const finishedAt = readTime();
          if (finishedAt >= liveUntilMs) {throw new TypeError("kernel route readback expired");}
          return !revoked && !released && finishedAt - issuedAt < 1_000;
        } catch {revoke(); return false;}
      }});
    },
    revoke,
    releaseAfterContainerRemoval(): Promise<"closed" | "quarantined"> {
      releaseFlight ??= (async () => {
        revoke();
        try {
          if (!await kernel.containerRemoved()) {quarantined = true; return "quarantined";}
          // Closing can partially succeed before throwing. Retire kernel I/O
          // first so neither revocation nor cleanup can reuse descriptor numbers.
          released = true; kernel.releaseNamespace();
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
