import type { ContainedTurnKernelCustodyPort } from "../../../application/ports/outbound/contained-turn-ports.js";
import type {
  ContainedTurnKernelCustodyAttemptOwner,
  ContainedTurnKernelWorkspaceOwner,
  KernelOpenInput,
} from "./contained-turn-kernel-custody-contracts.js";
import type { HostCustodyReservationInput } from "./custodied-provider-process.js";

// Bound retained fences for the entire owner lifetime; never evict or reopen them.
const MAX_OWNER_LIFETIME_OPEN_ATTEMPTS = 1024;

export interface KernelOpenAttempt {
  readonly input: KernelOpenInput;
  closed: boolean;
  acquisitionPossible: boolean;
  failedBeforeAcquisition: boolean;
}
/** Private owner-lifetime fencing and retirement for kernel open attempts. */
export class KernelOpenAttempts {
  readonly #openAttempts = new Map<string, KernelOpenAttempt>();
  readonly #consumedOperationAttempts = new Set<string>();

  public sealAdmission(): void {
    for (const attempt of this.#openAttempts.values()) {attempt.closed = true;}
  }

  public async open(
    input: KernelOpenInput,
    workspaceOwner: ContainedTurnKernelWorkspaceOwner,
    attemptOwner: ContainedTurnKernelCustodyAttemptOwner,
    openScoped: (
      input: KernelOpenInput,
      authority: HostCustodyReservationInput["workspaceAuthority"],
      attempt: KernelOpenAttempt,
    ) => ReturnType<ContainedTurnKernelCustodyPort["open"]>,
  ): ReturnType<ContainedTurnKernelCustodyPort["open"]> {
    // Keep failed identities fenced for this owner lifetime: absence is not proof,
    // and a duplicate call must never race preparation or resurrect acquisition.
    const operationAttempt = JSON.stringify([input.operationId, input.attemptId]);
    if (this.#openAttempts.has(input.custodyId) || this.#consumedOperationAttempts.has(operationAttempt)) {
      throw new TypeError("Host Custody kernel open attempt is already consumed");
    }
    // Refuse before workspace authority or attempt preparation. Saturation is permanent
    // for this owner, so refused identities cannot retry after cleanup frees resources.
    if (this.#openAttempts.size >= MAX_OWNER_LIFETIME_OPEN_ATTEMPTS) {
      throw new TypeError("Host Custody kernel owner lifetime open attempt limit reached");
    }
    input = Object.freeze({ ...input, adapterSnapshot: Object.freeze({ ...input.adapterSnapshot }),
      providerAccessSnapshot: Object.freeze({ ...input.providerAccessSnapshot }) });
    const attempt: KernelOpenAttempt = {
      input, closed: false, acquisitionPossible: false, failedBeforeAcquisition: false,
    };
    this.#openAttempts.set(input.custodyId, attempt);
    this.#consumedOperationAttempts.add(operationAttempt);
    let callbackEntered = false;
    let scoped: ReturnType<ContainedTurnKernelCustodyPort["open"]> | undefined;
    try {
      const ids = {attemptId: input.attemptId, operationId: input.operationId, workspaceId: input.workspaceId};
      const consume = (authority: HostCustodyReservationInput["workspaceAuthority"]) => {
        if (attempt.closed || callbackEntered) {
          throw new TypeError("Host Custody workspace authority is already consumed");
        }
        callbackEntered = true;
        scoped = openScoped(input, authority, attempt);
        return scoped;
      };
      return await workspaceOwner.withLaunchAuthority(ids, consume);
    } catch (error) {
      attempt.closed = true;
      // A workspace owner can reject while its callback is still preparing.
      // Fence raw acquisition and wait for preparation before retiring its record.
      await scoped?.catch(() => {});
      if (!attempt.acquisitionPossible) {
        attemptOwner.retire(input);
        attempt.failedBeforeAcquisition = true;
      }
      throw error;
    } finally {
      attempt.closed = true;
    }
  }

  public failedBeforeAcquisition(
    input: Readonly<{ attemptId: string; custodyId: string; operationId: string; workspaceId: string }>,
  ): KernelOpenAttempt | undefined {
    const attempt = this.#openAttempts.get(input.custodyId);
    return attempt?.failedBeforeAcquisition === true && attempt.input.attemptId === input.attemptId &&
      attempt.input.operationId === input.operationId &&
      attempt.input.workspaceId === input.workspaceId ? attempt : undefined;
  }
}
