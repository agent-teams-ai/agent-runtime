import {createDockerHostCustodyLifecycle, type DockerHostCustodyCompositionDependencies,
  type DockerHostCustodyResiduePort} from "./docker-host-custody-lifecycle.js";
import {sameDockerAuthority, isInactiveDockerObservation} from "./docker-host-custody-lifecycle-guards.js";
import {validateAuthorityShape, snapshotDockerEnginePolicy, NodeUnixSocketDockerEngine}
  from "./engine/docker-engine-composition.js";
import type {DockerContainerAuthority, DockerContainerCreate, DockerContainerObservation, DockerEngineCall,
  DockerEngineIdentity, DockerEnginePolicy, DockerEnginePort} from "./engine/docker-engine-port.js";
import {boundResidueWork, NodeLinuxDockerResidueIo, ResidueIoScope, type DockerResidueIo,
  type ResidueFile, type ResiduePin} from "./linux-docker-residue-io.js";
import {compareResidueTrees, openResidueTree, pinResidueProcess, requireLeafMembership,
  scanResidueTree, verifyResidueProcess, type ResidueProcess, type ResidueTree} from "./linux-docker-residue-kernel.js";
import {recursivePopulation, residueFault, residueLeaf, residueParent, sameResidueEngine} from "./linux-docker-residue-parsers.js";

const concreteLifecycles = new WeakSet<object>();
/** Provenance readback only; no caller-supplied empty callback qualifies. */
export const isConcreteLinuxDockerLifecycle = (lifecycle: object): boolean => concreteLifecycles.has(lifecycle);

type Present = Extract<DockerContainerObservation, {existence: "present"}>;
interface RetainedResidue {
  readonly authority: DockerContainerAuthority;
  readonly engine: DockerEngineIdentity;
  readonly files: Set<ResidueFile>;
  readonly leafName: string;
  readonly path: string;
  readonly tree: ResidueTree;
  faulted: boolean;
  released: boolean;
  releaseAuthorized: boolean;
  sealed: boolean;
  leaf?: ResiduePin;
  process?: ResidueProcess;
}

/** Volatile FD custody cannot be reconstructed from an Engine observation after
 * restart. The durable lifecycle retains reconciliation debt in that case. */
class LinuxDockerResidueOwner implements DockerHostCustodyResiduePort {
  private readonly records = new Map<string, RetainedResidue>();
  private readonly cleanupDebt = new Set<ResidueFile>();
  private active: Promise<unknown> | undefined;
  private scope: ResidueIoScope | undefined;
  private disposed = false;
  private disposal: Promise<void> | undefined;
  private admitted = 0;
  public constructor(private readonly engine: DockerEnginePort, private readonly policy: DockerEnginePolicy,
    private readonly io: DockerResidueIo) {}

  public reserveCreate(call: DockerEngineCall): void {
    if (this.disposed || this.admitted >= 64 || call.signal.aborted ||
        !Number.isSafeInteger(call.deadlineEpochMs) || Date.now() >= call.deadlineEpochMs) {throw residueFault();}
    // Failed/ambiguous creates consume their slot too; no eviction or retry can
    // erase a possibly materialized container's reservation.
    this.admitted += 1;
  }

  private async run<T>(call: DockerEngineCall, work: (scope: ResidueIoScope) => Promise<T>): Promise<T> {
    if (this.disposed || this.active !== undefined || this.cleanupDebt.size > 0) {throw residueFault();}
    const scope = new ResidueIoScope(this.io, Object.freeze({...call}));
    scope.check();
    this.scope = scope;
    const pending = (async () => {
      try {return await work(scope);} finally {
        try {await scope.close();} finally {
          for (const file of scope.files) {this.cleanupDebt.add(file);}
          this.active = undefined;
          this.scope = undefined;
        }
      }
    })();
    this.active = pending;
    const publish = pending.then(result => {
      // Disposal/abort can race the final temporary-FD cleanup, after work has
      // calculated its result. Recheck the fence at publication as well.
      scope.check();
      if (this.disposed) {throw residueFault();}
      return result;
    });
    return boundResidueWork(publish, call, () => {scope.cancelled = true;});
  }

