// Private, test-only administrative entrypoint. Importing performs no I/O.
import {createHash} from "node:crypto";
import {digestContainedTurnCanonicalValue} from
  "../../../../contexts/agent-execution/dist/features/contained-agent-turn/domain/contained-turn-codecs.js";
import {isDeepStrictEqual} from "node:util";
import {NodeProviderProcessCustody} from "../../../../contexts/agent-execution/dist/composition.js";
import {containedTurnAcceptanceIntentDigestV1} from
  "../../../../contexts/agent-execution/dist/features/contained-agent-turn/application/contained-turn-acceptance-digests.js";
import type {DispatchAcceptancePolicy} from "../../../../contexts/runtime-security/dist/composition.js";
import {currentEgressDigest} from
  "../../../../contexts/runtime-security/dist/features/provider-process-egress-authorization/composition/current-egress-validation.js";
import {allocateLinuxCodexLiveAdminDirectories} from "./linux-codex-live-admin-directories.ts";
import {createLinuxCodexLiveAdminRoute} from "./linux-codex-live-admin-route.ts";
import {LinuxCodexLiveSetupError, setupLinuxCodexLiveBootstrap,
  type LinuxCodexLivePins, type LinuxCodexLiveSetupStage} from "./linux-codex-live-bootstrap.ts";

type Bootstrap = Awaited<ReturnType<typeof setupLinuxCodexLiveBootstrap>>;
type CleanupCall = Parameters<Bootstrap["cleanup"]>[0];
type CurrentPolicy = ReturnType<LinuxCodexLivePins["deployment"]["currentPolicy"]>;
type Directories = Awaited<ReturnType<typeof allocateLinuxCodexLiveAdminDirectories>>;

/** Root approves this record independently of the ordinary submit path. The
 * entrypoint exposes submit() with no request argument, so it cannot turn a
 * caller's different prompt, binding or requested policy into approval.
 */
export interface LinuxCodexLiveAdminApproval {
  readonly submission: Parameters<Bootstrap["submit"]>[0];
  readonly binding: LinuxCodexLivePins["issuance"]["binding"];
  readonly dispatchPolicy: DispatchAcceptancePolicy;
  readonly egressRule: CurrentPolicy["rule"];
  readonly intentAuthority: LinuxCodexLivePins["intentAuthority"];
}

export interface LinuxCodexLiveAdminConfiguration {
  readonly firewall?: LinuxCodexLivePins["firewall"];
  readonly sourceRevision: string;
  readonly hostBootId: string;
  readonly hostInstanceId: string;
  readonly authorityRevision: string;
  readonly capabilityManifestRevision: string;
  readonly testParent: string;
  readonly executablePath: string;
  /** Fixed absolute performance.now() deadline for PA material custody. */
  readonly credentialDeadlineMonotonic: number;
  readonly authorityReadTimeoutMs: number;
  readonly issuance: Omit<LinuxCodexLivePins["issuance"], "binding">;
  readonly route: Omit<LinuxCodexLivePins["route"], "binding">;
  /** Actual deployment RS policy reader, including its current revocation.
   * No request-derived policy or deterministic test authority is accepted by
   * this administrative contract. RS still owns the durable decision and head.
   */
  readonly policy: LinuxCodexLivePins["policy"];
  readonly clock: LinuxCodexLivePins["clock"];
  readonly capabilities: LinuxCodexLivePins["capabilities"];
  /** Borrowed real owner. Docker selection constructs its own kernel custody;
   * this required compatibility owner must also be real, never a fixture port.
   */
  readonly hostCustody: NodeProviderProcessCustody;
  readonly node: Omit<LinuxCodexLivePins["node"],
    "binding" | "readDirectories" | "workspaceBackingTreeOwnership" | "enginePolicy"> & {
      readonly enginePolicy: Omit<LinuxCodexLivePins["node"]["enginePolicy"],
        "workspaceSourceRoot" | "privateRootSourceRoot">;
    };
  /** Uses actual Node DNS/TLS options (no resolver/transport injection), real
   * clocks and the existing RS signer. The entrypoint binds the independently
   * approved rule only after the real PA/RS handoff has been acknowledged.
   */
  readonly deployment: Omit<LinuxCodexLivePins["deployment"], "currentPolicy">;
}

