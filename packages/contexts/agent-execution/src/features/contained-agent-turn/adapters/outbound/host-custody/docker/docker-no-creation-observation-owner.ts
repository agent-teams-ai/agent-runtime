import type {DockerEngineCall, DockerEnginePort} from "./engine/docker-engine-port.js";
import {snapshotDockerEngineCall, awaitNetworkCleanupWork} from "./engine/docker-engine-composition.js";
import {assertDockerEngineBinding} from "./docker-host-custody-lifecycle-guards.js";
import {canonicalDockerCustodyJson, createDockerCustodyRecord, dockerCustodyAttemptLocator,
  validateDockerCustodyAttemptKey} from "./journal/docker-custody-journal-codec.js";
import type {DockerCustodyJournalWriter} from "./journal/docker-custody-journal.js";
import type {DockerCustodyAttemptKey} from "./journal/docker-custody-journal-types.js";

export type DockerNoCreationInput = Readonly<{key: DockerCustodyAttemptKey; call: DockerEngineCall}>;
export type DockerNoCreationObservation = Readonly<{
  attemptKey: DockerCustodyAttemptKey;
  journalChecksumSha256: string;
}>;
type Slot = {
  work: Promise<null> | undefined;
  token: object | undefined;
};

const live = (call: DockerEngineCall): boolean =>
  !call.signal.aborted && Date.now() < call.deadlineEpochMs;
const check = (call: DockerEngineCall): void => {
  if (!live(call)) {throw new TypeError("No-creation observation expired");}
};

/** Synchronous lifecycle fencing only; durable proof remains separately required. */
export const sealDockerNoCreationAttempt = (key: DockerCustodyAttemptKey, state: Readonly<{
  liveLaunches: ReadonlyMap<string, unknown>; launchAttempts: ReadonlyMap<string, string>;
  retainedAuthority: unknown; failedBeforeCreate: Set<string>; maximum: number;
}>): boolean => {
  const locator = dockerCustodyAttemptLocator(key);
  const attemptFence = JSON.stringify([key.tenantId, key.projectId, key.operationId, key.attemptId]);
  if (state.liveLaunches.has(locator) || [...state.launchAttempts.values()].includes(attemptFence) ||
      state.retainedAuthority !== undefined) {return false;}
  const additions = Number(!state.failedBeforeCreate.has(locator)) + Number(!state.failedBeforeCreate.has(attemptFence));
  if (state.failedBeforeCreate.size + additions > state.maximum * 2) {return false;}
  // A launch suspended in its initial identity read must see these fences
  // when it resumes. Other lifecycle instances must win the journal CAS
  // before they can issue create; closing prepared removes that authority.
  state.failedBeforeCreate.add(locator);
  state.failedBeforeCreate.add(attemptFence);
  return true;
};

/** Adapter-private lifecycle companion. Its seal is supplied by the actual
 * lifecycle, synchronously, before identity or journal work can yield.
 * Slots and fences are never evicted to admit another attempt. */
export const createDockerNoCreationObservationOwner = (
  engine: Pick<DockerEnginePort, "identity">,
  journal: Pick<DockerCustodyJournalWriter, "prepare" | "observe">,
  seal: (key: DockerCustodyAttemptKey) => boolean,
  maximum: number,
) => {
  if (!Number.isSafeInteger(maximum) || maximum < 1) {throw new TypeError("Invalid no-creation capacity");}
  const identity = engine.identity.bind(engine);
  const prepare = journal.prepare.bind(journal);
  const observe = journal.observe.bind(journal);
  const slots = new Map<string, Slot>();
  const observations = new WeakMap<object, DockerNoCreationObservation>();
  const prove = async (key: DockerCustodyAttemptKey, call: DockerEngineCall, slot: Slot): Promise<void> => {
    check(call);
    assertDockerEngineBinding(key, await identity(call));
    check(call);
    const prepared = createDockerCustodyRecord({attemptKey: key, sequence: 0,
      state: "prepared", evidence: {status: "proved"}, previousChecksumSha256: null});
    const closed = createDockerCustodyRecord({attemptKey: key, sequence: 1,
      state: "closed", evidence: {status: "proved"}, previousChecksumSha256: prepared.checksumSha256});
    let current = await prepare(key);
    check(call);
    if (canonicalDockerCustodyJson(current) === canonicalDockerCustodyJson(prepared)) {
      current = await observe({key, expectedSequence: 0, state: "closed", evidence: {status: "proved"}});
    }
    // prepare replays the complete durable chain. This exact sequence-one
    // checksum proves prepared->closed, including after a lost append ack.
    // create_requested->closed and every real-create history differ.
    if (canonicalDockerCustodyJson(current) !== canonicalDockerCustodyJson(closed)) {
      throw new TypeError("No-creation durable history is unproven");
    }
    check(call);
    const token = Object.freeze({});
    observations.set(token, Object.freeze({attemptKey: key, journalChecksumSha256: closed.checksumSha256}));
    slot.token = token;
  };
  return Object.freeze({
    async observeNoCreation(input: DockerNoCreationInput): Promise<object | undefined> {
      try {
        const key = validateDockerCustodyAttemptKey(input.key);
        const invocation = snapshotDockerEngineCall(input.call);
        check(invocation);
        const exact = canonicalDockerCustodyJson(key);
        let slot = slots.get(exact);
        if (slot === undefined) {
          if (slots.size >= maximum || !seal(key)) {return undefined;}
          slot = {work: undefined, token: undefined};
          slots.set(exact, slot);
        }
        const call = invocation;
        check(call);
        if (slot.token !== undefined) {return slot.token;}
        const retained = slot;
        retained.work ??= prove(key, call, retained).then(
          () => {retained.work = undefined; return null;},
          () => {retained.work = undefined; return null;},
        );
        // A timed-out waiter cannot clear a pending journal mutation or start
        // another flight. The pending work retains its original call; a later settled retry
        // may read durable closure under a new bounded call.
        await awaitNetworkCleanupWork(retained.work, call);
        return live(call) ? retained.token : undefined;
      } catch {return undefined;}
    },
    readNoCreationObservation(token: object): DockerNoCreationObservation | undefined {
      return observations.get(token);
    },
  });
};
