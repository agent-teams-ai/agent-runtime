// Private one-shot test administration. Importing does no I/O. No live test runs here.
import {createHash, randomBytes} from "node:crypto";
import {isAbsolute, normalize} from "node:path";
import {isDeepStrictEqual} from "node:util";
import {
  NodeProviderProcessCustody, NodeTlsHttpEgressTransport, nativeHttpRequestProfile,
  createNodeExecutableFileObserver, createRuntimeInstallationDiscoveryFeature,
  CODEX_APP_SERVER_CURRENT_KERNEL_ADAPTER_SNAPSHOT as adapterSnapshot,
  CODEX_APP_SERVER_CURRENT_KERNEL_MANIFEST as capabilityManifest,CODEX_LOCAL_BROKER_CAPABILITY_ENV,containedTurnAcceptanceConstraintsDigestV1,containedTurnAcceptanceIntentDigestV1,digestContainedTurnCanonicalValue,containedTurnScopeDigest,snapshotDockerImageInitLock
} from "@agent-teams/agent-execution/composition";
import {createCredentialMaterializationRequestDigest} from "@agent-teams/provider-access/composition";
import {createNodePathCanonicalizer, createSetupInspectionAuthorizationFeature,currentEgressDigest} from
  "@agent-teams/runtime-security/composition";
import {
  createClaudeCodeConfigurationInspectionFeature, createClaudeCodeConfigurationSemanticClassifierV2,
  createClaudeCodeConfigurationSourceReaderAdapter, createCodexConfigurationInspectionFeature,
  createCodexConfigurationSemanticClassifierV1, createNodeClaudeCodeConfigurationDigest,
  createNodeCodexConfigurationDigest, createNodeConfigurationSourceReader,
  createSmolTomlParser, createStrictClaudeCodeJsonParser,
} from "@agent-teams/runtime-configuration/composition";
import {createClaudeCodeSetupInspectionPlanner} from "../../../dist/composition/claude-code-setup-inspection-planner.js";
import {createCodexSetupInspectionPlanner} from "../../../dist/composition/codex-setup-inspection-planner.js";
import {setupLinuxCodexLiveAdmin, type LinuxCodexLiveAdminApproval,
  type LinuxCodexLiveAdminConfiguration, type LinuxCodexLiveAdminCredentials} from "./linux-codex-live-admin.ts";

type Configuration = LinuxCodexLiveAdminConfiguration;
type Approval = LinuxCodexLiveAdminApproval;
const revision = "linux-codex-marker-canary:v1";
// Keep the whole canary lease within the exclusive route owner's supported maximum.
const runtimeMs = 120_000;
const cleanupMs = 30_000;
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

/** Root approves these facts BEFORE calling the factory. This is approval of
 * precisely the marker intent below, the finite ChatGPT route and fixed limits,
 * not an approval callback exposed to submit. Binding digests belong to PA;
 * they are supplied explicitly, never guessed from token/account plaintext.
 */
export interface LinuxCodexCanaryApproval {
  readonly approvedIntent: "write-one-marker-and-return-it/v1";
  readonly testId: string;
  readonly commandId: string;
  readonly deploymentId: string;
  readonly deploymentIncarnation: string;
  readonly binding: Approval["binding"];
  readonly externalAuthorityDigest: Approval["intentAuthority"]["externalAuthorityDigest"];
  readonly markerFile: string;
  readonly marker: string;
}

/** Only deployment observations/material remain explicit. No clock, signer,
 * policy reader, authority, synthetic proof, or owner callback is an input.
 * The image lock includes actual measured sizes/modes; tool and daemon pins
 * retain their existing exact contracts. The catalog and TLS roots are explicit
 * bytes, not paths to discover. Root owns the disposable parent and database.
 */
export interface LinuxCodexCanaryHostPins {
  readonly firewall?: Configuration["firewall"];
  readonly sourceRevision: string;
  readonly hostBootId: string;
  readonly hostInstanceId: string;
  readonly testParent: string;
  readonly enginePolicy: Omit<Configuration["node"]["enginePolicy"],
    "allowedEnvironmentKeys" | "cpuNanoCpus" | "memoryBytes" |
    "pidsLimit" | "tmpfsBytes" | "writableLayerBytes">;
  readonly tools: Configuration["node"]["tools"];
  readonly imageInitLock: Configuration["node"]["imageInitLock"];
  readonly native: Configuration["node"]["native"];
  readonly observerSha256: string;
  readonly certificateAuthorities: Configuration["deployment"]["transport"]["certificateAuthorities"];
}

