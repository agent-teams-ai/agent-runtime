// Test-only administrative glue. Import/selection performs no discovery or launch.
import {createHash, randomUUID} from "node:crypto";
import {isAbsolute, normalize, relative} from "node:path";
import type {LinuxCodexNodeRecipeSelection} from "../../dist/composition/linux-codex-node-recipe.js";
import type {LinuxCodexDeploymentInfrastructure} from "../../dist/composition/linux-codex-deployment.js";
import type {ContainedTurnDispatchGrantSubject} from "../../../../contexts/agent-execution/dist/features/contained-agent-turn/domain/contained-turn-dispatch-authority.js";
import type {DockerCustodyInitConfiguration} from "../../../../contexts/agent-execution/dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/init/docker-custody-init-configuration.js";

type Selection = LinuxCodexNodeRecipeSelection;
type Input = Parameters<LinuxCodexDeploymentInfrastructure["recipe"]>[0];
type Directory = Selection["consumption"]["directory"];
type Clock = Selection["localCut"]["clock"];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const fail = (reason: string): never => {throw new TypeError(`Linux Codex Node selection: ${reason}`);};
const digest = (value: string) => /^[a-f0-9]{64}$/u.test(value);
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
const contains = (parent: string, child: string) => {
  const part = relative(parent, child);
  return part === "" || part !== ".." && !part.startsWith("../") && !isAbsolute(part);
};

export interface LinuxCodexNodeSelectionPins {
  readonly binding: Readonly<{tenantId: string; projectId: string; scopeDigest: string;
    hostBootId: string; hostInstanceId: string}>;
  readonly enginePolicy: Selection["node"]["enginePolicy"];
  readonly tools: Pick<Selection["node"], "nsenter" | "nft">;
  readonly imageInitLock: LinuxCodexDeploymentInfrastructure["imageInitLock"];
  readonly provider: Omit<DockerCustodyInitConfiguration, "observedIdentity">;
  readonly native: Selection["nativeFileOptions"];
  /** Receipt for the test administrator's exclusive disposable backing tree. */
  readonly workspaceBackingTreeOwnership: Selection["workspaceBackingTreeOwnership"];
  readonly observerSha256: string;
  /** Same borrowed control clock/domain as RS and the HTTP broker. */
  readonly clock: Clock;
  readonly expectedClock: Selection["localCut"]["expectedClock"];
  readonly monotonicNow: () => number;
  readonly wallNow: () => number;
  readonly lifetime: Readonly<{signal: AbortSignal; observationSignal: AbortSignal;
    operationDeadline: number; closureDeadline: number;
    wallDeadlineEpochMs: number; observationWallDeadlineEpochMs: number;
    maximumLifetimeMs: number}>;
  readonly deadlines: Omit<Selection["deadlines"], "routeLifetimeMs">;
  readonly initTimeouts: Readonly<{readyTimeoutMs: number; acknowledgementTimeoutMs: number}>;
  readonly decorateListener?: Selection["decorateListener"];
  readonly connection: Omit<Selection["connection"], "limits"> & Readonly<{
    limits: Omit<Selection["connection"]["limits"], "deadline" | "closureDeadline">}>;
  /** REQUIRED READBACK: kernel+record omit scope digest, Host IDs and execution
   * generation. Root must project its retained acknowledged PA/RS handoff here.
   * Never synthesize it from binding pins or requested RS policy. Undefined fails
   * before selection. This reader does not create or approve authority. */
  readAcknowledged(input: Input): Readonly<{subject: ContainedTurnDispatchGrantSubject;
    acceptedAuthorityVectorDigest: string; securityDecisionDigest: string}> | undefined;
  /** Fresh disposable directories allocated by administration, outside provider
   * mounts. IDs are actual stat readbacks, not chosen labels. Do not recycle debt.
   * Mounted identity tokens below are configuration only; later AE owners must
   * independently prove opened-object/mount custody (this glue cannot do so). */
  readDirectories(input: Input): Readonly<{custody: Directory; resource: Directory;
    consumption: Directory; privateRoot: Directory; workspace: Directory}> | undefined;
}

