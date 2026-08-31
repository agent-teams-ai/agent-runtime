import { join } from "node:path";

import type { ContainedTurnKernelArtifactPort } from "../../../application/ports/outbound/contained-turn-ports.js";
import type { ContainedTurnWorkspaceId } from "../../../domain/contained-turn-identities.js";
import type { ContainedTurnFilesystemArtifactPort as ContainedTurnArtifactPort } from "./contained-turn-filesystem-port.js";
import {
  parseContainedTurnResultUrnDigest,
  type ContainedTurnArtifactManifest,
} from "./contained-turn-artifact-manifest.js";
import {
  assertContainedTurnArtifactLimits,
  bindArtifactCustody,
  closeContainedTurnArtifactHandles,
} from "./contained-turn-artifact-custody.js";
import { rehydrateContainedTurnArtifact } from "./contained-turn-artifact-rehydration.js";
import { sealContainedTurnArtifact } from "./contained-turn-artifact-sealing.js";
import {
  createContainedTurnArtifactStore,
  type VerifiedStoredArtifact,
} from "./contained-turn-artifact-store.js";
import {
  scopedArtifactWorkspaceName,
  verifyContainedTurnArtifactLookup,
} from "./contained-turn-artifact-verification.js";
import {
  guardContainedTurnFilesystemOperation,
  isMissingFilesystemEntry,
  revalidateBoundRoots,
} from "./contained-turn-filesystem-custody.js";
import { openBoundDirectories } from "./contained-turn-filesystem-handles.js";
import {
  readStableFileAt,
  writeImmutableFileAt,
  type ContainedTurnFilesystemFaults,
} from "./contained-turn-durable-file.js";
import { parseWorkspaceCreationRecord } from "./contained-turn-workspace-state.js";
import {
  encodeKernelClosureRecord,
  kernelClosureEvidenceId,
  kernelClosureProofId,
  kernelClosureRecordName,
  parseKernelClosureRecord,
  sameKernelClosureRequest,
  type KernelArtifactClosureRecord,
} from "./contained-turn-kernel-closure-record.js";
import {
  DEFAULT_CONTAINED_TURN_WORKSPACE_LIMITS,
  type ContainedTurnWorkspaceTreeLimits,
} from "./contained-turn-workspace-tree.js";

const inflightRehydrations = new Map<string, Readonly<{
  fingerprint: string;
  promise: Promise<string>;
}>>();

export type NodeContainedTurnArtifactDigest = (
  domain: "blob" | "manifest", bytes: Uint8Array,
) => string;

export interface NodeContainedTurnArtifactOptions {
  readonly canonicalProjectRoot: string;
  readonly disposableRoot: string;
  readonly limits?: ContainedTurnWorkspaceTreeLimits;
  readonly rehydrationRoot: string;
  readonly root: string;
  readonly testDigest?: NodeContainedTurnArtifactDigest;
  readonly testFaults?: ContainedTurnFilesystemFaults;
  readonly workspaceRoot: string;
}

export type NodeContainedTurnArtifacts = ContainedTurnArtifactPort &
  ContainedTurnKernelArtifactPort & Readonly<{
    rehydrate(input: NodeContainedTurnArtifactLookup): Promise<string>;
    verify(input: NodeContainedTurnArtifactLookup): Promise<ContainedTurnArtifactManifest>;
  }>;

export interface NodeContainedTurnArtifactLookup {
  readonly operationId: string;
  readonly resultRef: string;
  readonly scope: Parameters<ContainedTurnArtifactPort["seal"]>[0]["scope"];
}

const rehydrationFingerprint = (lookup: NodeContainedTurnArtifactLookup): string => JSON.stringify([
  lookup.resultRef, lookup.operationId, lookup.scope.tenantId, lookup.scope.projectId,
]);

const RECORD_BYTES = 64 * 1_024;

const kernelWorkspaceName = (workspaceId: ContainedTurnWorkspaceId): string => {
  const match = /^workspace:(operation-[a-f\d]{64})$/u.exec(workspaceId);
  if (match?.[1] === undefined) {
    throw new Error("contained turn kernel artifact workspace identity is not opaque");
  }
  return match[1];
};

