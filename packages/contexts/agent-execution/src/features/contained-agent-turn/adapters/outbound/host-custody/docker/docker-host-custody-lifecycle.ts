import {DockerContainedTurnHostCustody, type DockerContainedTurnInitOptions, type DockerContainedTurnInitSession} from "./docker-contained-turn-host-custody.js";
import type {DockerCustodyInitHostExec} from "./init/docker-custody-init-host-session.js";
import type {
  DockerContainerAuthority,
  DockerContainerObservation,
  DockerEngineCall,
  DockerEnginePort,
} from "./engine/docker-engine-port.js";
import {
  DockerCustodyJournal,
  type DockerCustodyJournalRecoveryReader,
  type DockerCustodyJournalWriter,
} from "./journal/docker-custody-journal.js";
import { dockerCustodyAttemptLocator, dockerCustodyAuthoritySha256 } from "./journal/docker-custody-journal-codec.js";
import {
  DEFAULT_DOCKER_CUSTODY_JOURNAL_LIMITS,
  DockerCustodyJournalConflictError,
  DockerCustodyJournalCorruptionError,
  DockerCustodyJournalUnavailableError,
} from "./journal/docker-custody-journal-types.js";
import {
  assertDockerAuthorityBinding,
  assertDockerEngineBinding,
  bindDockerHostCustodyCreate,
  dockerHostCustodyAttemptKey,
  isInactiveDockerObservation,
  isRunningDockerObservation,
  sameDockerAuthority,
  type DockerHostCustodyContainerCreateInput,
} from "./docker-host-custody-lifecycle-guards.js";
import type {
  DockerCustodyAttemptKey,
  DockerCustodyJournalEvidence,
  DockerCustodyJournalLimits,
  DockerCustodyJournalRecord,
  DockerCustodyJournalStorage,
  DockerCustodyOwnerIdentity,
  DockerCustodyRecoveryObservation,
} from "./journal/docker-custody-journal-types.js";

export interface DockerHostCustodyJournalPort
  extends DockerCustodyJournalWriter, DockerCustodyJournalRecoveryReader {}

export interface DockerHostCustodyResiduePort {
  proveEmpty(authority: DockerContainerAuthority, call: DockerEngineCall): Promise<"empty" | "residue" | "unknown">;
}

/** Outer composition supplies launch facts only; the lifecycle derives and seals ownerIdentitySha256. */
export type DockerHostCustodyContainerCreate = DockerHostCustodyContainerCreateInput;

export interface DockerHostCustodyRecoveryResolver {
  resolve(key: DockerCustodyAttemptKey): Promise<Readonly<{
    /** Optional durable authority permits exact absence proof after a remove acknowledgement was lost. */
    authority?: DockerContainerAuthority;
    call: DockerEngineCall;
    create: DockerHostCustodyContainerCreate;
  }> | undefined>;
}

export interface DockerHostCustodyCompositionDependencies {
  readonly engine: DockerEnginePort;
  readonly journalLimits?: Partial<DockerCustodyJournalLimits>;
  readonly journalStorage: DockerCustodyJournalStorage;
  readonly residue: DockerHostCustodyResiduePort;
}

export type DockerHostCustodyRecovery =
  | { readonly journal: DockerCustodyRecoveryObservation; readonly kind: "journal_unproven"; readonly containment?: "closed" | "indeterminate" }
  | { readonly journal: DockerCustodyJournalRecord; readonly kind: "closed" }
  | {
    readonly journal: Extract<DockerCustodyRecoveryObservation, { readonly kind: "replayed" }>;
    readonly kind: "indeterminate";
    readonly reason: "authority_unavailable" | "engine_observation_unavailable" | "containment_unproven";
  };

export type DockerHostCustodyContainment =
  | Readonly<{ journal: DockerCustodyJournalRecord; kind: "closed" }>
  | Readonly<{ journal: DockerCustodyJournalRecord; kind: "indeterminate"; reason: "containment_unproven" }>
  | Readonly<{
      authority: DockerContainerAuthority;
      containment: "closed" | "indeterminate";
      kind: "indeterminate";
      reason: "journal_unavailable";
    }>
  | Readonly<{
      authority: DockerContainerAuthority;
      containment: "indeterminate";
      kind: "indeterminate";
      reason: "authority_mismatch" | "authority_unavailable";
    }>;

