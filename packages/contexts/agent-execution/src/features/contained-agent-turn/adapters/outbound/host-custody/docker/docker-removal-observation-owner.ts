import type { DockerContainerAuthority, DockerEngineCall, DockerEnginePort } from "./engine/docker-engine-port.js";
import type {createDockerNoCreationObservationOwner, DockerNoCreationInput,
  DockerNoCreationObservation} from "./docker-no-creation-observation-owner.js";
import { assertDockerAuthorityBinding, assertDockerEngineBinding, sameDockerAuthority } from "./docker-host-custody-lifecycle-guards.js";
import { canonicalDockerCustodyJson, dockerCustodyAuthoritySha256, validateDockerCustodyAttemptKey } from "./journal/docker-custody-journal-codec.js";
import type { DockerCustodyAttemptKey, DockerCustodyJournalRecord } from "./journal/docker-custody-journal-types.js";

export type DockerHostCustodyContainmentInput = Readonly<{
  authority: DockerContainerAuthority;
  call: DockerEngineCall;
  key: DockerCustodyAttemptKey;
}>;

export type DockerRemovalObservation = Readonly<{
  attemptKey: DockerCustodyAttemptKey;
  authority: DockerContainerAuthority;
  journalChecksumSha256: string;
}>;

type Contain = (input: DockerHostCustodyContainmentInput) => Promise<Readonly<{
  kind: string;
  journal?: DockerCustodyJournalRecord;
}>>;

/**
 * Private lifecycle-owned evidence for later listener/network release. Creation
 * is inert. Only containAndObserve performs effects, using the existing durable
 * containment path before a fresh exact Engine absence observation. A caller's
 * boolean, receipt copy or another owner's token cannot stand in for that call.
 * This proves historical absence of this full container/daemon/boot generation;
 * it does not prove listener/socket closure or confer dispatch authority.
 */
export const createDockerRemovalObservationOwner = (engine: Pick<DockerEnginePort, "inspect">, contain: Contain,
  noCreation?: ReturnType<typeof createDockerNoCreationObservationOwner>) => {
  const inspect = engine.inspect.bind(engine);
  const observations = new WeakMap<object, DockerRemovalObservation>();
  return Object.freeze({
    /** Only the lifecycle's sealed, durable no-create path can issue this token. */
    async observeNoCreation(input: DockerNoCreationInput): Promise<object | undefined> {
      return noCreation?.observeNoCreation(input);
    },
    readNoCreationObservation(token: object): DockerNoCreationObservation | undefined {
      return noCreation?.readNoCreationObservation(token);
    },
    async containAndObserve(input: DockerHostCustodyContainmentInput): Promise<object | undefined> {
      try {
        const key = validateDockerCustodyAttemptKey(input.key);
        // Validate the original data-only shape before detaching caller storage.
        const authoritySha256 = dockerCustodyAuthoritySha256(input.authority);
        const authority = Object.freeze({...input.authority});
        assertDockerAuthorityBinding(key, authority);
        const call = Object.freeze({deadlineEpochMs: input.call.deadlineEpochMs, signal: input.call.signal});
        const live = (): boolean => !call.signal.aborted && Number.isSafeInteger(call.deadlineEpochMs)
          && Date.now() < call.deadlineEpochMs;
        if (!live()) {return undefined;}
        const closed = await contain(Object.freeze({key, authority, call}));
        const journal = closed.journal;
        if (!live() || closed.kind !== "closed" || journal === undefined || journal.state !== "closed"
          || journal.evidence.status !== "proved" || journal.authoritySha256 !== authoritySha256
          || canonicalDockerCustodyJson(validateDockerCustodyAttemptKey(journal.attemptKey)) !== canonicalDockerCustodyJson(key)
          || !/^[a-f0-9]{64}$/u.test(journal.checksumSha256)) {return undefined;}
        const journalChecksumSha256 = journal.checksumSha256;
        const observed = await inspect(authority, call);
        if (!live() || observed.existence !== "absent" || !sameDockerAuthority(authority, observed.authority)) {
          return undefined;
        }
        assertDockerEngineBinding(key, observed.engine);
        const token = Object.freeze({});
        observations.set(token, Object.freeze({attemptKey: key, authority, journalChecksumSha256}));
        return token;
      } catch {
        // Unknown containment, identity, journal or inspection has no release proof.
        return undefined;
      }
    },
    readObservation(token: object): DockerRemovalObservation | undefined {return observations.get(token);},
  });
};
