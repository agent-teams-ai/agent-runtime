export {
  createContainedTurnProviderAccessFeature,
  type ContainedTurnProviderAccessDependencies,
} from "./features/contained-turn-access/composition/feature-module-factory.js";
export {
  createStaticProviderAccessBindingRepository,
} from "./features/contained-turn-access/adapters/outbound/static-provider-access-binding-repository.js";
export type {
  ProviderAccessBindingRepository,
} from "./features/contained-turn-access/application/ports/outbound/provider-access-binding-repository.js";
export type {
  ProviderAccessBindingRecord,
} from "./features/contained-turn-access/domain/provider-access-binding.js";