  private retain(scope: ResidueIoScope, record: RetainedResidue): void {
    scope.check();
    const pins = [...record.tree.ancestry, record.tree.proc, record.tree.events,
      ...(record.leaf === undefined ? [] : [record.leaf]),
      ...(record.process === undefined ? [] : [record.process.directory, record.process.stat,
        record.process.cgroup, record.process.status])];
    for (const pin of pins) {
      if (scope.files.delete(pin.file)) {record.files.add(pin.file);}
    }
  }

  private expectedLeaves(): ReadonlyMap<string, ResiduePin | undefined> {
    return new Map([...this.records.values()].filter(record => !record.released)
      .map(record => [record.leafName, record.leaf]));
  }

  private assertObservation(authority: DockerContainerAuthority, observation: DockerContainerObservation): void {
    if (!sameDockerAuthority(authority, observation.authority) ||
        observation.engine.hostIdentitySha256 !== this.policy.hostIdentitySha256 || observation.engine.cgroupVersion !== "2" ||
        authority.hostIdentitySha256 !== observation.engine.hostIdentitySha256 ||
        authority.hostBootGenerationSha256 !== observation.engine.hostBootGenerationSha256 ||
        authority.daemonIdentitySha256 !== observation.engine.daemonIdentitySha256 ||
        authority.daemonBootGenerationSha256 !== observation.engine.daemonBootGenerationSha256) {throw residueFault();}
    residueParent(this.policy.cgroupParent, observation.engine.cgroupDriver);
    if (observation.existence === "present" && (observation.resources.cgroupParent !== this.policy.cgroupParent ||
        observation.resources.user !== this.policy.user || observation.resources.containerId !== authority.containerId ||
        observation.resources.cgroupNamespaceMode !== "private" || observation.resources.capabilitiesDropped !== "all" ||
        !observation.resources.noNewPrivileges || observation.resources.restart !== "disabled")) {throw residueFault();}
  }

  private record(authority: DockerContainerAuthority, allowReleased = false): RetainedResidue {
    const record = this.records.get(authority.containerId);
    if (record === undefined || record.faulted || record.released && !allowReleased || !sameDockerAuthority(authority, record.authority)) {
      throw residueFault();
    }
    return record;
  }

  private async confirm(scope: ResidueIoScope, record: RetainedResidue, call: DockerEngineCall): Promise<void> {
    const engine = await this.engine.identity(call);
    scope.check();
    if (!sameResidueEngine(record.engine, engine)) {throw residueFault();}
    const current = await openResidueTree(scope, record.path);
    await compareResidueTrees(scope, record.tree, current);
    if (current.boot !== engine.hostBootGenerationSha256) {throw residueFault();}
  }

  public async start(authority: DockerContainerAuthority, call: DockerEngineCall): Promise<void> {
    authority = validateAuthorityShape(authority);
    return this.run(call, async scope => {
      if (this.records.has(authority.containerId) || this.records.size >= 64) {throw residueFault();}
      const before = await this.engine.inspect(authority, call);
      scope.check();
      this.assertObservation(authority, before);
      if (before.existence !== "present" || before.state.status !== "created" || before.state.hostPid !== 0) {throw residueFault();}
      const path = residueParent(this.policy.cgroupParent, before.engine.cgroupDriver);
      const tree = await openResidueTree(scope, path);
      if (tree.boot !== before.engine.hostBootGenerationSha256) {throw residueFault();}
      await scanResidueTree(scope, tree, this.expectedLeaves());
      // Pin the policy-owned ancestor BEFORE Docker starts its init. Docker may
      // delete its leaf on stop; the held ancestor still covers every descendant.
      // No missing-path or deleted-leaf read participates in the empty proof.
      const record: RetainedResidue = {authority, engine: Object.freeze({...before.engine}), files: new Set(),
        path, tree, leafName: residueLeaf(authority.containerId, before.engine.cgroupDriver),
        faulted: false, released: false, releaseAuthorized: false, sealed: false};
      this.records.set(authority.containerId, record);
      this.retain(scope, record);
      try {
        await this.confirm(scope, record, call);
        scope.check();
        await this.engine.start(authority, call);
        scope.check();
        const actual = await this.engine.inspect(authority, call);
        scope.check();
        this.assertObservation(authority, actual);
        if (actual.existence !== "present" || !sameResidueEngine(record.engine, actual.engine)) {throw residueFault();}
        record.process = await pinResidueProcess(scope, tree, actual, `${path}/${record.leafName}`);
        const leaf = await scanResidueTree(scope, tree, this.expectedLeaves(), record.leafName);
        if (leaf === undefined) {throw residueFault();}
        record.leaf = leaf;
        await requireLeafMembership(scope, record.leaf, actual.state.hostPid);
        await verifyResidueProcess(scope, record.process, actual);
        await this.confirm(scope, record, call);
        this.retain(scope, record);
      } catch (error) {record.faulted = true; throw error;}
    });
  }

