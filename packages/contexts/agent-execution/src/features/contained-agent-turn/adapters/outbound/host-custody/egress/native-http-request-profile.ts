/** Internal, literal wire contracts. Selection still requires PA/RS and composition review. */
export type NativeHttpRequestProfileId = "codex-chatgpt-responses/v1" | "codex-api-key-responses/v1"
  | "claude-authorization-messages/v1" | "claude-api-key-messages/v1";

const codexNames = Object.freeze(["accept", "content-type", "originator", "session-id", "thread-id", "user-agent",
  "version", "x-client-request-id", "x-codex-beta-features", "x-codex-routing-hint", "x-codex-turn-metadata",
  "x-codex-window-id"] as const);
const claudeNames = Object.freeze(["accept", "anthropic-beta", "anthropic-dangerous-direct-browser-access",
  "anthropic-version", "content-type", "user-agent", "x-app", "x-claude-code-session-id", "x-stainless-arch",
  "x-stainless-lang", "x-stainless-os", "x-stainless-package-version", "x-stainless-retry-count",
  "x-stainless-runtime", "x-stainless-runtime-version", "x-stainless-timeout"] as const);
export type HttpPresentationHeaderName = typeof codexNames[number] | typeof claudeNames[number];

export type NativeHttpRequestProfile = Readonly<{
  id: NativeHttpRequestProfileId;
  provider: "codex" | "claude";
  credentialMode: "chatgpt-account" | "api-key" | "authorization";
  originHost: "chatgpt.com" | "api.openai.com" | "api.anthropic.com";
  originPort: 443;
  upstreamMethod: "POST";
  upstreamPath: "/backend-api/codex/responses" | "/v1/responses" | "/v1/messages?beta=true";
  forwardedRequestHeaderNames: readonly HttpPresentationHeaderName[];
  credentialFieldNames: readonly string[];
  requiredHeaderNames: readonly HttpPresentationHeaderName[];
  exactValues: Readonly<Record<string, string>>;
}>;

export const NATIVE_HTTP_HEADER_LIMITS = Object.freeze({maximumValueBytes: 4_096,
  maximumTotalValueBytes: 32_768, maximumInboundFields: 24});

const codexValues = Object.freeze({"content-type": "application/json", version: "0.153.4"});
const codexRequired = Object.freeze(["accept", "content-type", "user-agent", "originator", "version"] as const);
const claudeValues = Object.freeze({"content-type": "application/json", "anthropic-version": "2023-06-01",
  "x-app": "cli", "anthropic-dangerous-direct-browser-access": "true", "x-stainless-retry-count": "0",
  "anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,"
    + "context-management-2025-06-27,prompt-caching-scope-2026-01-05,effort-2025-11-24"});

const chatgpt: NativeHttpRequestProfile = Object.freeze({id: "codex-chatgpt-responses/v1", provider: "codex",
  credentialMode: "chatgpt-account", originHost: "chatgpt.com", originPort: 443, upstreamMethod: "POST",
  upstreamPath: "/backend-api/codex/responses", forwardedRequestHeaderNames: codexNames,
  credentialFieldNames: Object.freeze(["authorization", "chatgpt-account-id"]),
  requiredHeaderNames: codexRequired, exactValues: codexValues});
const codexApiKey: NativeHttpRequestProfile = Object.freeze({...chatgpt, id: "codex-api-key-responses/v1",
  credentialMode: "api-key", originHost: "api.openai.com", upstreamPath: "/v1/responses",
  credentialFieldNames: Object.freeze(["authorization"])});
const claudeAuthorization: NativeHttpRequestProfile = Object.freeze({id: "claude-authorization-messages/v1",
  provider: "claude", credentialMode: "authorization", originHost: "api.anthropic.com", originPort: 443,
  upstreamMethod: "POST", upstreamPath: "/v1/messages?beta=true", forwardedRequestHeaderNames: claudeNames,
  credentialFieldNames: Object.freeze(["authorization"]), requiredHeaderNames: claudeNames, exactValues: claudeValues});
const claudeApiKey: NativeHttpRequestProfile = Object.freeze({...claudeAuthorization, id: "claude-api-key-messages/v1",
  credentialMode: "api-key", credentialFieldNames: Object.freeze(["x-api-key"])});

/** No registration, arbitrary endpoints, inference from host, or credential fallback. */
export const nativeHttpRequestProfile = (id: unknown): NativeHttpRequestProfile | undefined => {
  switch (id) {
    case "codex-chatgpt-responses/v1": return chatgpt;
    case "codex-api-key-responses/v1": return codexApiKey;
    case "claude-authorization-messages/v1": return claudeAuthorization;
    case "claude-api-key-messages/v1": return claudeApiKey;
    default: return undefined;
  }
};

const route = (profile: NativeHttpRequestProfile, receipt: string) => {
  if (typeof receipt !== "string" || !/^[\x21-\x7e]{1,512}$/.test(receipt)) {
    throw new TypeError("invalid native HTTP route receipt");
  }
  return Object.freeze({requestProfile: profile.id, routeReceiptDigest: receipt, originHost: profile.originHost,
    originPort: profile.originPort, upstreamMethod: profile.upstreamMethod, upstreamPath: profile.upstreamPath,
    forwardedRequestHeaderNames: profile.forwardedRequestHeaderNames, credentialFieldNames: profile.credentialFieldNames});
};

export const createCodexChatGptHttpRoute = (receipt: string) => route(chatgpt, receipt);
export const createCodexApiKeyHttpRoute = (receipt: string) => route(codexApiKey, receipt);
export const createClaudeAuthorizationHttpRoute = (receipt: string) => route(claudeAuthorization, receipt);
export const createClaudeApiKeyHttpRoute = (receipt: string) => route(claudeApiKey, receipt);

/** Protocol and transport names can never be repurposed as materializer credential slots. */
export const isHttpCredentialCollision = (name: string): boolean =>
  (codexNames as readonly string[]).includes(name) || (claudeNames as readonly string[]).includes(name)
  || ["accept-encoding", "connection", "content-length", "expect", "host", "keep-alive", "proxy-authenticate",
    "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"].includes(name);

export const nativeHeaderValueAllowed = (profile: NativeHttpRequestProfile, name: string, value: string): boolean =>
  (profile.forwardedRequestHeaderNames as readonly string[]).includes(name)
  && /^[\x20-\x7e]+$/.test(value) && value.length <= NATIVE_HTTP_HEADER_LIMITS.maximumValueBytes
  && value.trim() === value
  && (!Object.hasOwn(profile.exactValues, name) || profile.exactValues[name] === value);
