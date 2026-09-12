import {mkdir} from "node:fs/promises";
import {join} from "node:path";
import {createCodexAppServerPermissionBoundary} from "@agent-teams/agent-execution/composition";
import {createClaudeCodeSetupInspectionPlanner, createCodexSetupInspectionPlanner,
  type ContainedTurnOuterCompositionDependencies} from "../dist/composition.js";
import type {DeterministicCurrentOwnerHost} from "./support/external/agent-execution/current-owner-success-fixture.ts";
import {createDependencies} from "./support/external/agent-execution/features/contained-agent-turn/support/contained-agent-turn-fixture.ts";

const unavailable = (): never => {throw new Error("setup dependency must not be reached");};
export const setupCapabilities = Object.freeze({
  claudeCodeSetup: Object.freeze({
    authorizeClaudeCodeSetupInspection: Object.freeze({execute: unavailable}),
    discoverClaudeCodeInstallations: Object.freeze({execute: unavailable}),
    inspectClaudeCodeConfiguration: Object.freeze({execute: unavailable}),
    planClaudeCodeSetupInspection: createClaudeCodeSetupInspectionPlanner("linux"),
  }),
  codexSetup: Object.freeze({
    authorizeSetupInspection: Object.freeze({execute: unavailable}),
    discoverCodexInstallations: Object.freeze({execute: unavailable}),
    inspectCodexConfiguration: Object.freeze({execute: unavailable}),
    planCodexSetupInspection: createCodexSetupInspectionPlanner("linux"),
  }),
});

type LegacyDependencies = Extract<ContainedTurnOuterCompositionDependencies, {authority?: "legacy"}>;
type OuterProviderAccess = LegacyDependencies["providerAccess"];
type OuterSecurityAuthority = LegacyDependencies["security"]["dispatchAuthorityV1"];

const providerAccess = (bindingDigest = "binding:synthetic") => Object.freeze({
  dispatchConsumptionV1: Object.freeze({
    async consumeForDispatch(input: Parameters<OuterProviderAccess["dispatchConsumptionV1"]["consumeForDispatch"]>[0]) {
      return Object.freeze({kind: "consumed" as const, receipt: Object.freeze({
        ...input.binding,
        authorityHeadDigestAtConsumption: input.binding.authorityHeadDigest,
        claimBeforeControlTime: 100,
        claimBindingDigest: input.claimBindingDigest,
        consumedAtControlTime: 50,
        consumptionDigest: "provider-access-consumption:synthetic",
        grantRequestId: input.grantRequestId,
        opaqueOwnerEvidenceRef: "provider-access-evidence:synthetic",
        operationId: input.operationId,
        provider: input.provider,
        purpose: input.purpose,
        requestDigest: input.requestDigest,
        scope: input.scope,
      })});
    },
    async observeDispatchConsumption() {return Object.freeze({kind: "not_found" as const});},
    async settleDispatchConsumption(input: Parameters<OuterProviderAccess["dispatchConsumptionV1"]["settleDispatchConsumption"]>[0]) {
      return Object.freeze({kind: "settled" as const, receipt: Object.freeze({
        consumptionDigest: input.consumptionDigest,
        disposition: input.disposition,
        expectedBinding: input.expectedBinding,
        operationId: input.operationId,
        provider: input.provider,
        scope: input.scope,
        settledAtControlTime: 100,
        settlementDigest: "provider-access-settlement:synthetic",
        settlementRequestId: input.settlementRequestId,
      })});
    },
  }),
  resolve: Object.freeze({async execute(input: Parameters<OuterProviderAccess["resolve"]["execute"]>[0]) {
    return Object.freeze({
      binding: Object.freeze({
        accessRef: "access:synthetic", credentialBindingDigest: bindingDigest,
        credentialBindingRef: "credential-binding:synthetic", credentialGeneration: 1,
        projectId: input.scope.projectId, provider: input.provider, providerAccountRef: "account:synthetic",
        providerRouteRef: "route:synthetic", revision: 1, tenantId: input.scope.tenantId,
      }),
      evidence: Object.freeze({authorityDigest: "authority:acceptance", bindingAuthorityDigest: bindingDigest,
        proofRef: "proof:acceptance", purpose: "acceptance" as const}),
      kind: "resolved" as const,
    });
  }}),
  revalidate: Object.freeze({async execute(input: Parameters<OuterProviderAccess["revalidate"]["execute"]>[0]) {
    return Object.freeze({
      binding: input.binding,
      evidence: Object.freeze({authorityDigest: "authority:dispatch", bindingAuthorityDigest: bindingDigest,
        proofRef: "proof:dispatch", purpose: "dispatch" as const}),
      kind: "valid" as const,
    });
  }}),
}) satisfies OuterProviderAccess;

