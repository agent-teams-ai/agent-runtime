/**
 * Private, inert custody validation seam. No production native adapter exists.
 * Only closed, trusted Host composition may supply this dependency. Owner-local
 * identity authenticates the source, not OS policy: synthetic bridges qualify
 * this state machine only. Structural DarwinOwnedImage records and known hashes
 * are not attestation. This module neither launches nor issues physical receipts.
 */
export interface SingletonBinding {
  readonly operation: string;
  readonly attempt: string;
  readonly custody: string;
  readonly hostGeneration: string;
  readonly helper: string;
  readonly profile: string;
  readonly policy: string;
  readonly ipcPolicy: string;
  /** Exact ordered executable identities, including trusted pre-exec images. */
  readonly imageChain: readonly string[];
}
export interface SingletonBirth {
  readonly pid: number;
  readonly seconds: number;
  readonly micros: number;
}
export interface SingletonAdmission {
  readonly binding: SingletonBinding;
  readonly birth: SingletonBirth;
  readonly ordering: 'policy-and-observer-before-untrusted-exec';
  readonly descendants: 'all-creation-denied-across-exec';
  readonly delegation: 'mach-xpc-launch-services-and-capability-transfer-denied';
  readonly inheritedAuthority: 'only-owned-stdio-and-bounded-model-http';
  readonly imageEnforcement: 'exact-chain-enforced-through-exit';
}
export interface SingletonTerminal {
  readonly binding: SingletonBinding;
  readonly birth: SingletonBirth;
  readonly imageChain: readonly string[];
  readonly exit: 'exact-birth-exited';
  readonly launch: 'settled';
  readonly stdout: 'sealed';
  readonly stderr: 'sealed';
  readonly ownerFlights: 'settled';
}
export type NativeObservation<T> =
  | { readonly kind: 'authenticated'; readonly evidence: T }
  | { readonly kind: 'pending' | 'unknown' };
/**
 * Consumer-owned trusted dependency, selected once by Host, never by an operation.
 * reserve binds a unique native launch authority to the immutable reservation.
 * Reads must authenticate native provenance and return stable snapshots, not
 * synthesize attestations from caller flags, digests or process observation.
 * Admission authenticates exact PID/birth and helper/profile/policy/image pins.
 * The immutable policy cannot be removed or weakened by any allowed image; it
 * denies fork/vfork/spawn and delegation via writable executable/control
 * endpoints, Mach rights, XPC, launch services or transferred capabilities.
 * Only reviewed exact IPC rules allowing bounded model HTTP are admissible.
 * No untrusted execution or descendant-creation window may precede policy.
 * closeAdmission MUST synchronously prevent all further launch/stdio/owner
 * admissions; 'closed' is irrevocable. Terminal settlement covers ALL previously
 * admitted flights (including route owners), exact exit and the full image chain.
 * Pending is retryable only before cutoff; missing/partial/invalid/late native
 * acknowledgments are unknown. No API here registers arbitrary evidence.
 * Existing sandbox-exec could underpin a future qualified bridge; none is wired.
 */
export interface TrustedSingletonNativeOwner {
  reserve(binding: SingletonBinding): {
    readAdmission(): NativeObservation<SingletonAdmission>;
    closeAdmission(): 'closed' | 'unknown';
    readTerminal(): NativeObservation<SingletonTerminal>;
  } | undefined;
}
declare const reservationBrand: unique symbol;
declare const custodyBrand: unique symbol;
declare const closureBrand: unique symbol;
export interface SingletonReservation { readonly [reservationBrand]: true }
export interface SingletonCustody { readonly [custodyBrand]: true }
export interface SingletonClosure { readonly [closureBrand]: true }

type Session = NonNullable<ReturnType<TrustedSingletonNativeOwner['reserve']>>;
type RecordState = {
  binding: SingletonBinding;
  session: Session;
  phase: 'reserved' | 'admitting' | 'admitted' | 'sealing' | 'closing' | 'settling' | 'closed' | 'unknown';
  closeAttempted?: boolean;
  birth?: SingletonBirth;
  custody?: SingletonCustody;
  closure?: SingletonClosure;
};
const bindingKeys = ['operation', 'attempt', 'custody', 'hostGeneration',
  'helper', 'profile', 'policy', 'ipcPolicy'] as const;
function snapshot(binding: SingletonBinding): SingletonBinding | undefined {
  if (!binding || bindingKeys.some((key) => typeof binding[key] !== 'string' ||
      binding[key].length === 0) || !Array.isArray(binding.imageChain) ||
      binding.imageChain.length === 0 || binding.imageChain.length > 16 ||
      !Array.from(binding.imageChain).every((value) => typeof value === 'string' && value.length > 0)) {
    return undefined;
  }
  return Object.freeze({ operation: binding.operation, attempt: binding.attempt,
    custody: binding.custody, hostGeneration: binding.hostGeneration,
    helper: binding.helper, profile: binding.profile, policy: binding.policy,
    ipcPolicy: binding.ipcPolicy, imageChain: Object.freeze([...binding.imageChain]) });
}
function sameChain(a: readonly string[], b: readonly string[]): boolean {
  return Array.isArray(b) && a.length === b.length && a.every((image, i) => image === b[i]);
}
function sameBinding(a: SingletonBinding, b: SingletonBinding): boolean {
  return !!b && bindingKeys.every((key) => a[key] === b[key]) && sameChain(a.imageChain, b.imageChain);
}
function validBirth(birth: SingletonBirth): boolean {
  return !!birth && Number.isSafeInteger(birth.pid) && birth.pid > 0 &&
    Number.isSafeInteger(birth.seconds) && birth.seconds >= 0 &&
    Number.isSafeInteger(birth.micros) && birth.micros >= 0 && birth.micros < 1_000_000;
}
function sameBirth(a: SingletonBirth, b: SingletonBirth): boolean {
  return !!b && a.pid === b.pid && a.seconds === b.seconds && a.micros === b.micros;
}

