import { types } from 'node:util';
import { HelperCleanupIndeterminate } from './auth-ipc.ts';
import { createHash, randomUUID } from 'node:crypto';
import { createPrivateOfficialAuthOwner, type PrivateAuthConfig } from './owner.ts';
import {
  createPostgresMaterializationRepository,
  createPostgresRouteSelectionOwner,
  createPostgresOperationDispatchConsumption,
  createPostgresCredentialRenderingOwner,
  type RouteSelectionInput,
  type MaterializationPostgresPool,
  type CredentialRenderingBinding,
} from '@agent-teams/provider-access/composition';
export interface OperatorApproval {
  /** Retained explicit-ID compatibility for the original regressions. New callers use approveCapture. */
  readonly approvedAccountId?: string;
  readonly approveCapture?: (metadata: Readonly<{accountId: string; generation: number; captureRef: string;
    provenance: 'operator-owned-private-isolated-official-test-session'; scope: Readonly<Omit<OperatorApproval, 'approveCapture' | 'approvedAccountId'>>}>) => Promise<boolean>;
  readonly testSessionProvenance?: 'operator-owned-private-isolated-official-test-session'; readonly tenantId: string; readonly projectId: string; readonly scopeDigest: string;
  readonly descriptor: RouteSelectionInput['descriptor'];
  readonly validFromControlTime: number; readonly claimBeforeControlTime: number; readonly expiresAtControlTime: number;
}
type CredentialOutputInventory = Readonly<{credentialBindingDigest: string; credentialGeneration: number;
  sensitiveOutputTokens: readonly string[]}>;
type PublicationStatus = 'not-started' | 'pending' | 'acknowledged' | 'refused' | 'unconfirmed';
export class PABootstrapRefused extends Error {
  readonly publication: Readonly<{binding: PublicationStatus; route: PublicationStatus; issuance: PublicationStatus}>;
  constructor(publication: Readonly<{binding: PublicationStatus; route: PublicationStatus; issuance: PublicationStatus}>) {
    super('PA_BOOTSTRAP_REFUSED');
    this.publication = publication;
  }
}
/** Trusted operator input only. Parent owns a new unique scope and borrowed empty DB pool.
 * Migrations and each publication are explicit acknowledged owner transactions, not a fake grant.
 */
