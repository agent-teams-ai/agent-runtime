import { AUTHORIZATION_COMMAND_KEYS, snapshotAuthorizationRecord } from "../../domain/materialization-authorization.js";
import { exactProviderAccessDataRecord } from "../provider-access-data.js";
import { exactCredentialData } from "./credential-rendering-bytes.js";
import type {
  CredentialGenerationAcquisition, CredentialGenerationMaterialLifetime, CredentialGenerationOutcome,
  CredentialGenerationRequest, CredentialRenderingSelection, OperationCredentialMaterial,
  OperationCredentialMaterialAdmission, PrivateCredentialField,
} from "./credential-rendering-contracts.js";
import { signalAborted } from "./credential-rendering-lifetime.js";
import { copyOperationMaterial, eraseOperationMaterial, inspectOperationMaterial, transferOperationMaterial } from "./operation-credential-material-bytes.js";
import { snapshotCredentialRenderingSelection } from "./operation-credential-selection.js";

const unavailable = (): never => {throw new TypeError("operation credential material unavailable");};
const admitted = Object.freeze({kind: "admitted" as const});
const rejected = Object.freeze({kind: "rejected" as const});
const addListener = EventTarget.prototype.addEventListener;
const removeListener = EventTarget.prototype.removeEventListener;
const dependentSignal = AbortSignal.any;

/** One seed, no discovery, refresh, retry, durable authority or cross-operation reuse. */
class OperationCredentialGenerationAcquisition {
  readonly #selection: CredentialRenderingSelection;
  readonly #consumed = new Set<CredentialGenerationRequest>();
  #accepted: CredentialGenerationRequest | undefined;
  #seed: readonly PrivateCredentialField[] | undefined;
  #attempted = false;
  #closed = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #signal: AbortSignal | undefined;
  readonly #retire = () => {this.dispose();};

  constructor(selection: CredentialRenderingSelection) {this.#selection = snapshotCredentialRenderingSelection(selection);}

  dispose(): void {
    this.#closed = true;
    this.#accepted = undefined;
    this.#consumed.clear();
    if (this.#seed) {eraseOperationMaterial(this.#seed); this.#seed = undefined;}
    if (this.#timer !== undefined) {clearTimeout(this.#timer); this.#timer = undefined;}
    if (this.#signal) {
      Reflect.apply(removeListener, this.#signal, ["abort", this.#retire]);
      this.#signal = undefined;
    }
  }
  #check(): void {
    try {
      if (!this.#closed && !signalAborted(this.#selection.operationAbortSignal)) {
        const remaining = this.#selection.deadline - performance.now();
        if (remaining > 0 && remaining <= 2_147_483_647) {return;}
      }
    } catch { /* Unavailable operation signal also retires local custody. */ }
    this.dispose(); unavailable();
  }
  #matches(value: unknown): boolean {
    const keys = Object.keys(this.#selection.binding) as (keyof CredentialRenderingSelection["binding"])[];
    const binding = exactProviderAccessDataRecord("operation material binding", value, keys);
    return keys.every(key => binding[key] === this.#selection.binding[key]);
  }
  #startLifetime(): void {
    const remaining = this.#selection.deadline - performance.now();
    if (remaining <= 0 || remaining > 2_147_483_647) {unavailable();}
    // A private dependent signal cannot lose idle cleanup to stopImmediatePropagation.
    this.#signal = Reflect.apply(dependentSignal, AbortSignal, [[this.#selection.operationAbortSignal]]) as AbortSignal;
    Reflect.apply(addListener, this.#signal, ["abort", this.#retire, {once: true}]);
    this.#timer = setTimeout(this.#retire, remaining);
    this.#check();
  }
  admit(material: OperationCredentialMaterial): ReturnType<OperationCredentialMaterialAdmission["admit"]> {
    if (this.#attempted || this.#closed) {return rejected;}
    this.#attempted = true;
    try {
      this.#check();
      const data = exactCredentialData(material, ["operationRef", "binding", "recipe", "fields"]);
      if (data.operationRef?.value !== this.#selection.operationRef || data.recipe?.value !== this.#selection.recipe ||
        !this.#matches(data.binding?.value)) {return rejected;}
      const fields = inspectOperationMaterial(data.fields?.value, this.#selection.recipe);
      // All validation precedes ownership transfer. A transfer failure salvages its own partial result.
      this.#seed = transferOperationMaterial(fields);
      this.#startLifetime();
      return admitted;
    } catch {this.dispose(); return rejected;}
  }
  acceptRequest(request: CredentialGenerationRequest): void {
    // Called only by the same rendering owner after consuming freshness and rereading PA.
    // One synchronous handoff slot: accepting a second request cannot leave stale permits.
    this.#accepted = undefined;
    this.#check();
    const data = exactCredentialData(request, ["operationRef", "recipe", "authorization"]);
    if (data.operationRef?.value !== this.#selection.operationRef || data.recipe?.value !== this.#selection.recipe) {unavailable();}
    const receipt = snapshotAuthorizationRecord(exactProviderAccessDataRecord("operation material receipt", data.authorization?.value,
      [...AUTHORIZATION_COMMAND_KEYS, "decision", "rejectionReason"]));
    if (!Object.isFrozen(request) || !Object.isFrozen(data.authorization?.value)) {unavailable();}
    const keys = Object.keys(this.#selection.binding) as (keyof CredentialRenderingSelection["binding"])[];
    if (receipt.decision !== "authorized" || receipt.rejectionReason !== null ||
      !keys.every(key => receipt[key] === this.#selection.binding[key]) ||
      receipt.availability !== "available" || receipt.revocation !== "active") {unavailable();}
    this.#accepted = request;
  }
  async acquire(request: CredentialGenerationRequest, signal: AbortSignal): Promise<CredentialGenerationOutcome> {
    const accepted = this.#accepted;
    this.#accepted = undefined;
    this.#check();
    if (accepted !== request || this.#consumed.has(request) || this.#consumed.size >= 256) {unavailable();}
    // Burn identity before cancellation, allocation or promise completion; never restore it.
    this.#consumed.add(request);
    if (signalAborted(signal)) {unavailable();}
    if (!this.#seed) {return Object.freeze({kind: "unsupported"});}
    let fields: readonly PrivateCredentialField[] | undefined;
    try {
      fields = copyOperationMaterial(this.#seed);
      this.#check();
      if (signalAborted(signal)) {unavailable();}
      return Object.freeze({kind: "acquired", request, fields});
    } catch {if (fields) {eraseOperationMaterial(fields);} return unavailable();}
  }
}

/** PA-private capabilities. Construction performs no material/clock reads or resource activation. */
export const createOperationCredentialGenerationAcquisition = (selection: CredentialRenderingSelection): {
  readonly acquisition: CredentialGenerationAcquisition;
  readonly admission: OperationCredentialMaterialAdmission;
  readonly lifetime: CredentialGenerationMaterialLifetime;
} => {
  const owner = new OperationCredentialGenerationAcquisition(selection);
  return Object.freeze({
    acquisition: Object.freeze({acquire: (request: CredentialGenerationRequest, signal: AbortSignal) => owner.acquire(request, signal)}),
    admission: Object.freeze({admit: (material: OperationCredentialMaterial) => owner.admit(material)}),
    lifetime: Object.freeze({acceptRequest: (request: CredentialGenerationRequest) => {owner.acceptRequest(request);}, dispose: () => {owner.dispose();}}),
  });
};