/** No dependency means unavailable. No selectable profile or fallback is added. */
export function createDarwinSingletonCustodyOwner(
  hostGeneration: string,
  nativeOwner?: TrustedSingletonNativeOwner,
) {
  const reserveNative = nativeOwner?.reserve.bind(nativeOwner);
  const reservations = new WeakMap<SingletonReservation, RecordState>();
  const custodies = new WeakMap<SingletonCustody, RecordState>();
  const closures = new WeakMap<SingletonClosure, RecordState>();
  const used = new Set<string>();
  let active = true;
  // Empty frozen objects intentionally carry no serializable authority. These
  // exact local casts mint nominal handles; only the WeakMaps confer authority.
  function reserve(request: SingletonBinding): SingletonReservation | undefined {
    if (!active || !reserveNative) { return undefined; }
    try {
      const binding = snapshot(request);
      if (!binding || binding.hostGeneration !== hostGeneration) { return undefined; }
      const key = JSON.stringify([binding.operation, binding.attempt, binding.custody]);
      if (used.has(key)) { return undefined; }
      used.add(key); // A failed/throwing native reservation can never be retried.
      const native = reserveNative(binding);
      if (!active || !native) { return undefined; }
      const session: Session = Object.freeze({
        readAdmission: native.readAdmission.bind(native),
        closeAdmission: native.closeAdmission.bind(native),
        readTerminal: native.readTerminal.bind(native),
      });
      const token = Object.freeze({}) as SingletonReservation;
      reservations.set(token, { binding, session, phase: 'reserved' });
      return token;
    } catch { return undefined; }
  }
  function admit(token: SingletonReservation): SingletonCustody | undefined {
    const state = reservations.get(token);
    if (!active || !state || state.phase !== 'reserved') { return undefined; }
    state.phase = 'admitting';
    try {
      const observation = state.session.readAdmission();
      if (!active || state.phase !== 'admitting') { return undefined; }
      if (observation.kind === 'pending') { state.phase = 'reserved'; return undefined; }
      state.phase = 'unknown';
      if (observation.kind !== 'authenticated') { return undefined; }
      const a = observation.evidence;
      if (!sameBinding(state.binding, a.binding) || !validBirth(a.birth) ||
          a.ordering !== 'policy-and-observer-before-untrusted-exec' ||
          a.descendants !== 'all-creation-denied-across-exec' ||
          a.delegation !== 'mach-xpc-launch-services-and-capability-transfer-denied' ||
          a.inheritedAuthority !== 'only-owned-stdio-and-bounded-model-http' ||
          a.imageEnforcement !== 'exact-chain-enforced-through-exit') { return undefined; }
      state.birth = Object.freeze({ pid: a.birth.pid, seconds: a.birth.seconds, micros: a.birth.micros });
      state.custody = Object.freeze({}) as SingletonCustody;
      state.phase = 'admitted';
      custodies.set(state.custody, state);
      return state.custody;
    } catch { state.phase = 'unknown'; return undefined; }
  }
  /** Closes admission synchronously even when called before an acknowledgment. */
  function closeAdmission(token: SingletonReservation): boolean {
    const state = reservations.get(token);
    if (!active || !state || state.closeAttempted || state.phase === 'closed') { return false; }
    state.closeAttempted = true;
    const admitted = state.phase === 'admitted';
    state.phase = 'sealing';
    try {
      const closed = state.session.closeAdmission() === 'closed';
      if (!active || state.phase !== 'sealing') { return false; }
      state.phase = closed && admitted ? 'closing' : 'unknown';
      return closed;
    } catch { state.phase = 'unknown'; return false; }
  }
  function settle(token: SingletonReservation, custody: SingletonCustody): SingletonClosure | undefined {
    const state = reservations.get(token);
    if (!active || !state || custodies.get(custody) !== state || state.phase !== 'closing') { return undefined; }
    state.phase = 'settling';
    try {
      const observation = state.session.readTerminal();
      if (!active || state.phase !== 'settling') { return undefined; }
      if (observation.kind === 'pending') { state.phase = 'closing'; return undefined; }
      state.phase = 'unknown';
      if (observation.kind !== 'authenticated') { return undefined; }
      const t = observation.evidence;
      if (!state.birth || !sameBinding(state.binding, t.binding) || !sameBirth(state.birth, t.birth) ||
          !sameChain(state.binding.imageChain, t.imageChain) || t.exit !== 'exact-birth-exited' ||
          t.launch !== 'settled' || t.stdout !== 'sealed' || t.stderr !== 'sealed' ||
          t.ownerFlights !== 'settled') { return undefined; }
      state.closure = Object.freeze({}) as SingletonClosure;
      state.phase = 'closed';
      closures.set(state.closure, state);
      return state.closure;
    } catch { state.phase = 'unknown'; return undefined; }
  }
  return Object.freeze({ reserve, admit, closeAdmission, settle,
    /** Cutoff cannot turn a pending launch into proof of no-start. */
    cutoff(token: SingletonReservation): void {
      const state = reservations.get(token);
      if (!active || !state || state.phase === 'closed') { return; }
      closeAdmission(token);
      state.phase = 'unknown';
    },
    /** One-shot consumption by a future private issuer; original reservation only. */
    consume(token: SingletonReservation, proof: SingletonClosure): boolean {
      const state = reservations.get(token);
      if (!active || !state || state.phase !== 'closed' || closures.get(proof) !== state) { return false; }
      closures.delete(proof);
      return true;
    },
    /** Host owns native teardown separately; retirement invalidates all handles. */
    retire(): void { active = false; },
  });
}
