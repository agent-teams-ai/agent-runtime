import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { createOperationCredentialGenerationAcquisition } from "../../../dist/features/contained-turn-access/adapters/outbound/operation-credential-generation-acquisition.js";
import { createCredentialRenderingAdapter } from "../../../dist/features/contained-turn-access/adapters/outbound/credential-rendering-owner.js";
import { createContainedTurnCredentialMaterializationAuthorizationV1 } from "../../../dist/features/contained-turn-access/composition/materialization-authorization-v1-factory.js";
import type {
  CredentialGenerationOutcome, CredentialGenerationRequest, CredentialRecipe, CredentialRenderingSelection,
  OperationCredentialMaterial, PrivateCredentialField,
} from "../../../dist/features/contained-turn-access/adapters/outbound/credential-rendering-contracts.js";
import { renderingFixture, syntheticBytes } from "./credential-rendering-test-fixture.ts";

export const materialFor = (selection: CredentialRenderingSelection): OperationCredentialMaterial => ({
  operationRef: selection.operationRef, binding: {...selection.binding}, recipe: selection.recipe,
  fields: selection.recipe === "codex-chatgpt"
    ? [{name: "token", valueBytes: syntheticBytes("synthetic-token")}, {name: "accountId", valueBytes: syntheticBytes("synthetic-account")}]
    : [{name: selection.recipe === "claude-api" ? "apiKey" : "token", valueBytes: syntheticBytes("synthetic-key")}],
});
export const acquired = (result: CredentialGenerationOutcome) => {
  assert.equal(result.kind, "acquired");
  if (result.kind !== "acquired") {throw new Error("synthetic acquisition expected");}
  return result;
};
export const wipe = (fields: readonly PrivateCredentialField[]) => {for (const field of fields) {field.valueBytes.fill(0);}};

/** Test-only visibility into allocations, never an extra production material capability. */
export const watchBytes = (t: TestContext) => {
  const Native = Uint8Array;
  const allocations: Uint8Array[] = [];
  t.mock.method(globalThis, "Uint8Array", function (value: number | ArrayBuffer) {
    const bytes = typeof value === "number" ? new Native(value) : new Native(value);
    allocations.push(bytes); return bytes;
  } as never);
  return allocations;
};

export const acquisitionFixture = (recipe: CredentialRecipe = "codex-chatgpt") => {
  const fixture = renderingFixture(recipe);
  const source = createOperationCredentialGenerationAcquisition(fixture.selection);
  const results: CredentialGenerationOutcome[] = [];
  const signals: AbortSignal[] = [];
  const requests: CredentialGenerationRequest[] = [];
  const hooks: {after?: () => Promise<void>; delivery?: (value: CredentialGenerationOutcome) => Promise<CredentialGenerationOutcome>} = {};
  const owner = createCredentialRenderingAdapter(fixture.selection,
    createContainedTurnCredentialMaterializationAuthorizationV1(fixture.dependencies), {
      async acquire(request, signal) {
        requests.push(request); signals.push(signal);
        const result = await source.acquisition.acquire(request, signal); results.push(result);
        await hooks.after?.();
        return hooks.delivery ? hooks.delivery(result) : result;
      },
    }, source.lifetime);
  return {...fixture, source, owner, results, signals, requests, hooks};
};

export const permittedRequest = async (fixture: ReturnType<typeof acquisitionFixture>, id = "request:synthetic") => {
  const receipt = await fixture.fresh(fixture.owner, await fixture.request({authorizationRequestId: id}));
  return Object.freeze({operationRef: fixture.selection.operationRef, recipe: fixture.selection.recipe, authorization: receipt});
};