/** Dedicated caller-owned bytes: no environment, home or credential lookup.
 * Ownership transfers on invocation, including failure. Do not retain aliases.
 */
export interface LinuxCodexLiveAdminCredentials {
  readonly token: Uint8Array;
  readonly accountId: Uint8Array;
}

export class LinuxCodexLiveAdminSetupError extends Error {
  public readonly directory: string | undefined;
  public readonly cleanup: (call: CleanupCall) => Promise<"released" | "pending">;
  public readonly setupStage: LinuxCodexLiveSetupStage | "admin-setup";
  public constructor(directory: string | undefined,
    cleanup: (call: CleanupCall) => Promise<"released" | "pending">,
    setupStage: LinuxCodexLiveSetupStage | "admin-setup" = "admin-setup") {
    super("Linux Codex administrative setup incomplete; retain owners and retry cleanup");
    this.name = "LinuxCodexLiveAdminSetupError";
    this.directory = directory;
    this.cleanup = cleanup;
    this.setupStage = setupStage;
  }
}

/** Snapshot route data while borrowing the native cancellation capability. */
export const snapshotLinuxCodexLiveAdminRoute = (route: LinuxCodexLivePins["route"]): LinuxCodexLivePins["route"] => {
  const {operationAbortSignal, ...data} = route;
  return {...structuredClone(data), operationAbortSignal};
};

const validateApproval = (approval: LinuxCodexLiveAdminApproval,
  issuance: LinuxCodexLivePins["issuance"], route: LinuxCodexLivePins["route"]) => {
  const {binding, submission, dispatchPolicy} = approval;
  const scope = {tenantId: binding.tenantId, projectId: binding.projectId, scopeDigest: binding.scopeDigest};
  if (submission.expectedProvider !== "codex" || binding.provider !== "codex" ||
      binding.availability !== "available" || binding.revocation !== "active" ||
      route.recipe !== "codex-chatgpt" || issuance.materializationHeadVersion !== 1 ||
      dispatchPolicy.providerId !== "codex" || !dispatchPolicy.enabled || dispatchPolicy.revoked ||
      !isDeepStrictEqual(dispatchPolicy.scope, scope) ||
      dispatchPolicy.intentDigest !== containedTurnAcceptanceIntentDigestV1(submission.intent) ||
      approval.egressRule.expectedAcceptedConstraintsDigest !== dispatchPolicy.constraintsDigest) {
    throw new TypeError("Independent Linux Codex approval/configuration mismatch");
  }
};

/** Deployment identity is observed locally before any allocation or database call. */
export const assertLinuxCodexLiveAdminIdentity = (node: LinuxCodexLiveAdminConfiguration["node"]): void => {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined || uid <= 0 || gid <= 0 ||
      process.geteuid?.() !== uid || process.getegid?.() !== gid ||
      node.enginePolicy.user !== `${uid}:${gid}` ||
      node.native.ownerUid !== uid || node.native.ownerGid !== gid) {
    throw new TypeError("Linux Codex Host and container deployment identity mismatch");
  }
};

const validateConfiguration = (config: LinuxCodexLiveAdminConfiguration,
  lifetime: LinuxCodexLivePins["node"]["lifetime"], credentialDeadline: number) => {
  if (process.platform !== "linux" || process.arch !== "x64" ||
      !/^[a-f0-9]{40}$/u.test(config.sourceRevision) ||
      !(config.hostCustody instanceof NodeProviderProcessCustody) ||
      !isDeepStrictEqual(config.node.imageInitLock, config.deployment.imageInitLock) ||
      config.executablePath !== config.node.provider.executablePath ||
      !Number.isSafeInteger(config.authorityReadTimeoutMs) || config.authorityReadTimeoutMs < 1 ||
      !Number.isFinite(credentialDeadline) || credentialDeadline <= performance.now() ||
      credentialDeadline - performance.now() > lifetime.wallDeadlineEpochMs - Date.now() ||
      lifetime.signal.aborted || lifetime.observationSignal.aborted) {
    throw new TypeError("Independent Linux Codex approval/configuration mismatch");
  }
};