// One shared wall/control domain for PA's epoch-millisecond SQL clock and RS.
// Monotonic elapsed time prevents a backward wall adjustment extending a lease.
const createClock = (authorityId: string, epoch: string) => {
  const wallAnchor = Date.now();
  const anchor = performance.now();
  let last = wallAnchor;
  const now = () => {
    last = Math.max(last, Date.now(), wallAnchor + Math.floor(performance.now() - anchor));
    return last;
  };
  const within: Configuration["deployment"]["clock"]["within"] = async (deadline, action, signal) => {
    const remaining = deadline - now();
    if (signal?.aborted || !Number.isSafeInteger(remaining) || remaining <= 0 || remaining > 2_147_483_647) {
      throw new Error("Canary clock deadline unavailable");
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      const expired = new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Error("Canary operation cancelled"));
        signal?.addEventListener("abort", abort, {once: true});
        timer = setTimeout(() => reject(new Error("Canary operation deadline expired")), remaining);
      });
      if (signal?.aborted) {abort!();}
      const value = await Promise.race([expired, Promise.resolve().then(() => {
        if (signal?.aborted || now() >= deadline) {throw new Error("Canary operation expired");}
        return action();
      })]);
      if (signal?.aborted || now() >= deadline) {throw new Error("Canary operation expired");}
      return value;
    } finally {
      if (timer !== undefined) {clearTimeout(timer);}
      if (abort !== undefined) {signal?.removeEventListener("abort", abort);}
    }
  };
  return Object.freeze({now, read: () => ({authorityId, epoch, controlTime: now()}), within});
};

// The same real setup components as the default Host. Constructing these ports
// does not invoke inspection or discovery, and the returned canary exposes only
// contained-turn submit/observe/cancel/cleanup, never a setup-inspection handle.
const createCapabilities = (): Configuration["capabilities"] => {
  const security = createSetupInspectionAuthorizationFeature({pathCanonicalizer: createNodePathCanonicalizer()});
  const execution = createRuntimeInstallationDiscoveryFeature({executableFileObserver: createNodeExecutableFileObserver()});
  const codex = createCodexConfigurationInspectionFeature({digest: createNodeCodexConfigurationDigest(), parser: createSmolTomlParser(),
    semanticClassifier: createCodexConfigurationSemanticClassifierV1(), sourceIdentityKey: randomBytes(32),
    sourceReader: createNodeConfigurationSourceReader()});
  const claude = createClaudeCodeConfigurationInspectionFeature({digest: createNodeClaudeCodeConfigurationDigest(), parser: createStrictClaudeCodeJsonParser(),
    semanticClassifier: createClaudeCodeConfigurationSemanticClassifierV2(), sourceIdentityKey: randomBytes(32),
    sourceReader: createClaudeCodeConfigurationSourceReaderAdapter()});
  return {codexSetup: {authorizeSetupInspection: security.authorizeSetupInspection,
    discoverCodexInstallations: execution.discoverCodexInstallations,
    inspectCodexConfiguration: codex.inspectCodexConfiguration,
    planCodexSetupInspection: createCodexSetupInspectionPlanner("linux")},
  claudeCodeSetup: {authorizeClaudeCodeSetupInspection: security.authorizeClaudeCodeSetupInspection,
    discoverClaudeCodeInstallations: execution.discoverClaudeCodeInstallations,
    inspectClaudeCodeConfiguration: claude,
    planClaudeCodeSetupInspection: createClaudeCodeSetupInspectionPlanner("linux")}};
};

const validateCanaryFacts = (a: LinuxCodexCanaryApproval, p: LinuxCodexCanaryHostPins) => {
  // Reject inconsistent approval before constructing any setup resources.
  // The approved binding remains authoritative; never repair its scope here.
  if (a.binding.scopeDigest !== containedTurnScopeDigest({
    tenantId: a.binding.tenantId, projectId: a.binding.projectId,
  })) {
    throw new TypeError("Approved Linux marker canary scope digest mismatch");
  }
  if (process.platform !== "linux" || process.arch !== "x64" ||
      !/^[a-f0-9]{40}$/u.test(p.sourceRevision) ||
      a.approvedIntent !== "write-one-marker-and-return-it/v1" ||
      ![a.testId, a.deploymentId, a.deploymentIncarnation].every(value =>
        /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u.test(value) && !value.includes("..")) ||
      !/^command:[A-Za-z0-9._:-]{1,100}$/u.test(a.commandId) ||
      !/^host-boot:[\x21-\x7e]+$/u.test(p.hostBootId) || !/^host-instance:[\x21-\x7e]+$/u.test(p.hostInstanceId) ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.txt$/u.test(a.markerFile) ||
      !/^[A-Za-z0-9_-]{1,128}$/u.test(a.marker) ||
      !/^sha256:[a-f0-9]{64}$/u.test(a.externalAuthorityDigest) ||
      a.binding.provider !== "codex" || a.binding.availability !== "available" || a.binding.revocation !== "active" ||
      !isAbsolute(p.testParent) || normalize(p.testParent) !== p.testParent || p.testParent === "/" ||
      !/^[a-f0-9]{64}$/u.test(p.observerSha256)) {
    throw new TypeError("Explicit approved Linux marker canary facts required");
  }
};

