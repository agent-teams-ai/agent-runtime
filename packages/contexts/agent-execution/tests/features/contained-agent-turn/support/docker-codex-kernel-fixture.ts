import {dockerProviderProcessMountFacts} from "../../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-provider-process-entrypoint.js";
import assert from "node:assert/strict";
import {dirname, join} from "node:path";
import {copyFileSync, writeFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {encodeCreateRequest} from "../../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/docker-create-request.js";
import {policy} from "./docker-host-custody-lifecycle-fixture.ts";
import {createDockerCodexCurrentKernelOwner} from "../../../../dist/features/contained-agent-turn/composition/docker-codex-current-kernel-owner.js";
import {createCodexAppServerLaunchPlan, isCodexNativeBrokerLaunchPlan} from "../../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-launch-plan.js";
import {CODEX_APP_SERVER_CURRENT_KERNEL_ADAPTER_SNAPSHOT as adapterSnapshot}
  from "../../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-current-kernel-adapter.js";
import {containedTurnIdentity as id} from "../../../../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import {digestContainedTurnCanonicalValue as digest} from "../../../../dist/features/contained-agent-turn/domain/contained-turn-codecs.js";
import {nativeConfigResult} from "../../../fixtures/codex-native-config-0.153.4/fixture.ts";
import {agentMessage, emitAgentStarted, emitAgentCompleted, generatedTurn} from "../../../codex-app-server-test-messages.mjs";
import {fixture} from "./docker-provider-process-fixture.ts";
import {codexChannelFixture} from "./docker-codex-channel-fixture.ts";
import {access, codexCredentialOutputInventory, syntheticCodexEffectCustody} from "./current-provider-owner-fixture.ts";

export const secret = "synthetic-output-token-connection-test";
import {brokerFixture, nativeBrokerConfig, fixtureCapability, catalogUrl, fixtureEndpoint} from "../../../fixtures/codex-native-broker-0.153.4/fixture.ts";
import {createCodexAppServerPermissionBoundary, codexTurnSandboxPolicy} from "../../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-permission-boundary.js";

import {createCodexNativeBrokerRecipe, renderCodexNativeBrokerConfig} from "../../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-native-broker-recipe.js";
import {prepareCodexNativeBrokerFiles} from "../../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-native-broker-files.js";

export const connectionFixture = async (native?: ReturnType<typeof brokerFixture>) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ar233 Docker é 😀 ")));
  const privateRootPath = join(root, "private", "operation");
  const workspaceRef = join(root, "workspaces", "operation");
  const codexHome = join(privateRootPath, "codex-home"); const tmpDir = join(privateRootPath, "tmp");
  for (const path of [privateRootPath, workspaceRef, codexHome, tmpDir]) {mkdirSync(path, {recursive: true, mode: 0o700});}
  const boundary = createCodexAppServerPermissionBoundary({codexHome, workspaceRef, intentMode: native?.boundary.intentMode ?? "analysis"});
  const f = fixture();
  const transport: {beforeProtocolWrite?: () => void} = {};
  const attach = f.engine.attachCustody.bind(f.engine);
  f.engine.attachCustody = async authority => {await attach(authority); return codexChannelFixture(f.channel, () => transport.beforeProtocolWrite?.());};
  (f.launchInput.create as {workspaceSource: string; privateRootSource: string}).workspaceSource = boundary.workspaceRef;
  (f.launchInput.create as {privateRootSource: string}).privateRootSource = privateRootPath;
  let encodedCreate: Record<string, unknown> | undefined;
  const create = f.engine.create.bind(f.engine);
  f.engine.create = async input => {
    encodedCreate = encodeCreateRequest(input, {...policy("/synthetic"),
      workspaceSourceRoot: dirname(boundary.workspaceRef), privateRootSourceRoot: dirname(privateRootPath)});
    return create(input);
  };
  const a = await f.launch();
  let material;
  if (native !== undefined) {
    const recipe = createCodexNativeBrokerRecipe({boundary, endpoint: fixtureEndpoint, profile: "codex-chatgpt", dockerMounts: dockerProviderProcessMountFacts(a.launched)});
    writeFileSync(join(codexHome, "config.toml"), renderCodexNativeBrokerConfig(recipe), {mode: 0o600});
    copyFileSync(catalogUrl, join(codexHome, "models.json"));
    const {chmodSync} = await import("node:fs"); chmodSync(join(codexHome, "models.json"), 0o600);
    material = {recipe, files: await prepareCodexNativeBrokerFiles(recipe), localCapability: fixtureCapability};
  }
  const plan = createCodexAppServerLaunchPlan({boundary, executablePath: "/usr/local/bin/codex", intentMode: boundary.intentMode,
    platformTarget: {architecture: "x64", platform: "linux"}, privateRootPath, tmpDir,
    ...(material === undefined ? {} : {nativeBroker: material})});
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
  return {...f, ...a, encodedCreate, transport, options, input, output,
    contain: async () => {const result = await a.contain(); rmSync(root, {recursive: true, force: true}); return result;}, delegatedStarts: () => delegatedStarts,
    owner: () => createDockerCodexCurrentKernelOwner(options)};
};