const requireDecisionDigest = (value: string): string => {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) {return fail("security decision digest unavailable");}
  return value;
};

const validateAcknowledged = (p: LinuxCodexNodeSelectionPins, input: Input) => {
  const {kernel: k} = input;
  const acknowledged = p.readAcknowledged(input);
  if (acknowledged === undefined) {return fail("missing acknowledged subject readback");}
  const s = structuredClone(acknowledged.subject);
  for (const key of ["operationId", "attemptId", "custodyId", "effectId", "workspaceId",
    "preparationToken", "operationCutoffRevision"] as const) {
    if (s[key] !== k[key]) {return fail("acknowledged attempt mismatch");}
  }
  if (acknowledged.acceptedAuthorityVectorDigest !== k.authorityVectorDigest ||
      !/^sha256:[a-f0-9]{64}$/u.test(k.authorityVectorDigest) ||
      s.providerAccessExpectation.acceptedAuthorityDigest !== k.authorityVectorDigest ||
      s.runtimeSecurityExpectation.acceptedAuthorityDigest !== requireDecisionDigest(acknowledged.securityDecisionDigest) ||
      s.provider !== "codex" || k.providerAccessSnapshot.provider !== "codex" ||
      s.purpose !== "contained_turn_provider_start_v1" ||
      s.scope.tenantId !== p.binding.tenantId || s.scope.projectId !== p.binding.projectId ||
      k.providerAccessSnapshot.tenantId !== p.binding.tenantId ||
      k.providerAccessSnapshot.projectId !== p.binding.projectId ||
      s.scopeDigest !== p.binding.scopeDigest || !/^sha256:[a-f0-9]{64}$/u.test(s.scopeDigest) ||
      s.hostBootId !== p.binding.hostBootId || s.hostInstanceId !== p.binding.hostInstanceId ||
      !s.executionGenerationId) {return fail("independent deployment binding mismatch");}
  return s;
};

const validateDirectories = (p: LinuxCodexNodeSelectionPins, input: Input) => {
  const {record} = input;
  const dirs = p.readDirectories(input);
  if (dirs === undefined) {return fail("missing disposable directory readback");}
  const d = structuredClone(dirs);
  for (const dir of Object.values(d)) {
    if (!isAbsolute(dir.path) || normalize(dir.path) !== dir.path ||
        !/^[0-9]+$/u.test(dir.device) || !/^[1-9][0-9]*$/u.test(dir.inode)) {return fail("directory identity unavailable");}
  }
  if (d.privateRoot.path !== record.privateRootPath || d.workspace.path !== record.boundary.workspaceRef ||
      !contains(p.enginePolicy.privateRootSourceRoot, d.privateRoot.path) ||
      !contains(p.enginePolicy.workspaceSourceRoot, d.workspace.path)) {return fail("launch directory mismatch");}
  const journals = [d.custody, d.resource, d.consumption];
  if (journals.some((dir, i) =>
    [p.enginePolicy.privateRootSourceRoot, p.enginePolicy.workspaceSourceRoot].some(root => contains(root, dir.path) || contains(dir.path, root)) ||
    journals.some((other, j) => i !== j && (contains(dir.path, other.path) ||
      dir.device === other.device && dir.inode === other.inode)))) {return fail("journal roots overlap");}
  return d;
};

