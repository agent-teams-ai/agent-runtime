import type {DockerCustodyInitHostExec, DockerCustodyInitHostStart} from "./init/docker-custody-init-host-session.js";
import type {DockerContainedTurnHostCustody} from "./docker-contained-turn-host-custody.js";
import type {DockerHostCustodyJournalPort} from "./docker-host-custody-lifecycle.js";
import {sameDockerAuthority} from "./docker-host-custody-lifecycle-guards.js";
import type {DockerContainerAuthority, DockerContainerObservation, DockerContainerStateFacts} from "./engine/docker-engine-port.js";
import {DockerCustodyJournal} from "./journal/docker-custody-journal.js";
import {dockerCustodyAttemptLocator, dockerCustodyAuthoritySha256, dockerCustodyOwnerIdentitySha256} from "./journal/docker-custody-journal-codec.js";
import {DockerCustodyJournalConflictError, type DockerCustodyAttemptKey, type DockerCustodyJournalLimits,
  type DockerCustodyJournalRecord, type DockerCustodyJournalStorage} from "./journal/docker-custody-journal-types.js";

type Present = Extract<DockerContainerObservation, {existence: "present"}>;
type Absent = Extract<DockerContainerObservation, {existence: "absent"}>;
export interface DockerLifecycleObservation {
  readonly authority: DockerContainerAuthority;
  readonly key: DockerCustodyAttemptKey;
  readonly journal: DockerCustodyJournalRecord;
  readonly initial: Present;
  readonly execution: Readonly<{exec: DockerCustodyInitHostExec; result: DockerCustodyInitHostStart | null;
    journal: DockerCustodyJournalRecord | null; settled: boolean}> | null;
  readonly terminal: Readonly<{observation: Present; journal: DockerCustodyJournalRecord}> | null;
  readonly recursiveEmpty: Readonly<{journal: DockerCustodyJournalRecord}> | null;
  readonly removal: Readonly<{observation: Absent; journal: DockerCustodyJournalRecord}> | null;
  readonly attachCleanup: "pending" | "complete";
  readonly retired: boolean;
}

interface Retained {
  snapshot: DockerLifecycleObservation;
  readonly live: DockerContainedTurnHostCustody;
}

const freezeJournal = (record: DockerCustodyJournalRecord): DockerCustodyJournalRecord => Object.freeze({
  ...record, attemptKey: Object.freeze({...record.attemptKey}), evidence: Object.freeze({...record.evidence}),
});
const freezePresent = (observation: Present): Present => Object.freeze({...observation,
  authority: Object.freeze({...observation.authority}), engine: Object.freeze({...observation.engine}),
  resources: Object.freeze({...observation.resources}), state: Object.freeze({...observation.state}),
});

/** RFC3339 nanoseconds, rejecting Docker's zero sentinel and normalized invalid calendar dates. */
const timestamp = (value: string): bigint | null => {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$/.exec(value);
  if (match === null) {return null;}
  const calendar = Date.parse(`${match[1]}Z`);
  const milliseconds = Date.parse(`${match[1]}${match[3]}`);
  if (!Number.isFinite(calendar) || !Number.isFinite(milliseconds) || milliseconds <= 0 ||
      !new Date(calendar).toISOString().startsWith(match[1]!)) {return null;}
  return BigInt(milliseconds) * 1_000_000n + BigInt((match[2] ?? "").padEnd(9, "0"));
};

const terminal = (state: DockerContainerStateFacts): boolean => {
  const started = timestamp(state.startedAt); const finished = timestamp(state.finishedAt);
  return !state.running && !state.paused && !state.restarting && state.hostPid === 0 &&
    (state.status === "exited" || state.status === "dead") && Number.isSafeInteger(state.exitCode) && state.exitCode >= 0 &&
    started !== null && finished !== null && finished >= started;
};

/** Volatile evidence only. No Engine effects, journal authority, reader, or operation closure predicate. */
export class DockerLifecycleObservations {
  readonly #issued = new WeakMap<object, Retained>();
  // Entries share the lifecycle's bounded live-launch capacity and are removed only on successful retirement.
  readonly #active = new Map<string, Retained>();

