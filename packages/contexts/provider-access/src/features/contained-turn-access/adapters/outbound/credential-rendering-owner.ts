import type {
  AuthorizeCredentialMaterializationInput, AuthorizeCredentialMaterializationOutcome,
  CredentialMaterializationAuthorizationReceipt, CredentialMaterializationAuthorizationV1,
  ObserveCredentialMaterializationAuthorizationInput, ObserveCredentialMaterializationAuthorizationOutcome,
} from "../../contracts/materialization-authorization-v1.js";
import { AUTHORIZATION_COMMAND_KEYS, snapshotAuthorizationCommand, snapshotAuthorizationOwnerSelector } from "../../domain/materialization-authorization.js";
import { detachedDispatchData } from "../dispatch-consumption-data.js";
import type {
  CredentialGenerationAcquisition, CredentialGenerationMaterialLifetime, CredentialGenerationRequest, CredentialRenderingOutcome, CredentialRenderingOwner,
  CredentialRenderingSelection, RenderedCredentialFields,
} from "./credential-rendering-contracts.js";
import { CredentialRenderingLifetime, signalAborted } from "./credential-rendering-lifetime.js";

const denied = Object.freeze({kind: "denied" as const});
const unsupported = Object.freeze({kind: "unsupported" as const, reason: "credential_acquisition_unavailable" as const});
const indeterminate = Object.freeze({kind: "indeterminate" as const});
const sameReceipt = (receipt: CredentialMaterializationAuthorizationReceipt, command: AuthorizeCredentialMaterializationInput): boolean =>
  receipt.decision === "authorized" && receipt.rejectionReason === null &&
  AUTHORIZATION_COMMAND_KEYS.every(key => receipt[key] === command[key]);
const selectorFor = (receipt: AuthorizeCredentialMaterializationInput): ObserveCredentialMaterializationAuthorizationInput => Object.freeze({
  authorizationRequestId: receipt.authorizationRequestId, requestDigest: receipt.requestDigest,
  tenantId: receipt.tenantId, projectId: receipt.projectId, provider: receipt.provider, scopeDigest: receipt.scopeDigest,
});

/** Retains freshness only, not another operation state machine or durable PA repository. */
class CredentialRenderingAdapter {
  readonly #selection: CredentialRenderingSelection;
  readonly #authorization: CredentialMaterializationAuthorizationV1;
  readonly #acquisition: CredentialGenerationAcquisition | undefined;
  readonly #material: CredentialGenerationMaterialLifetime | undefined;
  readonly #fresh = new Set<CredentialMaterializationAuthorizationReceipt>();
  readonly #pending = new Set<CredentialRenderingLifetime>();
  #admissions = 0;
  #closed = false;

