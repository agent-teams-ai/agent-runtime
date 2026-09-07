import assert from "node:assert/strict";
import { createContainedTurnFeature, type ContainedTurnFeatureDependencies } from "../../../../dist/composition.js";
import { containedTurnIdentity } from "../../../../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import { createDependencies } from "./contained-agent-turn-fixture.ts";

export const joinedAeSubmit = (providerAccess: ContainedTurnFeatureDependencies["providerAccess"], security: ContainedTurnFeatureDependencies["security"], scope: {projectId: string; tenantId: string}, intent: {mode: "analysis"; prompt: string}) => {
  return async (id: string, beforeConsume?: (input: Parameters<ContainedTurnFeatureDependencies["providerAccess"]["consumeForDispatch"]>[0]) => Promise<void>, potentialAcceptance = false) => {
    const ae = createDependencies({potentialAcceptance});
    let handoff: Parameters<ContainedTurnFeatureDependencies["providerAccess"]["consumeForDispatch"]>[0] | undefined;
    const dependencies: ContainedTurnFeatureDependencies = {...ae.dependencies, security,
      custody: {...ae.dependencies.custody, async open(input) {
        const custody = await ae.dependencies.custody.open(input);
        return {...custody, hostCustodyProof: {...custody.hostCustodyProof, binding: {...custody.hostCustodyProof.binding, effectId: containedTurnIdentity("effect", `effect:${id}`)}}};
      }},
      operationStore: {...ae.dependencies.operationStore, async read(request) {
        const current = ae.current();
        return current?.operationId === request.operationId && current.scope.tenantId === request.scope.tenantId && current.scope.projectId === request.scope.projectId ? current : undefined;
      }, async identifyAcceptance() {
        return {kind: "available", operationId: containedTurnIdentity("operation", `operation:${id}`),
          effectId: containedTurnIdentity("effect", `effect:${id}`), acceptanceProofId: containedTurnIdentity("proof", `proof:acceptance:${id}`), operationAuthorityRevision: "operation-authority:one"};
      }},
      providerAccess: Object.freeze<ContainedTurnFeatureDependencies["providerAccess"]>({...providerAccess, async consumeForDispatch(input) {
        handoff = input; await beforeConsume?.(input); return providerAccess.consumeForDispatch(input);
      }}),
    };
    assert.deepEqual(Object.keys(dependencies).toSorted(), ["artifacts", "custody", "operationStore", "provider", "providerAccess", "security", "workspace"]);
    const feature = createContainedTurnFeature(dependencies);
    const result = await feature.submit.execute({commandId: `command:${id}`, expectedProvider: "codex", intent, scope});
    return {ae, handoff, result, feature};
  };
};