/** Produces concrete reviewable admin arguments, with a finite policy captured
 * independently of all subsequent requests. No directories, DB, DNS, Docker,
 * firewall or provider are touched here (Node custody checks its own procfs).
 * Build immediately before setup: the
 * two-minute lease starts here and never renews on submit/retry/cleanup.
 */
export const createLinuxCodexLiveCanaryConfiguration = (
  approved: LinuxCodexCanaryApproval, host: LinuxCodexCanaryHostPins,
) => {
  const a = structuredClone(approved);
  const {firewall, ...hostData} = host;
  const p = structuredClone(hostData);
  validateCanaryFacts(a, p);
  const imageInitLock = snapshotDockerImageInitLock(p.imageInitLock);
  if (imageInitLock.imageReference !== "sha256:041d6401e155737c93b484483d16ccf460b66c41f1a71bbbeff259bf7a4d5a9a" ||
      imageInitLock.architecture !== "amd64" ||
      imageInitLock.bootstrap.sha256 !== "e54bf7263a01b3ccc48a0b401a48eb14be60ce27520edd2bd865d04e3f04674c" ||
      imageInitLock.bootstrap.size !== 85430 ||
      imageInitLock.interpreter.sha256 !== "41a74efb34cbde5c7632cdac0cf8bd1a14d0b8d73dc1e82755014d9a9ce70f5c") {
    throw new TypeError("Approved canary image/init closure mismatch");
  }
  const enginePolicy: Configuration["node"]["enginePolicy"] = {...p.enginePolicy,
    // The engine owns HOME/PATH/TMPDIR; only init configuration is caller supplied.
    // Provider environment is authorized separately by provider.allowedEnvironmentNames.
    allowedEnvironmentKeys: ["AR_CUSTODY_INIT_CONFIGURATION"],
    cpuNanoCpus: 1_000_000_000,
    memoryBytes: 1_073_741_824, pidsLimit: 128, tmpfsBytes: 67_108_864, writableLayerBytes: 67_108_864};
  // Deployment snapshots accept plain DTOs. Preserve every PEM byte while
  // projecting decoded JSON byte inputs; the TLS constructor still validates CAs.
  const certificateAuthorities = Object.freeze(p.certificateAuthorities.map(authority => {
    if (typeof authority === "string") {return authority;}
    if (!(authority instanceof Uint8Array)) {throw new TypeError("Canary CA bytes required");}
    const pem = new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(authority);
    if (!Buffer.from(pem, "utf8").equals(authority)) {
      throw new TypeError("Lossless canary CA PEM required");
    }
    return pem;
  }));
  const transport = {certificateAuthorities, connectTimeoutMs: 10_000,
    responseIdleTimeoutMs: 30_000, closeTimeoutMs: 2_000};
  // Constructor parses explicit roots and derives the production TLS policy
  // digest. It does not connect. The deployment makes the actual transport.
  const tlsPolicyDigest = new NodeTlsHttpEgressTransport(transport).tlsPolicyDigest;
  const clock = createClock(`canary:${a.testId}`, a.deploymentIncarnation);
  const start = clock.now();
  const deadline = start + runtimeMs;
  const signal = AbortSignal.timeout(runtimeMs);
  const observationSignal = AbortSignal.timeout(runtimeMs + cleanupMs);
  const intent = {mode: "workspace-write" as const,
    prompt: `In the current disposable workspace, create exactly one file named ${a.markerFile} containing exactly ` +
      `${a.marker} followed by a newline. Do not read or modify other files. Return exactly ${a.marker} as your final response.`};
  const constraintsDigest = containedTurnAcceptanceConstraintsDigestV1({adapterSnapshot, capabilityManifest, intent});
  const administrativeDigest = currentEgressDigest({purpose: revision, approved: a,
    sourceRevision: p.sourceRevision, hostBootId: p.hostBootId, hostInstanceId: p.hostInstanceId, testParent: p.testParent,
    enginePolicy, tools: p.tools, imageInitLock, observerSha256: p.observerSha256,
    native: {ownerUid: p.native.ownerUid, ownerGid: p.native.ownerGid, catalogSha256: sha256(p.native.catalogSource)},
    tlsPolicyDigest, constraintsDigest, start, deadline});
  // RS trusted profiles require the security authority/revision namespace. The
  // fixed ASCII prefix plus all 64 digest hex characters is 112 characters,
  // within exactBoundedToken's 512-character limit and free of control bytes.
  const policyRevision = `security-authority:${revision}:${administrativeDigest.slice(7)}`;
  // Host access authority has its own revision domain, independent of RS policy.
  const authorityRevision = `runtime-access-authority:linux-codex-marker-canary-v1-${administrativeDigest.slice(7)}`;
  const scope = {tenantId: a.binding.tenantId, projectId: a.binding.projectId, scopeDigest: a.binding.scopeDigest};
  const dispatchPolicy: Approval["dispatchPolicy"] = {
    scope, providerId: "codex", intentDigest: containedTurnAcceptanceIntentDigestV1(intent), policyRevision,
    enabled: true, revoked: false, constraintsDigest,
    containmentPolicyDigest: digestContainedTurnCanonicalValue({purpose: revision,
      intentDigest: containedTurnAcceptanceIntentDigestV1(intent), constraintsDigest,
      externalAuthorityDigest: a.externalAuthorityDigest, administrativeDigest, runtimeMs, cleanupMs,
      imageConfigId: imageInitLock.imageConfigId, hostIdentitySha256: p.enginePolicy.hostIdentitySha256,
      seccompProfileSha256: p.enginePolicy.seccompProfileSha256}),
    validFromControlTime: start, claimBeforeControlTime: deadline,
  };
  // Real finite administrative RS reader: retain a separate approved value.
  // An arbitrary operation/request cannot alter or broaden the policy record.
  const retained = structuredClone(dispatchPolicy);
  const policy: Configuration["policy"] = {async read(request) {
    const now = clock.now();
    if (signal.aborted || now < retained.validFromControlTime || now >= retained.claimBeforeControlTime ||
        request.providerId !== retained.providerId || request.intentDigest !== retained.intentDigest ||
        request.policyRevision !== retained.policyRevision || !isDeepStrictEqual(request.scope, retained.scope)) {return;}
    return structuredClone(retained);
  }};
  const profile = nativeHttpRequestProfile("codex-chatgpt-responses/v1")!;
  const descriptor: Configuration["route"]["descriptor"] = {
    id: profile.id, provider: profile.provider, credentialMode: profile.credentialMode,
    originHost: profile.originHost, originPort: profile.originPort, upstreamMethod: profile.upstreamMethod,
    upstreamPath: profile.upstreamPath, credentialFieldNames: [...profile.credentialFieldNames],
    forwardedRequestHeaderNames: [...profile.forwardedRequestHeaderNames],
    requiredHeaderNames: [...profile.requiredHeaderNames], exactValues: {...profile.exactValues},
  };
  const approval: Approval = {binding: a.binding, submission: {commandId: a.commandId, expectedProvider: "codex", intent},
    dispatchPolicy,
    intentAuthority: {audience: revision, authorityRevision: policyRevision, deploymentId: a.deploymentId,
      deploymentIncarnation: a.deploymentIncarnation, externalAuthorityDigest: a.externalAuthorityDigest,
      runtimeScopeRevision: capabilityManifest.resourceScopeRevision},
    egressRule: {policyRef: policyRevision, revision: policyRevision, expectedAcceptedConstraintsDigest: constraintsDigest,
      tlsPolicyDigest, limits: {requestBytes: 1_048_576, responseBytes: 8_388_608, totalMilliseconds: 120_000},
      decisionTtlMilliseconds: 5_000,
      route: {method: profile.upstreamMethod, origin: {scheme: "https", hostname: profile.originHost, port: profile.originPort},
        requestTarget: {digest: `sha256:${sha256(profile.upstreamPath)}`, byteLength: Buffer.byteLength(profile.upstreamPath)},
        credentialSlots: [...profile.credentialFieldNames], credentialRecipeRef: "codex-chatgpt",
        framing: {protocol: "http/1.1", requestTarget: "origin-form", authoritySource: "host",
          contentLength: "body-byte-length", transferEncoding: "absent", connectionSpecificHeaders: "absent"}}},
  };
  // Docker supplies the real selected custody owner. This required compatibility
  // owner is real and has no host launch plan; accidentally selecting it fails.
  const hostCustody = new NodeProviderProcessCustody({hostLifecycleGeneration: a.deploymentIncarnation,
    monotonicNow: () => performance.now(), launchPlans: {async resolve() {}}});
  const configuration: Configuration = {
    ...(firewall === undefined ? {} : {firewall}),
    sourceRevision: p.sourceRevision, hostBootId: p.hostBootId, hostInstanceId: p.hostInstanceId,
    authorityRevision, capabilityManifestRevision: capabilityManifest.manifestRevision,
    testParent: p.testParent, executablePath: "/ar-provider/provider-entrypoint",
    credentialDeadlineMonotonic: performance.now() + deadline - clock.now() - 1_000, authorityReadTimeoutMs: 5_000,
    issuance: {issuanceRef: `${revision}:${a.testId}`, materializationHeadVersion: 1,
      validFromControlTime: start, claimBeforeControlTime: deadline, expiresAtControlTime: deadline},
    route: {recipe: "codex-chatgpt", descriptor, deadline: performance.now() + deadline - clock.now(),
      operationAbortSignal: signal}, policy, clock, hostCustody, capabilities: createCapabilities(),
    node: {enginePolicy, tools: p.tools, imageInitLock, native: p.native,
      observerSha256: p.observerSha256, clock, expectedClock: {authorityId: `canary:${a.testId}`, epoch: a.deploymentIncarnation},
      monotonicNow: () => performance.now(), wallNow: () => Date.now(),
      lifetime: {signal, observationSignal, operationDeadline: deadline, closureDeadline: deadline + cleanupMs,
        wallDeadlineEpochMs: deadline, observationWallDeadlineEpochMs: deadline + cleanupMs, maximumLifetimeMs: runtimeMs},
      deadlines: {engineIdentityMs: 5_000, allocationMs: 15_000, launchMs: 15_000,
        membershipMs: 5_000, cleanupMs, routeMs: 15_000},
      initTimeouts: {readyTimeoutMs: 10_000, acknowledgementTimeoutMs: 10_000},
      provider: {executablePath: "/ar-provider/provider-entrypoint",
        executableSha256: "56ef98ab4032d317ab26e9b5e5a175650717351edb16ed9cde0cb6d1734d62da",
        allowedEnvironmentNames: ["CODEX_HOME", "HOME", "LANG", "PATH", "TMPDIR", CODEX_LOCAL_BROKER_CAPABILITY_ENV],
        maximumProviderRuntimeMs: 120_000,
        shutdownGraceMs: 2_000, maximumStdinBytes: 1_048_576,
        maximumStdoutBytes: 8_388_608, maximumStderrBytes: 1_048_576},
      connection: {limits: {maxInboundHeaderBytes: 16_384, maxInboundBodyBytes: 1_048_576,
        maxUpstreamHeaderBytes: 16_384, maxOutputBytes: 8_388_608, maxBufferedBytes: 65_536,
        maxUpstreamWireBytes: 8_388_608}}},
    deployment: {deploymentId: a.deploymentId, imageInitLock, cleanupMilliseconds: cleanupMs,
      dns: {resolverIdentity: `node-dns:${a.testId}`, resolverEpoch: a.deploymentIncarnation, timeoutMs: 5_000},
      transport, clock, authorities: {createRequestDigest: createCredentialMaterializationRequestDigest},
      signer: {keyRef: `canary:${a.testId}`, keyGeneration: a.deploymentIncarnation, signerRevision: revision, clock}},
  };
  return Object.freeze({approval, configuration});
};

/** Root explicitly invokes this in its approved disposable environment. Setup
 * migrates the supplied empty Pool, but never submits. Keep the Pool alive until
 * cleanup reports released; setup errors retain the existing admin cleanup API.
 * Credential ownership transfers here, including configuration failure.
 */
export const setupLinuxCodexLiveCanary = async (
  pool: Parameters<typeof setupLinuxCodexLiveAdmin>[0], approved: LinuxCodexCanaryApproval,
  pins: LinuxCodexCanaryHostPins, credentials: LinuxCodexLiveAdminCredentials,
) => {
  credentials = Object.freeze({token: credentials.token, accountId: credentials.accountId});
  let prepared: ReturnType<typeof createLinuxCodexLiveCanaryConfiguration>;
  try {prepared = createLinuxCodexLiveCanaryConfiguration(approved, pins);} catch (error) {
    for (const bytes of [credentials.token, credentials.accountId]) {
      try {Uint8Array.prototype.fill.call(bytes, 0);} catch { /* Already detached. */ }
    }
    throw error;
  }
  return setupLinuxCodexLiveAdmin(pool, prepared.approval, prepared.configuration, credentials);
};
