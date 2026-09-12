import type {
  AuthorizeClaudeCodeSetupInspection as AuthorizeClaudeCodeSetupInspectionV1,
  TrustedClaudeCodeSetupInspectionScope as TrustedClaudeCodeSetupInspectionScopeV1,
} from "../../contracts/claude-code-setup-inspection-authorization.js";
import type {
  AuthorizeClaudeCodeSetupInspection,
  TrustedClaudeCodeSetupInspectionScope,
} from "../../application/models/claude-code-setup-inspection-models.js";

/** Perimeter check, not the owner of the rule. The use case already refuses an
 * empty or oversized observation epoch before touching any port; repeating the
 * scope shape here keeps transport types off the application interface. */
const request = (
  input: TrustedClaudeCodeSetupInspectionScopeV1,
): TrustedClaudeCodeSetupInspectionScope => input;

/** Projects the application outcome onto the published contract. The two shapes
 * coincide today, so this is a structural pass-through; its value is that either
 * declaration can move without the other, and that the use case never names a
 * transport type. */
export const createAuthorizeClaudeCodeSetupInspectionV1 = (
  useCase: AuthorizeClaudeCodeSetupInspection,
): AuthorizeClaudeCodeSetupInspectionV1 => Object.freeze({
  execute(
    input: TrustedClaudeCodeSetupInspectionScopeV1,
    options?: { readonly signal?: AbortSignal },
  ) {
    return useCase.execute(request(input), options);
  },
});