  private async validateRunning(scope: ResidueIoScope, record: RetainedResidue, actual: Present,
    call: DockerEngineCall): Promise<void> {
    if (record.process === undefined || record.leaf === undefined || record.sealed) {throw residueFault();}
    await this.confirm(scope, record, call);
    await verifyResidueProcess(scope, record.process, actual);
    // A pinned proc FD alone cannot prove the current PID pathname still names
    // that process. Reopen and compare start identity and membership as well.
    const current = await pinResidueProcess(scope, record.tree, actual, record.process.path);
    if (current.start !== record.process.start || current.directory.facts.ino !== record.process.directory.facts.ino) {
      throw residueFault();
    }
    await scanResidueTree(scope, record.tree, this.expectedLeaves());
    await requireLeafMembership(scope, record.leaf, actual.state.hostPid);
    await this.confirm(scope, record, call);
  }

  public async inspect(authority: DockerContainerAuthority, call: DockerEngineCall): Promise<DockerContainerObservation> {
    const actual = await this.engine.inspect(authority, call);
    this.assertObservation(authority, actual);
    if (actual.existence === "absent") {
      const record = this.records.get(authority.containerId);
      // The lifecycle's remove_requested recovery path can consume absence
      // directly. Never let that shortcut reconstruct lost volatile custody.
      const releasedHere = record?.released === true && !record.faulted &&
        sameDockerAuthority(authority, record.authority) && sameResidueEngine(record.engine, actual.engine);
      return releasedHere ? actual : this.releaseAbsent(authority, call);
    }
    if (!actual.state.running) {return actual;}
    const record = this.record(authority);
    await this.run(call, async scope => {
      // A busy owner rejected before this callback has not observed a provenance
      // failure. Only an admitted validation may quarantine this record.
      try {await this.validateRunning(scope, record, actual, call);}
      catch (error) {record.faulted = true; throw error;}
    });
    return actual;
  }

  public async proveEmpty(authority: DockerContainerAuthority, call: DockerEngineCall): Promise<"empty" | "residue" | "unknown"> {
    try {
      return await this.run(call, async scope => {
        const record = this.record(authority, true);
        if (record.process === undefined || record.leaf === undefined) {throw residueFault();}
        const actual = await this.engine.inspect(authority, call);
        scope.check();
        this.assertObservation(authority, actual);
        if (!isInactiveDockerObservation(actual) || !sameResidueEngine(record.engine, actual.engine)) {throw residueFault();}
        if (record.released) {
          // Only this instance's completed empty/absence/FD-release transaction
          // may retain closure truth after its descriptors have been closed.
          if (!record.releaseAuthorized || actual.existence !== "absent") {throw residueFault();}
          return "empty";
        }
        await this.confirm(scope, record, call);
        await scanResidueTree(scope, record.tree, this.expectedLeaves());
        const population = recursivePopulation(await scope.text(record.tree.events, 128));
        await this.confirm(scope, record, call);
        // Re-read through the original FD after identity/generation validation.
        const confirmed = recursivePopulation(await scope.text(record.tree.events, 128));
        if (!sameResidueEngine(record.engine, await this.engine.identity(call))) {throw residueFault();}
        scope.check();
        record.sealed = true;
        return population === "empty" && confirmed === "empty" ? "empty" : "residue";
      });
    } catch {return "unknown";}
  }

  public async remove(authority: DockerContainerAuthority, call: DockerEngineCall): Promise<void> {
    // Also protects recovery from a previously persisted empty_observed record:
    // without this instance's retained pre-execution pins, removal stays debt.
    if (await this.proveEmpty(authority, call) !== "empty") {throw residueFault();}
    if (this.disposed) {throw residueFault();}
    await this.engine.remove(authority, call);
    await this.releaseAbsent(authority, call);
  }