type DockerHostCustodyContainmentInput = Readonly<{
  authority: DockerContainerAuthority;
  call: DockerEngineCall;
  key: DockerCustodyAttemptKey;
}>;

const proved = Object.freeze({ status: "proved" as const });

const journalUnavailable = (error: unknown): boolean =>
  error instanceof DockerCustodyJournalUnavailableError || error instanceof DockerCustodyJournalCorruptionError;

/** Coordinates Docker effects only after their exact journal authority is durable. */
export class DockerHostCustodyLifecycle {
  /** Volatile exact binding permits safe cleanup after same-instance journal loss, but is not restart authority. */
  private readonly liveAuthorityBindings = new Map<string, string>();
  private readonly liveLaunches = new Map<string, DockerContainedTurnHostCustody>();

  private assertLaunchOpen(key: DockerCustodyAttemptKey, call: DockerEngineCall): void {
    const launch = this.liveLaunches.get(dockerCustodyAttemptLocator(key));
    if (launch === undefined) {throw new TypeError("Docker Host Custody live launch is unavailable");}
    launch.assertOpen(call);
  }

  public constructor(
    private readonly engine: DockerEnginePort,
    private readonly journal: DockerHostCustodyJournalPort,
    private readonly residue: DockerHostCustodyResiduePort,
    private readonly maxLiveAuthorityBindings = DEFAULT_DOCKER_CUSTODY_JOURNAL_LIMITS.maxJournalFiles,
  ) {}

  private holdAuthority(key: DockerCustodyAttemptKey, authority: DockerContainerAuthority): string {
    const locator = dockerCustodyAttemptLocator(key);
    const authoritySha256 = dockerCustodyAuthoritySha256(authority);
    if (!this.liveAuthorityBindings.has(locator) && this.liveAuthorityBindings.size >= this.maxLiveAuthorityBindings) {
      const oldest = this.liveAuthorityBindings.keys().next().value as string | undefined;
      if (oldest !== undefined) {this.liveAuthorityBindings.delete(oldest);}
    }
    this.liveAuthorityBindings.set(locator, authoritySha256);
    return authoritySha256;
  }

