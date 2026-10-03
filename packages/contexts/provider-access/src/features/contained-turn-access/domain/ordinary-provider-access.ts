export interface OrdinaryPaBinding {
  readonly operationId: string;
  readonly attemptId: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly executionProfile: 'user-session-v1';
  readonly effectClass: 'ordinary_user_session_effect';
  readonly capabilityManifestRevision: 'ordinary-codex-macos-arm64-0.153.4-v1';
}
/** Domain refusal. The code matches the contract's `OrdinaryPaUnavailable`; layers cannot import each other, so the shapes below mirror the contract. */
class OrdinaryPaRefused extends Error {
  readonly code = 'ORDINARY_PA_UNAVAILABLE';
  constructor() { super('ORDINARY_PA_UNAVAILABLE'); }
}
export interface OrdinaryPaAuthority extends OrdinaryPaBinding {
  readonly owner: 'provider_access';
  readonly provider: 'codex';
  readonly grantId: string;
  readonly ownerReceiptId: string;
  readonly consumptionDigest: string;
  readonly consumptionRevision: 1;
  readonly authorityDigest: string;
  readonly expiresAt: number;
  readonly scope: { readonly tenantId: string; readonly projectId: string };
}
export interface OrdinaryPaSnapshot {
  readonly authority: OrdinaryPaAuthority;
  readonly generation: number;
  readonly accountId: string;
  readonly materializationId: string;
  readonly retiredAt: string | null;
  readonly disposition: 'claim_committed' | 'abandoned_without_claim' | null;
  readonly settlementReceiptId: string | null;
  readonly requestsStarted: number;
  readonly requestsCompleted: number;
  readonly requestsFailed: number;
}
const keys = ['operationId', 'attemptId', 'tenantId', 'projectId', 'executionProfile', 'effectClass', 'capabilityManifestRevision'] as const;
/** Exact, detached fieldwise snapshot. No callers' aliases enter durable PA facts. */
export function snapshotOrdinaryPaBinding(input: unknown): OrdinaryPaBinding {
  if (input === null || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype) { throw new OrdinaryPaRefused(); }
  const fields = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(fields).length !== keys.length || keys.some(key => !fields[key] || !('value' in fields[key]))) { throw new OrdinaryPaRefused(); }
  const get = (key: typeof keys[number]) => {
    const value: unknown = fields[key]?.value;
    if (typeof value !== 'string' || value.length < 1 || value.length > 512 || Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) { throw new OrdinaryPaRefused(); }
    return value;
  };
  if (get('executionProfile') !== 'user-session-v1' || get('effectClass') !== 'ordinary_user_session_effect' ||
      get('capabilityManifestRevision') !== 'ordinary-codex-macos-arm64-0.153.4-v1') { throw new OrdinaryPaRefused(); }
  return Object.freeze({ operationId: get('operationId'), attemptId: get('attemptId'), tenantId: get('tenantId'), projectId: get('projectId'),
    executionProfile: 'user-session-v1', effectClass: 'ordinary_user_session_effect', capabilityManifestRevision: 'ordinary-codex-macos-arm64-0.153.4-v1' });
}
export const sameOrdinaryPaBinding = (a: OrdinaryPaBinding, b: OrdinaryPaBinding): boolean => keys.every(key => a[key] === b[key]);

export type OrdinaryPaDisposition = 'claim_committed' | 'abandoned_without_claim';
export type OrdinaryPaRequestOutcome = 'completed' | 'failed';
/** Hard cap on broker requests per grant; the table CHECK constraint states the same number. */
export const ordinaryPaMaxRequests = 64;
/** A grant may not outlive its capture by more than this window. */
export const ordinaryPaMaxGrantLifetimeMs = 60_000;

const dispositions: readonly string[] = ['claim_committed', 'abandoned_without_claim'];
export const isOrdinaryPaDisposition = (value: unknown): value is OrdinaryPaDisposition => typeof value === 'string' && dispositions.includes(value);

