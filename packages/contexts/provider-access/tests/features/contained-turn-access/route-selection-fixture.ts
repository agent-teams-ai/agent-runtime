import { createPostgresMaterializationRepository } from "../../../dist/features/contained-turn-access/adapters/outbound/postgres/materialization-postgres-repository.js";
import { createPostgresRouteSelectionOwner } from "../../../dist/features/contained-turn-access/composition/route-selection-owner.js";
import { materializationPostgresSchemaDigest } from "../../../dist/features/contained-turn-access/adapters/outbound/postgres/materialization-postgres-schema.js";
import { routeSelectionSchemaDigest } from "../../../dist/features/contained-turn-access/adapters/outbound/postgres/route-selection-schema.js";
import type { RouteSelectionInput } from "../../../dist/features/contained-turn-access/composition/route-selection-owner.js";

export const selection = (recipe: RouteSelectionInput["recipe"] = "codex-chatgpt"): RouteSelectionInput => {
  const codex = recipe.startsWith("codex");
  const api = recipe.endsWith("api");
  const forwarded = codex ? ["accept", "content-type", "originator", "session-id", "thread-id", "user-agent",
    "version", "x-client-request-id", "x-codex-beta-features", "x-codex-routing-hint", "x-codex-turn-metadata", "x-codex-window-id"] :
    ["accept", "anthropic-beta", "anthropic-dangerous-direct-browser-access", "anthropic-version", "content-type", "user-agent",
      "x-app", "x-claude-code-session-id", "x-stainless-arch", "x-stainless-lang", "x-stainless-os", "x-stainless-package-version",
      "x-stainless-retry-count", "x-stainless-runtime", "x-stainless-runtime-version", "x-stainless-timeout"];
  return {
    binding: {accessRef: "access:1", availability: "available", bindingRevision: 1, credentialBindingDigest: "credential:digest:1",
      credentialBindingRef: "credential:1", credentialGeneration: 1, projectId: "project:1", provider: codex ? "codex" : "claude",
      providerAccountRef: "account:1", providerRouteRef: "route:1", revocation: "active", scopeDigest: "scope:1", tenantId: "tenant:1"},
    recipe, deadline: performance.now() + 60_000, operationAbortSignal: new AbortController().signal,
    descriptor: {id: codex ? (api ? "codex-api-key-responses/v1" : "codex-chatgpt-responses/v1") :
      (api ? "claude-api-key-messages/v1" : "claude-authorization-messages/v1"), provider: codex ? "codex" : "claude",
    credentialMode: api ? "api-key" : codex ? "chatgpt-account" : "authorization", originHost: codex ? (api ? "api.openai.com" : "chatgpt.com") : "api.anthropic.com",
    originPort: 443, upstreamMethod: "POST", upstreamPath: codex ? (api ? "/v1/responses" : "/backend-api/codex/responses") : "/v1/messages?beta=true",
    credentialFieldNames: codex && !api ? ["authorization", "chatgpt-account-id"] : [!codex && api ? "x-api-key" : "authorization"],
    forwardedRequestHeaderNames: forwarded, requiredHeaderNames: codex ? ["accept", "content-type", "user-agent", "originator", "version"] : forwarded,
    exactValues: codex ? {"content-type": "application/json", version: "0.153.4"} : {"content-type": "application/json",
      "anthropic-version": "2023-06-01", "x-app": "cli", "anthropic-dangerous-direct-browser-access": "true", "x-stainless-retry-count": "0",
      "anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,"
        + "context-management-2025-06-27,prompt-caching-scope-2026-01-05,effort-2025-11-24"}},
  };
};
export const deferred = <T>() => {
  let complete!: (value: T) => void;
  const promise = new Promise<T>(resolve => {complete = resolve;});
  return {promise, resolve: complete};
};
type Row = Record<string, unknown>;
export const harness = async (input = selection()) => {
  const baseDigest = await materializationPostgresSchemaDigest();
  const routeDigest = await routeSelectionSchemaDigest();
  const state = {binding: structuredClone(input.binding) as unknown, headVersion: "1", rows: [] as Row[], migrated: true,
    schemaBad: false, insertCount: 1 as number | null, unavailable: false, duplicateHead: false};
  const calls: {sql: string; values?: unknown[]}[] = [];
  const releases: boolean[] = [];
  let connects = 0;
  let tail = Promise.resolve();
  let hook: ((sql: string) => Promise<void>) | undefined;
  const statement = (sql: string, values?: unknown[]) => {
  if (sql.includes("SELECT version")) {
    const route = sql.includes("pa-route-selection-v1");
    return {rows: route && !state.migrated ? [] : [{version: state.schemaBad ? 2 : 1, digest: route ? routeDigest : baseDigest}], rowCount: 1};
  }
  if (sql.includes("SELECT binding_revision")) {return {rows: structuredClone(state.rows.slice(-1)), rowCount: state.rows.length ? 1 : 0};}
  if (sql.startsWith("INSERT INTO provider_access.route_selection(")) {
    if (state.rows.some(row => row.binding_revision === values?.[1])) {throw new Error("Synthetic unique constraint");}
    state.rows.push({binding_revision: values?.[1], head_version: values?.[2], endorsement: JSON.parse(values?.[3] as string)});
    return {rows: [], rowCount: state.insertCount};
  }
  if (sql.startsWith("UPDATE provider_access.materialization_owner")) {
    state.binding = JSON.parse(values?.[5] as string); state.headVersion = values?.[6] as string;
    return {rows: [], rowCount: 1};
  }
  if (sql.startsWith("INSERT INTO provider_access.materialization_schema") && sql.includes("pa-route-selection-v1")) {
    state.migrated = true; return {rows: [], rowCount: state.insertCount};
  }
  return {rows: [], rowCount: 0};
  };
  const pool = {async connect() {
    connects++;
    if (state.unavailable) {throw new Error("Synthetic outage");}
    let unlock: (() => void) | undefined;
    let backup: typeof state | undefined;
    return {
      async query(sql: string, values?: unknown[]) {
        calls.push({sql, values});
        if (hook) {await hook(sql);}
        if (sql.includes("FOR UPDATE")) {
          const prior = tail;
          const gate = deferred<void>(); tail = gate.promise; unlock = () => gate.resolve();
          await prior;
          backup = structuredClone(state);
          const rows = state.duplicateHead ? [{head_version: state.headVersion, binding: state.binding}, {}] :
            [{head_version: state.headVersion, binding: state.binding}];
          return {rows, rowCount: rows.length};
        }
        if (sql === "COMMIT" || sql === "ROLLBACK") {
          if (sql === "ROLLBACK" && backup) {Object.assign(state, backup);}
          unlock?.(); unlock = undefined;
        }
        return statement(sql, values);
      },
      release(discard?: boolean) {releases.push(discard === true); unlock?.();},
    };
  }};
  const owner = (value = input, timeouts = {}) => createPostgresRouteSelectionOwner(pool, value, timeouts);
  return {input, pool, state, calls, releases, owner, connects: () => connects,
    setHook: (value: typeof hook) => {hook = value;}, store: () => createPostgresMaterializationRepository(pool)};
};
