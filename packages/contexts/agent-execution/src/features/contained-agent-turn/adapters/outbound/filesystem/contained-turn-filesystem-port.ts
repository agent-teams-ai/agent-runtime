import type { ContainedTurnScope } from "../../../domain/contained-turn-authority.js";
import type { ContainedTurnOutputKind } from "../../../domain/contained-turn-operation.js";

/**
 * Filesystem-private contract retained by the durable custody engine.
 *
 * The current kernel deliberately carries only an opaque WorkspaceId.  This
 * contract keeps paths and stable-directory capabilities on the filesystem
 * side of the adapter; node-contained-turn-{workspace,artifacts}.ts map its
 * durable owner facts into the kernel's typed closure proofs.
 */
export interface ContainedTurnFilesystemWorkspacePort {
  close(input: Readonly<{
    operationId: string;
    scope: ContainedTurnScope;
    workspaceRef: string;
  }>): Promise<{ readonly receiptRef: string }>;
  create(input: Readonly<{
    operationId: string;
    scope: ContainedTurnScope;
  }>): Promise<{ readonly workspaceRef: string }>;
  quarantine(input: Readonly<{
    evidenceRef: string;
    operationId: string;
    scope: ContainedTurnScope;
    workspaceRef: string;
  }>): Promise<void>;
  verify(input: Readonly<{
    operationId: string;
    scope: ContainedTurnScope;
    workspaceRef: string;
  }>): Promise<ContainedTurnWorkspaceLaunchAuthority>;
}

export interface ContainedTurnWorkspaceLaunchAuthority {
  readonly authorityRef: string;
  readonly kind: "workspace_launch_authority";
  readonly version: 1;
}

export interface ContainedTurnFilesystemArtifactPort {
  seal(input: Readonly<{
    operationId: string;
    output: readonly Readonly<{
      cursor: number;
      kind: ContainedTurnOutputKind;
      text: string;
    }>[];
    scope: ContainedTurnScope;
    workspaceRef: string;
  }>): Promise<Readonly<{
    manifestReceiptRef: string;
    manifestRef: string;
    resultReceiptRef: string;
    resultRef: string;
  }>>;
}
