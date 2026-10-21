import type { Failure, FailureCode } from '@agent-teams/agent-execution/interactive-contracts';
export const fail = (code: FailureCode): Failure => ({ ok: false, code });