  public issue(launch: object, binding: Readonly<{authority: DockerContainerAuthority; journal: DockerCustodyJournalRecord;
    key: DockerCustodyAttemptKey}>, live: DockerContainedTurnHostCustody, initial: DockerContainerObservation): void {
    if (initial.existence !== "present") {throw new TypeError("Docker observation launch requires present init");}
    const authority = Object.freeze({...binding.authority});
    const digest = dockerCustodyAuthoritySha256(authority);
    if (this.#issued.has(launch) || this.#active.has(digest)) {throw new TypeError("Docker observation launch already issued");}
    const retained: Retained = {live, snapshot: Object.freeze({authority, key: Object.freeze({...binding.key}),
      journal: freezeJournal(binding.journal), initial: freezePresent(initial), execution: null, terminal: null, recursiveEmpty: null, removal: null,
      attachCleanup: "pending", retired: false})};
    this.#issued.set(launch, retained); this.#active.set(digest, retained);
  }

  public read(launch: object): DockerLifecycleObservation {
    const retained = this.#issued.get(launch);
    if (retained === undefined) {throw new TypeError("Docker observation requires this lifecycle's actual issued launch");}
    return Object.freeze({...retained.snapshot, attachCleanup: retained.live.cleanupComplete ? "complete" : "pending"});
  }

  public execution(authority: DockerContainerAuthority, exec: DockerCustodyInitHostExec,
    result: DockerCustodyInitHostStart | null, journal: DockerCustodyJournalRecord | null, settled = false): void {
    const retained = this.#active.get(dockerCustodyAuthoritySha256(authority));
    if (retained === undefined) {return;}
    retained.snapshot = Object.freeze({...retained.snapshot, execution: Object.freeze({
      exec: Object.freeze({...exec, argv: Object.freeze([...exec.argv]),
        environment: Object.freeze(exec.environment.map(item => Object.freeze({...item})))}),
      result: result === null ? null : Object.freeze({...result}),
      journal: journal === null ? null : freezeJournal(journal), settled,
    })});
  }

  public engine(authority: DockerContainerAuthority, observation: DockerContainerObservation): DockerContainerObservation {
    if (!sameDockerAuthority(authority, observation.authority) ||
        authority.daemonIdentitySha256 !== observation.engine.daemonIdentitySha256 ||
        authority.daemonBootGenerationSha256 !== observation.engine.daemonBootGenerationSha256 ||
        authority.hostIdentitySha256 !== observation.engine.hostIdentitySha256 ||
        authority.hostBootGenerationSha256 !== observation.engine.hostBootGenerationSha256) {
      throw new TypeError("Docker lifecycle observation conflicts with exact Engine authority");
    }
    const retained = this.#active.get(dockerCustodyAuthoritySha256(authority));
    if (retained !== undefined && retained.snapshot.terminal === null && observation.existence === "present" && terminal(observation.state)) {
      const exact = freezePresent(observation);
      retained.snapshot = Object.freeze({...retained.snapshot, terminal: Object.freeze({observation: exact, journal: retained.snapshot.journal})});
    }
    return observation;
  }

  public empty(authority: DockerContainerAuthority, result: "empty" | "residue" | "unknown"): void {
    const retained = this.#active.get(dockerCustodyAuthoritySha256(authority));
    if (retained !== undefined && result === "empty" && retained.snapshot.recursiveEmpty === null) {
      retained.snapshot = Object.freeze({...retained.snapshot, recursiveEmpty: Object.freeze({journal: retained.snapshot.journal})});
    }
  }

  public removed(observation: DockerContainerObservation | null): void {
    if (observation?.existence !== "absent") {return;}
    const retained = this.#active.get(dockerCustodyAuthoritySha256(observation.authority));
    if (retained === undefined || retained.snapshot.removal !== null) {return;}
    const exact = Object.freeze({...observation, authority: Object.freeze({...observation.authority}), engine: Object.freeze({...observation.engine})});
    retained.snapshot = Object.freeze({...retained.snapshot, removal: Object.freeze({observation: exact, journal: retained.snapshot.journal})});
  }

  private record(record: DockerCustodyJournalRecord): DockerCustodyJournalRecord {
    const retained = record.authoritySha256 === null ? undefined : this.#active.get(record.authoritySha256);
    if (retained !== undefined && dockerCustodyOwnerIdentitySha256(record.attemptKey) === retained.snapshot.authority.ownerIdentitySha256 &&
        record.sequence >= retained.snapshot.journal.sequence) {
      retained.snapshot = Object.freeze({...retained.snapshot, journal: freezeJournal(record)});
    }
    return record;
  }

  public journal(owner: DockerHostCustodyJournalPort): DockerHostCustodyJournalPort {
    return {
      prepare: async key => this.record(await owner.prepare(key)),
      lookup: async key => this.record(await owner.lookup(key)),
      beforeAction: async input => this.record(await owner.beforeAction(input)),
      observe: async input => this.record(await owner.observe(input)),
      recover: () => owner.recover(),
      retire: async input => {
        await owner.retire(input);
        for (const [digest, retained] of this.#active) {
          if (retained.snapshot.authority.ownerIdentitySha256 !== dockerCustodyOwnerIdentitySha256(input.key)) {continue;}
          retained.snapshot = Object.freeze({...retained.snapshot, retired: true}); this.#active.delete(digest);
        }
      },
    };
  }
}

/** Check the existing tombstone inside prepare's storage lock, including a coexisting journal. */
export const createDockerLifecycleJournal = (storage: DockerCustodyJournalStorage, limits?: Partial<DockerCustodyJournalLimits>): DockerHostCustodyJournalPort => {
  const journal = new DockerCustodyJournal(storage, limits);
  return {
    prepare: key => {
      const locator = dockerCustodyAttemptLocator(key);
      return new DockerCustodyJournal({
        exclusive: operation => storage.exclusive(async () => {
          const retirement = await storage.openRetirement(locator);
          if (retirement !== undefined) {await retirement.close(); throw new DockerCustodyJournalConflictError("Docker launch identity is retired");}
          return operation();
        }),
        create: name => storage.create(name), open: name => storage.open(name),
        openRetirement: name => storage.openRetirement(name), retire: (name, receipt) => storage.retire(name, receipt),
        scan: limit => storage.scan(limit),
      }, limits).prepare(key);
    },
    lookup: key => journal.lookup(key), beforeAction: input => journal.beforeAction(input),
    observe: input => journal.observe(input), recover: () => journal.recover(), retire: input => journal.retire(input),
  };
};
