import { z } from "zod";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const gitOid = z.string().regex(/^[a-f0-9]{40}$/u);
const githubUrl = z
  .string()
  .url()
  .startsWith("https://github.com/agent-teams-ai/agent-runtime/");

const successfulRun = z
  .object({
    id: z.number().int().positive(),
    workflow: z.string().min(1),
    event: z.enum(["push", "workflow_dispatch"]),
    result: z.literal("success"),
    url: githubUrl,
  })
  .strict();

const platformJob = z
  .object({
    runner: z.enum(["ubuntu-24.04", "macos-15", "windows-2025"]),
    jobId: z.number().int().positive(),
    result: z.literal("success"),
    url: githubUrl,
  })
  .strict();

const assertion = z
  .object({
    id: z.string().regex(/^[A-Z0-9-]+$/u),
    result: z.literal("passed"),
    evidence: z.array(z.string().min(1)).min(1),
  })
  .strict();

export const rustBoundaryEvidenceRecordV1 = z
  .object({
    schema: z.literal("agent-teams.rust-system-boundaries.evidence-record/v1"),
    recordId: z.string().regex(/^main-[a-f0-9]{7}$/u),
    disposition: z
      .object({
        spike: z.literal("proven"),
        production: z.literal("unqualified"),
      })
      .strict(),
    source: z
      .object({
        ref: z.literal("refs/heads/main"),
        revision: gitOid,
        pullRequest: githubUrl,
        mergedAt: z.string().datetime(),
      })
      .strict(),
    runs: z
      .object({
        qualityGate: successfulRun,
        boundaryMatrix: successfulRun.extend({
          jobs: z.array(platformJob).length(3),
        }),
        provenance: successfulRun.extend({
          evidenceScope: z.literal("trusted-main-attestation"),
          archive: z
            .object({
              name: z.string().min(1),
              sha256,
              artifactRetentionDays: z.literal(3),
            })
            .strict(),
        }),
      })
      .strict(),
    assertions: z.array(assertion).min(1),
    safety: z
      .object({
        syntheticFixturesOnly: z.literal(true),
        providerInvocations: z.literal(false),
        networkCallsFromHarness: z.literal(false),
        credentialsAccessed: z.literal(false),
        userProjectsAccessed: z.literal(false),
      })
      .strict(),
    limitations: z.array(z.string().min(1)).min(1),
  })
  .strict();