  constructor(selection: CredentialRenderingSelection, authorization: CredentialMaterializationAuthorizationV1,
    acquisition: CredentialGenerationAcquisition | undefined, material: CredentialGenerationMaterialLifetime | undefined) {
    this.#selection = selection;
    this.#authorization = authorization;
    this.#acquisition = acquisition;
    this.#material = material;
  }
  dispose(): void {
    this.#closed = true;
    this.#material?.dispose();
    this.#fresh.clear();
    for (const pending of this.#pending) {pending.close();}
    this.#pending.clear();
  }
  #open(): boolean {
    try {
      if (!this.#closed && !signalAborted(this.#selection.operationAbortSignal)) {
        const remaining = this.#selection.deadline - performance.now();
        if (remaining > 0 && remaining <= 2_147_483_647) {return true;}
      }
    } catch { /* A mutated signal is unavailable authority, without invoking shadows. */ }
    this.dispose(); return false;
  }
  #begin(): CredentialRenderingLifetime {
    const lifetime = new CredentialRenderingLifetime(this.#selection.operationAbortSignal, this.#selection.deadline);
    this.#pending.add(lifetime);
    return lifetime;
  }
  #finish(lifetime: CredentialRenderingLifetime): void {lifetime.close(); this.#pending.delete(lifetime);}
  #bindingMatches(command: AuthorizeCredentialMaterializationInput): boolean {
    const binding = this.#selection.binding;
    return (Object.keys(binding) as (keyof typeof binding)[]).every(key => command[key] === binding[key]);
  }
  async authorize(input: AuthorizeCredentialMaterializationInput): Promise<AuthorizeCredentialMaterializationOutcome> {
    let command: AuthorizeCredentialMaterializationInput;
    try {command = snapshotAuthorizationCommand(detachedDispatchData("render authorization", input));}
    catch {return Object.freeze({kind: "invalid", reason: "invalid_request"});}
    if (!this.#bindingMatches(command)) {return Object.freeze({kind: "invalid", reason: "invalid_request"});}
    if (!this.#open() || this.#admissions >= 256 || this.#pending.size >= 256) {return indeterminate;}
    // Reserve before the first await. Burned slots are never recycled, even on failure.
    this.#admissions += 1;
    const lifetime = this.#begin();
    try {
      lifetime.check();
      const outcome = await lifetime.wait(this.#authorization.authorize(command));
      if (!this.#open()) {return indeterminate;}
      if (outcome.kind === "authorized") {
        if (!sameReceipt(outcome.receipt, command) || command.availability !== "available" || command.revocation !== "active") {
          this.dispose(); return indeterminate;
        }
        this.#fresh.add(outcome.receipt);
      }
      if (outcome.kind !== "authorized" && outcome.kind !== "observed") {this.dispose();}
      return outcome;
    } catch {this.dispose(); return indeterminate;}
    finally {this.#finish(lifetime);}
  }
  async observe(input: ObserveCredentialMaterializationAuthorizationInput): Promise<ObserveCredentialMaterializationAuthorizationOutcome> {
    let selector: ObserveCredentialMaterializationAuthorizationInput;
    try {selector = snapshotAuthorizationOwnerSelector(detachedDispatchData("render observation", input));}
    catch {return indeterminate;}
    const binding = this.#selection.binding;
    if (!this.#open() || this.#pending.size >= 256 || selector.tenantId !== binding.tenantId ||
      selector.projectId !== binding.projectId || selector.scopeDigest !== binding.scopeDigest || selector.provider !== binding.provider) {
      return indeterminate;
    }
    const lifetime = this.#begin();
    try {
      const outcome = await lifetime.wait(this.#authorization.observe(selector));
      if (outcome.kind !== "observed") {this.dispose();}
      return outcome;
    }
    catch {this.dispose(); return indeterminate;}
    finally {this.#finish(lifetime);}
  }
  async #reobserve(receipt: CredentialMaterializationAuthorizationReceipt, lifetime: CredentialRenderingLifetime): Promise<void> {
    lifetime.check();
    const current = await lifetime.wait(this.#authorization.observe(selectorFor(receipt)));
    if (!this.#open() || current.kind !== "observed" || !sameReceipt(current.receipt, receipt)) {
      throw new TypeError("credential rendering unavailable");
    }
  }
  async render(receipt: CredentialMaterializationAuthorizationReceipt): Promise<CredentialRenderingOutcome> {
    // Object identity, not a structural receipt/digest, is the retained capability.
    if (!this.#open() || !this.#fresh.delete(receipt)) {return denied;}
    if (this.#pending.size >= 256) {return denied;}
    if (!this.#acquisition) {this.dispose(); return unsupported;}
    const lifetime = this.#begin();
    let credentials: RenderedCredentialFields | undefined;
    let received: Promise<RenderedCredentialFields | undefined> | undefined;
    let transferred = false;
    try {
      await this.#reobserve(receipt, lifetime);
      lifetime.check();
      const request: CredentialGenerationRequest = Object.freeze({
        operationRef: this.#selection.operationRef, recipe: this.#selection.recipe, authorization: receipt,
      });
      this.#material?.acceptRequest(request);
      received = lifetime.receive(this.#acquisition.acquire(request, lifetime.signal), request);
      // Always retain a cleanup observer before racing an abort/deadline.
      void received.then(value => {if (!this.#open()) {value?.release();} return null;}, () => null);
      credentials = await lifetime.wait(received);
      if (!credentials) {this.dispose(); return unsupported;}
      await this.#reobserve(receipt, lifetime);
      lifetime.check();
      if (!this.#open()) {return denied;}
      transferred = true;
      return Object.freeze({kind: "rendered", credentials});
    } catch {this.dispose(); return denied;}
    finally {
      this.#finish(lifetime);
      if (!transferred) {
        credentials?.release();
        if (received) {void received.then(value => {value?.release(); return null;}, () => null);}
      }
    }
  }
}

export const createCredentialRenderingAdapter = (selection: CredentialRenderingSelection,
  authorization: CredentialMaterializationAuthorizationV1, acquisition: CredentialGenerationAcquisition | undefined,
  material?: CredentialGenerationMaterialLifetime,
): CredentialRenderingOwner => {
  const owner = new CredentialRenderingAdapter(selection, authorization, acquisition, material);
  return Object.freeze({
    authorization: Object.freeze({
      authorize: async (input: AuthorizeCredentialMaterializationInput) => owner.authorize(input),
      observe: async (input: ObserveCredentialMaterializationAuthorizationInput) => owner.observe(input),
    }),
    rendering: Object.freeze({render: async (receipt: CredentialMaterializationAuthorizationReceipt) => owner.render(receipt)}),
    dispose: () => {owner.dispose();},
  });
};
