import type {
  AcknowledgeCredentialCleanupInput, AuthorizeCredentialMaterializationInput, CredentialMaterializationAuthorizationV1,
  ObserveCredentialMaterializationInput, TransitionCredentialMaterializationInput,
} from "../contracts/materialization-authorization-v1.js";
import { createCredentialMaterializationAuthorizationV1 } from "../application/materialization-authorization-v1.js";
import type { MaterializationAuthorizationDigest } from "../application/ports/outbound/materialization-authorization-digest.js";
import type { MaterializationAuthorizationRepository } from "../application/ports/outbound/materialization-authorization-repository.js";

export const createContainedTurnCredentialMaterializationAuthorizationV1 = (dependencies: {
  readonly digest: MaterializationAuthorizationDigest;
  readonly repository: MaterializationAuthorizationRepository;
}): CredentialMaterializationAuthorizationV1 => {
  const useCase = createCredentialMaterializationAuthorizationV1(dependencies);
  return Object.freeze({
    acknowledgeCleanup: (input: AcknowledgeCredentialCleanupInput) => useCase.acknowledgeCleanup(input),
    authorize: (input: AuthorizeCredentialMaterializationInput) => useCase.authorize(input),
    observe: (input: ObserveCredentialMaterializationInput) => useCase.observe(input),
    transition: (input: TransitionCredentialMaterializationInput) => useCase.transition(input),
  });
};
