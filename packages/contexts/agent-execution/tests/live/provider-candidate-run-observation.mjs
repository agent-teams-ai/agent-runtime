import { observeProviderCandidateResult } from "./provider-candidate-observation.mjs";

// Local to one canary invocation; this collector observes cleanup, never grants
// kernel or route authority. It also retains facts on the failure path.
export const createCandidateRunObservation = () => {
  let facts = {ownerDisposal: "not_observed", runtimeDisposal: "not_observed"};
  let physicalContainment = "indeterminate";
  return Object.freeze({
    result(result) {
      facts = {...facts, ...observeProviderCandidateResult(result)};
      physicalContainment = result.physicalContainment.kind;
    },
    completed(observations) {facts = {...facts, ...observations};},
    closure(closure) {
      if (closure !== undefined) {
        facts = {...facts, closureStatus: closure.status, containmentProfile: closure.profile,
          containmentLimitations: Object.freeze([...closure.limitations])};
      }
    },
    async dispose(kind, action) {
      if (!["ownerDisposal", "runtimeDisposal"].includes(kind)) {throw new TypeError("unknown canary disposal");}
      try {await action(); facts = {...facts, [kind]: "completed"};}
      catch (error) {facts = {...facts, [kind]: "failed"}; throw error;}
    },
    evidence(status) {
      return Object.freeze({
        compositeContainment: "indeterminate", physicalContainment, status,
        observations: Object.freeze({...facts, ...(status === "failed" ? {failureKind: "canary-failed"} : {})}),
      });
    },
  });
};
