import assert from "node:assert/strict";
import {join} from "node:path";
import {mkdirSync, mkdtempSync, realpathSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {createDockerCodexCurrentKernelOwner} from "../../../../dist/features/contained-agent-turn/composition/docker-codex-current-kernel-owner.js";
import {createCodexAppServerLaunchPlan} from "../../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-launch-plan.js";
import {CODEX_APP_SERVER_CURRENT_KERNEL_ADAPTER_SNAPSHOT as adapterSnapshot}
  from "../../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-current-kernel-adapter.js";
import {containedTurnIdentity as id} from "../../../../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import {digestContainedTurnCanonicalValue as digest} from "../../../../dist/features/contained-agent-turn/domain/contained-turn-codecs.js";
import {fixture} from "./docker-provider-process-fixture.ts";
import {codexChannelFixture} from "./docker-codex-channel-fixture.ts";
import {access, codexCredentialOutputInventory, syntheticCodexEffectCustody} from "./current-provider-owner-fixture.ts";

export const secret = "synthetic-output-token-connection-test";
import {createCodexAppServerPermissionBoundary} from "../../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-permission-boundary.js";


export const publicationFixture = async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "docker-publication-")));
  const privateRootPath = join(root, "private", "operation");
  const workspaceRef = join(root, "workspaces", "operation");
  const codexHome = join(privateRootPath, "codex-home"); const tmpDir = join(privateRootPath, "tmp");
  for (const path of [privateRootPath, workspaceRef, codexHome, tmpDir]) {mkdirSync(path, {recursive: true, mode: 0o700});}
  const boundary = createCodexAppServerPermissionBoundary({codexHome, workspaceRef, intentMode: "analysis"});
  const f = fixture();
  const transport: {beforeProtocolWrite?: () => void} = {};
  const attach = f.engine.attachCustody.bind(f.engine);
  f.engine.attachCustody = async authority => {await attach(authority); return codexChannelFixture(f.channel, () => transport.beforeProtocolWrite?.());};
  (f.launchInput.create as {workspaceSource: string; privateRootSource: string}).workspaceSource = boundary.workspaceRef;
  (f.launchInput.create as {privateRootSource: string}).privateRootSource = privateRootPath;
  const admission = new AbortController(); const observation = new AbortController();
  const deadlineEpochMs = Date.now() + 4000;
  const a = await f.launch({admission: {signal: admission.signal, deadlineEpochMs},
    observation: {signal: observation.signal, deadlineEpochMs,
      isActive: () => !observation.signal.aborted && Date.now() < deadlineEpochMs}});
  const plan = createCodexAppServerLaunchPlan({boundary, executablePath: "/usr/local/bin/codex", intentMode: boundary.intentMode,
    platformTarget: {architecture: "x64", platform: "linux"}, privateRootPath, tmpDir});
  const providerAccessSnapshot = Object.freeze({...access("codex"),
    tenantId: a.launched.key.tenantId, projectId: a.launched.key.projectId});
  const attempt = Object.freeze({adapterSnapshot, providerAccessSnapshot,
    attemptId: id("attempt", a.launched.key.attemptId), custodyId: id("custody", a.launched.key.custodyId),
    operationId: id("operation", a.launched.key.operationId), effectId: id("effect", "effect:docker-codex"),
    authorityVectorDigest: digest({authority: "docker-codex"}), workspaceId: id("workspace", "workspace:docker-codex"),
    intent: Object.freeze({mode: boundary.intentMode, prompt: String("Inspect the synthetic disposable workspace.")})});
  const options = {attempt, boundary, plan, process: a.input, effectCustody: syntheticCodexEffectCustody(),
    credentialOutputInventory: {...codexCredentialOutputInventory(providerAccessSnapshot, [secret]),
      credentialGeneration:Number(providerAccessSnapshot.credentialGeneration)},
    platformTarget: {architecture: "x64" as const, platform: "linux" as const}};
  const output: {cursor: number; kind: "assistant" | "diagnostic" | "progress"; text: string}[] = [];
  let delegatedStarts = 0;
  const input = {...attempt, emit: async (chunk: typeof output[number]) => {output.push(chunk);},
    isCancellationRequested: async () => false,
    start: {createProcess<Process>(createProcess: () => Process): Process {
      assert.equal(delegatedStarts, 0, "the kernel start owner invokes one creator");
      delegatedStarts += 1;
      return createProcess();
    }, observation: Promise.resolve({kind: "indeterminate" as const, evidenceId: id("evidence", "evidence:start:synthetic")})}};
  return {...f, ...a, transport, options, input, output,
    contain: async () => {const result = await a.contain(); rmSync(root, {recursive: true, force: true}); return result;}, delegatedStarts: () => delegatedStarts,
    owner: () => createDockerCodexCurrentKernelOwner(options)};
};