const validateConfiguration = (p: LinuxCodexNodeSelectionPins) => {
  const lock = p.imageInitLock;
  const imageSha256 = /(?:^sha256:|@sha256:)([a-f0-9]{64})$/u.exec(lock.imageReference)?.[1];
  if (imageSha256 === undefined || lock.os !== "linux" || !/^sha256:[a-f0-9]{64}$/u.test(lock.imageConfigId) ||
      !digest(lock.bootstrap.sha256) || !digest(lock.interpreter.sha256) ||
      !digest(p.provider.executableSha256) || !digest(p.observerSha256) ||
      lock.loadingPolicy !== "closed-bundle-node-builtins-only-v1" ||
      lock.interpreter.path !== "/ar-custody-node" || lock.bootstrap.path !== "/ar-custody-init.mjs" ||
      !isAbsolute(p.provider.executablePath) || !p.provider.executablePath.endsWith("/provider-entrypoint") ||
      !digest(p.enginePolicy.seccompProfileSha256) ||
      ![p.native.ownerUid, p.native.ownerGid].every(value => Number.isSafeInteger(value) && value >= 0) ||
      p.native.catalogSource.byteLength === 0) {return fail("installed image/init pins unavailable");}
  for (const value of [...Object.values(p.deadlines), ...Object.values(p.initTimeouts),
    p.lifetime.maximumLifetimeMs, p.provider.maximumProviderRuntimeMs, p.provider.shutdownGraceMs,
    p.provider.maximumStdinBytes, p.provider.maximumStdoutBytes, p.provider.maximumStderrBytes]) {
    if (!positive(value)) {return fail("unbounded runtime configuration");}
  }
  return imageSha256;
};

const identity = (dir: Directory) => `dev:${dir.device}:ino:${dir.inode}`;

/** One factory per disposable bootstrap attempt. Failed selection is consumed.
 * No PID, namespace, cgroup, listener, signer or authority-header facts are made.
 */
