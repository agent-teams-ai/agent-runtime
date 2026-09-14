import fs from "node:fs";
import {syncBuiltinESMExports} from "node:module";
import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, realpath, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createOrdinaryAgentRuntimeHost} from "../dist/features/ordinary-session-runtime/composition/ordinary-agent-runtime-host.js";
import {createClaudeCodeSetupInspectionPlanner} from "../dist/composition/claude-code-setup-inspection-planner.js";
import {createAgentRuntimeHost} from "../dist/composition/agent-runtime-host.js";
function forbidden(): never {throw new Error("TEST port must remain passive", {cause: "synthetic port"});}

test("ordinary Host retains owners and writable journal until retry proves feature closure", async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "ordinary-retained-TEST-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const open = fs.openSync; const close = fs.closeSync;
  let journalFd: number | undefined; let journalCloses = 0; let hostCloses = 0; let featureCloses = 0;
  t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    const fd = open(...args); if (String(args[0]).endsWith(".jsonl")) {journalFd = fd;} return fd;
  });
  t.mock.method(fs, "closeSync", (fd: number) => {if (fd === journalFd) {journalCloses += 1;} return close(fd);});
  syncBuiltinESMExports();
  t.after(() => {t.mock.restoreAll(); syncBuiltinESMExports();});
  const failure = new Error("TEST process termination unproven", {cause: "synthetic feature"}); let stopped = false;
  const pool = {connect: forbidden, query: forbidden};
  const hostFailure = new Error("TEST independent Host owner failure", {cause: "synthetic owner"});
  const dispose = async () => {hostCloses += 1; if (!stopped) {throw hostFailure;}};
  const entered = Promise.withResolvers<AbortSignal>();

  const host = await createOrdinaryAgentRuntimeHost({execution: {provider: "codex", executablePath: join(root, "absent-TEST"), authSourceDirectory: root, privateRoot: root, evidenceRoot: root, sourceDirectory: root, workspaceRoot: root, artifactRoot: root, sourceRevision: "TEST"}, storage: {pool}, scope: {tenantId: "test", projectId: "TEST"}}, async (_signal, ordinary) => {
    await ordinary.factories.provider();
    const realHost = createAgentRuntimeHost({
      codexSetup: {authorizeSetupInspection: {execute: forbidden}, discoverCodexInstallations: {execute: forbidden}, inspectCodexConfiguration: {execute: forbidden}, planCodexSetupInspection: {plan: forbidden}},
      claudeCodeSetup: {authorizeClaudeCodeSetupInspection: {async execute(_input, options): Promise<never> {
        assert.ok(options?.signal); const signal = options.signal; entered.resolve(signal);
        return new Promise((_resolve, reject) => {signal.addEventListener("abort", () => reject(signal.reason), {once: true});});
      }}, discoverClaudeCodeInstallations: {execute: forbidden}, inspectClaudeCodeConfiguration: {execute: forbidden}, planClaudeCodeSetupInspection: createClaudeCodeSetupInspectionPlanner("darwin")},
    }, {dispose});
    return ordinary.decorateHost(realHost, {
      submit: {execute: async () => ({status: "denied"})},
      observe: {execute: async () => ({status: "not_found"})},
      cancel: {execute: async () => ({status: "not_found"})},
      dispose: async () => {featureCloses += 1; if (!stopped) {throw failure;}},
    });
  });
  const access = host.bindAccess({claudeCodeSetup: {dialect: "claude-code-settings@2026-08-28", explicitExecutablePaths: [], homeRoot: root, workspaceRoot: root, workspaceTrusted: false, observationEpoch: "TEST", pathEntries: [], scopeId: "TEST"}});
  const inspecting = assert.rejects(access.claudeCodeSetup.inspect(), /disposed/, "pending inspection");
  const signal = await entered.promise;
  const first = host.dispose();
  assert.equal(signal.aborted, true); await inspecting;
  assert.throws(() => host.bindAccess({}), /disposed/);
  await assert.rejects(access.codexSetup.inspect({}), /disposed/, "closed codex handle");
  await assert.rejects(access.claudeCodeSetup.inspect(), /disposed/, "closed claude handle"); assert.equal(first, host.dispose());
  await assert.rejects(first, error => error instanceof AggregateError && error.errors.includes(failure) && error.errors.includes(hostFailure) && error.errors.length === 2);
  assert.equal(hostCloses, 1); assert.equal(journalCloses, 0); assert.equal(featureCloses, 1);
  assert.ok(journalFd !== undefined); fs.writeSync(journalFd, '{"kind":"TEST late evidence"}\n'); fs.fsyncSync(journalFd);
  stopped = true;
  await Promise.all([host.dispose(), host.dispose()]); await host[Symbol.asyncDispose]();
  assert.equal(hostCloses, 2); assert.equal(journalCloses, 1); assert.equal(featureCloses, 2);
  const closedFd = journalFd;
  assert.throws(() => fs.fstatSync(closedFd), /EBADF/);
});

test('real auth helper indeterminate cleanup remains owned through Host disposal', async () => {
  const {execFileSync} = await import('node:child_process');
  const {fileURLToPath} = await import('node:url');
  execFileSync(process.execPath, ['--experimental-test-module-mocks', '--test', fileURLToPath(new URL('./ordinary-auth-host-disposal.fixture.ts', import.meta.url))], {timeout: 10000, stdio: 'pipe'});
});
