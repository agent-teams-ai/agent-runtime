import { randomBytes } from 'node:crypto';
import { types } from 'node:util';
import { OrdinaryPaUnavailable, type OrdinaryPaBinding, type OrdinaryPaGrant, type OrdinaryPaRetirement } from '../contracts/ordinary-provider-access.js';
import { snapshotOrdinaryPaBinding } from '../domain/ordinary-provider-access.js';
import type { OrdinaryCodexAuthCapture } from '../adapters/outbound/ordinary-codex-auth-contracts.js';
import { createOrdinaryPaStore, ordinaryPaDigest } from '../adapters/outbound/postgres/ordinary-pa-store.js';
import type { MaterializationPostgresPool } from '../adapters/outbound/postgres/materialization-postgres-transactions.js';
import { createPostgresMaterializationRepository } from '../adapters/outbound/postgres/materialization-postgres-repository.js';
import { createPostgresCredentialRenderingOwner } from './postgres-credential-rendering-owner.js';
import type { CredentialRenderingSelection } from '../adapters/outbound/credential-rendering-contracts.js';
import { createOrdinaryPaBroker } from '../adapters/outbound/ordinary-pa-broker.js';
import { createOrdinaryPaUpstream } from '../adapters/outbound/ordinary-pa-upstream.js';
import { createOrdinaryPaSecretGuard } from '../adapters/outbound/ordinary-pa-secret-guard.js';

