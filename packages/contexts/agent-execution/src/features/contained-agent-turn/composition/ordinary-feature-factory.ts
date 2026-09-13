import {createOrdinaryEngine} from "../application/ordinary-engine.js";
import {ORDINARY_DEPENDENCY_NAMES, type OrdinaryTurnDependencies} from "../application/ordinary-ports.js";
import type {ContainedTurnFeatureApi} from "../contracts/contained-agent-turn.js";
import {ORDINARY_PROFILE} from "../domain/ordinary-model.js";
import {assertContainedTurnExactRecord} from "../domain/contained-turn-record.js";
export interface OrdinaryFeature extends ContainedTurnFeatureApi {dispose(): Promise<void>}
export const createOrdinaryTurnFeature = (dependencies: OrdinaryTurnDependencies): OrdinaryFeature => {
  assertContainedTurnExactRecord("ordinary dependencies", dependencies, ORDINARY_DEPENDENCY_NAMES);
  if (dependencies.provider.supported.executionProfile !== ORDINARY_PROFILE.executionProfile || dependencies.provider.supported.capabilityManifestRevision !== ORDINARY_PROFILE.capabilityManifestRevision) {throw new TypeError("ordinary provider profile mismatch");}
  const feature = createOrdinaryEngine(Object.freeze({...dependencies}));
  const api: OrdinaryFeature = {
    submit: {execute: (input, options) => feature.submit.execute({commandId: input.commandId, expectedProvider: input.expectedProvider, intent: {mode: input.intent.mode, prompt: input.intent.prompt}, scope: {tenantId: input.scope.tenantId, projectId: input.scope.projectId}}, options === undefined ? undefined : {...(options.signal === undefined ? {} : {signal: options.signal}), ...(options.onAccepted === undefined ? {} : {onAccepted: options.onAccepted})})},
    observe: {execute: input => feature.observe.execute({operationId: input.operationId, scope: {tenantId: input.scope.tenantId, projectId: input.scope.projectId}})},
    cancel: {execute: input => feature.cancel.execute({operationId: input.operationId, scope: {tenantId: input.scope.tenantId, projectId: input.scope.projectId}})},
    dispose: () => feature.dispose(),
  };
  return Object.freeze(api);
};
