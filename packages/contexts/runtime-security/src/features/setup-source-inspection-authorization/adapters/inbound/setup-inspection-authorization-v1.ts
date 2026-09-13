import type {
  AuthorizeSetupInspection as AuthorizeSetupInspectionV1,
  AuthorizeSetupInspectionInput as AuthorizeSetupInspectionV1Input,
} from "../../contracts/setup-inspection-authorization.js";
import type {
  AuthorizeSetupInspection,
  AuthorizeSetupInspectionInput,
} from "../../application/models/setup-inspection-models.js";

/** Perimeter check, not the owner of the rule. The use case already refuses an
 * empty observation epoch and root set before touching any port; repeating the
 * request shape here keeps transport types off the application interface. */
const request = (input: AuthorizeSetupInspectionV1Input): AuthorizeSetupInspectionInput => input;

/** Projects the application outcome onto the published contract. The two shapes
 * coincide today, so this is a structural pass-through; its value is that either
 * declaration can move without the other, and that the use case never names a
 * transport type. */
export const createAuthorizeSetupInspectionV1 = (
  useCase: AuthorizeSetupInspection,
): AuthorizeSetupInspectionV1 => Object.freeze({
  execute(
    input: AuthorizeSetupInspectionV1Input,
    options?: { readonly signal?: AbortSignal },
  ) {
    return useCase.execute(request(input), options);
  },
});
