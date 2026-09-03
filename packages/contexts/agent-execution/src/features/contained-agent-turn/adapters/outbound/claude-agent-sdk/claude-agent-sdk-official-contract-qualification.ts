import type { ClaudeSdkQueryInput } from "./claude-agent-sdk-query-contracts.js";

type OfficialClaudeQueryFactory = typeof import("@anthropic-ai/claude-agent-sdk")["query"];
type OfficialClaudeQueryInput = Parameters<OfficialClaudeQueryFactory>[0];
type Assert<T extends true> = T;

/** Compile-only parity proof kept outside every public declaration path. */
export type ClaudeSdkOfficialQueryInputAssignability = Assert<
  ClaudeSdkQueryInput extends OfficialClaudeQueryInput ? true : false
>;
