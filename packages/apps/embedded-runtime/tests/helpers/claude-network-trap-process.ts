import assert from "node:assert/strict";
import dgram from "node:dgram";
import dns from "node:dns";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";

const networkAttempts: string[] = [];
const trap = (api: string) => (..._arguments: unknown[]): never => {
  networkAttempts.push(api);
  throw new Error(`network API attempted: ${api}`);
};

const install = (target: object, member: string, api: string): void => {
  assert.equal(Reflect.set(target, member, trap(api)), true);
};

Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  value: trap("fetch"),
  writable: true,
});
for (const member of ["lookup", "resolve", "resolve4", "resolve6", "resolveAny", "reverse"]) {
  install(dns, member, `dns.${member}`);
  install(dns.promises, member, `dns.promises.${member}`);
}
for (const member of ["get", "request"]) {
  install(http, member, `http.${member}`);
  install(https, member, `https.${member}`);
}
for (const member of ["connect", "createConnection"]) {
  install(net, member, `net.${member}`);
}
install(net.Socket.prototype, "connect", "net.Socket.connect");
install(tls, "connect", "tls.connect");
install(tls.TLSSocket.prototype, "connect", "tls.TLSSocket.connect");
install(dgram, "createSocket", "dgram.createSocket");
for (const member of ["bind", "connect", "send"]) {
  install(dgram.Socket.prototype, member, `dgram.Socket.${member}`);
}
syncBuiltinESMExports();

const root = await mkdtemp(join(tmpdir(), "ar-claude-network-trap-"));
const home = join(root, "home");
const workspace = join(root, "workspace");
const executable = join(home, ".local", "bin", "claude");
const executionMarker = join(root, "execution-marker");
const executableBytes = `#!/bin/sh\nprintf executed > '${executionMarker}'\n`;
let disposeHost: (() => Promise<void>) | undefined;