/** Exact non-secret facts the adapter persists for one consumed grant. */
export interface OrdinaryPaGrantRecord {
  readonly binding: OrdinaryPaBinding;
  readonly snapshot: Readonly<{ authority: OrdinaryPaAuthority; generation: number; accountId: string; materializationId: string }>;
  readonly expiresAt: number;
}
export interface OrdinaryPaSelectedFacts { readonly generation: number; readonly accountId: string; readonly expiresAt: number }
/** Everything non-deterministic a decision needs, supplied by the caller. */
export interface OrdinaryPaDecisionEnvironment {
  readonly now: number;
  readonly newId: () => string;
  readonly digest: (value: unknown) => string;
}
export interface OrdinaryPaAuthorityFacts {
  readonly grantId: string; readonly ownerReceiptId: string; readonly expiresAt: number; readonly generation: number; readonly accountId: string;
}
/** The authority is a pure function of the binding and the persisted facts; readers recompute it to detect tampering. */
export function deriveOrdinaryPaAuthority(binding: OrdinaryPaBinding, facts: OrdinaryPaAuthorityFacts, digest: (value: unknown) => string): OrdinaryPaAuthority {
  const { grantId, ownerReceiptId, expiresAt, generation, accountId } = facts;
  const consumptionDigest = digest([binding, grantId, ownerReceiptId, expiresAt, generation, accountId]);
  return Object.freeze({ ...binding, owner: 'provider_access', provider: 'codex', grantId, ownerReceiptId,
    consumptionDigest, consumptionRevision: 1, authorityDigest: digest(['ordinary-pa-authority-v1', consumptionDigest]),
    expiresAt, scope: Object.freeze({ tenantId: binding.tenantId, projectId: binding.projectId }) });
}
/** Candidate for the one-shot insert. The storage clock still decides the window when the row is written. */
export function newOrdinaryPaGrant(input: unknown, selected: OrdinaryPaSelectedFacts, environment: OrdinaryPaDecisionEnvironment): OrdinaryPaGrantRecord {
  const binding = snapshotOrdinaryPaBinding(input);
  const { generation, accountId, expiresAt } = selected;
  if (!Number.isSafeInteger(generation) || generation < 1 || typeof accountId !== 'string' || accountId.length < 1 || accountId.length > 256 ||
      expiresAt <= environment.now || expiresAt > environment.now + ordinaryPaMaxGrantLifetimeMs) { throw new OrdinaryPaRefused(); }
  const authority = deriveOrdinaryPaAuthority(binding, { grantId: environment.newId(), ownerReceiptId: environment.newId(), generation, accountId, expiresAt }, environment.digest);
  return Object.freeze({ binding, expiresAt,
    snapshot: Object.freeze({ authority, generation, accountId, materializationId: environment.newId() }) });
}

export interface OrdinaryPaBrokerRequest { readonly bodyDigest: string; readonly byteLength: number }
/** Exact, detached request facts or a refusal; nothing else reaches the request journal. */
export function snapshotOrdinaryPaRequest(input: OrdinaryPaBrokerRequest): OrdinaryPaBrokerRequest {
  const { bodyDigest, byteLength } = input;
  if (typeof bodyDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(bodyDigest) || !Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > 1_048_576) { throw new OrdinaryPaRefused(); }
  return Object.freeze({ bodyDigest, byteLength });
}

export type OrdinaryPaTransition = { readonly kind: 'refused' } | { readonly kind: 'keep' } | { readonly kind: 'write' };
const refused = Object.freeze({ kind: 'refused' } as const);
const keep = Object.freeze({ kind: 'keep' } as const);
const write = Object.freeze({ kind: 'write' } as const);
const requestsSettled = (current: OrdinaryPaSnapshot): number => current.requestsCompleted + current.requestsFailed;

/** Retirement needs every started request to be ended; a repeat keeps the first `retiredAt`. */
export function decideOrdinaryPaRetire(current: OrdinaryPaSnapshot | undefined): OrdinaryPaTransition {
  if (!current || current.requestsStarted !== requestsSettled(current)) { return refused; }
  return current.retiredAt === null ? write : keep;
}
/** Settlement needs retirement; the same disposition is idempotent and any other one is refused. */
export function decideOrdinaryPaSettle(current: OrdinaryPaSnapshot | undefined, disposition: OrdinaryPaDisposition): OrdinaryPaTransition {
  if (!current || current.retiredAt === null) { return refused; }
  if (current.disposition !== null && current.disposition !== disposition) { return refused; }
  return current.disposition === null ? write : keep;
}
/** The next sequence is strictly `requestsStarted + 1`, one request in flight at most, never after retirement, settlement or a failure. */
export function decideOrdinaryPaBeginRequest(current: OrdinaryPaSnapshot | undefined, now: number): { readonly kind: 'refused' } | { readonly kind: 'begin'; readonly sequence: number } {
  if (!current || current.retiredAt !== null || current.disposition !== null || current.requestsFailed !== 0 || current.authority.expiresAt <= now ||
      current.requestsStarted >= ordinaryPaMaxRequests || current.requestsStarted !== current.requestsCompleted) { return refused; }
  return Object.freeze({ kind: 'begin', sequence: current.requestsStarted + 1 });
}
/** Only the newest started request can end, and only once. */
export function decideOrdinaryPaEndRequest(current: OrdinaryPaSnapshot | undefined, sequence: number): { readonly kind: 'refused' } | { readonly kind: 'end' } {
  if (!current || !Number.isSafeInteger(sequence) || sequence < 1 || sequence !== current.requestsStarted || requestsSettled(current) >= current.requestsStarted) { return refused; }
  return Object.freeze({ kind: 'end' });
}