  public async launch(input: Readonly<{
    call: DockerEngineCall;
    create: DockerHostCustodyContainerCreate;
    owner: DockerCustodyOwnerIdentity;
  }>): Promise<Readonly<{
    authority: DockerContainerAuthority;
    journal: DockerCustodyJournalRecord;
    key: DockerCustodyAttemptKey;
    kind: "launched";
    openInitSession(options: DockerContainedTurnInitOptions): DockerContainedTurnInitSession;
  }>> {
    if (input.call.signal.aborted || Date.now() >= input.call.deadlineEpochMs) {
      throw new TypeError("Docker Host Custody launch call is closed");
    }
    const engineIdentity = await this.engine.identity(input.call);
    const key = dockerHostCustodyAttemptKey(input.owner, input.create, engineIdentity);
    const locator = dockerCustodyAttemptLocator(key);
    if (this.liveLaunches.has(locator) || this.liveLaunches.size >= this.maxLiveAuthorityBindings) {
      throw new TypeError("Docker Host Custody requires unused launch capacity");
    }
    const live = new DockerContainedTurnHostCustody();
    this.liveLaunches.set(locator, live);
    try {
      this.assertLaunchOpen(key, input.call);
      const create = bindDockerHostCustodyCreate(key, input.create);
      const prepared = await this.journal.prepare(key);
      this.assertLaunchOpen(key, input.call);
      if (prepared.state !== "prepared" || prepared.sequence !== 0) {
        throw new TypeError("Docker Host Custody launch requires fresh prepared authority");
      }
      const confirmedEngineIdentity = await this.engine.identity(input.call);
      this.assertLaunchOpen(key, input.call);
      assertDockerEngineBinding(key, confirmedEngineIdentity);
      await this.journal.beforeAction({ key, expectedSequence: prepared.sequence, state: "create_requested" });
      this.assertLaunchOpen(key, input.call);
      const authority = await this.engine.create(create, input.call, confirmedEngineIdentity);
      assertDockerAuthorityBinding(key, authority);
      const authoritySha256 = this.holdAuthority(key, authority);
      this.assertLaunchOpen(key, input.call);
      const created = await this.journal.observe({
        authoritySha256, key, expectedSequence: 1, state: "created", evidence: proved,
      });
      this.assertLaunchOpen(key, input.call);
      await this.journal.beforeAction({ key, expectedSequence: created.sequence, state: "init_start_requested" });
      this.assertLaunchOpen(key, input.call);
      live.retain(authority, await this.engine.attachCustody(authority, input.call));
      this.assertLaunchOpen(key, input.call);
      await this.engine.start(authority, input.call);
      this.assertLaunchOpen(key, input.call);
      const observation = await this.engine.inspect(authority, input.call);
      this.assertLaunchOpen(key, input.call);
      const journal = await this.journal.observe({
        key,
        expectedSequence: 3,
        state: "init_ready",
        evidence: isRunningDockerObservation(observation)
          ? proved
          : { status: "unproven", reason: "docker_observation_unavailable" },
      });
      this.assertLaunchOpen(key, input.call);
      if (!isRunningDockerObservation(observation)) {
        throw new TypeError("Docker Host Custody init readiness is unproven");
      }
      // V2 init_ready is a running-container observation, not authenticated protocol readiness.
      return Object.freeze({ authority, journal, key, kind: "launched" as const,
        openInitSession: (options: DockerContainedTurnInitOptions) => live.openInitSession(options, input.call),
      });
    } catch (error) {
      try {await live.close();} catch {}
      throw error;
    }
  }

  public async executeProvider(input: Readonly<{
    authority: DockerContainerAuthority;
    call: DockerEngineCall;
    exec: DockerCustodyInitHostExec;
    key: DockerCustodyAttemptKey;
  }>): Promise<DockerCustodyJournalRecord> {
    assertDockerAuthorityBinding(input.key, input.authority);
    this.assertLaunchOpen(input.key, input.call);
    const live = this.liveLaunches.get(dockerCustodyAttemptLocator(input.key))!;
    live.beginExecute(input.call);
    const current = await this.journal.lookup(input.key);
    this.assertLaunchOpen(input.key, input.call);
    if (this.authorityMatch(input.key, input.authority, current) !== "match") {
      throw new TypeError("Docker Host Custody provider execution requires exact created authority");
    }
    if (current.state !== "init_ready" || current.evidence.status !== "proved" ||
        !isRunningDockerObservation(await this.engine.inspect(input.authority, input.call))) {
      throw new TypeError("Docker Host Custody provider execution requires exact live init authority");
    }
    this.assertLaunchOpen(input.key, input.call);
    const requested = await this.journal.beforeAction({
      key: input.key,
      expectedSequence: current.sequence,
      state: "provider_exec_requested",
    });
    let evidence: DockerCustodyJournalEvidence;
    try {
      this.assertLaunchOpen(input.key, input.call);
      const observation = await this.engine.inspect(input.authority, input.call);
      this.assertLaunchOpen(input.key, input.call);
      if (!isRunningDockerObservation(observation)) {throw new TypeError("Docker init identity is no longer live");}
      const start = await live.execute(input.exec);
      this.assertLaunchOpen(input.key, input.call);
      evidence = start.kind === "started"
        ? proved
        : { status: "unproven", reason: "provider_execution_unproven" };
    } catch {
      evidence = { status: "unproven", reason: "provider_execution_unproven" };
    }
    return this.journal.observe({
      key: input.key,
      expectedSequence: requested.sequence,
      state: "provider_exec_observed",
      evidence,
    });
  }

