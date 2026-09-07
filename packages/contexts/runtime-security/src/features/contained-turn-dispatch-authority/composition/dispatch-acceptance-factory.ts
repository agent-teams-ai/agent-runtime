import type { DispatchAcceptanceStore, DispatchPolicyReadPort, DispatchPublicationRepository,
  DispatchAcceptanceIntent, DispatchAcceptedPreparation } from '../application/ports/outbound/dispatch-acceptance-owner.js';
import { isNodeDispatchProxy } from '../adapters/node-dispatch-proxy.js';
import { snapshotExactDispatchRecord } from '../domain/dispatch-exact-record.js';
import type { DispatchControlClock } from '../application/ports/outbound/control-clock.js';
import type { DispatchDigest } from '../application/ports/outbound/dispatch-digest.js';
import type { ConsumeForDispatchInput } from '../contracts/contained-turn-dispatch-authority-v1.js';
import { evaluateDispatchAcceptance } from '../application/dispatch-acceptance.js';
import { publishAndConsumeForDispatch } from '../application/publish-dispatch-authority.js';
import { createContainedTurnDispatchAuthorityFeature } from './feature-module-factory.js';
import { detachDispatchBoundaryValue, exactOwnerMethods } from './node-dispatch-boundary.js';

export interface DispatchAcceptanceDependencies {
  readonly decisions: DispatchAcceptanceStore;
  readonly policy: DispatchPolicyReadPort;
  readonly repository: DispatchPublicationRepository;
  readonly clock: DispatchControlClock;
  readonly digest: DispatchDigest;
}
const unavailable = () => Object.freeze({ status: 'indeterminate', reason: 'owner_unavailable' } as const);
/** Private owner factory. Construction performs no I/O. Ordinary handles must
 * never receive this capability or the deployment policy/store dependencies. */
export const createDispatchAcceptanceFeature = (dependencies: DispatchAcceptanceDependencies) => {
  if (isNodeDispatchProxy(dependencies)) {throw new TypeError('invalid acceptance dependencies');}
  const fields = snapshotExactDispatchRecord(dependencies, ['repository', 'decisions', 'policy', 'clock', 'digest']);
  if (fields === undefined) {throw new TypeError('invalid acceptance dependencies');}
  const deps = Object.freeze({
    repository: exactOwnerMethods(fields.repository, ['consumeAtomically', 'observe',
      'settleAtomically', 'readAuthority', 'replaceAuthority']),
    decisions: exactOwnerMethods(fields.decisions, ['read', 'retain']),
    policy: exactOwnerMethods(fields.policy, ['read']),
    clock: exactOwnerMethods(fields.clock, ['now']),
    digest: exactOwnerMethods(fields.digest, ['digestCanonical']),
  }) as unknown as DispatchAcceptanceDependencies;
  const publication: DispatchPublicationRepository = Object.freeze({ ...deps.repository,
    async readAuthority(key: Parameters<DispatchPublicationRepository['readAuthority']>[0]) {
      return detachDispatchBoundaryValue(await deps.repository.readAuthority(key)) as
        Awaited<ReturnType<DispatchPublicationRepository['readAuthority']>>;
    },
    async replaceAuthority(head: Parameters<DispatchPublicationRepository['replaceAuthority']>[0], version: string) {
      return detachDispatchBoundaryValue(await deps.repository.replaceAuthority(head, version)) as
        Awaited<ReturnType<DispatchPublicationRepository['replaceAuthority']>>;
    },
    async observe(key: Parameters<DispatchPublicationRepository['observe']>[0]) {
      const value = await deps.repository.observe(key);
      return value === undefined ? undefined : detachDispatchBoundaryValue(value) as typeof value;
    },
  });
  const dispatch = createContainedTurnDispatchAuthorityFeature({ repository: deps.repository,
    clock: deps.clock, digest: deps.digest }).dispatchAuthorityV1;
  const ops = {
    decisions: {
      async read(input: DispatchAcceptanceIntent) {
        const value = await deps.decisions.read(input);
        return value === undefined ? undefined : detachDispatchBoundaryValue(value) as NonNullable<typeof value>;
      },
      async retain(input: Parameters<DispatchAcceptanceStore['retain']>[0]) {
        return detachDispatchBoundaryValue(await deps.decisions.retain(input)) as typeof input;
      },
    },
    policy: { async read(input: DispatchAcceptanceIntent) {
      const value = await deps.policy.read(input);
      return value === undefined ? undefined : detachDispatchBoundaryValue(value) as NonNullable<typeof value>;
    } },
    now: () => deps.clock.now(), digestCanonical: (value: string) => deps.digest.digestCanonical(value),
  };
  return Object.freeze({
    async evaluateForAcceptance(value: DispatchAcceptanceIntent) {
      try {
        const input = detachDispatchBoundaryValue(value) as DispatchAcceptanceIntent;
        const decision = await evaluateDispatchAcceptance(input, ops);
        return decision === undefined ? Object.freeze({ status: 'denied' } as const) :
          Object.freeze({ status: 'allowed', decision } as const);
      } catch {return unavailable();}
    },
    async publishAndConsumeForDispatch(projection: DispatchAcceptedPreparation, value: ConsumeForDispatchInput) {
      try {
        const prepared = detachDispatchBoundaryValue(projection) as DispatchAcceptedPreparation;
        const input = detachDispatchBoundaryValue(value) as ConsumeForDispatchInput;
        return await publishAndConsumeForDispatch(prepared, input, ops, publication,
          dispatch.consumeForDispatch);
      } catch {return unavailable();}
    },
    observeDispatchConsumption: dispatch.observeDispatchConsumption,
    settleDispatchConsumption: dispatch.settleDispatchConsumption,
  });
};