const credentialOutputTokens = (credentials: LinuxCodexLiveAdminCredentials): string[] => {
  // PA requires dedicated non-shared buffers, not Buffer slices or aliases.
  for (const bytes of [credentials.token, credentials.accountId]) {
    if (Object.getPrototypeOf(bytes) !== Uint8Array.prototype ||
        !(bytes.buffer instanceof ArrayBuffer) || bytes.buffer.resizable ||
        bytes.byteOffset !== 0 || bytes.byteLength !== bytes.buffer.byteLength ||
        bytes.byteLength === 0 || bytes.byteLength > 16384) {
      throw new TypeError("Dedicated bounded credential bytes required");
    }
  }
  if (credentials.token.buffer === credentials.accountId.buffer) {throw new TypeError("Credential buffers overlap");}
  const decoder = new TextDecoder("utf-8", {fatal: true});
  return [credentials.token, credentials.accountId].flatMap(bytes => {
    const value = decoder.decode(bytes);
    if (!value || /[\r\n\0]/u.test(value)) {throw new TypeError("Credential field invalid");}
    return [value, createHash("sha256").update(bytes).digest("hex")];
  });
};

/** AE inventory uses the accepted snapshot namespace. PA issuance, route and
 * owned material retain the original owner binding, including its raw digest. */
export const createLinuxCodexLiveCredentialInventory = (
  binding: Pick<LinuxCodexLivePins["issuance"]["binding"], "credentialBindingDigest" | "credentialGeneration">,
  sensitiveOutputTokens: readonly string[],
): LinuxCodexLivePins["credentials"]["inventory"] => ({
  credentialBindingDigest: digestContainedTurnCanonicalValue({ownerDigest: binding.credentialBindingDigest}),
  credentialGeneration: binding.credentialGeneration, sensitiveOutputTokens,
});

const approvedCurrentPolicy = (approval: LinuxCodexLiveAdminApproval,
  timing: CurrentPolicy["timing"], monotonicNow: CurrentPolicy["monotonicNow"]):
  LinuxCodexLivePins["deployment"]["currentPolicy"] => {
  const {binding, dispatchPolicy} = approval;
  const scope = {tenantId: binding.tenantId, projectId: binding.projectId, scopeDigest: binding.scopeDigest};
  return acknowledged => {
    const head = acknowledged.acceptedDispatch.authority;
    const subject = acknowledged.input.subject;
    if (head === undefined || head.revoked || head.constraintsDigest !== dispatchPolicy.constraintsDigest ||
        head.containmentPolicyDigest !== dispatchPolicy.containmentPolicyDigest ||
        !isDeepStrictEqual(head.scope, scope) || head.providerId !== "codex" ||
        acknowledged.input.accepted.intentDigest !== dispatchPolicy.intentDigest ||
        !isDeepStrictEqual(acknowledged.current.binding, binding)) {
      throw new TypeError("Acknowledged authority differs from independent approval");
    }
    // Same closed projection used by the existing current-egress ACL. All
    // head fields come from acknowledged RS, never request expectations.
    const operation = {scope: {...head.scope, operationId: head.operationId},
      providerId: head.providerId, authorityGeneration: head.authorityGeneration,
      claimBindingDigest: head.claimBindingDigest};
    if (head.operationId !== subject.operationId ||
        head.claimBindingDigest !== subject.runtimeSecurityRequest.claimBindingDigest) {
      throw new TypeError("Acknowledged operation mismatch");
    }
    const acceptedDispatch = {headVersion: acknowledged.acceptedDispatch.headVersion,
      authority: {operation, decision: head.decision, purpose: head.purpose,
        authorityRevision: head.authorityRevision, acceptedAuthorityDigest: head.acceptedAuthorityDigest,
        authorityHeadDigest: head.authorityHeadDigest, constraintsDigest: head.constraintsDigest,
        containmentPolicyDigest: head.containmentPolicyDigest, requestDigest: head.requestDigest,
        providerBindingDigest: head.providerBindingDigest, claimBeforeControlTime: head.claimBeforeControlTime,
        revoked: head.revoked, ownerEvidenceRef: head.ownerEvidenceRef}};
    const rule = structuredClone(approval.egressRule);
    return {rule, approval: {ruleRevision: rule.revision,
      bindingDigest: currentEgressDigest({domain: "rs-current-egress-rule/v1", operation, acceptedDispatch, rule})},
      timing, monotonicNow};
  };
};

