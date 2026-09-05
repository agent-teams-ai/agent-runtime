import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { createCodexChatGptHttpRoute, createCodexApiKeyHttpRoute, createClaudeAuthorizationHttpRoute,
  createClaudeApiKeyHttpRoute } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/native-http-request-profile.js";
import type { HttpEgressBrokerPorts, HttpEgressRoute } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-egress-ports.js";
import { bytes, createEgressFixture } from "./http-egress-test-fixture.ts";

export const cases = [
  {factory: createCodexChatGptHttpRoute, provider: "codex", host: "chatgpt.com", path: "/backend-api/codex/responses",
    credentials: ["authorization", "chatgpt-account-id"]},
  {factory: createCodexApiKeyHttpRoute, provider: "codex", host: "api.openai.com", path: "/v1/responses",
    credentials: ["authorization"]},
  {factory: createClaudeAuthorizationHttpRoute, provider: "claude", host: "api.anthropic.com", path: "/v1/messages?beta=true",
    credentials: ["authorization"]},
  {factory: createClaudeApiKeyHttpRoute, provider: "claude", host: "api.anthropic.com", path: "/v1/messages?beta=true",
    credentials: ["x-api-key"]},
] as const;
export type ProfileCase = typeof cases[number];
export type Header = Readonly<{name: string; value: string}>;
export const body = () => bytes('{ "model": "synthetic-model", "input": [{"text":"synthetic 🧪"}], "stream": true }\n');
export const beta = "claude-code-20250219,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,"
  + "context-management-2025-06-27,prompt-caching-scope-2026-01-05,effort-2025-11-24";

export const headers = (provider: "codex" | "claude"): Header[] => Object.entries(provider === "codex" ? {
  accept: "text/event-stream", "content-type": "application/json", version: "0.153.4", originator: "synthetic-app-server",
  "user-agent": "synthetic-codex/0.153.4", "x-codex-beta-features": "synthetic-beta-marker",
  "x-codex-window-id": "synthetic-window", "x-codex-turn-metadata": '{"turn_id":"synthetic-turn"}',
  "x-codex-routing-hint": "synthetic-route", "x-client-request-id": "synthetic-request",
  "session-id": "synthetic-session", "thread-id": "synthetic-thread",
} : {
  accept: "application/json", "content-type": "application/json", "user-agent": "synthetic-claude-code/2.1.251",
  "x-claude-code-session-id": "synthetic-session", "x-stainless-arch": "x64", "x-stainless-lang": "js",
  "x-stainless-os": "Linux", "x-stainless-package-version": "0.3.251", "x-stainless-retry-count": "0",
  "x-stainless-runtime": "node", "x-stainless-runtime-version": "v24.18.0", "x-stainless-timeout": "600",
  "anthropic-beta": beta, "anthropic-dangerous-direct-browser-access": "true", "anthropic-version": "2023-06-01",
  "x-app": "cli",
}).map(([name, value]) => ({name, value}));

export const request = (candidate: ProfileCase, fields = headers(candidate.provider)) => ({
  method: "POST", path: candidate.path, headers: fields, body: body(), wireBytes: 0,
});
export const credential = (name: string) => name === "authorization" ? "Bearer fixture-pa"
  : name === "chatgpt-account-id" ? "synthetic-PA-account" : "synthetic-PA-api-key";
export const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
export const projection = (lines: readonly string[]): Uint8Array => {
  const parts = [Buffer.alloc(4)]; parts[0]!.writeUInt32BE(lines.length);
  for (const line of lines) {const value = Buffer.from(line); const size = Buffer.alloc(4);
    size.writeUInt32BE(value.byteLength); parts.push(size, value);}
  return new Uint8Array(Buffer.concat(parts));
};

const unsigned = (value: {signature: unknown}) => {const {signature: _signature, ...payload} = value;
    return bytes(JSON.stringify(payload));};

// Each fixture owns fresh synthetic signing keys. No socket or provider is involved.
const signedAuthority = (ports: HttpEgressBrokerPorts): Pick<HttpEgressBrokerPorts, "runtimeSecurity" | "verifier"> => {
  const {privateKey, publicKey} = generateKeyPairSync("ed25519");
  const signature = (value: {signature: unknown}) => sign(null, unsigned(value), privateKey).toString("hex");
  const verified = (value: {signature: {value: string}}) => verify(null, unsigned(value), publicKey,
    Buffer.from(value.signature.value, "hex"));
  return {verifier: {...ports.verifier, verifyProvisionalDecision: verified, verifyGrant: verified},
    runtimeSecurity: {
      requestProvisional: async input => {const result = await ports.runtimeSecurity.requestProvisional(input);
        return result.status === "denied" ? result : {status: "authorized", decision: {...result.decision,
          signature: {...result.decision.signature, value: signature(result.decision)}}};},
      authorizeFirstApplicationByte: async input => {const result = await ports.runtimeSecurity.authorizeFirstApplicationByte(input);
        return result.status === "denied" ? result : {status: "authorized", grant: {...result.grant,
          signature: {...result.grant.signature, value: signature(result.grant)}}};},
    }};
};

export const nativeFixture = (candidate: ProfileCase, fields = headers(candidate.provider), options: {
  path?: string; method?: string; route?: HttpEgressRoute; provider?: "codex" | "claude"; response?: string;
} = {}) => {
  const route = options.route ?? candidate.factory("synthetic-route-receipt");
  const nativeBody = body();
  const head = `${options.method ?? "POST"} ${options.path ?? candidate.path} HTTP/1.1\r\nHost: broker.invalid\r\n`
    + `Content-Length: ${nativeBody.byteLength}\r\nAuthorization: Bearer fixture-broker\r\n`
    + `Connection: keep-alive\r\nAccept-Encoding: gzip, deflate, br\r\n`
    + (candidate.credentials.includes("chatgpt-account-id" as never) ? "Chatgpt-Account-Id: synthetic-ambient-account\r\n" : "")
    + fields.map(field => `${field.name}: ${field.value}\r\n`).join("") + "\r\n";
  const fixture = createEgressFixture({route, provider: options.provider ?? candidate.provider,
    request: [bytes(head), nativeBody], ...(options.response === undefined ? {} : {response: [options.response]})});
  const rendered: Uint8Array[] = [];
  const ports: HttpEgressBrokerPorts = {...fixture.ports, ...signedAuthority(fixture.ports),
    materializer: {render: async () => {fixture.observations.renders += 1; fixture.observations.order.push("render-credential");
      return candidate.credentials.map(name => {const valueBytes = bytes(credential(name)); rendered.push(valueBytes);
        return {name, valueBytes};});}}};
  const operation = {...fixture.operation, expectedRequest: {...fixture.operation.expectedRequest, path: candidate.path},
    limits: {...fixture.operation.limits, maxInboundHeaderBytes: 65_536}};
  return {...fixture, ports, operation, rendered, nativeBody};
};
