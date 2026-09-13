import type {OrdinaryProviderPort, OrdinaryProcessPort} from "../../../application/ordinary-ports.js";
import type {OrdinaryBinding, OrdinaryReceiptOf} from "../../../domain/ordinary-model.js";
import {ORDINARY_PROFILE} from "../../../domain/ordinary-model.js";
import {isCodexRecord as isRecord} from "../codex-app-server/codex-app-server-jsonl.js";
import {createOrdinaryCodexLaunchRecipe, ORDINARY_CODEX_MODEL, ORDINARY_CODEX_PROVIDER, ORDINARY_CODEX_PERMISSION,
  ordinaryCodexRefusal as refuse, ordinaryJson, validateOrdinaryCodexConfig} from "./ordinary-codex-config.js";
import {OrdinaryCodexProtocol, OrdinaryCodexTurnEvents, ordinaryCodexTurn, admitOrdinaryStartup, isOrdinaryCodexId} from "./ordinary-codex-protocol.js";

export interface OrdinaryCodexObservation extends OrdinaryBinding {
  readonly kind: "thread_start" | "turn_start" | "terminal" | "transport_drained" | "model_metadata_defaulted" | "provider_stage";
  readonly stage?: "binding" | "initialize_request" | "initialize_validation" | "initialized" | "config_request" | "config_validation" | "thread_request" | "thread_validation" | "startup_validation" | "turn_request" | "turn_validation" | "event_read" | "event_validation" | "input_close" | "drain_read" | "drain_validation" | "output_emit";
  readonly threadId?: string;
  readonly turnId?: string;
}
export interface OrdinaryCodexAdapterOptions {
  readonly executable: string;
  readonly record: (observation: OrdinaryCodexObservation) => void;
}
const binding = (input: OrdinaryBinding): OrdinaryBinding => ({operationId: input.operationId, attemptId: input.attemptId,
  executionProfile: input.executionProfile, capabilityManifestRevision: input.capabilityManifestRevision});
const equal = (left: unknown, right: unknown): boolean => ordinaryJson(left) === ordinaryJson(right);

function validateThread(result: unknown, cwd: string): string {
  if (!isRecord(result) || !isRecord(result.thread) || !isOrdinaryCodexId(result.thread.id) ||
      result.model !== ORDINARY_CODEX_MODEL || result.modelProvider !== ORDINARY_CODEX_PROVIDER ||
      result.cwd !== cwd || result.thread.cwd !== cwd || result.thread.ephemeral !== true ||
      result.thread.model !== ORDINARY_CODEX_MODEL || result.thread.modelProvider !== ORDINARY_CODEX_PROVIDER ||
      result.thread.cliVersion !== "0.153.4" || result.approvalPolicy !== "never" ||
      !equal(result.instructionSources, []) || !equal(result.runtimeWorkspaceRoots, [cwd]) ||
      !equal(result.activePermissionProfile, {id: ORDINARY_CODEX_PERMISSION, extends: ":workspace"}) ||
      !equal(result.sandbox, {type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true})) {return refuse();}
  return result.thread.id;
}