  public async contain(input: DockerHostCustodyContainmentInput): Promise<DockerHostCustodyContainment> {
    assertDockerAuthorityBinding(input.key, input.authority);
    // Seal before the first await; a delayed exec-intent acknowledgement cannot reopen it.
    const live = this.liveLaunches.get(dockerCustodyAttemptLocator(input.key));
    if (live !== undefined && (live.owns(input.authority) || this.authorityMatch(input.key, input.authority) === "match")) {
      try {await live.close();} catch {}
    }
    for (let transition = 0; transition < 16; transition += 1) {
      let current: DockerCustodyJournalRecord;
      try {current = await this.journal.lookup(input.key);} catch (error) {
        if (!journalUnavailable(error)) {throw error;}
        const match = this.authorityMatch(input.key, input.authority);
        if (match !== "match") {return this.authorityIndeterminate(input.authority, match);}
        return Object.freeze({
          authority: input.authority,
          containment: await this.containWithoutJournal(input.authority, input.call),
          kind: "indeterminate" as const,
          reason: "journal_unavailable" as const,
        });
      }
      const match = this.authorityMatch(input.key, input.authority, current);
      if (match !== "match") {return this.authorityIndeterminate(input.authority, match);}
      try {
        const result = await this.advanceContainment(input, current);
        if (result !== null) {return result;}
      } catch (error) {
        if (error instanceof DockerCustodyJournalConflictError) {continue;}
        throw error;
      }
    }
    throw new TypeError("Docker Host Custody containment exceeded its bounded transition count");
  }

  private authorityMatch(
    key: DockerCustodyAttemptKey,
    authority: DockerContainerAuthority,
    journal?: DockerCustodyJournalRecord,
  ): "match" | "mismatch" | "unavailable" {
    const expected = journal?.authoritySha256 ?? this.liveAuthorityBindings.get(dockerCustodyAttemptLocator(key));
    if (expected === undefined || expected === null) {return "unavailable";}
    return expected === dockerCustodyAuthoritySha256(authority) ? "match" : "mismatch";
  }

  private authorityIndeterminate(
    authority: DockerContainerAuthority,
    match: "mismatch" | "unavailable",
  ): DockerHostCustodyContainment {
    return Object.freeze({
      authority,
      containment: "indeterminate" as const,
      kind: "indeterminate" as const,
      reason: match === "mismatch" ? "authority_mismatch" as const : "authority_unavailable" as const,
    });
  }

  private async advanceContainment(
    input: DockerHostCustodyContainmentInput,
    current: DockerCustodyJournalRecord,
  ): Promise<DockerHostCustodyContainment | null> {
    switch (current.state) {
      case "closed": return Object.freeze({ journal: current, kind: "closed" as const });
      case "prepared": {
        const closed = await this.journal.observe({
          key: input.key, expectedSequence: current.sequence, state: "closed", evidence: proved,
        });
        return Object.freeze({ journal: closed, kind: "closed" as const });
      }
      case "create_requested": return this.containCreatedRequest(input, current);
      case "created":
      case "init_start_requested":
      case "init_ready":
      case "provider_exec_requested":
      case "provider_exec_observed":
        await this.journal.beforeAction({
          key: input.key, expectedSequence: current.sequence, state: "contain_requested",
        });
        return null;
      case "empty_observed":
        await this.journal.beforeAction({
          key: input.key,
          expectedSequence: current.sequence,
          state: current.evidence.status === "proved" ? "remove_requested" : "contain_requested",
        });
        return null;
      case "removed_observed":
        if (current.evidence.status !== "proved") {
          await this.journal.beforeAction({
            key: input.key, expectedSequence: current.sequence, state: "contain_requested",
          });
          return null;
        }
        return Object.freeze({
          journal: await this.journal.observe({
            key: input.key, expectedSequence: current.sequence, state: "closed", evidence: proved,
          }),
          kind: "closed" as const,
        });
      case "contain_requested": return this.recordEmptyObservation(input, current);
      case "remove_requested": return this.recordRemovedObservation(input, current);
    }
  }

