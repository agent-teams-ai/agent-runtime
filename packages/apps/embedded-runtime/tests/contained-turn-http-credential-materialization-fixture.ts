import assert from "node:assert/strict";
import type {AuthorizeCredentialMaterializationOutcome, CredentialMaterializationAuthorizationReceipt} from "@agent-teams/provider-access";
import {createCredentialMaterializationRequestDigest} from "@agent-teams/provider-access/composition";
import {createContainedTurnHttpCredentialMaterialization} from "../dist/composition/contained-turn-http-provider-access.js";
import {renderingFixture} from "../../../contexts/provider-access/tests/features/contained-turn-access/credential-rendering-test-fixture.ts";
import type {CredentialGenerationAcquisition, CredentialRecipe, CredentialRenderingOutcome} from
  "../../../contexts/provider-access/dist/features/contained-turn-access/adapters/outbound/credential-rendering-contracts.js";

type Pair = ReturnType<typeof createContainedTurnHttpCredentialMaterialization>;
type Owner = Parameters<typeof createContainedTurnHttpCredentialMaterialization>[0];
type PaOutcome = AuthorizeCredentialMaterializationOutcome;
export type HostReceipt = Extract<Awaited<ReturnType<Pair["providerAccess"]["authorize"]>>, {receipt: unknown}>["receipt"];
type Options = Readonly<{
  recipe?: CredentialRecipe;
  acquisition?: CredentialGenerationAcquisition;
  afterAuthorize?(result: PaOutcome): Promise<unknown>;
  afterRender?(result: CredentialRenderingOutcome): Promise<Awaited<ReturnType<Owner["rendering"]["render"]>>>;
}>;

/** Instrument real PA factory/application results without replacing their decisions or receipt identities. */
export const pairedFixture = (options: Options = {}) => {
  const fixture = renderingFixture(options.recipe);
  const pa = fixture.create(options.acquisition);
  const outcomes: PaOutcome[] = [];
  const renderInputs: CredentialMaterializationAuthorizationReceipt[] = [];
  const renderedBuffers: Uint8Array[] = [];
  let disposals = 0;
  const owner: Owner = Object.freeze({
    authorization: Object.freeze({
      async authorize(input: Parameters<Owner["authorization"]["authorize"]>[0]) {
        const result = await pa.authorization.authorize(input); outcomes.push(result);
        return options.afterAuthorize ? options.afterAuthorize(result) : result;
      },
      observe: pa.authorization.observe,
    }),
    rendering: Object.freeze({
      async render(receipt: CredentialMaterializationAuthorizationReceipt) {
        renderInputs.push(receipt);
        const result = await pa.rendering.render(receipt);
        if (result.kind === "rendered") {renderedBuffers.push(...result.credentials.fields.map(field => field.valueBytes));}
        return options.afterRender ? options.afterRender(result) : result;
      },
    }),
    dispose() {disposals += 1; pa.dispose();},
  });
  const pair = createContainedTurnHttpCredentialMaterialization(owner, createCredentialMaterializationRequestDigest);
  const fresh = async (id = "request:fixture"): Promise<HostReceipt> => {
    const result = await pair.providerAccess.authorize(await fixture.request({authorizationRequestId: id}));
    assert.equal(result.kind, "authorized");
    if (result.kind !== "authorized") {throw new Error("fixture expected fresh Host authorization");}
    return result.receipt;
  };
  return {fixture, pa, owner, pair, fresh, outcomes, renderInputs, renderedBuffers, disposals: () => disposals};
};

export const hostWipe = (fields: Awaited<ReturnType<Pair["materializer"]["render"]>>): void => {
  for (const field of fields) {field.valueBytes.fill(0);}
};