export interface OrdinaryProviderAccessOwnerOptions {
  readonly pool: MaterializationPostgresPool;
  /** Trusted ER/RS sink. Receives exactly one complete inventory before dispatch. */
  readonly registerSecrets: (operationId: string, tokens: readonly string[]) => boolean;
}
/** Ordinary grant and credential authorities stay inside PA; Host borrows only closed capabilities. */
export function createPostgresOrdinaryProviderAccessOwner(options: OrdinaryProviderAccessOwnerOptions) {
  if (typeof options.registerSecrets !== 'function' || types.isAsyncFunction(options.registerSecrets)) { throw new OrdinaryPaUnavailable(); }
  const pool = options.pool, registerSecrets = options.registerSecrets;
  const store = createOrdinaryPaStore(pool), grants = new Set<OrdinaryPaGrant>();
  const pendingCaptures = new Set<OrdinaryCodexAuthCapture>();
  let disposed = false;
  let disposal: Promise<void> | undefined;
  const check = () => { if (disposed) { throw new OrdinaryPaUnavailable(); } };
  return Object.freeze({
    async migrate() {
      check(); await store.migrate();
      const materialization = createPostgresMaterializationRepository(pool);
      try { await materialization.migrate(); } finally { materialization.dispose(); }
    },
    observe: (binding: OrdinaryPaBinding) => store.observe(binding),
    async consume(input: OrdinaryPaBinding, capture: OrdinaryCodexAuthCapture, signal: AbortSignal): Promise<OrdinaryPaGrant> {
      check(); const binding = snapshotOrdinaryPaBinding(input);
      if (signal.aborted || pendingCaptures.has(capture) || grants.size + pendingCaptures.size >= 64) { capture.dispose(); throw new OrdinaryPaUnavailable(); }
      pendingCaptures.add(capture);
      let metadata: Awaited<ReturnType<OrdinaryCodexAuthCapture['capture']>>;
      let consumed: Awaited<ReturnType<typeof store.consume>>;
      try {
        metadata = await capture.capture(); check();
        if (signal.aborted) { throw new OrdinaryPaUnavailable(); }
        consumed = await store.consume(binding, { generation: metadata.generation, accountId: metadata.accountId, expiresAt: metadata.expiresAt });
        check();
      } catch { capture.dispose(); throw new OrdinaryPaUnavailable(); }
      finally { pendingCaptures.delete(capture); }
      const selection: CredentialRenderingSelection = Object.freeze({ operationRef: binding.operationId, recipe: 'codex-chatgpt',
        operationAbortSignal: signal, deadline: metadata.deadline,
        binding: Object.freeze({ accessRef: consumed.authority.grantId, availability: 'available', bindingRevision: 1,
          credentialBindingDigest: consumed.authority.authorityDigest, credentialBindingRef: metadata.captureRef,
          credentialGeneration: metadata.generation, projectId: binding.projectId, provider: 'codex',
          providerAccountRef: metadata.accountId, providerRouteRef: 'ordinary-codex-chatgpt-responses-v1', revocation: 'active',
          scopeDigest: ordinaryPaDigest(binding), tenantId: binding.tenantId }) });
      const guard = createOrdinaryPaSecretGuard();
      let rendering: ReturnType<typeof createPostgresCredentialRenderingOwner> | undefined;
      let broker: Awaited<ReturnType<typeof createOrdinaryPaBroker>> | undefined;
      let capability: Buffer | undefined;
      let attempted = false, retiring: Promise<OrdinaryPaRetirement> | undefined;
      const retire = (): Promise<OrdinaryPaRetirement> => {
        if (retiring) { return retiring; }
        retiring = (async () => {
          try { await broker?.close(); }
          finally { rendering?.owner.dispose(); capture.dispose(); guard.dispose(); capability?.fill(0); }
          await capture.settled;
          const retired = await store.retire(binding).catch(async () => {
            const observed = await store.observe(binding);
            if (!observed || observed.retiredAt === null) { throw new OrdinaryPaUnavailable(); }
            return observed;
          });
          if (retired.retiredAt === null) { throw new OrdinaryPaUnavailable(); }
          return Object.freeze({ materializationId: retired.materializationId, generation: retired.generation, retiredAt: retired.retiredAt });
        })(); return retiring;
      };
      const grant = Object.freeze<OrdinaryPaGrant>({ grantId: consumed.authority.grantId, expiresAt: consumed.authority.expiresAt, authority: consumed.authority,
        async materialize() {
          if (attempted || retiring || signal.aborted || performance.now() >= metadata.deadline) { throw new OrdinaryPaUnavailable(); }
          attempted = true;
          try {
            check(); rendering = createPostgresCredentialRenderingOwner(pool, selection);
            if (await rendering.control.replaceBinding(selection.binding, 0) !== 1 || !rendering.control.materialAdmission) { throw new OrdinaryPaUnavailable(); }
            const random = randomBytes(32);
            try { capability = Buffer.alloc(64); capability.write(random.toString('hex'), 'ascii'); } finally { random.fill(0); }
            const local = capability.toString('ascii');
            capture.withCredentialOutputTokens(binding.operationId, tokens => {
              const inventory = Object.freeze([...tokens, local]);
              guard.install(inventory);
              const accepted: unknown = registerSecrets(binding.operationId, inventory);
              if (types.isPromise(accepted) && Object.getPrototypeOf(accepted) === Promise.prototype && Object.getOwnPropertyDescriptor(accepted, 'constructor') === undefined) {
                Promise.prototype.then.call(accepted, () => {}, () => {});
              }
              return accepted === true;
            });
            capture.admit(selection, rendering.control.materialAdmission);
            broker = await createOrdinaryPaBroker({ binding, selection, renderer: rendering.owner, store,
              upstream: createOrdinaryPaUpstream(), capability, secretGuard: guard });
            if (signal.aborted || performance.now() >= metadata.deadline) { throw new OrdinaryPaUnavailable(); }
            return Object.freeze({ brokerEndpoint: broker.endpoint, materializationId: consumed.materializationId,
              generation: metadata.generation, environment: Object.freeze({ AR_ORDINARY_BROKER_CAPABILITY: local }) });
          } catch { await retire(); throw new OrdinaryPaUnavailable(); }
        },
        retire,
        async settle(disposition) {
          const settled = await store.settle(binding, disposition).catch(async () => {
            const observed = await store.observe(binding);
            if (!observed || observed.disposition !== disposition) { throw new OrdinaryPaUnavailable(); }
            return observed;
          });
          if (!settled.settlementReceiptId || !settled.disposition) { throw new OrdinaryPaUnavailable(); }
          grants.delete(grant);
          return Object.freeze({ grantId: consumed.authority.grantId, ownerReceiptId: consumed.authority.ownerReceiptId,
            settlementReceiptId: settled.settlementReceiptId, disposition: settled.disposition });
        },
        admitCanonicalText: text => guard.check(text),
        admitArtifactBytes: bytes => guard.artifact(bytes),
      });
      grants.add(grant); return grant;
    },
    dispose(): Promise<void> {
      if (disposal) { return disposal; } disposed = true;
      disposal = (async () => {
        for (const capture of pendingCaptures) { capture.dispose(); }
        const results = await Promise.allSettled([...grants].map(grant => grant.retire()));
        const captures = await Promise.allSettled([...pendingCaptures].map(capture => capture.settled));
        grants.clear(); store.dispose();
        if ([...results, ...captures].some(result => result.status === 'rejected')) { throw new OrdinaryPaUnavailable(); }
      })(); return disposal;

    },
  });
}
