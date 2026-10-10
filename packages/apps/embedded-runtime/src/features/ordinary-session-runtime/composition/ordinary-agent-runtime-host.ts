import {isAbsolute} from "node:path";
import {types} from "node:util";
import {applyOrdinaryPostgresSchema, PostgresOrdinaryOperationStore, ORDINARY_PROFILE, createNodeOrdinaryWorkspace, createNodeOrdinaryArtifacts, createNodeOrdinaryProcess, createOrdinaryCodexAdapter} from "@agent-teams/agent-execution/composition";
import {createPostgresOrdinaryProviderAccessOwner} from "@agent-teams/provider-access/composition";
import {createOrdinarySecurityOwner} from "@agent-teams/runtime-security/composition";
import {createScope, CloseIncompleteError, type CloseReport} from "@get-modular/resources";
import {bindOrdinaryProviderAccessOwner, bindOrdinarySecurityOwner} from "../adapters/ordinary-owner-acl.js";
import {createOrdinaryObservationJournal, OrdinaryJournalInitializationError} from "../adapters/ordinary-observation-journal.js";
import type {OrdinaryRuntimeAssemblyInput} from "../../../composition/runtime-setup-assembly.js";
import {copyTrustedContainedTurnScope, type TrustedRuntimeAccessScope} from "../../../composition/trusted-runtime-access-scope.js";
import type {AgentRuntimeHost} from "../../../composition/agent-runtime-host.js";
import {AgentRuntimeHostCreationError} from "../../../composition/agent-runtime-host-creation-error.js";

export interface OrdinaryAgentRuntimeHostOptions {
  readonly execution: {
    readonly provider: "codex";
    readonly executablePath: string;
    readonly authSourceDirectory: string;
    readonly privateRoot: string;
    readonly evidenceRoot: string;
    readonly sourceDirectory: string;
    readonly workspaceRoot: string;
    readonly artifactRoot: string;
    readonly sourceRevision: string;
  };
  /** Borrowed pool: the Host never ends it. Schema is expanded additively during construction. */
  readonly storage: {readonly pool: ConstructorParameters<typeof PostgresOrdinaryOperationStore>[0]["pool"]};
  readonly scope: {readonly tenantId: string; readonly projectId: string};
  readonly signal?: AbortSignal;
}
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).some(key => typeof key !== "string" || !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key))) {throw new TypeError("ordinary_host_options_invalid");}
  for (const key of keys) {const d = Object.getOwnPropertyDescriptor(value, key); if (d === undefined || !("value" in d)) {throw new TypeError("ordinary_host_options_invalid");}}
}
const incomplete = (report: CloseReport, message: string): AggregateError =>
  new AggregateError(report.debts.flatMap(debt => debt.state === "failed" ? [debt.cause] : []), message, {cause: new CloseIncompleteError(report)});
