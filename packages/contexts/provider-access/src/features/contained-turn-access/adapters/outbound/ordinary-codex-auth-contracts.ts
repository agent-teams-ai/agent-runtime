import type { CredentialRenderingSelection, OperationCredentialMaterialAdmission } from './credential-rendering-contracts.js';

export const ORDINARY_CODEX_AUTH_BINARY_SHA256 = 'b973d440acac501fd2594a43e7ca9ce41e0a65b9dfb28d0d7a7837c99e1261e3';
export const ORDINARY_CODEX_AUTH_MODEL = 'gpt-5.3-codex-spark';
export interface OrdinaryCodexAuthObservation {
  readonly captureRef: string;
  readonly outcome: 'started' | 'closed' | 'refused' | 'cleanup-indeterminate';
  readonly exitObserved: boolean;
  readonly closeObserved: boolean;
  readonly processGroupGone: boolean;
  readonly retainedDirectory?: string;
}
export interface OrdinaryCodexAuthCaptureOptions {
  readonly operationRef: string;
  readonly executable: string;
  readonly sourceDirectory: string;
  /** Existing private, current-user-owned 0700 directory; child directories are owned here. */
  readonly privateRoot: string;
  readonly generation: number;
  readonly signal: AbortSignal;
  /** Absolute monotonic deadline, no more than 60 seconds from construction. */
  readonly deadline: number;
  /** Synchronous non-secret durable observation sink. Throwing fails closed. */
  readonly record: (observation: OrdinaryCodexAuthObservation) => void;
}
export interface OrdinaryCodexAuthMetadata {
  readonly accountId: string;
  readonly generation: number;
  readonly captureRef: string;
  readonly expiresAt: number;
  readonly deadline: number;
  readonly sourceIdentity: string;
  readonly modelObserved: true;
}
export interface OrdinaryCodexAuthCapture {
  /** Resolves after a pending capture finishes its bounded cleanup; failures remain on capture(). */
  readonly settled: Promise<void>;
  capture(): Promise<OrdinaryCodexAuthMetadata>;
  /** Synchronous bounded redaction registration. Strings necessarily outlive Buffer erasure if retained by the trusted sink. */
  withCredentialOutputTokens(operationRef: string, consume: (tokens: readonly string[]) => boolean): void;
  admit(selection: CredentialRenderingSelection, admission: OperationCredentialMaterialAdmission): void;
  dispose(): void;
}
export class OrdinaryCodexAuthRefused extends Error {
  readonly code = 'ORDINARY_CODEX_AUTH_REFUSED';
  constructor() { super('ORDINARY_CODEX_AUTH_REFUSED'); }
}
export class OrdinaryCodexAuthCleanupIndeterminate extends Error {
  readonly code = 'ORDINARY_CODEX_AUTH_CLEANUP_INDETERMINATE';
  constructor(readonly observation: OrdinaryCodexAuthObservation) { super('ORDINARY_CODEX_AUTH_CLEANUP_INDETERMINATE'); }
}

export const AUTH_DISABLED_FEATURES = Object.freeze(['apps', 'hooks', 'plugins', 'remote_plugin', 'multi_agent', 'multi_agent_v2',
  'browser_use', 'computer_use', 'image_generation', 'unbounded_connection_retries']);