  private async containCreatedRequest(
    input: DockerHostCustodyContainmentInput,
    current: DockerCustodyJournalRecord,
  ): Promise<DockerHostCustodyContainment | null> {
    let observation: DockerContainerObservation;
    try {observation = await this.engine.inspect(input.authority, input.call);} catch {
      return Object.freeze({ journal: current, kind: "indeterminate" as const, reason: "containment_unproven" as const });
    }
    if (observation.existence === "present") {
      await this.journal.observe({
        authoritySha256: dockerCustodyAuthoritySha256(input.authority),
        key: input.key, expectedSequence: current.sequence, state: "created", evidence: proved,
      });
      return null;
    }
    const empty = await this.residue.proveEmpty(input.authority, input.call).catch(() => "unknown" as const);
    if (empty !== "empty") {return Object.freeze({ journal: current, kind: "indeterminate" as const, reason: "containment_unproven" as const });}
    const closed = await this.journal.observe({
      key: input.key, expectedSequence: current.sequence, state: "closed", evidence: proved,
    });
    return Object.freeze({ journal: closed, kind: "closed" as const });
  }

  private async recordEmptyObservation(
    input: DockerHostCustodyContainmentInput,
    current: DockerCustodyJournalRecord,
  ): Promise<DockerHostCustodyContainment | null> {
    const contained = await this.observeEmpty(input.authority, input.call);
    const emptyRecord = await this.journal.observe({
      key: input.key,
      expectedSequence: current.sequence,
      state: "empty_observed",
      evidence: contained === "empty"
        ? proved
        : { status: "unproven", reason: contained === "residue" ? "empty_custody_unproven" : "containment_unproven" },
    });
    return contained === "empty"
      ? null
      : Object.freeze({ journal: emptyRecord, kind: "indeterminate" as const, reason: "containment_unproven" as const });
  }

  private async recordRemovedObservation(
    input: DockerHostCustodyContainmentInput,
    current: DockerCustodyJournalRecord,
  ): Promise<DockerHostCustodyContainment | null> {
    const removalProved = await this.observeRemoved(input.authority, input.call);
    const removedRecord = await this.journal.observe({
      key: input.key,
      expectedSequence: current.sequence,
      state: "removed_observed",
      evidence: removalProved ? proved : { status: "unproven", reason: "removal_unproven" },
    });
    return removalProved
      ? null
      : Object.freeze({ journal: removedRecord, kind: "indeterminate" as const, reason: "containment_unproven" as const });
  }

  private async observeEmpty(
    authority: DockerContainerAuthority,
    call: DockerEngineCall,
  ): Promise<"empty" | "residue" | "unknown"> {
    let observation = await this.engine.inspect(authority, call).catch(() => null);
    if (observation?.existence === "present" && observation.state.running) {
      try {await this.engine.stop(authority, call);} catch {
        try {await this.engine.kill(authority, call);} catch {}
      }
      observation = await this.engine.inspect(authority, call).catch(() => null);
    }
    if (observation === null || !isInactiveDockerObservation(observation)) {return "unknown";}
    return this.residue.proveEmpty(authority, call).catch(() => "unknown" as const);
  }

  private async observeRemoved(authority: DockerContainerAuthority, call: DockerEngineCall): Promise<boolean> {
    let observation = await this.engine.inspect(authority, call).catch(() => null);
    if (observation?.existence === "present") {
      try {await this.engine.remove(authority, call);} catch {}
      observation = await this.engine.inspect(authority, call).catch(() => null);
    }
    return observation?.existence === "absent";
  }

  private async resolveAuthority(
    key: DockerCustodyAttemptKey,
    resolved: Awaited<ReturnType<DockerHostCustodyRecoveryResolver["resolve"]>>,
    journal?: DockerCustodyJournalRecord,
  ): Promise<DockerContainerAuthority | undefined> {
    if (resolved === undefined) {return undefined;}
    const create = bindDockerHostCustodyCreate(key, resolved.create);
    if (resolved.authority !== undefined) {
      assertDockerAuthorityBinding(key, resolved.authority);
      let canonical: DockerContainerAuthority;
      try {canonical = await this.engine.reconcileCreate(create, resolved.call);} catch {
        if (this.authorityMatch(key, resolved.authority, journal) !== "match") {return undefined;}
        try {
          return (await this.engine.inspect(resolved.authority, resolved.call)).existence === "absent"
            ? resolved.authority
            : undefined;
        } catch {return undefined;}
      }
      if (!sameDockerAuthority(canonical, resolved.authority)) {return undefined;}
      this.holdAuthority(key, resolved.authority);
      return resolved.authority;
    }
    try {
      const authority = await this.engine.reconcileCreate(create, resolved.call);
      assertDockerAuthorityBinding(key, authority);
      this.holdAuthority(key, authority);
      return authority;
    } catch {
      return undefined;
    }
  }