function captureOptions(value: OrdinaryAgentRuntimeHostOptions): OrdinaryAgentRuntimeHostOptions {
  exact(value, Object.hasOwn(value, "signal") ? ["execution", "storage", "scope", "signal"] : ["execution", "storage", "scope"]);
  exact(value.execution, ["provider", "executablePath", "authSourceDirectory", "privateRoot", "evidenceRoot", "sourceDirectory", "workspaceRoot", "artifactRoot", "sourceRevision"]);
  exact(value.storage, ["pool"]); exact(value.scope, ["tenantId", "projectId"]);
  const e = value.execution;
  const provider: unknown = e.provider;
  const pool = value.storage.pool as {connect?: unknown} | null | undefined;
  if (provider !== "codex" || typeof e.sourceRevision !== "string" || e.sourceRevision.length === 0 || e.sourceRevision.length > 256 || [e.executablePath, e.authSourceDirectory, e.privateRoot, e.evidenceRoot, e.sourceDirectory, e.workspaceRoot, e.artifactRoot].some(path => typeof path !== "string" || !isAbsolute(path)) || [value.scope.tenantId, value.scope.projectId].some(id => typeof id !== "string" || !/^[A-Za-z0-9:._-]{1,128}$/.test(id)) || typeof pool?.connect !== "function") {throw new TypeError("ordinary_host_options_invalid");}
  return Object.freeze({execution: Object.freeze({...e}), storage: Object.freeze({pool: value.storage.pool}), scope: Object.freeze({...value.scope}), ...(value.signal === undefined ? {} : {signal: value.signal})});
}
/** One Assembly root constructs passive setup and active ordinary execution. Auth remains lazy until submit. */
export async function createOrdinaryAgentRuntimeHost(input: OrdinaryAgentRuntimeHostOptions, construct: (signal: AbortSignal | undefined, ordinary: OrdinaryRuntimeAssemblyInput) => Promise<AgentRuntimeHost>): Promise<AgentRuntimeHost> {
  const options = captureOptions(input); options.signal?.throwIfAborted();
  let journal: ReturnType<typeof createOrdinaryObservationJournal>;
  try {journal = createOrdinaryObservationJournal(options.execution.evidenceRoot);} catch (cause) {
    if (!OrdinaryJournalInitializationError.is(cause)) {throw cause;}
    let cancellationObserved = false;
    try {cancellationObserved = options.signal?.aborted === true;} catch { /* Keep the acquired journal owner reachable. */ }
    throw new AgentRuntimeHostCreationError("internal_failure", "run", {
      cause, cancellationObserved, cleanupFailed: true, cleanupRecovery: cause.cleanupRecovery,
    });
  }
  const host = createScope({name: "ordinary-host"});
  host.resources.use({[Symbol.dispose]: () => { journal.close(); }}, "journal"); // owners record into it while releasing
  const owners = host.resources.child({name: "owners"});
  const releaseOwnersThenJournal = async (): Promise<void> => {
    const inner = await owners.control.close(); // a later call retries only failures
    const report = inner.complete ? await host.control.close() : inner;
    if (!report.complete) {throw incomplete(report, "ordinary_host_cleanup_incomplete");}
  };
  try {
    return await construct(options.signal, {
      owners: owners.resources,
      factories: {
        async operationStore() {await applyOrdinaryPostgresSchema(options.storage.pool); return new PostgresOrdinaryOperationStore({pool: options.storage.pool});},
        async security(resources) {
          const owner = await resources.setup({name: "security-owner", cleanup: o => o.dispose(),
            setup: () => createOrdinarySecurityOwner({pool: options.storage.pool, allowedScope: options.scope, policy: {...ORDINARY_PROFILE, provider: "codex", mode: "workspace-write", ttlMs: 60000, maxOutputBytes: 2000000, maxArtifactBytes: 2000000}})});
          await owner.migrate(); // registered before migrate awaits, so a failed migration keeps the owner owned
          return {port: bindOrdinarySecurityOwner(owner), registerSecrets: (operationId, tokens) => owner.registerSecrets(operationId, tokens)};
        },
        async providerAccess(registerSecrets, resources) {
          const owner = await resources.setup({name: "provider-access-owner", cleanup: o => o.dispose(),
            setup: () => createPostgresOrdinaryProviderAccessOwner({pool: options.storage.pool, registerSecrets})});
          await owner.migrate();
          return bindOrdinaryProviderAccessOwner(owner, {executable: options.execution.executablePath, sourceDirectory: options.execution.authSourceDirectory, privateRoot: options.execution.privateRoot, record: observation => { journal.record({kind: "auth_capture", ...observation}); }});
        },
        async workspace() {return createNodeOrdinaryWorkspace({sourceDirectory: options.execution.sourceDirectory, workspaceRoot: options.execution.workspaceRoot, sourceRevision: options.execution.sourceRevision, record: observation => { journal.record({...observation}); }});},
        async artifacts() {return createNodeOrdinaryArtifacts({artifactRoot: options.execution.artifactRoot, sourceRevision: options.execution.sourceRevision, record: event => { journal.record({...event}); }});},
        async process(prepareLaunch) {return createNodeOrdinaryProcess({prepareLaunch, record: event => { journal.record({...event}); }});},
        provider: resources => resources.setup({name: "codex", cleanup: codex => { codex.dispose(); },
          setup: () => createOrdinaryCodexAdapter({executable: options.execution.executablePath, record: event => { journal.record({...event}); }})}),
      },
      decorateHost(inner) {
        let disposal: Promise<void> | undefined;
        const dispose = (): Promise<void> => disposal ??= (async () => {
          await inner.dispose(); // drain and turn owner handoff prove closure first
          await releaseOwnersThenJournal(); // no root deadline in this train
        })().catch((error: unknown) => {
          disposal = undefined;
          throw new AggregateError(error instanceof AggregateError ? error.errors : [error], "ordinary_host_disposal_incomplete", {cause: error});
        });
        return Object.freeze({bindAccess(scope: TrustedRuntimeAccessScope) {
          const candidate: unknown = scope;
          if (candidate === null || typeof candidate !== "object" || types.isProxy(candidate)) {throw new Error("ordinary_host_scope_mismatch");}
          const descriptor = Object.getOwnPropertyDescriptor(scope, "containedTurn");
          if (descriptor === undefined) {return inner.bindAccess(scope);}
          if (!("value" in descriptor)) {throw new Error("ordinary_host_scope_mismatch");}
          const containedTurn = copyTrustedContainedTurnScope(descriptor.value);
          if (containedTurn === undefined || containedTurn.tenantId !== options.scope.tenantId || containedTurn.projectId !== options.scope.projectId) {throw new Error("ordinary_host_scope_mismatch");}
          return inner.bindAccess({...scope, containedTurn});
        }, dispose, [Symbol.asyncDispose]: dispose});
      },
    });
  } catch (error) {
    if (AgentRuntimeHostCreationError.is(error) && error.cleanupRecovery !== undefined) {
      // The decorated inner Host may still use these owners and journal. Keep
      // them alive until its retained recovery proves closure.
      throw error.withCleanupFailure(error, releaseOwnersThenJournal);
    }
    const [result] = await Promise.allSettled([releaseOwnersThenJournal()]);
    if (result.status === "rejected") {
      let cancellationObserved = false;
      try {cancellationObserved = options.signal?.aborted === true;} catch { /* Metadata must not lose cleanup custody. */ }
      const failure = AgentRuntimeHostCreationError.is(error) ? error
        : new AgentRuntimeHostCreationError("internal_failure", "run", {cause: error, cancellationObserved});
      throw failure.withCleanupFailure(result.reason, releaseOwnersThenJournal);
    }
    throw error;
  }
}
