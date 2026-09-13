import type {
  InspectClaudeCodeConfiguration,
  InspectClaudeCodeConfigurationInput,
  InspectClaudeCodeConfigurationResult,
} from "../../contracts/claude-code-configuration-inspection.js";
import type {
  ClaudeCodeInspectionRequest,
  InspectClaudeCodeConfigurationUseCase,
} from "../../application/models/claude-code-inspection-models.js";

/** Perimeter check, not the owner of the rule. The use case already refuses an
 * unstable identityScope before touching any port; repeating emptiness here is
 * about rejecting a malformed transport request at the edge. */
const request = (input: InspectClaudeCodeConfigurationInput): ClaudeCodeInspectionRequest => {
  if (input.identityScope.length === 0) {
    throw new TypeError("identityScope must not be empty");
  }
  return input;
};

/** Projects the application outcome onto the published contract. The two shapes
 * coincide today, so this is a structural pass-through; its value is that either
 * declaration can move without the other, and that the use case never names a
 * transport type. */
export const createClaudeCodeConfigurationInspectionV1 = (
  useCase: InspectClaudeCodeConfigurationUseCase,
): InspectClaudeCodeConfiguration => Object.freeze({
  async execute(
    input: InspectClaudeCodeConfigurationInput,
    options?: { readonly signal?: AbortSignal },
  ): Promise<InspectClaudeCodeConfigurationResult> {
    return useCase.execute(request(input), options);
  },
});
