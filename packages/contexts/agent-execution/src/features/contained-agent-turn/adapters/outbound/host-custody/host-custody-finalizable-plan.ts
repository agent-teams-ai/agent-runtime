import type { HostCustodyLaunchPlan } from "./custodied-provider-process.js";
import { assertInertHostLaunchData, createImmutableHostCustodyLaunchPlan } from "./host-custody-launch-plan-snapshot.js";

/** Adapter-private issuance, never a registration operation on an existing plan.
 * The provider captures original inputs; Host owns immutable retention and the
 * requirement to finish before first start. No caller flag grants that authority.
 */
export interface HostLaunchFinalizationRecipe {
  readonly providerAccess: Readonly<{provider: string; providerRouteRef: string; credentialGeneration: number;
    credentialBindingRef: string; ownerAuthorityDigest: string}>;
  build(material: unknown, localCapability: string): Readonly<{
    plan: HostCustodyLaunchPlan;
    materialSha256: string;
    validate(): void;
  }>;
}
const recipes = new WeakMap<object, HostLaunchFinalizationRecipe>();

export const createFinalizableHostCustodyLaunchPlan = <Plan extends HostCustodyLaunchPlan>(
  input: Parameters<typeof createImmutableHostCustodyLaunchPlan<Plan>>[0],
  recipe: HostLaunchFinalizationRecipe,
): ReturnType<typeof createImmutableHostCustodyLaunchPlan<Plan>> => {
  assertInertHostLaunchData(recipe);
  assertInertHostLaunchData(recipe.providerAccess);
  const plan = createImmutableHostCustodyLaunchPlan<Plan>(input);
  recipes.set(plan, Object.freeze({build: recipe.build.bind(recipe), providerAccess: Object.freeze({
    provider: recipe.providerAccess.provider, providerRouteRef: recipe.providerAccess.providerRouteRef,
    credentialGeneration: recipe.providerAccess.credentialGeneration,
    credentialBindingRef: recipe.providerAccess.credentialBindingRef, ownerAuthorityDigest: recipe.providerAccess.ownerAuthorityDigest,
  })}));
  return plan;
};

export const hostLaunchFinalizationRecipe = (plan: HostCustodyLaunchPlan): HostLaunchFinalizationRecipe | undefined =>
  recipes.get(plan);
