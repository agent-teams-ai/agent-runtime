export { createNodePathCanonicalizer } from "./adapters/outbound/node-path-canonicalizer.js";
export type { PathCanonicalizer } from "./application/ports/outbound/path-canonicalizer.js";
export {
  createSetupInspectionAuthorizationFeature,
  type SetupInspectionAuthorizationDependencies,
} from "./composition/feature-module-factory.js";
