import { canonicalJson } from "../../../domain/dispatch-consumption.js";
import { AUTHORIZATION_COMMAND_KEYS, snapshotAuthorizationCommand } from "../../../domain/materialization-authorization.js";
import { exactDispatchDataRecord } from "../../dispatch-consumption-data.js";
import { createSha256DispatchConsumptionDigest } from "../sha256-dispatch-consumption-digest.js";
import type { MaterializationAuthorizationBinding } from "../../../application/ports/outbound/materialization-authorization-repository.js";
import type { CredentialRecipe } from "../credential-rendering-contracts.js";

export type RouteSelectionDescriptor = Readonly<{
  id: string; provider: "codex" | "claude"; credentialMode: string; originHost: string; originPort: 443;
  upstreamMethod: "POST"; upstreamPath: string; forwardedRequestHeaderNames: readonly string[];
  credentialFieldNames: readonly string[]; requiredHeaderNames: readonly string[]; exactValues: Readonly<Record<string, string>>;
}>;
export type RouteSelectionFacts = Readonly<{
  binding: MaterializationAuthorizationBinding; recipe: CredentialRecipe; descriptor: RouteSelectionDescriptor;
}>;
export type RouteSelectionCurrent = RouteSelectionFacts & Readonly<{routeGeneration: string; routeAuthorityDigest: string}>;
export const routeSelectionDigest = (facts: RouteSelectionFacts): Promise<string> => createSha256DispatchConsumptionDigest().digest(
  canonicalJson({purpose: "provider-access.contained-turn.route-selection/v1", binding: facts.binding, recipe: facts.recipe, descriptor: facts.descriptor}));

// PA recipe associations only. Host owns the versioned presentation-header catalog and exact values.
const association = (recipe: unknown): readonly unknown[] => {
  switch (recipe) {
    case "codex-chatgpt": return ["codex", "codex-chatgpt-responses/v1", "chatgpt-account", "chatgpt.com", "/backend-api/codex/responses", ["authorization", "chatgpt-account-id"]];
    case "codex-api": return ["codex", "codex-api-key-responses/v1", "api-key", "api.openai.com", "/v1/responses", ["authorization"]];
    case "claude-oauth": return ["claude", "claude-authorization-messages/v1", "authorization", "api.anthropic.com", "/v1/messages?beta=true", ["authorization"]];
    case "claude-api": return ["claude", "claude-api-key-messages/v1", "api-key", "api.anthropic.com", "/v1/messages?beta=true", ["x-api-key"]];
    default: throw new TypeError("Invalid PA route recipe");
  }
};
const excluded = ["authorization", "chatgpt-account-id", "x-api-key", "cookie", "set-cookie", "host", "connection", "content-length",
  "transfer-encoding", "trailer", "te", "upgrade", "expect", "keep-alive", "accept-encoding"];
const headers = (input: unknown): readonly string[] => {
  if (!Array.isArray(input) || input.length === 0 || input.length > 24 || new Set(input).size !== input.length ||
    input.some(name => typeof name !== "string" || !/^[a-z][a-z0-9-]{0,63}$/u.test(name) || excluded.includes(name) || name.startsWith("proxy-"))) {
    throw new TypeError("Invalid PA route presentation headers");
  }
  return input as readonly string[];
};
const descriptorSnapshot = (input: unknown, provider: string, recipe: unknown): RouteSelectionDescriptor => {
  const data = exactDispatchDataRecord("PA route descriptor", input, ["id", "provider", "credentialMode", "originHost", "originPort",
    "upstreamMethod", "upstreamPath", "forwardedRequestHeaderNames", "credentialFieldNames", "requiredHeaderNames", "exactValues"]);
  const tuple = [data.provider, data.id, data.credentialMode, data.originHost, data.upstreamPath, data.credentialFieldNames];
  if (provider !== data.provider || data.originPort !== 443 || data.upstreamMethod !== "POST" || canonicalJson(tuple) !== canonicalJson(association(recipe))) {
    throw new TypeError("Invalid PA route recipe association");
  }
  const forwarded = headers(data.forwardedRequestHeaderNames);
  const required = headers(data.requiredHeaderNames);
  if (!required.includes("content-type") || required.some(name => !forwarded.includes(name))) {throw new TypeError("Invalid PA route required headers");}
  const values = data.exactValues;
  if (!values || typeof values !== "object" || Array.isArray(values)) {throw new TypeError("Invalid PA route exact values");}
  const exact = values as Record<string, unknown>;
  if (exact["content-type"] !== "application/json" || Object.entries(exact).some(([name, value]) =>
    !required.includes(name) || typeof value !== "string" || !/^[\x20-\x7e]{1,512}$/u.test(value) || value.trim() !== value)) {
    throw new TypeError("Invalid PA route exact headers");
  }
  return data as unknown as RouteSelectionDescriptor;
};
export const snapshotRouteSelectionFacts = (input: unknown): RouteSelectionFacts => {
  const data = exactDispatchDataRecord("PA route selection", input, ["binding", "recipe", "descriptor"]);
  const keys = AUTHORIZATION_COMMAND_KEYS.filter(key => !["authorizationRequestId", "requestDigest", "purpose", "schemaVersion"].includes(key));
  const binding = exactDispatchDataRecord("PA route binding", data.binding, keys);
  snapshotAuthorizationCommand({...binding, authorizationRequestId: "route:selection", requestDigest: "route:selection",
    purpose: "contained-turn.credential-materialization-authorization/v1", schemaVersion: 1});
  if (binding.availability !== "available" || binding.revocation !== "active") {throw new TypeError("PA route binding unavailable");}
  return Object.freeze({binding: binding as unknown as MaterializationAuthorizationBinding, recipe: data.recipe as CredentialRecipe,
    descriptor: descriptorSnapshot(data.descriptor, binding.provider as string, data.recipe)});
};

export const snapshotRouteSelectionCurrent = async (input: unknown): Promise<RouteSelectionCurrent> => {
  const data = exactDispatchDataRecord("PA route endorsement", input, ["binding", "recipe", "descriptor", "routeGeneration", "routeAuthorityDigest"]);
  const facts = snapshotRouteSelectionFacts({binding: data.binding, recipe: data.recipe, descriptor: data.descriptor});
  const routeAuthorityDigest = await routeSelectionDigest(facts);
  const routeGeneration = String(facts.binding.bindingRevision);
  if (data.routeAuthorityDigest !== routeAuthorityDigest || data.routeGeneration !== routeGeneration) {throw new TypeError("Invalid PA route endorsement digest or generation");}
  return Object.freeze({...facts, routeAuthorityDigest, routeGeneration});
};