export const installProtocol = (f: Awaited<ReturnType<typeof connectionFixture>>) => {
  const boundary = f.options.boundary;
  const childHome = "/agent-private/codex-home"; const childWorkspace = "/workspace";
  const requests: string[] = []; let buffer = Buffer.alloc(0);
  const emit = (message: unknown) => f.channel.outputBytes("stdout", `${JSON.stringify(message)}\n`);
  f.channel.onMessage = message => {
    f.channel.respond(message);
    if (message.kind === "provider-exec") {
      assert.deepEqual(message.argv, [f.options.plan.executablePath, ...f.options.plan.arguments]);
      assert.equal(message.executableSha256, f.options.plan.executableSha256);
      assert.deepEqual(message.environment, Object.entries({...f.options.plan.environment,
        CODEX_HOME: childHome, HOME: childHome, TMPDIR: "/agent-private/tmp"}).map(([name, value]) => ({name, value})));
    }
    if (message.kind === "provider-input-eof") {setImmediate(() => {f.channel.rootExit(); f.channel.drain();});}
    if (message.kind !== "provider-input") {return;}
    buffer = Buffer.concat([buffer, Buffer.from(message.bytesBase64, "base64")]);
    if (buffer.at(-1) !== 10) {return;}
    const request = JSON.parse(buffer.toString().trim()); buffer = Buffer.alloc(0); requests.push(request.method);
    if (["config/read", "permissionProfile/list", "thread/start", "turn/start"].includes(request.method)) {
      assert.equal(request.params.cwd, childWorkspace);
    }
    if (request.method === "initialize") {emit({id: request.id, result: {codexHome: childHome,
      platformFamily: "unix", platformOs: "linux", userAgent: "agent-runtime/0.153.4 (Ubuntu 24.4.0; x86_64) unknown (agent-runtime; codex-app-server-contained-turn:0.153.4+native-permission-config-v2)"}});}
    if (request.method === "config/read") {emit({id: request.id, result: isCodexNativeBrokerLaunchPlan(f.options.plan) ? nativeBrokerConfig(childHome, boundary.intentMode) : nativeConfigResult(childHome, boundary.intentMode)});}
    if (request.method === "permissionProfile/list") {emit({id: request.id,
      result: {data: [{allowed: true, description: null, id: boundary.permissionProfileId}], nextCursor: null}});}
    if (request.method === "thread/start") {emit({id: request.id, result: {thread: {id: "thread:test"},
      activePermissionProfile: {extends: boundary.permissionProfile.extends, id: boundary.permissionProfileId},
      approvalPolicy: "never", cwd: childWorkspace, sandbox: codexTurnSandboxPolicy(boundary.intentMode,boundary.workspaceRef)}});}
    if (request.method === "turn/start") {
      assert.equal(request.params.input[0].text, f.input.intent.prompt);
      const turn = "turn:docker-kernel"; const item = "item:docker-kernel"; const text = "bounded synthetic output";
      f.channel.outputBytes("stderr", "synthetic diagnostic");
      emit({id: request.id, result: {turn: generatedTurn(turn, "inProgress")}});
      emit({method: "turn/started", params: {threadId: "thread:test", turn: generatedTurn(turn, "inProgress")}});
      emitAgentStarted({emit}, turn, item);
      emit({method: "item/agentMessage/delta", params: {threadId: "thread:test", turnId: turn, itemId: item, delta: text}});
      emitAgentCompleted({emit}, turn, item, text);
      emit({method: "turn/completed", params: {threadId: "thread:test", turn: generatedTurn(turn, "completed", null, [agentMessage(item, text)])}});
    }
  };
  return requests;
};
