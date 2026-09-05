import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const environment = {GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C", PATH: "/usr/bin:/bin"};
export const git = async (root, ...args) => (await exec("/usr/bin/git", [
  "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", root, ...args,
], {env: environment, timeout: 10_000})).stdout.trim();
export const commit = async root => {
  await git(root, "add", ".");
  await git(root, "-c", "user.name=Canary Test", "-c", "user.email=canary@example.invalid",
    "commit", "--quiet", "-m", "test: exact canary source");
};
const AE = "packages/contexts/agent-execution";
const FS = "packages/platform/filesystem-custody";

// Real Git commits and fresh temporary packages. A small installed compiler
// stand-in makes the fixed build recipe executable without dependencies.
// No provider, SDK query, transport, credentials, or injected build callback.
export const sourceFixture = async (t, provider = "codex", withGit = true) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ar-canary-source-")));
  t.after(() => rm(root, {recursive: true, force: true}));
  const live = join(root, AE, "tests/live");
  await mkdir(live, {recursive: true});
  const origin = new URL("../../../live/", import.meta.url);
  for (const name of await readdir(origin)) {
    if (name.startsWith("provider-candidate-") && name.endsWith(".mjs")) {
      await writeFile(join(live, name), await readFile(new URL(name, origin)));
    }
  }
  const canaryPath = join(live, `${provider}-contained-turn-live-canary.mjs`);
  await writeFile(canaryPath, "export const canary = true;\n");
  await writeFile(join(root, ".gitignore"), "node_modules/\n**/dist/\n**/.cache/\n");
  await writeFile(join(root, "package.json"), '{"type":"module"}\n');
  await writeFile(join(root, "pnpm-lock.yaml"), 'lockfileVersion: "9.0"\n');
  await writeFile(join(root, "pnpm-workspace.yaml"), 'packages: ["packages/*/*"]\n');
  await mkdir(join(root, "node_modules/typescript/bin"), {recursive: true});
  await writeFile(join(root, "node_modules/typescript/package.json"), '{"type":"module"}\n');
  await cp(new URL("./provider-candidate-fixture-compiler.mjs", import.meta.url), join(root, "node_modules/typescript/bin/tsc"));
  for (const pkg of [FS, AE]) {
    await mkdir(join(root, pkg, "src"), {recursive: true});
    await writeFile(join(root, pkg, "package.json"), '{"type":"module"}\n');
    await writeFile(join(root, pkg, "tsconfig.json"), JSON.stringify({
      compilerOptions: {target: "ES2024", module: "NodeNext", rootDir: "src", outDir: "dist", types: []},
      include: ["src/*.ts"],
    }));
    await writeFile(join(root, pkg, "src/runtime.ts"), "export const freshBuild: number = 1;\n");
  }
  await mkdir(join(root, FS, "scripts"));
  await writeFile(join(root, FS, "scripts/build-native-helper.mjs"), "// No native code in this disposable compiler fixture.\n");
  if (withGit) {await git(root, "init", "--quiet"); await commit(root);}
  const build = async () => {
    for (const pkg of [FS, AE]) {
      await rm(join(root, pkg, "dist"), {recursive: true, force: true});
      await exec(process.execPath, ["node_modules/typescript/bin/tsc", "--project", `${pkg}/tsconfig.json`, "--pretty", "false"], {cwd: root});
    }
  };
  await build();
  const authority = await import(pathToFileURL(join(live, "provider-candidate-evidence-envelope.mjs")).href);
  const providerId = provider === "codex" ? "codex-app-server-current-kernel" : "claude-agent-sdk-current-kernel";
  const canaryId = `${provider}-contained-turn-live-canary/v1`;
  const resolve = async (overrides = {}) => authority.resolveCanaryExecutionProvenance(Object.freeze({
    buildRootUrl: pathToFileURL(join(root, AE, "dist")).href, canaryId,
    canarySourceUrl: pathToFileURL(canaryPath).href,
    claimedSourceSha: withGit ? await git(root, "rev-parse", "HEAD") : "0".repeat(40),
    provider: providerId, ...overrides,
  }));
  return {root, authority, build, canaryPath, resolve, canaryId, providerId,
    buildPath: join(root, AE, "dist/runtime.js"), sourcePath: join(root, AE, "src/runtime.ts"),
  };
};

export const evidenceInput = (fixture, executionProvenance, overrides = {}) => Object.freeze({
  binaryRevision: fixture.providerId.startsWith("codex") ? "@openai/codex:0.150.1+linux-x64" : `sha256:${"a".repeat(64)}`,
  binarySha256: "a".repeat(64),
  canaryId: fixture.canaryId, provider: fixture.providerId, executionProvenance,
  compositeContainment: "indeterminate", physicalContainment: "indeterminate",
  observations: Object.freeze({failureKind: "canary-failed", ownerDisposal: "not_observed", runtimeDisposal: "not_observed"}),
  packageIdentity: Object.freeze(fixture.providerId.startsWith("codex") ? {wrapperPackageRevision: "@openai/codex@0.150.1"} : {sdkRevision: "@anthropic-ai/claude-agent-sdk@0.3.251"}),
  platformTuple: Object.freeze({architecture: "x64", platform: "linux"}), status: "failed", ...overrides,
});