/** Allocates a private empty project, composes the real PA/RS/AE owners and
 * returns one explicitly invokable turn. Setup migrates only an empty disposable
 * database; it does not submit or launch. No public runtime framework is added.
 * Keep the supplied Pool, clocks, host owner and firewall owner's lifetime alive
 * until cleanup returns released, including setup failure and unknown submit.
 * Firewall installation/rollback remains with the separately owned host helper.
 */
export const setupLinuxCodexLiveAdmin = async (
  pool: Parameters<typeof setupLinuxCodexLiveBootstrap>[0],
  approved: LinuxCodexLiveAdminApproval,
  config: LinuxCodexLiveAdminConfiguration,
  credentials: LinuxCodexLiveAdminCredentials,
) => {
  // Retain the byte arrays themselves, not mutable slots in the producer record.
  credentials = Object.freeze({token: credentials.token, accountId: credentials.accountId});
  let directories: Directories | undefined;
  let bootstrap: Bootstrap | undefined;
  let failedCleanup: LinuxCodexLiveSetupError["cleanup"] | undefined;
  let closing = false;
  let materialTaken = false;
  let cleanupFlight: Promise<"released" | "pending"> | undefined;
  const tokens: string[] = [];
  const erase = () => {
    for (const bytes of [credentials.token, credentials.accountId]) {
      try {Uint8Array.prototype.fill.call(bytes, 0);} catch { /* PA may have detached it. */ }
    }
    tokens.length = 0;
  };
  const cleanup = (call: CleanupCall): Promise<"released" | "pending"> => {
    closing = true;
    if (cleanupFlight !== undefined) {return cleanupFlight;}
    const settle = async (): Promise<"released" | "pending"> => {
      try {
        const result = bootstrap !== undefined ? await bootstrap.cleanup(call) :
          failedCleanup !== undefined ? await failedCleanup(call) : "released";
        if (result === "released") {erase();}
        return result;
      } catch {return "pending";}
    };
    cleanupFlight = directories === undefined ? settle() : directories.releaseAfterBootstrap(settle);
    void cleanupFlight.finally(() => {cleanupFlight = undefined;});
    return cleanupFlight;
  };
  try {
    // Snapshot approvals before the first await. No acknowledged authority is
    // synthesized from these facts; bootstrap obtains it from PA and RS stores.
    const approval = structuredClone(approved);
    assertLinuxCodexLiveAdminIdentity(config.node);
    const {binding, submission, dispatchPolicy} = approval;
    const issuance = structuredClone({...config.issuance, binding});
    const route = snapshotLinuxCodexLiveAdminRoute({...config.route, binding});
    const policyRead = config.policy.read.bind(config.policy);
    const lifetime = {...config.node.lifetime};
    const credentialDeadline = config.credentialDeadlineMonotonic;
    const monotonicNow = config.node.monotonicNow.bind(config.node);
    const timing = {controlTimeAtAnchor: config.clock.now(), monotonicAtAnchor: monotonicNow(),
      operationDeadlineMonotonic: monotonicNow() + lifetime.wallDeadlineEpochMs - Date.now(),
      readTimeoutMilliseconds: config.authorityReadTimeoutMs};
    const scope = {tenantId: binding.tenantId, projectId: binding.projectId, scopeDigest: binding.scopeDigest};
    validateApproval(approval, issuance, route);
    validateConfiguration(config, lifetime, credentialDeadline);
    tokens.push(...credentialOutputTokens(credentials));
    directories = await allocateLinuxCodexLiveAdminDirectories(config.testParent);
    const tree = directories;
    const enginePolicy = {...config.node.enginePolicy, ...tree.engineRoots};
    const routeEnforcement = await createLinuxCodexLiveAdminRoute({sourceRevision: config.sourceRevision,
      route, hostBootId: config.hostBootId, capabilityManifestRevision: config.capabilityManifestRevision,
      enginePolicy, tools: config.node.tools});
    const pins: LinuxCodexLivePins = {
      ...(config.firewall === undefined ? {} : {firewall: config.firewall}),
      sourceRevision: config.sourceRevision, authorityRevision: config.authorityRevision,
      hostBootId: config.hostBootId, hostInstanceId: config.hostInstanceId,
      issuance, route, policyRevision: dispatchPolicy.policyRevision,
      policy: {async read(intent) {
        const current = await policyRead(intent);
        // Revocation/absence fails closed. Even an independently updated policy
        // cannot change this invocation's immutable approved intent or limits.
        return isDeepStrictEqual(current, dispatchPolicy) ? structuredClone(dispatchPolicy) : undefined;
      }},
      clock: config.clock, intentAuthority: approval.intentAuthority,
      workspace: tree.workspace, artifacts: tree.artifacts, capabilities: config.capabilities,
      platformTarget: {platform: "linux", architecture: "x64"},
      routeEnforcement, hostCustody: config.hostCustody,
      node: {...config.node, lifetime, enginePolicy, binding: {...scope, hostBootId: config.hostBootId,
        hostInstanceId: config.hostInstanceId}, readDirectories: tree.readDirectories,
        workspaceBackingTreeOwnership: tree.workspaceBackingTreeOwnership},
      deployment: {...config.deployment, currentPolicy: approvedCurrentPolicy(approval, timing, monotonicNow)},
      credentials: {
        inventory: createLinuxCodexLiveCredentialInventory(binding, tokens),
        takeOwnedMaterial(operationId) {
          if (closing || materialTaken) {throw new TypeError("Administrative material already consumed or closed");}
          materialTaken = true;
          return {material: {operationRef: operationId, binding, recipe: "codex-chatgpt",
            fields: [{name: "token", valueBytes: credentials.token}, {name: "accountId", valueBytes: credentials.accountId}]},
            operationAbortSignal: lifetime.signal, deadline: credentialDeadline};
        },
      },
      launchPaths: input => tree.launchPaths(input, config.executablePath),
    };
    bootstrap = await setupLinuxCodexLiveBootstrap(pool, pins);
    const live = bootstrap;
    return Object.freeze({directory: tree.root,
      submit() {
        if (closing) {throw new TypeError("Administrative entrypoint closed");}
        return live.submit(submission, {signal: lifetime.signal});
      },
      collectNativeStart: live.collectNativeStart,
      observe: live.observe, cancel: live.cancel, cleanup,
    });
  } catch (error) {
    if (error instanceof LinuxCodexLiveSetupError) {failedCleanup = error.cleanup;}
    // Keep partial owner handles and tree; do not invent a cleanup deadline or
    // erase a live rendering owner's bytes while its cleanup is still pending.
    if (failedCleanup === undefined && bootstrap === undefined) {erase();}
    throw new LinuxCodexLiveAdminSetupError(directories?.root, cleanup,
      error instanceof LinuxCodexLiveSetupError ? error.setupStage : "admin-setup");
  }
};
