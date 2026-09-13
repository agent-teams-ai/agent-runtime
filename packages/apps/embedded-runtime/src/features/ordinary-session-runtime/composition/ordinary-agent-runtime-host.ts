import {isAbsolute} from "node:path";
import {types} from "node:util";
import {applyOrdinaryPostgresSchema, PostgresOrdinaryOperationStore, ORDINARY_PROFILE, createNodeOrdinaryWorkspace, createNodeOrdinaryArtifacts, createNodeOrdinaryProcess, createOrdinaryCodexAdapter} from "@agent-teams/agent-execution/composition";
import {createPostgresOrdinaryProviderAccessOwner} from "@agent-teams/provider-access/composition";
import {createOrdinarySecurityOwner} from "@agent-teams/runtime-security/composition";
import {bindOrdinaryProviderAccessOwner, bindOrdinarySecurityOwner} from "../adapters/ordinary-owner-acl.js";
import {createOrdinaryObservationJournal} from "../adapters/ordinary-observation-journal.js";
import type {OrdinaryRuntimeAssemblyInput} from "../../../composition/runtime-setup-assembly.js";
import {copyTrustedContainedTurnScope, type TrustedRuntimeAccessScope} from "../../../composition/trusted-runtime-access-scope.js";
import type {AgentRuntimeHost} from "../../../composition/agent-runtime-host.js";

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
function captureOptions(value: OrdinaryAgentRuntimeHostOptions): OrdinaryAgentRuntimeHostOptions {
  exact(value, Object.hasOwn(value, "signal") ? ["execution", "storage", "scope", "signal"] : ["execution", "storage", "scope"]);
  exact(value.execution, ["provider", "executablePath", "authSourceDirectory", "privateRoot", "evidenceRoot", "sourceDirectory", "workspaceRoot", "artifactRoot", "sourceRevision"]);
  exact(value.storage, ["pool"]); exact(value.scope, ["tenantId", "projectId"]);
  const e = value.execution;
  if (e.provider !== "codex" || typeof e.sourceRevision !== "string" || e.sourceRevision.length === 0 || e.sourceRevision.length > 256 || [e.executablePath, e.authSourceDirectory, e.privateRoot, e.evidenceRoot, e.sourceDirectory, e.workspaceRoot, e.artifactRoot].some(path => typeof path !== "string" || !isAbsolute(path)) || [value.scope.tenantId, value.scope.projectId].some(id => typeof id !== "string" || !/^[A-Za-z0-9:._-]{1,128}$/.test(id)) || typeof value.storage.pool?.connect !== "function") {throw new TypeError("ordinary_host_options_invalid");}
  return Object.freeze({execution: Object.freeze({...e}), storage: Object.freeze({pool: value.storage.pool}), scope: Object.freeze({...value.scope}), ...(value.signal === undefined ? {} : {signal: value.signal})});
}
/** One Assembly root constructs passive setup and active ordinary execution. Auth remains lazy until submit. */
export async function createOrdinaryAgentRuntimeHost(input: OrdinaryAgentRuntimeHostOptions, construct: (signal: AbortSignal | undefined, ordinary: OrdinaryRuntimeAssemblyInput) => Promise<AgentRuntimeHost>): Promise<AgentRuntimeHost> {
  const options = captureOptions(input); options.signal?.throwIfAborted();
  const journal = createOrdinaryObservationJournal(options.execution.evidenceRoot);
  const cleanups: (() => void | Promise<void>)[] = [() => journal.close()];
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = (): Promise<void> => cleanupPromise ??= (async () => {
    const errors: unknown[] = [];
    for (const dispose of cleanups.toReversed()) {try {await dispose();} catch (error) {errors.push(error);}}
    if (errors.length > 0) {throw new AggregateError(errors, "ordinary_host_cleanup_incomplete");}
  })();
  let codex: ReturnType<typeof createOrdinaryCodexAdapter> | undefined;
  const getCodex = () => {
    if (codex === undefined) {
      codex = createOrdinaryCodexAdapter({executable: options.execution.executablePath, record: event => journal.record({...event})});
      const owned = codex; cleanups.push(() => owned.dispose());
    }
    return codex;
  };
  try {
    return await construct(options.signal, {
      factories: {
        async operationStore() {await applyOrdinaryPostgresSchema(options.storage.pool); return new PostgresOrdinaryOperationStore({pool: options.storage.pool});},
        async security() {
          const owner = createOrdinarySecurityOwner({pool: options.storage.pool, allowedScope: options.scope, policy: {...ORDINARY_PROFILE, provider: "codex", mode: "workspace-write", ttlMs: 60000, maxOutputBytes: 2000000, maxArtifactBytes: 2000000}});
          cleanups.push(() => owner.dispose()); await owner.migrate();
          return {port: bindOrdinarySecurityOwner(owner), registerSecrets: (operationId, tokens) => owner.registerSecrets(operationId, tokens)};
        },
        async providerAccess(registerSecrets) {
          const owner = createPostgresOrdinaryProviderAccessOwner({pool: options.storage.pool, registerSecrets});
          cleanups.push(() => owner.dispose()); await owner.migrate();
          return bindOrdinaryProviderAccessOwner(owner, {executable: options.execution.executablePath, sourceDirectory: options.execution.authSourceDirectory, privateRoot: options.execution.privateRoot, record: observation => journal.record({kind: "auth_capture", ...observation})});
        },
        async workspace() {return createNodeOrdinaryWorkspace({sourceDirectory: options.execution.sourceDirectory, workspaceRoot: options.execution.workspaceRoot, sourceRevision: options.execution.sourceRevision, record: observation => journal.record({...observation})});},
        async artifacts() {return createNodeOrdinaryArtifacts({artifactRoot: options.execution.artifactRoot, sourceRevision: options.execution.sourceRevision});},
        async process() {return createNodeOrdinaryProcess({prepareLaunch: getCodex().prepareLaunch, record: event => journal.record({...event})});},
        async provider() {return getCodex().provider;},
      },
      decorateHost(host, feature) {
        let disposal: Promise<void> | undefined;
        const dispose = (): Promise<void> => disposal ??= (async () => {
          const errors: unknown[] = [];
          try {await feature.dispose();} catch (error) {errors.push(error);}
          try {await host.dispose();} catch (error) {errors.push(error);}
          try {await cleanup();} catch (error) {errors.push(error);}
          if (errors.length > 0) {throw new AggregateError(errors, "ordinary_host_disposal_incomplete");}
        })();
        return Object.freeze({bindAccess(scope: TrustedRuntimeAccessScope) {
          if (scope === null || typeof scope !== "object" || types.isProxy(scope)) {throw new Error("ordinary_host_scope_mismatch");}
          const descriptor = Object.getOwnPropertyDescriptor(scope, "containedTurn");
          if (descriptor === undefined) {return host.bindAccess(scope);}
          if (!("value" in descriptor)) {throw new Error("ordinary_host_scope_mismatch");}
          const containedTurn = copyTrustedContainedTurnScope(descriptor.value);
          if (containedTurn === undefined || containedTurn.tenantId !== options.scope.tenantId || containedTurn.projectId !== options.scope.projectId) {throw new Error("ordinary_host_scope_mismatch");}
          return host.bindAccess({...scope, containedTurn});
        }, dispose, [Symbol.asyncDispose]: dispose});
      },
    });
  } catch (error) {
    const [result] = await Promise.allSettled([cleanup()]);
    if (result.status === "rejected") {
      // oxlint-disable-next-line eslint/preserve-caught-error -- AggregateError retains the primary error in both errors and cause.
      throw new AggregateError([error, result.reason], "ordinary_host_creation_cleanup_incomplete", {cause: error});
    }
    throw error;
  }
}
