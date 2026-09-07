import {retainedHostPrivateRootBinding, type HostPrivateRootOwner} from "./host-private-root-owner.js";
import {renderCodexNativeBrokerConfig, isIssuedCodexAppServerLaunchPlan, isCodexNativeBrokerLaunchPlan,
  codexNativeBrokerLaunchInput} from "../adapters/outbound/codex-app-server/codex-app-server-launch-plan.js";
import {sameHostCustodyBinding} from "../adapters/outbound/host-custody/contained-turn-kernel-custody-entrypoint.js";
import {createHash} from "node:crypto";
import type {HostCustodyEvidence, HostCustodyReservationInput, HostCustodyLaunchFingerprintEvidence}
  from "../adapters/outbound/host-custody/custodied-provider-process.js";
import {assertDockerPreparedIoLaunch, canonicalJsonSha256, dockerProviderProcessMountFacts,
  DockerHostCustodyLifecycle, isConcreteLinuxDockerLifecycle, type PreparedDockerProviderIo, type LaunchedDockerCustody}
  from "../adapters/outbound/host-custody/docker/docker-provider-process-entrypoint.js";

const hash = (value: unknown): string => typeof value === "string"
  ? createHash("sha256").update(value).digest("hex") : canonicalJsonSha256(value);
const observeLaunch = DockerHostCustodyLifecycle.prototype.observeLaunch;
const observeImage = DockerHostCustodyLifecycle.prototype.imageInitWitness;
const retainedObservation = (owner: DockerHostCustodyLifecycle, launch: LaunchedDockerCustody) => observeLaunch.call(owner, launch);
const empty = createHash("sha256").digest("hex");

/** Planned authority only; never an execution witness. */
export const dockerReservationFingerprint = (input: HostCustodyReservationInput): HostCustodyLaunchFingerprintEvidence => {
  const plan = input.launchPlan;
  const fields = {binaryRevision: plan.binaryRevision, containmentProfile: plan.containmentProfile,
    environmentKeys: Object.freeze(Object.keys(plan.environment).toSorted()), executablePathSha256: hash(plan.executablePath),
    intentMode: plan.intentMode, argumentsSha256: hash(plan.arguments), executableSha256: plan.executableSha256,
    privatePathEnvironmentKeys: Object.freeze([...(plan.privatePathEnvironmentKeys ?? [])].toSorted()),
    privateRootPathSha256: hash(plan.privateRootPath), providerBindingSha256: hash(input.providerBinding),
    spawnMode: "sdk-delegated" as const, workspaceSha256: hash(input.workspaceRef)};
  const planSha256 = hash([fields, plan.environment]);
  return Object.freeze({...fields, planSha256, fingerprintSha256: planSha256});
};

