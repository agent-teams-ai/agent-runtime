import { addAbortListener } from "node:events";
import { hostLaunchFinalizationRecipe, type HostLaunchFinalizationRecipe } from "./host-custody-finalizable-plan.js";
import type { ExecutableObservation, LaunchCandidate } from "./host-custody-launch.js";
import type { LiveCustody } from "./node-provider-process-custody-state.js";
import type { NodeCustodyHttpLifetime } from "./node-provider-process-custody-http-reservation.js";
import { recheckFinalHostLaunch, retainFinalizationHttpResources, validateFinalHostLaunch } from "./host-launch-finalization-validation.js";
import {
  prepareAuthenticatedHostHttpEgressSession, type HostHttpEgressSessionDependencies,
} from "./egress/host-http-egress-session.js";

export interface FinalHostLaunch extends LaunchCandidate {
  readonly executable: ExecutableObservation;
  readonly materialSha256: string;
}
export interface ReservedHostLaunchView { readFinal(): FinalHostLaunch }
export interface StagedHostLaunch { readonly fingerprintSha256: string }
export interface ClaimedHostLaunchFinalizer {
  stage(this: ClaimedHostLaunchFinalizer, material: unknown): Promise<StagedHostLaunch>;
  bindSession(this: ClaimedHostLaunchFinalizer, dependencies: HostHttpEgressSessionDependencies):
    ReturnType<ReturnType<typeof prepareAuthenticatedHostHttpEgressSession>["bind"]>;
  commit(this: ClaimedHostLaunchFinalizer, staged: StagedHostLaunch): FinalHostLaunch;
}
const rejected = (): TypeError => new TypeError("Host launch finalization unavailable or conflicts");

/** The only execution publication slot lives on the actual reservation. Provider
 * records receive its read-only view. Original reservation identity never changes.
 */
export class HostLaunchBinding {
  #reservation: LaunchCandidate | undefined;
  #recipe: HostLaunchFinalizationRecipe | undefined;
  #final: FinalHostLaunch | undefined;
  #entered = false;
  #started = false;
  #pending: Promise<void> | undefined;
  #validate: (() => void) | undefined;
  public readonly view: ReservedHostLaunchView = Object.freeze({readFinal: () => {
    if (this.#final === undefined) {throw rejected();}
    return this.#final;
  }});

  public get reservation(): LaunchCandidate | undefined {return this.#reservation;}
  public get current(): LaunchCandidate | undefined {return this.#final ?? this.#reservation;}
  public get materialSha256(): string | undefined {return this.#final?.materialSha256;}
  public get pending(): Promise<void> | undefined {return this.#pending;}

  public reserve(candidate: LaunchCandidate): void {
    if (this.#reservation !== undefined) {throw rejected();}
    this.#reservation = Object.freeze(candidate);
    this.#recipe = hostLaunchFinalizationRecipe(candidate.plan);
  }

  public assertStart(bundle?: FinalHostLaunch): void {
    if (this.#recipe !== undefined && (bundle === undefined || bundle !== this.#final)) {throw rejected();}
  }

  public firstStart(live: LiveCustody): void {
    if (this.#recipe === undefined) {return;}
    if (this.#started || this.#final === undefined) {throw rejected();}
    this.#validate!();
    recheckFinalHostLaunch(live, this.#final);
    live.httpReservation.assertActive();
    if (live.sealed || live.abortRequested) {throw rejected();}
    this.#started = true;
  }

  /** Guardian calls once after placement and immediately before sending exec. */
  public executionPermitted(live: LiveCustody): boolean {
    try {
      live.httpReservation.assertActive();
      if (live.sealed || live.abortRequested) {return false;}
      if (this.#recipe !== undefined) {
        if (!this.#started || this.#final === undefined) {return false;}
        this.#validate!(); recheckFinalHostLaunch(live, this.#final);
        live.httpReservation.assertActive();
      }
      return !live.sealed && !live.abortRequested;
    } catch {return false;}
  }

  public bind(live: LiveCustody, lifetime: NodeCustodyHttpLifetime): ClaimedHostLaunchFinalizer {
    live.httpReservation.assertPreparation(lifetime);
    if (this.#entered || this.#recipe === undefined || live.launchBinding !== this) {throw rejected();}
    this.#entered = true;
    const proof = lifetime.committedDispatchProof;
    const ingress = prepareAuthenticatedHostHttpEgressSession({
      operationId: proof.operationId, attemptId: proof.attemptId, custodyId: proof.custodyId,
      hostBootId: proof.hostBootId, liveProcessSessionIdentity: lifetime.executionSessionIdentity,
    });
    addAbortListener(lifetime.signal, () => ingress.close());
    let stageUsed = false;
    let staged: StagedHostLaunch | undefined;
    let launch: FinalHostLaunch | undefined;
    let validate: (() => void) | undefined;
    let session: ReturnType<typeof ingress.bind> | undefined;
    const active = (receiver: ClaimedHostLaunchFinalizer): void => {
      if (receiver !== finalizer || this.#final !== undefined) {throw rejected();}
      live.httpReservation.assertPreparation(lifetime);
      ingress.nativeBearerToken();
    };
    const fail = (): never => {live.httpReservation.cutoff(); throw rejected();};
    const recipe = this.#recipe;
    const retainPending = (pending: Promise<void>): void => {this.#pending = pending;};
    const publish = (candidate: FinalHostLaunch, check: () => void): void => {
      this.#validate = () => {ingress.nativeBearerToken(); check();};
      this.#final = candidate;
    };
    const finalizer: ClaimedHostLaunchFinalizer = Object.freeze({
      stage: function(material: unknown): Promise<StagedHostLaunch> {
        try {active(this); if (stageUsed) {throw rejected();}} catch {return Promise.reject(rejected());}
        stageUsed = true;
        // Retain completion before invoking any builder or async verifier. Cutoff
        // closes ingress immediately; no-start cleanup still awaits this work.
        const completion = Promise.withResolvers<void>();
        retainPending(completion.promise);
        return (async () => {
          try {
            const built = recipe.build(material, ingress.nativeBearerToken());
            validate = built.validate;
            const candidate = await validateFinalHostLaunch(live, built.plan, built.materialSha256);
            active(finalizer); validate(); recheckFinalHostLaunch(live, candidate);
            launch = candidate;
            staged = Object.freeze({fingerprintSha256: candidate.fingerprint.fingerprintSha256});
            return staged;
          } catch {return fail();}
          finally {completion.resolve();}
        })();
      },
      bindSession(dependencies: HostHttpEgressSessionDependencies) {
        try {
          active(this);
          if (staged === undefined || session !== undefined) {throw rejected();}
          session = ingress.bind(retainFinalizationHttpResources(dependencies, recipe.providerAccess));
          active(this);
          return session;
        } catch {return fail();}
      },
      commit(candidate: StagedHostLaunch): FinalHostLaunch {
        try {
          active(this);
          if (candidate !== staged || launch === undefined || session === undefined || validate === undefined) {throw rejected();}
          // No callbacks or awaits between the final check and the one publication.
          validate(); recheckFinalHostLaunch(live, launch); active(this);
          publish(launch, validate);
          return launch;
        } catch {return fail();}
      },
    });
    return finalizer;
  }
}