/** Recipe and provider share only immutable operation-scoped launch observations. */
export function createOrdinaryCodexAdapter(options: OrdinaryCodexAdapterOptions) {
  const prepared = new Map<string, Parameters<OrdinaryProcessPort["reserve"]>[0]>();
  const recipe = createOrdinaryCodexLaunchRecipe(options.executable);
  let disposed = false;
  const prepareLaunch: ReturnType<typeof createOrdinaryCodexLaunchRecipe> = async input => {
    if (disposed || prepared.has(input.workspace.workspaceId)) {return refuse();}
    const launch = await recipe(input);
    prepared.set(input.workspace.workspaceId, input);
    return launch;
  };
  const provider: OrdinaryProviderPort = {
    supported: {provider: "codex", mode: "workspace-write", executionProfile: ORDINARY_PROFILE.executionProfile,
      capabilityManifestRevision: ORDINARY_PROFILE.capabilityManifestRevision},
    async execute(input): Promise<OrdinaryReceiptOf<"provider_terminal">> {
      const expected = prepared.get(input.workspace.workspaceId);
      prepared.delete(input.workspace.workspaceId);
      let currentStage: NonNullable<OrdinaryCodexObservation["stage"]> = "binding";
      const recordStage = (): void => {options.record({...binding(input.operation), kind: "provider_stage", stage: currentStage});};
      const stage = (value: typeof currentStage): void => {
        currentStage = value;
        // Per-frame stages are persisted only on failure, keeping evidence bounded.
        if (!["event_read", "event_validation", "drain_read", "drain_validation"].includes(value)) {recordStage();}
      };
      try {
        stage("binding");
        if (disposed || !expected || !equal(expected.binding, binding(input.operation)) ||
            expected.workspace.cwd !== input.workspace.cwd || expected.workspace.homeDirectory !== input.workspace.homeDirectory ||
            expected.deadline !== input.deadline) {return refuse();}
        const identity = binding(input.operation);
        const protocol = new OrdinaryCodexProtocol(input.transport, input.deadline, input.signal);
        stage("initialize_request");
        const initialized = await protocol.request("initialize", "initialize", {
          clientInfo: {name: "agent-runtime-ordinary", version: "1"}, capabilities: {experimentalApi: true},
        });
        stage("initialize_validation");
        validateInitialize(initialized, input.workspace.homeDirectory);
        stage("initialized");
        await protocol.notify("initialized");
        stage("config_request");
        const config = await protocol.request("config", "config/read", {cwd: input.workspace.cwd, includeLayers: true});
        stage("config_validation");
        if (validateOrdinaryCodexConfig(config, input.workspace.homeDirectory) !== expected.credential.brokerEndpoint) {refuse();}
        options.record({...identity, kind: "thread_start"});
        stage("thread_request");
        const threadResult = await protocol.request("thread", "thread/start", {
          model: ORDINARY_CODEX_MODEL, modelProvider: ORDINARY_CODEX_PROVIDER, allowProviderModelFallback: false,
          approvalPolicy: "never", cwd: input.workspace.cwd, runtimeWorkspaceRoots: [input.workspace.cwd],
          ephemeral: true, permissions: ORDINARY_CODEX_PERMISSION,
        });
        stage("thread_validation");
        const threadId = validateThread(threadResult, input.workspace.cwd);
        stage("startup_validation");
        const startup = new Set<string>();
        for (const message of protocol.pending.splice(0)) {admitOrdinaryStartup(message, threadId, startup);}
        options.record({...identity, kind: "turn_start", threadId});
        // This is the only turn/start write. Exceptions, timeouts and unknown replies never re-enter it.
        stage("turn_request");
        const turnResult = await protocol.request("turn", "turn/start", {
          threadId, approvalPolicy: "never", cwd: input.workspace.cwd, permissions: ORDINARY_CODEX_PERMISSION,
          input: [{type: "text", text: input.operation.input.intent.prompt, text_elements: []}],
        });
        stage("turn_validation");
        const turnId = validateTurnResponse(turnResult);
        const events = new OrdinaryCodexTurnEvents(threadId, turnId, input.workspace.cwd, startup);
        for (const message of protocol.pending.splice(0)) {stage("event_validation"); events.admit(message);}
        while (events.terminal === undefined) {
          stage("event_read");
          const message = await protocol.next();
          if (!message) {return refuse();}
          stage("event_validation");
          events.admit(message);
        }
        options.record({...identity, kind: "terminal", threadId, turnId});
        if (startup.has("warning")) {options.record({...identity, kind: "model_metadata_defaulted", threadId, turnId});}
        stage("input_close");
        await input.transport.closeInput();
        for (;;) {
          stage("drain_read");
          const message = await protocol.next();
          if (message === undefined) {break;}
          stage("drain_validation");
          events.admit(message);
        }
        options.record({...identity, kind: "transport_drained", threadId, turnId});
        stage("output_emit");
        if (events.assistant) {await input.emit({kind: "assistant", text: events.assistant});}
        const terminalStatus = events.terminal.status === "completed" ? "completed" : "failed";
        if (terminalStatus === "failed") {await input.emit({kind: "diagnostic", text: "ORDINARY_CODEX_PROVIDER_FAILED"});}
        return {...identity, kind: "provider_terminal", terminalStatus, threadId, turnId};
      } catch (error) {
        try {recordStage();} catch { /* Journal failure must not restore consumed preparation or mask the original failure. */ }
        throw error;
      }
    },
  };
  return Object.freeze({prepareLaunch, provider, dispose() {disposed = true; prepared.clear();}});
}

function validateInitialize(initialized: unknown, homeDirectory: string): void {
      if (!isRecord(initialized) || initialized.codexHome !== homeDirectory || initialized.platformFamily !== "unix" ||
          initialized.platformOs !== "macos" || typeof initialized.userAgent !== "string" ||
          !/^agent-runtime-ordinary\/0\.153\.4 \(Mac OS [^;]+; arm64\)/u.test(initialized.userAgent)) {refuse();}
}

function validateTurnResponse(result: unknown): string {
  if (!isRecord(result)) {return refuse();}
  const turn = ordinaryCodexTurn(result.turn);
  if (turn.status !== "inProgress") {refuse();}
  return String(turn.id);
}