export class DockerKernelEvidence {
  #fingerprint: HostCustodyLaunchFingerprintEvidence;
  #source: Readonly<{lifecycle: DockerHostCustodyLifecycle; launch: LaunchedDockerCustody; io: PreparedDockerProviderIo}> | undefined;
  #finalExec: Readonly<{argv: readonly string[]; environment: readonly {name: string; value: string}[]; executableSha256: string}> | undefined;
  #completion: Awaited<PreparedDockerProviderIo["completion"]> | undefined;
  #settled = false;
  #root: HostPrivateRootOwner | undefined;
  public attachPrivateRoot(root: HostPrivateRootOwner): void {
    retainedHostPrivateRootBinding(root);
    if (this.#root !== undefined) {throw new TypeError("Docker private root is one-use");}
    this.#root = root;
  }
  private rootBinding() {
    const binding = this.#root === undefined ? undefined : retainedHostPrivateRootBinding(this.#root);
    if (binding !== undefined && (binding.operationId !== this.input.operationId || binding.attemptId !== this.input.attemptId ||
      binding.canonicalBindSourcePath !== this.input.launchPlan.privateRootPath || binding.canonicalWorkspacePath !== this.input.workspaceRef ||
      this.#source !== undefined && (binding.hostInstanceId !== this.#source.launch.key.hostInstanceId ||
        binding.hostBootId !== this.#source.launch.key.hostBootId))) {
      throw new TypeError("Docker private root reservation conflict");
    }
    return binding;
  }
  public constructor(private readonly input: HostCustodyReservationInput) {this.#fingerprint = dockerReservationFingerprint(input); Object.freeze(this);}

  /** Same-object capabilities from the retained preparation, not observation bags. */
  public attach(lifecycle: DockerHostCustodyLifecycle, launch: LaunchedDockerCustody, io: PreparedDockerProviderIo): void {
    if (this.#source !== undefined) {throw new TypeError("Docker evidence attachment is one-use");}
    assertDockerPreparedIoLaunch(io, launch);
    const mounts = dockerProviderProcessMountFacts(launch);
    if (launch.key.operationId !== this.input.operationId || launch.key.attemptId !== this.input.attemptId ||
      mounts.workspaceSource !== this.input.workspaceRef || mounts.privateRootSource !== this.input.launchPlan.privateRootPath) {
      throw new TypeError("Docker evidence reservation conflicts with launch");
    }
    retainedObservation(lifecycle, launch); // Reject a foreign lifecycle without effects.
    this.#source = Object.freeze({lifecycle, launch, io});
    void io.completion.then(result => {this.#completion = result; this.#settled = true; return;}, () => {this.#settled = true;});
  }

  /** Finalized material is recorded by the same private composition that derives
   * bridge exec. This does not establish independently selected init provenance. */
  public finalize(plan: HostCustodyReservationInput["launchPlan"], exec: Readonly<{argv: readonly string[]; environment: readonly {name: string; value: string}[]; executableSha256: string}>): void {
    if (!isIssuedCodexAppServerLaunchPlan(plan) || this.#source === undefined || this.#finalExec !== undefined) {throw new TypeError("Docker evidence finalization unavailable");}
    this.#finalExec = Object.freeze({...exec, argv: Object.freeze([...exec.argv]),
      environment: Object.freeze(exec.environment.map(item => Object.freeze({...item})))});
    const fingerprint = dockerReservationFingerprint({...this.input, launchPlan: plan});
    const native = isCodexNativeBrokerLaunchPlan(plan) ? codexNativeBrokerLaunchInput(plan) : undefined;
    const material = native === undefined ? null : [native.recipe.kind, native.recipe.profile,
      native.recipe.endpoint, renderCodexNativeBrokerConfig(native.recipe), native.recipe.catalogSha256];
    const planSha256 = hash([plan, this.#finalExec, this.#source.launch.authority, material]);
    this.#fingerprint = Object.freeze({...fingerprint, argumentsSha256: hash(exec.argv.slice(1)),
      executablePathSha256: hash(exec.argv[0]), environmentKeys: Object.freeze(exec.environment.map(item => item.name).toSorted()),
      planSha256, fingerprintSha256: planSha256});
  }

  private identity(): HostCustodyEvidence["identity"] {
    const source = this.#source;
    const observation = source?.io.observation;
    const execution = source === undefined ? undefined : retainedObservation(source.lifecycle, source.launch).execution;
    const instance = observation?.providerInstance;
    const conflicting = this.#finalExec !== undefined && execution !== undefined && execution !== null &&
      (!sameHostCustodyBinding(execution.exec.argv, this.#finalExec.argv) ||
        !sameHostCustodyBinding(execution.exec.environment, this.#finalExec.environment) ||
        execution.exec.executableSha256 !== this.#finalExec.executableSha256);
    const root = this.rootBinding();
    let imageProved = false;
    if (source !== undefined && root !== undefined) {
      try {
        const witness = observeImage.call(source.lifecycle, source.launch, {
          hostIdentitySha256: source.launch.authority.hostIdentitySha256,
          hostBootGenerationSha256: source.launch.authority.hostBootGenerationSha256,
          hostLifecycleGenerationSha256: root.hostLifecycleGenerationSha256});
        imageProved = witness.scope === "created-image-init-readback";
      } catch { /* Missing or foreign readback remains unproven. */ }
    }
    const proved = imageProved && this.#finalExec !== undefined && executionAcknowledged(execution, observation) &&
      instance?.status === "observed" && observation?.executableMapping === "observed";
    return Object.freeze({binarySha256: this.#fingerprint.executableSha256,
      childProcessInstanceSha256: instance === undefined || instance.status === "missing" ? empty : hash([source?.launch.authority, instance.identity]),
      hostLifecycleGenerationSha256: root?.hostLifecycleGenerationSha256 ?? empty, planSha256: this.#fingerprint.planSha256,
      status: conflicting ? "ambiguous" : proved ? "proved" : "unproven"});
  }

  public snapshot(): HostCustodyEvidence {
    const source = this.#source;
    const lifecycle = source === undefined ? undefined : retainedObservation(source.lifecycle, source.launch);
    const observation = source?.io.observation;
    const execution = lifecycle?.execution;
    const acknowledged = executionAcknowledged(execution, observation);
    const providerExit = observedProviderExit(acknowledged, observation);
    const complete = providerExit.status === "observed" && drainComplete(this.#completion, observation);
    const terminal = lifecycle?.terminal?.observation.state;
    const physicallyClosed = source !== undefined && physicalClosure(source.lifecycle, lifecycle);
    // Image readback remains historical; provider identity also needs the exact
    // finalized execution and authenticated process observation.
    return Object.freeze({fingerprint: this.#fingerprint,
      spawn: acknowledged ? "acknowledged" : "ambiguous",
      identity: this.identity(), providerExit,
      guardianExit: terminal === undefined ? Object.freeze({status: "unobserved"})
        : Object.freeze({status: "observed", code: terminal.exitCode, signal: null}),
      stdout: Object.freeze({...observation?.stdout ?? {bytes: 0, sha256: empty}, status: complete ? "complete" : "incomplete"}),
      stderr: Object.freeze({...observation?.stderr ?? {bytes: 0, sha256: empty}, status: complete ? "complete" : "incomplete"}),
      closure: Object.freeze({profile: "strict-linux-cgroup-v2", limitations: Object.freeze([] as const),
        status: physicallyClosed ? "closed" : "unproven"}),
      privateRoot: this.#root?.snapshot().evidence ?? Object.freeze({identitySha256: empty, status: "unproven"}),
      sealed: this.#settled && observationSettled(lifecycle),
    });
  }
}


type Observation = PreparedDockerProviderIo["observation"] | undefined;
type Lifecycle = ReturnType<DockerHostCustodyLifecycle["observeLaunch"]> | undefined;
const executionAcknowledged = (execution: NonNullable<Lifecycle>["execution"] | undefined, observation: Observation): boolean => {
  if (execution === undefined || execution === null || observation === undefined) {return false;}
  return execution.result?.kind === "started" && execution.journal?.state === "provider_exec_observed" &&
    execution.journal.evidence.status === "proved" && execution.result.generation === observation.authority.generation &&
    execution.exec.requestId === observation.requestId && execution.exec.executableSha256 === observation.executableSha256;
};
const observedProviderExit = (acknowledged: boolean, observation: Observation): HostCustodyEvidence["providerExit"] => {
  const root = observation?.rootExit;
  return acknowledged && root !== undefined && root !== null && root.signal !== "SIGEMT"
    ? Object.freeze({status: "observed", code: root.exitCode, signal: root.signal}) : Object.freeze({status: "unobserved"});
};
const drainComplete = (completion: Awaited<PreparedDockerProviderIo["completion"]> | undefined, observation: Observation): boolean =>
  completion?.kind === "closed" && observation?.status === "complete" && observation.channelEof && observation.consumerIntegrity === "intact";
const physicalClosure = (owner: DockerHostCustodyLifecycle, lifecycle: Lifecycle): boolean =>
  isConcreteLinuxDockerLifecycle(owner) && lifecycle !== undefined && lifecycle.recursiveEmpty !== null &&
  lifecycle.removal !== null && lifecycle.attachCleanup === "complete" && lifecycle.journal.state === "closed" &&
  lifecycle.journal.evidence.status === "proved";

const observationSettled = (lifecycle: Lifecycle): boolean => lifecycle !== undefined && lifecycle.attachCleanup === "complete" &&
  (lifecycle.execution === null || lifecycle.execution.settled);
