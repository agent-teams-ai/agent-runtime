import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import type { TestContext } from "node:test";

export const configuration = {
  allowedEnvironmentNames: ["HOME", "PATH"],
  executablePath: "/agent-private/bin/provider-entrypoint",
  executableSha256: "c".repeat(64),
  maximumStderrBytes: 1_024,
  maximumStdinBytes: 2_048,
  maximumStdoutBytes: 4_096,
  maximumProviderRuntimeMs: 5_000,
  shutdownGraceMs: 100,
  observedIdentity: {
    containerImageSha256: "a".repeat(64), initBinarySha256: "b".repeat(64),
    privateRootIdentity: "private:test", protocol: "ar.docker-custody-init/v1",
    securityProfileIdentity: "security:test", workspaceIdentity: "workspace:test",
  },
};

// Source-loaded synthetic fixtures only: fixed file list, built-in TS transform, no bundling or image claim.
export const prepareBootstrapProject = async (t: Pick<TestContext, "after">): Promise<string> => {
  const root = await mkdtemp("/tmp/ar69-init-bootstrap-test-");
  t.after(() => rm(root, {recursive: true, force: true}));
  const source = new URL("../../../src/features/contained-agent-turn/adapters/outbound/host-custody/docker/", import.meta.url);
  await mkdir(join(root, "init"));
  await mkdir(join(root, "serialization"));
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  const files = [
    "init/docker-custody-init-configuration", "init/node-docker-custody-init-main",
    "init/node-docker-custody-init-driver", "init/docker-custody-init-protocol",
    "init/docker-custody-init-runtime", "init/docker-custody-init-runtime-types",
    "init/docker-custody-init-guards", "init/docker-custody-init-input",
    "init/docker-custody-init-control-writer", "serialization/strict-json",
  ];
  for (const file of files) {
    const code = await readFile(new URL(`${file}.ts`, source), "utf8");
    await writeFile(join(root, `${file}.js`), stripTypeScriptTypes(code, {mode: "transform"}));
  }
  return root;
};

export const invalidConfigurations: readonly [string, string | undefined][] = [
  ["missing", undefined], ["empty", ""], ["truncated", "{"], ["null", "null"], ["array", "[]"],
  ["string", '"secret"'], ["trailing data", `${JSON.stringify(configuration)} true`],
  ["BOM", `\uFEFF${JSON.stringify(configuration)}`],
  ["comment", `/*secret*/${JSON.stringify(configuration)}`],
  ["deep nesting", "[".repeat(34) + "0" + "]".repeat(34)],
  ["oversize", " ".repeat(32_769)],
  ["duplicate top-level", JSON.stringify(configuration).replace('"shutdownGraceMs":100', '"shutdownGraceMs":100,"shutdownGraceMs":200')],
  ["escaped duplicate", JSON.stringify(configuration).replace('"shutdownGraceMs":100', '"shutdownGraceMs":100,"shutdownGraceM\\u0073":200')],
  ["nested duplicate", JSON.stringify(configuration).replace('"workspaceIdentity":"workspace:test"', '"workspaceIdentity":"workspace:test","workspaceIdentit\\u0079":"other"')],
  ["escaped lone surrogate", JSON.stringify(configuration).replace("workspace:test", "\\uD800")],
  ...["controlInput", "controlOutput", "syscalls", "writeControl", "internals", "tickIntervalMs", "loader", "__proto__"].map(
    field => [`forbidden ${field}`, JSON.stringify({...configuration, [field]: {secret: "DO_NOT_ECHO"}})] as [string, string]),
];