const runtimeSecurityAuthority = Object.freeze({
  async consumeForDispatch(input: Parameters<OuterSecurityAuthority["consumeForDispatch"]>[0]) {
    return Object.freeze({status: "consumed" as const, receipt: Object.freeze({
      acceptedAuthorityDigest: input.acceptedAuthorityDigest,
      authorityGeneration: input.authorityGeneration,
      authorityHeadDigestAtConsumption: input.expectedAuthorityHeadDigest,
      authorityRevision: input.expectedAuthorityRevision,
      claimBeforeControlTime: 100,
      claimBindingDigest: input.claimBindingDigest,
      consumedAtControlTime: 50,
      consumptionDigest: "runtime-security-consumption:synthetic",
      constraintsDigest: input.expectedConstraintsDigest,
      containmentPolicyDigest: input.expectedContainmentPolicyDigest,
      contractVersion: "contained-turn-dispatch-consumption/v1" as const,
      grantRequestId: input.grantRequestId,
      operationId: input.operationId,
      ownerEvidenceRef: "runtime-security-evidence:synthetic",
      providerBindingDigest: input.providerBindingDigest,
      providerId: input.providerId,
      purpose: input.purpose,
      requestDigest: input.requestDigest,
      scope: input.scope,
    })});
  },
  async observeDispatchConsumption() {return Object.freeze({status: "not_found" as const});},
  async settleDispatchConsumption() {
    return Object.freeze({status: "settled" as const, receipt: Object.freeze({})});
  },
}) satisfies OuterSecurityAuthority;

export const createCompositionInput = async (hostCustody: DeterministicCurrentOwnerHost, root: string,
  selected: Readonly<{workspaceRef?: string; privateRootPath?: string; bindingDigest?: string}> = {}) => {
  const fixture = createDependencies();
  const effectAdmission = Object.freeze({});
  const workspaceRef = selected.workspaceRef ?? join(root, "workspace");
  const privateRootPath = selected.privateRootPath ?? join(root, "host-private");
  const codexHome = join(privateRootPath, "home");
  const tmpDir = join(privateRootPath, "temp");
  await Promise.all([
    mkdir(workspaceRef, {recursive: true, mode: 0o700}),
    mkdir(codexHome, {recursive: true, mode: 0o700}),
    mkdir(tmpDir, {recursive: true, mode: 0o700}),
  ]);
  return Object.freeze({
    fixture,
    input: Object.freeze({
      operationStore: fixture.dependencies.operationStore,
      security: Object.freeze({
        dispatchAuthorityV1: runtimeSecurityAuthority,
        legacy: fixture.dependencies.security,
      }),
      providerAccess: providerAccess(selected.bindingDigest),
      workspace: fixture.dependencies.workspace,
      artifacts: fixture.dependencies.artifacts,
      hostCustody,
      selectedProvider: Object.freeze({
        kind: "codex" as const,
        owner: Object.freeze({
          effectCustody: Object.freeze({admit: () => effectAdmission}),
          hostBootId: "host-boot:embedded-custody",
          hostInstanceId: "host-instance:embedded-custody",
          platformTarget: Object.freeze({architecture: "x64" as const, platform: "linux" as const}),
          launchRecords: Object.freeze({async resolve(input) {
            return Object.freeze({
              boundary: createCodexAppServerPermissionBoundary({codexHome, intentMode: input.intentMode, workspaceRef}),
              credentialOutputInventory: Object.freeze({
                credentialBindingDigest: input.credentialBindingDigest,
                credentialGeneration: input.credentialGeneration,
                sensitiveOutputTokens: Object.freeze([]),
              }),
              executablePath: "/synthetic/codex", privateRootPath, tmpDir,
            });
          }}),
          workspaceOwner: Object.freeze({async withLaunchAuthority<Result>(
            _input: unknown,
            consume: (authority: Readonly<{canonicalPath: string; descriptorPath: string;
              identity: Readonly<{dev: bigint; ino: bigint; mountId: string}>}>) => Promise<Result>,
          ): Promise<Result> {
            return consume(Object.freeze({canonicalPath: workspaceRef, descriptorPath: "/proc/self/fd/99",
              identity: Object.freeze({dev: 1n, ino: 2n, mountId: "mount:synthetic"})}));
          }}),
        }),
      }),
    }),
  });
};

export const submit = Object.freeze({
  commandId: "command:embedded-host-custody", expectedProvider: "codex",
  intent: Object.freeze({mode: "analysis" as const, prompt: "Inspect the disposable synthetic workspace."}),
  scope: Object.freeze({projectId: "project:one", tenantId: "tenant:one"}),
});