export const createLinuxCodexNodeSelection = (inputPins: LinuxCodexNodeSelectionPins):
  ((input: Input) => Selection) => {
  // Detach trusted data, retain borrowed ports and native signals deliberately.
  const p = {...inputPins, binding: structuredClone(inputPins.binding),
    enginePolicy: structuredClone(inputPins.enginePolicy), tools: structuredClone(inputPins.tools),
    imageInitLock: structuredClone(inputPins.imageInitLock), provider: structuredClone(inputPins.provider),
    workspaceBackingTreeOwnership: {...inputPins.workspaceBackingTreeOwnership},
    native: {...inputPins.native, catalogSource: Buffer.from(inputPins.native.catalogSource)},
    lifetime: {...inputPins.lifetime}, expectedClock: {...inputPins.expectedClock},
    deadlines: {...inputPins.deadlines}, initTimeouts: {...inputPins.initTimeouts},
    connection: structuredClone(inputPins.connection),
    clock: {read: inputPins.clock.read.bind(inputPins.clock), within: inputPins.clock.within.bind(inputPins.clock)},
    monotonicNow: inputPins.monotonicNow.bind(inputPins), wallNow: inputPins.wallNow.bind(inputPins),
    readAcknowledged: inputPins.readAcknowledged.bind(inputPins), readDirectories: inputPins.readDirectories.bind(inputPins)};
  let consumed = false;
  return (input: Input): Selection => {
    if (consumed) {return fail("attempt already selected");}
    consumed = true;
    const {kernel: k} = input;
    const s = validateAcknowledged(p, input);
    const d = validateDirectories(p, input);
    const imageSha256 = validateConfiguration(p);
    const lock = p.imageInitLock;
    const t = p.lifetime;
    const start = p.monotonicNow();
    let last = start;
    let clockFailed = false;
    let admissionClosed = false;
    const sample = () => {
      const value = p.clock.read();
      if (value.authorityId !== p.expectedClock.authorityId || value.epoch !== p.expectedClock.epoch ||
          !Number.isSafeInteger(value.controlTime) || value.controlTime < 0) {return fail("control clock domain changed");}
      return value.controlTime;
    };
    const remaining = Math.min(t.operationDeadline - sample(), t.wallDeadlineEpochMs - p.wallNow(), t.maximumLifetimeMs);
    if (!Number.isFinite(start) || !positive(remaining) || t.signal.aborted || t.observationSignal.aborted ||
        ![t.operationDeadline, t.closureDeadline, t.wallDeadlineEpochMs, t.observationWallDeadlineEpochMs].every(positive) ||
        t.closureDeadline <= t.operationDeadline || t.observationWallDeadlineEpochMs <= t.wallDeadlineEpochMs ||
        t.closureDeadline - t.operationDeadline > p.deadlines.cleanupMs ||
        t.observationWallDeadlineEpochMs - t.wallDeadlineEpochMs > p.deadlines.cleanupMs) {return fail("expired or unbounded lifetime");}
    const current = (observation: boolean) => {
      try {
        const now = p.monotonicNow();
        if (!Number.isFinite(now) || now < last) {clockFailed = true;}
        last = now;
        const active = !clockFailed && !t.observationSignal.aborted && (observation || !t.signal.aborted && !admissionClosed) &&
          now < start + remaining + (observation ? p.deadlines.cleanupMs : 0) &&
          sample() < (observation ? t.closureDeadline : t.operationDeadline) &&
          p.wallNow() < (observation ? t.observationWallDeadlineEpochMs : t.wallDeadlineEpochMs);
        if (!observation && !active) {admissionClosed = true;}
        return active;
      } catch {clockFailed = true; return false;}
    };
    const generation = randomUUID();
    const operationNonce = randomUUID();
    const expectedIdentity: DockerCustodyInitConfiguration["observedIdentity"] = {
      protocol: "ar.docker-custody-init/v1", containerImageSha256: imageSha256,
      initBinarySha256: lock.bootstrap.sha256, privateRootIdentity: identity(d.privateRoot),
      workspaceIdentity: identity(d.workspace), securityProfileIdentity: p.enginePolicy.seccompProfileSha256,
    };
    const configuration: DockerCustodyInitConfiguration = {...p.provider,
      maximumProviderRuntimeMs: Math.min(p.provider.maximumProviderRuntimeMs, remaining), observedIdentity: expectedIdentity};
    const encoded = JSON.stringify(configuration);
    if (Buffer.byteLength(`AR_CUSTODY_INIT_CONFIGURATION=${encoded}`) > 32768) {return fail("init configuration too large");}
    const environment = {HOME: "/agent-private/home", PATH: "/usr/local/bin:/usr/bin:/bin", TMPDIR: "/tmp",
      AR_CUSTODY_INIT_CONFIGURATION: encoded};
    const launchFingerprintSha256 = hash(JSON.stringify({domain: "linux-codex-live-node-selection/v1",
      subject: s, authority: k.authorityVectorDigest, generation, operationNonce,
      image: lock, policy: p.enginePolicy, configuration, privateRoot: d.privateRoot, workspace: d.workspace,
      intentMode: k.intentMode}));
    return {
      ...(p.decorateListener === undefined ? {} : {decorateListener: p.decorateListener}),
      node: {enginePolicy: p.enginePolicy, ...p.tools,
        custodyJournalRoot: d.custody.path, resourceJournalRoot: d.resource.path},
      create: {imageDigest: lock.imageReference, entrypoint: "/ar-custody-node",
        arguments: ["--no-addons", "--no-global-search-paths", "/ar-custody-init.mjs"], environment,
        launchFingerprintSha256, operationNonceSha256: hash(operationNonce), workspaceWritable: k.intentMode === "workspace-write"},
      subjectFacts: {scopeSha256: s.scopeDigest.slice(7), observerSha256: p.observerSha256,
        networkHandle: randomUUID(), listenerHandle: randomUUID(), routeHandle: randomUUID()},
      initOptions: {...p.initTimeouts, authority: {expectedIdentity, generation, operationNonce, launchFingerprintSha256},
        signal: t.signal, monotonicNow: p.monotonicNow,
        maximumStdoutBytes: p.provider.maximumStdoutBytes, maximumStderrBytes: p.provider.maximumStderrBytes,
        isCurrentGeneration: candidate => candidate === generation && current(false), isObservationActive: () => current(true)},
      workspaceBackingTreeOwnership: p.workspaceBackingTreeOwnership,
      deadlines: {...p.deadlines, routeLifetimeMs: remaining}, cleanupMilliseconds: p.deadlines.cleanupMs,
      consumptionSubject: {...s.scope, executionGenerationId: s.executionGenerationId},
      consumption: {directory: d.consumption}, nativeFileOptions: p.native,
      localCut: {clock: p.clock, expectedClock: p.expectedClock, operationDeadline: t.operationDeadline,
        hostShutdownSignal: t.signal},
      connection: {...p.connection, limits: {...p.connection.limits,
        deadline: t.operationDeadline, closureDeadline: t.closureDeadline}},
    };
  };
};