  private async containWithoutJournal(
    authority: DockerContainerAuthority,
    call: DockerEngineCall,
  ): Promise<"closed" | "indeterminate"> {
    if (await this.observeEmpty(authority, call) !== "empty") {return "indeterminate";}
    return await this.observeRemoved(authority, call) ? "closed" : "indeterminate";
  }

  public async recover(resolver: DockerHostCustodyRecoveryResolver): Promise<readonly DockerHostCustodyRecovery[]> {
    const recovered = await this.journal.recover();
    const observations: DockerHostCustodyRecovery[] = [];
    for (const journal of recovered) {
      if (journal.kind === "unproven") {
        const last = journal.lastValidRecord;
        if (last === undefined || last.state === "prepared" || last.state === "closed") {
          observations.push({ journal, kind: "journal_unproven" });
          continue;
        }
        const resolved = await resolver.resolve(last.attemptKey);
        const authority = await this.resolveAuthority(last.attemptKey, resolved, last);
        if (resolved === undefined || authority === undefined) {
          observations.push({ journal, kind: "journal_unproven", containment: "indeterminate" });
          continue;
        }
        observations.push({
          journal,
          kind: "journal_unproven",
          containment: await this.containWithoutJournal(authority, resolved.call),
        });
        continue;
      }
      let current: DockerCustodyJournalRecord;
      try {current = await this.journal.lookup(journal.attemptKey);} catch (error) {
        if (!journalUnavailable(error)) {throw error;}
        observations.push({ journal, kind: "journal_unproven" });
        continue;
      }
      if (current.state === "closed") {
        observations.push({ journal: current, kind: "closed" });
        continue;
      }
      if (current.state === "prepared") {
        const closed = await this.journal.observe({
          key: journal.attemptKey, expectedSequence: current.sequence, state: "closed", evidence: proved,
        });
        observations.push({ journal: closed, kind: "closed" });
        continue;
      }
      const resolved = await resolver.resolve(journal.attemptKey);
      if (resolved === undefined) {
        observations.push({ journal, kind: "indeterminate", reason: "authority_unavailable" });
        continue;
      }
      const authority = await this.resolveAuthority(journal.attemptKey, resolved, current);
      if (authority === undefined) {
        observations.push({ journal, kind: "indeterminate", reason: "engine_observation_unavailable" });
        continue;
      }
      const containment = await this.contain({ authority, call: resolved.call, key: journal.attemptKey });
      if (containment.kind === "closed") {
        observations.push({ journal: containment.journal, kind: "closed" });
      } else {
        observations.push({ journal, kind: "indeterminate", reason: "containment_unproven" });
      }
    }
    return Object.freeze(observations);
  }

  public async retire(input: Readonly<{
    expectedChecksumSha256: string;
    key: DockerCustodyAttemptKey;
  }>): Promise<void> {
    await this.journal.retire(input);
    this.liveAuthorityBindings.delete(dockerCustodyAttemptLocator(input.key));
    this.liveLaunches.delete(dockerCustodyAttemptLocator(input.key));
  }
}

/** The exact Host-owned API: launch returns the durable key consumed by execute, contain, recover, and retire. */
export const createDockerHostCustodyLifecycle = (
  dependencies: DockerHostCustodyCompositionDependencies,
): DockerHostCustodyLifecycle => new DockerHostCustodyLifecycle(
  dependencies.engine,
  new DockerCustodyJournal(dependencies.journalStorage, dependencies.journalLimits),
  dependencies.residue,
  dependencies.journalLimits?.maxJournalFiles ?? DEFAULT_DOCKER_CUSTODY_JOURNAL_LIMITS.maxJournalFiles,
);