try {
  await Promise.all([
    mkdir(join(home, ".local", "bin"), { recursive: true }),
    mkdir(join(home, ".claude"), { recursive: true }),
    mkdir(join(workspace, ".claude"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(executable, executableBytes),
    writeFile(join(home, ".claude", "settings.json"), JSON.stringify({ model: "claude-opus-4-8[1m]" })),
    writeFile(join(workspace, ".claude", "settings.json"), JSON.stringify({
      effortLevel: "low",
      model: "arn:aws:bedrock:us-east-1:111111111111:application-inference-profile/AR2_ROUTE_ID_MUST_NEVER_APPEAR",
    })),
    writeFile(join(workspace, ".claude", "settings.local.json"), JSON.stringify({ effortLevel: "high" })),
  ]);
  await chmod(executable, 0o755);

  process.chdir(workspace);
  process.env.HOME = home;
  process.env.PATH = join(home, ".local", "bin");

  const [executionComposition, configurationComposition, securityComposition, embeddedComposition] =
    await Promise.all([
      import("@agent-teams/agent-execution/composition"),
      import("@agent-teams/runtime-configuration/composition"),
      import("@agent-teams/runtime-security/composition"),
      import("../../dist/composition.js"),
    ]);

  const nodeCanonicalizer = securityComposition.createNodePathCanonicalizer();
  const pathCanonicalizer = {
    canonicalize(path: string, options?: Parameters<typeof nodeCanonicalizer.canonicalize>[1]) {
      options?.signal?.throwIfAborted();
      if (path === "/opt/homebrew" || path.startsWith("/opt/homebrew/") ||
        path === "/usr/local" || path.startsWith("/usr/local/")) {
        return Promise.resolve({
          absolutePath: path,
          canonicalLocationPath: path,
          exists: false as const,
        });
      }
      assert.ok(path === root || path.startsWith(`${root}/`), `unexpected filesystem input: ${path}`);
      return nodeCanonicalizer.canonicalize(path, options);
    },
  };
  const security = securityComposition.createSetupInspectionAuthorizationFeature({
    pathCanonicalizer,
  });

  const nodeExecutableObserver = executionComposition.createNodeExecutableFileObserver();
  const execution = executionComposition.createRuntimeInstallationDiscoveryFeature({
    executableFileObserver: {
      observe(request) {
        request.signal?.throwIfAborted();
        if (request.absolutePath === "/opt/homebrew/bin/claude" || request.absolutePath === "/usr/local/bin/claude") {
          return Promise.resolve({ kind: "missing" as const });
        }
        assert.ok(request.absolutePath.startsWith(`${root}/`), `unexpected executable input: ${request.absolutePath}`);
        return nodeExecutableObserver.observe(request);
      },
    },
  });

  const sourceReader = configurationComposition.createNodeConfigurationSourceReader();
  const codexConfiguration = configurationComposition.createCodexConfigurationInspectionFeature({
    parser: configurationComposition.createSmolTomlParser(),
    semanticClassifier: configurationComposition.createCodexConfigurationSemanticClassifierV1(),
    sourceIdentityKey: new Uint8Array(32).fill(3),
    sourceReader,
  });
  const claudeConfiguration = configurationComposition.createClaudeCodeConfigurationInspectionFeature({
    parser: configurationComposition.createStrictClaudeCodeJsonParser(),
    semanticClassifier: configurationComposition.createClaudeCodeConfigurationSemanticClassifierV2(),
    sourceIdentityKey: new Uint8Array(32).fill(5),
    sourceReader: configurationComposition.createClaudeCodeConfigurationSourceReaderAdapter(sourceReader),
  });

  const host = embeddedComposition.createAgentRuntimeHost({
    claudeCodeSetup: {
      authorizeClaudeCodeSetupInspection: security.authorizeClaudeCodeSetupInspection,
      discoverClaudeCodeInstallations: execution.discoverClaudeCodeInstallations,
      inspectClaudeCodeConfiguration: claudeConfiguration,
      planClaudeCodeSetupInspection: embeddedComposition.createClaudeCodeSetupInspectionPlanner("darwin"),
    },
    codexSetup: {
      authorizeSetupInspection: security.authorizeSetupInspection,
      discoverCodexInstallations: execution.discoverCodexInstallations,
      inspectCodexConfiguration: codexConfiguration.inspectCodexConfiguration,
      planCodexSetupInspection: embeddedComposition.createCodexSetupInspectionPlanner("linux"),
    },
  });
  disposeHost = host.dispose;
  const access = host.bindAccess({
    claudeCodeSetup: {
      dialect: "claude-code-settings@2026-08-28",
      explicitExecutablePaths: [],
      homeRoot: home,
      observationEpoch: "network-trap-epoch",
      pathEntries: [],
      scopeId: "network-trap-scope",
      workspaceRoot: workspace,
      workspaceTrusted: true,
    },
    codexSetup: {
      configurationDialect: "codex-0.134",
      configurationSources: [],
      explicitCodexExecutablePaths: [],
      knownExecutableDirectories: [],
      observationEpoch: "codex-network-trap-epoch",
      pathEntries: [],
      roots: [{ absolutePath: root, kind: "home" }],
      scopeId: "codex-network-trap-scope",
    },
  });

  const controller = new AbortController();
  const cancelled = access.claudeCodeSetup.inspect({ signal: controller.signal });
  controller.abort(new DOMException("synthetic cancellation", "AbortError"));
  await assert.rejects(cancelled, { name: "AbortError" });

  const result = await access.claudeCodeSetup.inspect();
  assert.equal(result.status, "observed", JSON.stringify(result));
  if (result.status !== "observed") {
    throw new Error("synthetic Claude Code setup was not observed");
  }
  assert.deepEqual(result.installations.map(installation => installation.status), [
    "found_unverified",
  ]);
  assert.deepEqual(result.observedPortableIntent.map(intent => JSON.stringify([
    intent.key, intent.key === "model" ? intent.selection : intent.value,
  ])).toSorted(), [
    ["effortLevel", "low"], ["effortLevel", "high"],
    ["model", { kind: "exact-name", value: "claude-opus-4-8[1m]" }],
  ].map(item => JSON.stringify(item)).toSorted());
  assert.deepEqual(result.deferredObservations.map(item => [item.key, item.form, item.status]), [
    ["model", "provider-deployment", "deferred"],
  ]);
  assert.equal(Object.isFrozen(result.deferredObservations), true);
  assert.equal(Object.isFrozen(result.deferredObservations[0]), true);
  assert.equal(result.status, "observed");
  assert.equal(result.nextActions.includes("review_configuration"), false);
  assert.equal(result.expectedLimitations.modelCompatibility, "unobserved");
  assert.doesNotMatch(JSON.stringify(result), /AR2_ROUTE_ID_MUST_NEVER_APPEAR|111111111111/u);
  assert.deepEqual(result.sourceObservations.map(source => source.status), [
    "applied",
    "applied",
    "applied",
  ]);
  assert.deepEqual(result.nextActions, []);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(root, "u"));
  assert.equal(await readFile(executable, "utf8"), executableBytes);
  await assert.rejects(readFile(executionMarker), { code: "ENOENT" });

  const firstDisposal = host.dispose();
  const secondDisposal = host.dispose();
  assert.strictEqual(firstDisposal, secondDisposal);
  await firstDisposal;
  await assert.rejects(access.claudeCodeSetup.inspect(), /Host is disposed/u);
  assert.throws(() => host?.bindAccess({} as never), /Host is disposed/u);
  assert.deepEqual(networkAttempts, []);
} finally {
  await disposeHost?.();
  await rm(root, { force: true, recursive: true });
}