export const createNodeContainedTurnArtifacts = async (
  options: NodeContainedTurnArtifactOptions,
): Promise<NodeContainedTurnArtifacts> => guardContainedTurnFilesystemOperation(
  "artifact_initialize",
  async () => {
    const limits = options.limits ?? DEFAULT_CONTAINED_TURN_WORKSPACE_LIMITS;
    assertContainedTurnArtifactLimits(limits);
    const { artifactRoots, custodyRoots, rehydrationRoots, resultPublications, workspaceRoots } =
      await bindArtifactCustody(options);
    const { contentDigest, verifyArtifact, writeContentAddressed } =
      createContainedTurnArtifactStore({
        faults: options.testFaults,
        limits,
        roots: artifactRoots,
        testDigest: options.testDigest,
      });
    const verifyLookup = async (
      lookup: NodeContainedTurnArtifactLookup,
    ): Promise<VerifiedStoredArtifact> => verifyContainedTurnArtifactLookup({
      lookup,
      manifestDigest: parseContainedTurnResultUrnDigest(lookup.resultRef),
      resultPublications,
      verifyArtifact,
      workspaceSeals: workspaceRoots.seals,
    });
    const resolveKernelWorkspace = async (input: Readonly<{
      operationId: string;
      workspaceId: ContainedTurnWorkspaceId;
    }>) => {
      await revalidateBoundRoots(custodyRoots);
      const name = kernelWorkspaceName(input.workspaceId);
      const [creations] = await openBoundDirectories([workspaceRoots.creations]);
      try {
        const creation = parseWorkspaceCreationRecord(await readStableFileAt(
          creations, `${name}.json`, RECORD_BYTES,
        ));
        if (
          creation.operationId !== input.operationId || creation.workspaceName !== name ||
          scopedArtifactWorkspaceName(creation.operationId, creation.scope) !== name
        ) {
          throw new Error("contained turn kernel artifact workspace conflicts with owner creation facts");
        }
        return Object.freeze({
          name,
          operationId: creation.operationId,
          scope: creation.scope,
          workspaceRef: join(workspaceRoots.active.canonicalPath, name),
        });
      } finally {await closeContainedTurnArtifactHandles([creations]);}
    };
    const replayRehydration = (lookup: NodeContainedTurnArtifactLookup): Promise<string> =>
      guardContainedTurnFilesystemOperation(
        "artifact_rehydrate",
        async () => rehydrateContainedTurnArtifact(lookup.resultRef, {
          contentDigest,
          custodyRoots,
          faults: options.testFaults,
          limits,
          roots: rehydrationRoots,
          verifyArtifact: async () => verifyLookup(lookup),
        }),
        options.testFaults !== undefined,
      );
    const inflightSeals = new Map<string, Readonly<{
      fingerprint: string;
      promise: ReturnType<ContainedTurnArtifactPort["seal"]>;
    }>>();
    const sealDurably = async (
      input: Parameters<ContainedTurnArtifactPort["seal"]>[0],
    ): ReturnType<ContainedTurnArtifactPort["seal"]> => {
      const fingerprint = JSON.stringify([
        input.operationId, input.scope.tenantId, input.scope.projectId,
        input.workspaceRef, input.output,
      ]);
      const existing = inflightSeals.get(input.workspaceRef);
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint) {
          throw new Error("contained turn artifact seal raced with conflicting input");
        }
        return existing.promise;
      }
      const promise = guardContainedTurnFilesystemOperation(
        "artifact_seal",
        () => sealContainedTurnArtifact(input, {
          contentDigest,
          custodyRoots,
          limits,
          resultPublications,
          testFaults: options.testFaults,
          verifyArtifact,
          workspaceRoots,
          writeContentAddressed,
        }),
        options.testFaults !== undefined,
      );
      inflightSeals.set(input.workspaceRef, Object.freeze({ fingerprint, promise }));
      try {return await promise;} finally {
        if (inflightSeals.get(input.workspaceRef)?.promise === promise) {
          inflightSeals.delete(input.workspaceRef);
        }
      }
    };

    const readKernelBinding = async (
      input: Parameters<ContainedTurnKernelArtifactPort["querySeal"]>[0],
    ): Promise<KernelArtifactClosureRecord | undefined> => {
      const [results] = await openBoundDirectories([resultPublications]);
      try {
        let bytes: Buffer;
        try {
          bytes = await readStableFileAt(
            results, kernelClosureRecordName("artifact_seal", input.requestDigest), RECORD_BYTES,
          );
        } catch (error) {
          if (isMissingFilesystemEntry(error)) {return undefined;}
          throw error;
        }
        const record = parseKernelClosureRecord(bytes);
        if (record.kind !== "artifact_seal") {
          throw new Error("contained turn kernel artifact closure record has the wrong kind");
        }
        return record;
      } finally {await closeContainedTurnArtifactHandles([results]);}
    };

    const queryKernelSeal = async (
      input: Parameters<ContainedTurnKernelArtifactPort["querySeal"]>[0],
    ): ReturnType<ContainedTurnKernelArtifactPort["querySeal"]> => {
      const resolved = await resolveKernelWorkspace(input);
      const record = await readKernelBinding(input);
      if (record === undefined) {
        return Object.freeze({
          evidenceId: kernelClosureEvidenceId({
            operationId: input.operationId,
            requestDigest: input.requestDigest,
            source: "artifact_binding_missing",
          }),
          kind: "indeterminate" as const,
        });
      }
      if (!sameKernelClosureRequest(record, input)) {
        return Object.freeze({
          evidenceId: kernelClosureEvidenceId({
            operationId: input.operationId,
            requestDigest: input.requestDigest,
            source: "artifact_binding_conflict",
          }),
          kind: "identity_conflict" as const,
        });
      }
      await verifyLookup({
        operationId: resolved.operationId,
        resultRef: record.resultRef,
        scope: resolved.scope,
      });
      return Object.freeze({
        kind: "proved" as const,
        proof: Object.freeze({
          artifactProof: Object.freeze({
            binding: Object.freeze({
              artifactManifestRef: record.manifestRef,
              authorityVectorDigest: record.authorityVectorDigest,
              operationId: record.operationId,
              workspaceId: record.workspaceId,
            }),
            kind: "artifact_manifest_seal" as const,
            proofId: kernelClosureProofId(record, "artifact_manifest_seal"),
          }),
          resultProof: Object.freeze({
            binding: Object.freeze({
              authorityVectorDigest: record.authorityVectorDigest,
              operationId: record.operationId,
              resultRef: record.resultRef,
            }),
            kind: "result_publication" as const,
            proofId: kernelClosureProofId(record, "result_publication"),
          }),
        }),
        requestDigest: record.requestDigest,
        requestId: record.requestId,
      });
    };

    const ensureKernelSealed = async (
      input: Parameters<ContainedTurnKernelArtifactPort["ensureSealed"]>[0],
    ): ReturnType<ContainedTurnKernelArtifactPort["ensureSealed"]> => {
      const observed = await queryKernelSeal(input);
      if (observed.kind !== "indeterminate") {return observed;}
      const resolved = await resolveKernelWorkspace(input);
      const sealed = await sealDurably({
        operationId: resolved.operationId,
        output: input.output,
        scope: resolved.scope,
        workspaceRef: resolved.workspaceRef,
      });
      const record: KernelArtifactClosureRecord = Object.freeze({
        authorityVectorDigest: input.authorityVectorDigest,
        kind: "artifact_seal",
        manifestReceiptRef: sealed.manifestReceiptRef,
        manifestRef: sealed.manifestRef,
        operationId: input.operationId,
        requestDigest: input.requestDigest,
        requestId: input.requestId,
        resultReceiptRef: sealed.resultReceiptRef,
        resultRef: sealed.resultRef,
        schemaVersion: 1,
        workspaceId: input.workspaceId,
      });
      const [results, staging] = await openBoundDirectories([
        resultPublications, workspaceRoots.staging,
      ]);
      try {
        await writeImmutableFileAt({
          bytes: encodeKernelClosureRecord(record),
          faults: options.testFaults,
          finalDirectory: results,
          finalName: kernelClosureRecordName(record.kind, record.requestDigest),
          stagingDirectory: staging,
          temporaryKind: "metadata",
        });
      } finally {await closeContainedTurnArtifactHandles([results, staging]);}
      return queryKernelSeal(input);
    };

    function seal(input: Parameters<ContainedTurnArtifactPort["seal"]>[0]): ReturnType<ContainedTurnArtifactPort["seal"]>;
    function seal(input: Parameters<ContainedTurnKernelArtifactPort["seal"]>[0]): ReturnType<ContainedTurnKernelArtifactPort["seal"]>;
    function seal(
      input: Parameters<ContainedTurnArtifactPort["seal"]>[0] |
        Parameters<ContainedTurnKernelArtifactPort["seal"]>[0],
    ): ReturnType<ContainedTurnArtifactPort["seal"]> | ReturnType<ContainedTurnKernelArtifactPort["seal"]> {
      if ("scope" in input) {return sealDurably(input);}
      return Promise.resolve(Object.freeze({
        evidenceId: kernelClosureEvidenceId({
          operationId: input.operationId,
          source: "unstaged_artifact_seal",
        }),
        kind: "indeterminate" as const,
      }));
    }

    return Object.freeze<NodeContainedTurnArtifacts>({
      ensureSealed: input => guardContainedTurnFilesystemOperation(
        "artifact_ensure_sealed", () => ensureKernelSealed(input), options.testFaults !== undefined,
      ),
      querySeal: input => guardContainedTurnFilesystemOperation(
        "artifact_query_seal", () => queryKernelSeal(input), options.testFaults !== undefined,
      ),
      async rehydrate(lookup) {
        const digest = parseContainedTurnResultUrnDigest(lookup.resultRef);
        const key = `${rehydrationRoots.results.canonicalPath}\0${digest}`;
        const fingerprint = rehydrationFingerprint(lookup);
        const existing = inflightRehydrations.get(key);
        if (existing !== undefined) {
          if (existing.fingerprint !== fingerprint) {
            throw new Error("contained turn rehydration raced with conflicting scope or provenance");
          }
          await existing.promise;
          return replayRehydration(lookup);
        }
        const promise = replayRehydration(lookup);
        inflightRehydrations.set(key, Object.freeze({ fingerprint, promise }));
        try {return await promise;} finally {
          if (inflightRehydrations.get(key)?.promise === promise) {inflightRehydrations.delete(key);}
        }
      },
      seal,
      async verify(lookup) {
        return guardContainedTurnFilesystemOperation("artifact_verify", async () => {
          await revalidateBoundRoots(custodyRoots);
          return (await verifyLookup(lookup)).manifest;
        }, options.testFaults !== undefined);
      },
    });
  },
  options.testFaults !== undefined,
);
