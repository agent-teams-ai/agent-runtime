import assert from "node:assert/strict";
import dgram from "node:dgram";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";

const trap = (api: string) => (..._arguments: unknown[]): never => {
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

const {
  createAgentRuntimeHost,
  createClaudeCodeSetupInspectionPlanner,
  createCodexSetupInspectionPlanner,
} = await import("../../dist/composition.js");

const unavailable = (): never => {
  throw new Error("unrelated dependency reached");
};
const host = createAgentRuntimeHost({
  authorizeClaudeCodeSetupInspection: {
    async execute() {
      return {
        diagnostics: [],
        executableCandidates: [],
        observationEpoch: "network-trap-epoch",
        sources: [],
        status: "authorized" as const,
      };
    },
  },
  authorizeSetupInspection: { execute: unavailable },
  discoverClaudeCodeInstallations: {
    async execute() {
      return { diagnostics: [], installations: [] };
    },
  },
  discoverCodexInstallations: { execute: unavailable },
  inspectClaudeCodeConfiguration: {
    async execute() {
      return { diagnostics: [], portableIntent: [], sources: [] };
    },
  },
  inspectCodexConfiguration: { execute: unavailable },
  planClaudeCodeSetupInspection: createClaudeCodeSetupInspectionPlanner("darwin"),
  planCodexSetupInspection: createCodexSetupInspectionPlanner("linux"),
});

try {
  const result = await host.bindAccess({
    claudeCodeSetup: {
      dialect: "claude-code-settings@2026-08-28",
      explicitExecutablePaths: [],
      homeRoot: "/synthetic/home",
      observationEpoch: "network-trap-epoch",
      pathEntries: [],
      scopeId: "network-trap-scope",
      workspaceRoot: "/synthetic/workspace",
      workspaceTrusted: true,
    },
    configurationDialect: "codex-0.134",
    configurationSources: [],
    explicitCodexExecutablePaths: [],
    knownExecutableDirectories: [],
    observationEpoch: "codex-network-trap-epoch",
    pathEntries: [],
    roots: [{ absolutePath: "/synthetic", kind: "home" }],
    scopeId: "codex-network-trap-scope",
  }).claudeCodeSetup.inspect();
  assert.equal(result.status, "observed");
} finally {
  await host.dispose();
}
