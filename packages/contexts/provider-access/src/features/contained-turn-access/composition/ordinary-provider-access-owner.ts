import { intrinsicMethod } from "../adapters/provider-access-data.js";
import { randomBytes, randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { createScope, type CloseReport, type Scope } from '@get-modular/resources';
import { OrdinaryPaUnavailable, type OrdinaryPaBinding, type OrdinaryPaGrant, type OrdinaryPaRetirement, type OrdinaryPaSnapshot } from '../contracts/ordinary-provider-access.js';
import { newOrdinaryPaGrant, snapshotOrdinaryPaBinding } from '../domain/ordinary-provider-access.js';
import type { OrdinaryPaGrantStore } from '../application/ports/outbound/ordinary-pa-grant-store.js';
import type { OrdinaryPaMaterializationStores, OrdinaryPaOperationMaterialization } from '../adapters/outbound/ordinary-pa-materialization-stores.js';
import type { OrdinaryCodexAuthCapture } from '../adapters/outbound/ordinary-codex-auth-contracts.js';
import { createOrdinaryPaStore, ordinaryPaDigest } from '../adapters/outbound/postgres/ordinary-pa-store.js';
import type { MaterializationPostgresPool } from '../adapters/outbound/postgres/materialization-postgres-transactions.js';
import { createPostgresMaterializationRepository } from '../adapters/outbound/postgres/materialization-postgres-repository.js';
import { createPostgresCredentialRenderingOwner } from './postgres-credential-rendering-owner.js';
import type { CredentialRenderingSelection } from '../adapters/outbound/credential-rendering-contracts.js';
import { createOrdinaryPaBroker } from '../adapters/outbound/ordinary-pa-broker.js';
import { createOrdinaryPaUpstream } from '../adapters/outbound/ordinary-pa-upstream.js';
import { createOrdinaryPaSecretGuard } from '../adapters/outbound/ordinary-pa-secret-guard.js';

function createCaptureDisposer(settledCaptures: WeakSet<OrdinaryCodexAuthCapture>) {
  const disposedCaptures = new WeakSet<OrdinaryCodexAuthCapture>();
  const captureDisposals = new WeakMap<OrdinaryCodexAuthCapture, Promise<void>>();
  return (capture: OrdinaryCodexAuthCapture): Promise<void> => {
    const pending = captureDisposals.get(capture);
    if (pending) {return pending;}
    const disposal = (async () => {
      if (disposedCaptures.has(capture)) {return;}
      const alreadySettled = settledCaptures.has(capture);
      capture.dispose(); await capture.settled;
      // Cancellation before settlement is not proof of completed helper cleanup.
      if (!alreadySettled) {capture.dispose();}
      disposedCaptures.add(capture);
    })().catch((error: unknown) => {captureDisposals.delete(capture); throw error;});
    captureDisposals.set(capture, disposal);
    return disposal;
  };
}

/** A child scope whose single cleanup retires the grant, so the domain retirement protocol stays in one entry. */
function ownGrant(scopes: Scope, grant: OrdinaryPaGrant): Scope {
  const scope = scopes.resources.child({ name: `grant:${grant.grantId}` });
  scope.resources.use({ async [Symbol.asyncDispose]() { await grant.retire(); } }, 'retire');
  return scope;
}
/** Never awaited: the child's close calls `retire()` again, which returns the cached promise. */
const releaseGrant = (scope: Scope | undefined): void => { if (scope !== undefined) { void scope.control.close(); } };
/** Retirements a closed grant scope still owes, as rejections for the dispose report. */
const grantDebts = (report: CloseReport): PromiseRejectedResult[] => report.debts.map((debt): PromiseRejectedResult =>
  ({ status: 'rejected', reason: debt.state === 'failed' ? debt.cause : new OrdinaryPaUnavailable() }));

type OrdinaryPaSecretSink = (operationId: string, tokens: readonly string[]) => boolean;
const assertSecretSink = (registerSecrets: unknown): OrdinaryPaSecretSink => {
  if (typeof registerSecrets !== 'function' || types.isAsyncFunction(registerSecrets)) { throw new OrdinaryPaUnavailable(); }
  return registerSecrets as OrdinaryPaSecretSink;
};
export interface OrdinaryProviderAccessOwnerOptions {
  readonly pool: MaterializationPostgresPool;
  /** Trusted ER/RS sink. Receives exactly one complete inventory before dispatch. */
  readonly registerSecrets: (operationId: string, tokens: readonly string[]) => boolean;
}
export interface OrdinaryProviderAccessOwnerPorts {
  readonly grants: OrdinaryPaGrantStore;
  /** Only while contained-turn materialization is alive; the grant store never touches those tables. */
  readonly materialization: OrdinaryPaMaterializationStores;
  /** Trusted ER/RS sink. Receives exactly one complete inventory before dispatch. */
  readonly registerSecrets: (operationId: string, tokens: readonly string[]) => boolean;
}
/**
 * Ordinary grant and credential authorities stay inside PA; Host borrows only closed capabilities.
 * The caller owns the lifetime of both stores and releases them after `dispose()` resolves.
 */
export function createOrdinaryProviderAccessOwner(ports: OrdinaryProviderAccessOwnerPorts) {
  const registerSecrets = assertSecretSink(ports.registerSecrets);
  const grantStore = ports.grants, grants = new Set<OrdinaryPaGrant>();
  const pendingConsumptions = new Map<OrdinaryCodexAuthCapture, Promise<void>>();
  const pendingCaptures = new Set<OrdinaryCodexAuthCapture>();
  const settledCaptures = new WeakSet<OrdinaryCodexAuthCapture>();
  const disposeCapture = createCaptureDisposer(settledCaptures);
  const grantScopes = createScope({ name: 'pa-grants', order: 'concurrent' }); // independent peers retire concurrently on dispose
  const ownerState = { disposed: false };
  let disposal: Promise<void> | undefined;
  const check = () => { if (ownerState.disposed) { throw new OrdinaryPaUnavailable(); } };
  return Object.freeze({
    observe: async (binding: OrdinaryPaBinding): Promise<OrdinaryPaSnapshot | undefined> => {try {return await grantStore.observe(binding);} catch {throw new OrdinaryPaUnavailable();}},
    async consume(input: OrdinaryPaBinding, capture: OrdinaryCodexAuthCapture, signal: AbortSignal): Promise<OrdinaryPaGrant> {
      const isAborted = () => signal.aborted;
      check();
      void capture.settled.then(() => settledCaptures.add(capture));
      let binding: OrdinaryPaBinding;
      try {binding = snapshotOrdinaryPaBinding(input);} catch {await disposeCapture(capture); throw new OrdinaryPaUnavailable();}
      if (isAborted() || pendingCaptures.has(capture) || grants.size + pendingCaptures.size >= 64) { await disposeCapture(capture); throw new OrdinaryPaUnavailable(); }
      pendingCaptures.add(capture);
      let complete!: () => void;
      pendingConsumptions.set(capture, new Promise<void>(resolve => {complete = resolve;}));
      try {
      let metadata: Awaited<ReturnType<OrdinaryCodexAuthCapture['capture']>>;
      let consumed: OrdinaryPaSnapshot;
      try {
        metadata = await capture.capture(); check();
        if (isAborted()) { throw new OrdinaryPaUnavailable(); }
        const candidate = newOrdinaryPaGrant(binding, { generation: metadata.generation, accountId: metadata.accountId, expiresAt: metadata.expiresAt },
          { now: Date.now(), newId: randomUUID, digest: ordinaryPaDigest });
        const inserted = await grantStore.insertGrant(candidate);
        // An unknown COMMIT throws out of insertGrant; either way no second grant is attempted.
        if (inserted.kind !== 'inserted') { throw new OrdinaryPaUnavailable(); }
        consumed = inserted.snapshot;
      } catch { await disposeCapture(capture); pendingCaptures.delete(capture); throw new OrdinaryPaUnavailable(); }
      pendingCaptures.delete(capture);
      const selection: CredentialRenderingSelection = Object.freeze({ operationRef: binding.operationId, recipe: 'codex-chatgpt',
        operationAbortSignal: signal, deadline: metadata.deadline,
        binding: Object.freeze({ accessRef: consumed.authority.grantId, availability: 'available', bindingRevision: 1,
          credentialBindingDigest: consumed.authority.authorityDigest, credentialBindingRef: metadata.captureRef,
          credentialGeneration: metadata.generation, projectId: binding.projectId, provider: 'codex',
          providerAccountRef: metadata.accountId, providerRouteRef: 'ordinary-codex-chatgpt-responses-v1', revocation: 'active',
          scopeDigest: ordinaryPaDigest(binding), tenantId: binding.tenantId }) });
      const guard = createOrdinaryPaSecretGuard();
      let rendering: OrdinaryPaOperationMaterialization | undefined;
      let broker: Awaited<ReturnType<typeof createOrdinaryPaBroker>> | undefined;
      let capability: Buffer | undefined;
      let brokerClosed = false, renderingDisposed = false, captureDisposed = false, guardDisposed = false, capabilityErased = false;
      const retirementState = { started: false };
      const retirementHasStarted = () => retirementState.started;
      let retired = false, settled = false;
      let construction: Promise<void> | undefined;
      let attempted = false, retiring: Promise<OrdinaryPaRetirement> | undefined, grantScope: Scope | undefined;
      const retire = (): Promise<OrdinaryPaRetirement> => {
        if (retiring) { return retiring; }
        retirementState.started = true;
        retiring = (async () => {
          await construction;
          const results = await Promise.allSettled([(async () => {
            if (!brokerClosed) {await broker?.close(); brokerClosed = true;}
          })()]);
          const actions = [
            async () => {if (!renderingDisposed) {rendering?.owner.dispose(); renderingDisposed = true;}},
            async () => {if (!captureDisposed) {await disposeCapture(capture); captureDisposed = true;}},
            async () => {if (!guardDisposed) {guard.dispose(); guardDisposed = true;}},
            async () => {if (!capabilityErased) {capability?.fill(0); capabilityErased = true;}},
          ];
          results.push(...await Promise.allSettled(actions.map(action => action())));
          const errors = results.filter(result => result.status === 'rejected').map((result): unknown => result.reason);
          if (errors.length > 0) {throw new AggregateError(errors, 'ORDINARY_PA_UNAVAILABLE', {cause: errors[0]});}
          await capture.settled;
          const retirement = await grantStore.retire(binding).catch(async () => {
            const observed = await grantStore.observe(binding);
            if (!observed || observed.retiredAt === null) { throw new OrdinaryPaUnavailable(); }
            return observed;
          });
          if (retirement.retiredAt === null) { throw new OrdinaryPaUnavailable(); }
          retired = true;
          if (settled) {grants.delete(grant); releaseGrant(grantScope);}
          return Object.freeze({ materializationId: retirement.materializationId, generation: retirement.generation, retiredAt: retirement.retiredAt });
        })().catch((error: unknown) => {retiring = undefined; throw error;}); return retiring;
      };
      const grant = Object.freeze<OrdinaryPaGrant>({ grantId: consumed.authority.grantId, expiresAt: consumed.authority.expiresAt, authority: consumed.authority,
        async materialize() {
          if (attempted || retirementState.started || isAborted() || performance.now() >= metadata.deadline) { throw new OrdinaryPaUnavailable(); }
          attempted = true;
          let constructed!: () => void;
          construction = new Promise<void>(resolve => {constructed = resolve;});
          try {
            try {
            check(); rendering = ports.materialization.forOperation(selection);
            if (await rendering.control.replaceBinding(selection.binding, 0) !== 1 || !rendering.control.materialAdmission) { throw new OrdinaryPaUnavailable(); }
            check(); if (retirementHasStarted()) {throw new OrdinaryPaUnavailable();}
            const random = randomBytes(32);
            try { capability = Buffer.alloc(64); capability.write(random.toString('hex'), 'ascii'); } finally { random.fill(0); }
            const local = capability.toString('ascii');
            capture.withCredentialOutputTokens(binding.operationId, tokens => {
              const inventory = Object.freeze([...tokens, local]);
              guard.install(inventory);
              const accepted: unknown = registerSecrets(binding.operationId, inventory);
              if (types.isPromise(accepted) && Object.getPrototypeOf(accepted) === Promise.prototype && Object.getOwnPropertyDescriptor(accepted, 'constructor') === undefined) {
                void intrinsicMethod(Promise.prototype, "then").call(accepted, () => {}, () => {});
              }
              return accepted === true;
            });
            capture.admit(selection, rendering.control.materialAdmission);
            broker = await createOrdinaryPaBroker({ binding, selection, renderer: rendering.owner, store: grantStore,
              upstream: createOrdinaryPaUpstream(), capability, secretGuard: guard });
            check();
            if (retirementHasStarted() || isAborted() || performance.now() >= metadata.deadline) { throw new OrdinaryPaUnavailable(); }
            return Object.freeze({ brokerEndpoint: broker.endpoint, materializationId: consumed.materializationId,
              generation: metadata.generation, environment: Object.freeze({ AR_ORDINARY_BROKER_CAPABILITY: local }) });
            } finally {constructed();}
          } catch { await retire(); throw new OrdinaryPaUnavailable(); }
        },
        retire,
        async settle(disposition) {
          const settlement = await grantStore.settle(binding, disposition, randomUUID()).catch(async () => {
            const observed = await grantStore.observe(binding);
            if (!observed || observed.disposition !== disposition) { throw new OrdinaryPaUnavailable(); }
            return observed;
          });
          if ((settlement.settlementReceiptId === null || settlement.settlementReceiptId === '') || !settlement.disposition) { throw new OrdinaryPaUnavailable(); }
          settled = true;
          if (retired) {grants.delete(grant); releaseGrant(grantScope);}
          return Object.freeze({ grantId: consumed.authority.grantId, ownerReceiptId: consumed.authority.ownerReceiptId,
            settlementReceiptId: settlement.settlementReceiptId, disposition: settlement.disposition });
        },
        admitCanonicalText: text => guard.check(text),
        admitArtifactBytes: bytes => guard.artifact(bytes),
      });
      // A closing owner never leaves a grant unowned.
      try { grantScope = ownGrant(grantScopes, grant); } catch { await grant.retire(); throw new OrdinaryPaUnavailable(); }
      grants.add(grant);
      if (ownerState.disposed || isAborted()) {await grant.retire(); throw new OrdinaryPaUnavailable();}
      return grant;
      } finally {complete(); pendingConsumptions.delete(capture);}
    },
    dispose(): Promise<void> {
      if (disposal) { return disposal; } ownerState.disposed = true;
      disposal = (async () => {
        const captures = [...new Set([...pendingCaptures, ...pendingConsumptions.keys()])];
        const results = await Promise.allSettled(captures.map(async capture => {await disposeCapture(capture); await capture.settled; await pendingConsumptions.get(capture); pendingCaptures.delete(capture);}));
        results.push(...grantDebts(await grantScopes.control.close())); // a later dispose retries only the failed grants
        const errors = results.filter(result => result.status === 'rejected').map((result): unknown => result.reason);
        if (errors.length > 0) {throw new AggregateError(errors, 'ORDINARY_PA_UNAVAILABLE', {cause: errors[0]});}
        grants.clear();
      })().catch((error: unknown) => {disposal = undefined; throw error;}); return disposal;

    },
  });
}

/** Postgres composition: the grant store and the per-operation materialization share the borrowed pool. */
export function createPostgresOrdinaryProviderAccessOwner(options: OrdinaryProviderAccessOwnerOptions) {
  const registerSecrets = assertSecretSink(options.registerSecrets);
  const pool = options.pool, store = createOrdinaryPaStore(pool);
  const materialization: OrdinaryPaMaterializationStores = Object.freeze({
    forOperation(selection: CredentialRenderingSelection): OrdinaryPaOperationMaterialization {
      const created = createPostgresCredentialRenderingOwner(pool, selection);
      return Object.freeze({ owner: created.owner, control: Object.freeze({ replaceBinding: created.control.replaceBinding,
        ...(created.control.materialAdmission ? { materialAdmission: created.control.materialAdmission } : {}) }) });
    },
  });
  const owner = createOrdinaryProviderAccessOwner({ grants: store, materialization, registerSecrets });
  let closing = false, disposal: Promise<void> | undefined;
  return Object.freeze({
    async migrate() {
      if (closing) { throw new OrdinaryPaUnavailable(); }
      await store.migrate();
      const repository = createPostgresMaterializationRepository(pool);
      try { await repository.migrate(); } finally { repository.dispose(); }
    },
    observe: owner.observe,
    consume: owner.consume,
    dispose(): Promise<void> {
      if (disposal) { return disposal; } closing = true;
      disposal = (async () => { await owner.dispose(); store.dispose(); })().catch((error: unknown) => {disposal = undefined; throw error;});
      return disposal;
    },
  });
}