  private async releaseAbsent(authority: DockerContainerAuthority, call: DockerEngineCall): Promise<DockerContainerObservation> {
    const record = this.record(authority);
    // Retain the completed proof before the first retained-FD close. A partial
    // close must be retryable without reading descriptors already released.
    if (!record.releaseAuthorized && await this.proveEmpty(authority, call) !== "empty") {throw residueFault();}
    return this.run(call, async scope => {
      this.record(authority);
      const actual = await this.engine.inspect(authority, call);
      scope.check();
      this.assertObservation(authority, actual);
      if (actual.existence !== "absent" || !sameResidueEngine(record.engine, actual.engine)) {throw residueFault();}
      record.releaseAuthorized = true;
      for (const file of record.files) {
        scope.check();
        await this.io.close(file);
        record.files.delete(file);
      }
      record.released = true;
      return actual;
    });
  }

  public async dispose(call: DockerEngineCall): Promise<"released" | "pending"> {
    this.disposed = true;
    if (this.scope !== undefined) {this.scope.cancelled = true;}
    this.disposal ??= (async () => {
      await this.active?.catch(() => {});
      for (const record of this.records.values()) {
        for (const file of record.files) {this.cleanupDebt.add(file);}
        record.files.clear();
        record.faulted = true;
      }
      for (const file of this.cleanupDebt) {
        await this.io.close(file);
        this.cleanupDebt.delete(file);
      }
    })();
    try {await boundResidueWork(this.disposal, call, () => {}); return "released";}
    catch {
      // A failed close is retryable. A still-pending close remains shared so a
      // second disposal cannot close the same descriptor concurrently.
      void this.disposal.catch(() => {this.disposal = undefined;});
      return "pending";
    }
  }
}

type ResidueComposition = Omit<DockerHostCustodyCompositionDependencies, "engine" | "residue"> & {
  readonly policy: DockerEnginePolicy;
};

/** Docker-private test seam; observations still come only from the engine at
 * start/inspect. No pin/brand issuance or always-empty configuration is exposed. */
export const composeLinuxDockerResidueCustody = (
  input: ResidueComposition, engine: DockerEnginePort, io: DockerResidueIo,
) => {
  const owner = new LinuxDockerResidueOwner(engine, snapshotDockerEnginePolicy(input.policy), io);
  const decorated: DockerEnginePort = Object.freeze({
    identity: engine.identity.bind(engine),
    create: (create: DockerContainerCreate, call: DockerEngineCall, expected?: DockerEngineIdentity) => {
      owner.reserveCreate(call); return engine.create(create, call, expected);
    },
    reconcileCreate: engine.reconcileCreate.bind(engine), attachCustody: engine.attachCustody.bind(engine),
    start: owner.start.bind(owner), inspect: owner.inspect.bind(owner), remove: owner.remove.bind(owner),
    stop: engine.stop.bind(engine), kill: engine.kill.bind(engine), wait: engine.wait.bind(engine), logs: engine.logs.bind(engine),
  });
  const lifecycle = createDockerHostCustodyLifecycle({engine: decorated, residue: owner, journalStorage: input.journalStorage,
    ...(input.journalLimits === undefined ? {} : {journalLimits: input.journalLimits})});
  concreteLifecycles.add(lifecycle);
  return Object.freeze({
    lifecycle,
    // Local residue FD disposal only; this does not stop a container, close the
    // lifecycle's sole attach reader, or manufacture containment/shutdown truth.
    disposeResidue: owner.dispose.bind(owner),
  });
};

/** Effect-free Docker-private production composition. The existing engine owns
 * all effects/attach I/O; the existing lifecycle owns receipts and execution.
 * Only this factory selects the actual Linux FD backend, with no caller override. */
export const createNodeLinuxDockerResidueCustody = (input: ResidueComposition) => {
  const policy = snapshotDockerEnginePolicy(input.policy);
  return composeLinuxDockerResidueCustody({...input, policy}, new NodeUnixSocketDockerEngine({policy}),
    new NodeLinuxDockerResidueIo());
};
