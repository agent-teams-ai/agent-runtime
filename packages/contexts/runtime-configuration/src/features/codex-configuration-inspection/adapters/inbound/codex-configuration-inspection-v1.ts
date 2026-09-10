import type {
  InspectCodexConfiguration,
  InspectCodexConfigurationInput,
  InspectCodexConfigurationResult,
} from "../../contracts/codex-configuration-inspection.js";
import type {
  CodexInspectionRequest,
  InspectCodexConfigurationUseCase,
} from "../../application/models/codex-inspection-models.js";

/** Perimeter check, not the owner of the rule. The use case owns the
 * identityScope invariant because it depends on it; repeating it here means an
 * invalid request is refused before any port is touched, so no source is read
 * and no digest is computed for input that cannot produce an answer. */
const request = (input: InspectCodexConfigurationInput): CodexInspectionRequest => {
  if (input.identityScope.length === 0) {
    throw new TypeError("identityScope must not be empty");
  }
  return input;
};

/** Projects the application outcome onto the published contract. The two shapes
 * coincide today, so this is a structural pass-through rather than a pretend
 * translation; its value is that either declaration can move without the other,
 * and that the use case never names a transport type. */
export const createCodexConfigurationInspectionV1 = (
  useCase: InspectCodexConfigurationUseCase,
): InspectCodexConfiguration => Object.freeze({
  async execute(
    input: InspectCodexConfigurationInput,
    options?: { readonly signal?: AbortSignal },
  ): Promise<InspectCodexConfigurationResult> {
    return useCase.execute(request(input), options);
  },
});