export async function acquireAndPublish(pool: MaterializationPostgresPool, authConfig: PrivateAuthConfig, input: OperatorApproval) {
  authConfig = Object.freeze({...authConfig});
  const {approveCapture, ...scope} = input;
  const approval = structuredClone(scope); const auth = createPrivateOfficialAuthOwner(authConfig);
  // Borrowed pool is never closed. A local query fence also covers an expired deadline
  // before the event loop has delivered its timer; already issued queries stay observed.
  const connect = pool.connect.bind(pool);
  pool = {async connect() {
    check(); const client = await connect();
    const query = client.query.bind(client), release = client.release.bind(client);
    try {check();} catch (error) {release(true); throw error;}
    return {query(sql, values) {check(); return query(sql, values);}, release};
  }};
  const store = createPostgresMaterializationRepository(pool);
  let route: ReturnType<typeof createPostgresRouteSelectionOwner> | undefined;
  let dispatch: ReturnType<typeof createPostgresOperationDispatchConsumption> | undefined;
  let renderer: ReturnType<typeof createPostgresCredentialRenderingOwner> | undefined;
  let used = false, closed = false;
  const publication: {binding: PublicationStatus; route: PublicationStatus; issuance: PublicationStatus} =
    {binding: 'not-started', route: 'not-started', issuance: 'not-started'};
  const refusal = () => new PABootstrapRefused(Object.freeze({
    binding: publication.binding === 'pending' ? 'unconfirmed' : publication.binding,
    route: publication.route === 'pending' ? 'unconfirmed' : publication.route,
    issuance: publication.issuance === 'pending' ? 'unconfirmed' : publication.issuance,
  }));
  const check = () => {if (closed || authConfig.signal.aborted || performance.now() >= authConfig.deadline ||
    authConfig.readGeneration() !== authConfig.generation) {dispose(); throw new Error('PA_BOOTSTRAP_REFUSED');}};
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const dispose = () => {
    if (closed) {return;}
    closed = true; clearTimeout(expiry); authConfig.signal.removeEventListener('abort', dispose);
    // Retire persistence synchronously before an awaited SQL continuation can start a new statement.
    store.dispose(); route?.dispose(); dispatch?.dispose(); renderer?.owner.dispose(); auth.dispose();
  };
  authConfig.signal.addEventListener('abort', dispose, {once: true});
  expiry = setTimeout(dispose, Math.max(1, Math.min(60000, authConfig.deadline - performance.now())));
  expiry.unref();
  try {
    check();
    const observed = await auth.capture(); check();
    let approved: boolean;
    if (approveCapture !== undefined) {
      if (typeof approveCapture !== 'function' || approval.testSessionProvenance !== 'operator-owned-private-isolated-official-test-session') {throw new Error('PA_BOOTSTRAP_REFUSED');}
      // Isolated clone: policy can approve or deny, never replace binding facts or material.
      approved = await approveCapture(Object.freeze({...observed,
        provenance: approval.testSessionProvenance, scope: Object.freeze(structuredClone(approval))}));
      check();
    } else {approved = observed.accountId === approval.approvedAccountId;}
    if (approved !== true) {throw new Error('PA_BOOTSTRAP_REFUSED');}
    const facts = {tenantId: approval.tenantId, projectId: approval.projectId, scopeDigest: approval.scopeDigest,
      provider: 'codex' as const, accountId: observed.accountId, generation: observed.generation,
      captureRef: observed.captureRef, descriptor: approval.descriptor};
    const digest = 'sha256:' + createHash('sha256').update(JSON.stringify(facts)).digest('hex');
    const binding: CredentialRenderingBinding = Object.freeze({tenantId: facts.tenantId, projectId: facts.projectId,
      scopeDigest: facts.scopeDigest, provider: 'codex', providerAccountRef: observed.accountId,
      credentialGeneration: observed.generation, bindingRevision: 1, availability: 'available', revocation: 'active',
      accessRef: 'pa-access:' + randomUUID(), credentialBindingRef: 'pa-credential:' + randomUUID(),
      providerRouteRef: 'pa-route:' + randomUUID(), credentialBindingDigest: digest});
    route = createPostgresRouteSelectionOwner(pool, {binding, descriptor: approval.descriptor, recipe: 'codex-chatgpt',
      deadline: authConfig.deadline, operationAbortSignal: authConfig.signal});
    await store.migrate(); check(); await route.control.migrate(); check();
    publication.binding = 'pending';
    const head = await store.replaceBinding(binding, 0);
    publication.binding = head === 1 ? 'acknowledged' : 'refused';
    check(); if (head !== 1) {throw refusal();}
    publication.route = 'pending';
    const endorsed = await route.control.endorse(head); publication.route = 'acknowledged'; check();
    dispatch = createPostgresOperationDispatchConsumption(pool, {binding, materializationHeadVersion: head,
      issuanceRef: 'pa-issuance:' + randomUUID(), validFromControlTime: approval.validFromControlTime,
      claimBeforeControlTime: approval.claimBeforeControlTime, expiresAtControlTime: approval.expiresAtControlTime});
    await dispatch.control.migrate(); check(); publication.issuance = 'pending';
    await dispatch.control.provisionIssuance(); publication.issuance = 'acknowledged'; check();
    const {tenantId, projectId, provider, scopeDigest} = binding;
    const readback = await store.observeBinding({tenantId, projectId, provider, scopeDigest}); check();
    const current = await route.readCurrent(); check();
    if (!readback || Object.keys(binding).some(key => readback[key as keyof typeof binding] !== binding[key as keyof typeof binding]) ||
        current?.routeAuthorityDigest !== endorsed.routeAuthorityDigest) {throw new Error('PA_BOOTSTRAP_REFUSED');}
    return Object.freeze({binding, ownerFacts: Object.freeze(structuredClone(facts)), routeSelection: route, dispatchConsumption: dispatch.dispatchConsumption,
      withCredentialOutputInventory(operationRef: string, consume: (inventory: CredentialOutputInventory) => boolean) {
        try {
          check();
          if (used || operationRef !== authConfig.operationRef || typeof consume !== 'function' ||
              types.isAsyncFunction(consume)) {throw refusal();}
          auth.withCredentialOutputTokens(operationRef, sensitiveOutputTokens => {
            check();
            const accepted = consume(Object.freeze({credentialBindingDigest: binding.credentialBindingDigest,
              credentialGeneration: observed.generation, sensitiveOutputTokens}));
            // Observe before lifetime checks: callback invalidation must not orphan rejection.
            if (types.isPromise(accepted) && Object.getPrototypeOf(accepted) === Promise.prototype &&
                Object.getOwnPropertyDescriptor(accepted, 'constructor') === undefined) {
              Promise.prototype.then.call(accepted, () => {}, () => {});
            }
            check(); if (used || accepted !== true) {throw refusal();}
            return true;
          });
          check();
        } catch {dispose(); throw refusal();}
      },
      createRendering(operationRef: string) {
        check(); if (used) {throw new Error('PA_BOOTSTRAP_REFUSED');} used = true;
        const selection = {operationRef, binding, recipe: 'codex-chatgpt' as const,
          operationAbortSignal: authConfig.signal, deadline: authConfig.deadline};
        try {
          renderer = createPostgresCredentialRenderingOwner(pool, selection);
          const admission = renderer.control.materialAdmission; if (!admission) {throw new Error('PA_BOOTSTRAP_REFUSED');}
          auth.admit(selection, admission); return renderer;
        } catch {dispose(); throw refusal();}
      }, dispose});
  } catch (error) {dispose(); if (error instanceof HelperCleanupIndeterminate) {throw error;} throw refusal();}
}
