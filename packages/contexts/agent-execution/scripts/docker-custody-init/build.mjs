import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const entry = "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/host-custody/docker/init/node-docker-custody-init-main.ts";
const base = "node@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d";
const version = "1.3.11";
const help = `Usage: node packages/contexts/agent-execution/scripts/docker-custody-init/build.mjs --output /absolute/new-directory
Builds only the current production init JavaScript and copies its Dockerfile.
Requires installed Bun ${version} on PATH and Git; never installs dependencies.
The output must be a NEW disposable directory with an existing parent.
Existing files, directories and symlinks are refused. Failed builds may leave
partial assets, but never a success manifest; retry with a new output path.
The manifest measures current bytes and records source revision/dirty status,
exact bundler argv and cwd. It is not a qualified lock or image identity.
Dockerfile targets linux/amd64; any later image build must select that platform.
No Docker build, pull, socket access or runtime launch is performed here.
Bundle/image component evidence is NOT native/Host/provider qualification.
Source/toolchain changes require fresh measurement and independent review.
`;

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root, encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
    env: { PATH: process.env.PATH, BUN_BE_BUN: "1" },
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed: ${result.error?.message ?? result.stderr}`);
  }
  return result.stdout.trim();
}

function outputPath(args) {
  if (args.length !== 2 || args[0] !== "--output" || !isAbsolute(args[1]) || [...args[1]].some(char => char.codePointAt(0) < 32 || char.codePointAt(0) === 127)) {
    throw new Error("Expected --output /absolute/new-directory; see --help");
  }
  return resolve(args[1]);
}

function build(output) {
  // Exclusive creation, without recursive mkdir or cleanup of caller paths.
  mkdirSync(output, { mode: 0o700 });
  const actualVersion = run("bun", ["--version"]);
  if (actualVersion !== version) {
    throw new Error(`Expected installed Bun ${version}; found ${actualVersion}. No install attempted.`);
  }
  const revision = run("git", ["rev-parse", "HEAD"]);
  const dirty = run("git", ["status", "--porcelain", "--untracked-files=all"]) !== "";
  const args = ["build", entry, "--target=node", "--format=esm", "--env=disable",
    "--reject-unresolved", "--external=node:*", "--outfile", join(output, "ar-custody-init.mjs")];
  run("bun", args);
  const bundle = readFileSync(join(output, "ar-custody-init.mjs"));
  if (bundle.length === 0) {throw new Error("Bundler emitted an empty bundle");}
  const dockerfile = readFileSync(new URL("./Dockerfile", import.meta.url));
  writeFileSync(join(output, "Dockerfile"), dockerfile, { flag: "wx" });
  const manifest = {
    schemaVersion: 1, evidence: "component-only; NOT native/Host/provider qualification",
    source: { revision, dirty, entry }, tool: { name: "bun", version: actualVersion },
    command: { executable: "bun", argv: args, cwd: root,
      environment: { PATH: process.env.PATH, BUN_BE_BUN: "1" } },
    image: { base, platform: "linux/amd64" },
    bundle: { file: "ar-custody-init.mjs", bytes: bundle.length,
      sha256: createHash("sha256").update(bundle).digest("hex") },
    dockerfile: { sha256: createHash("sha256").update(dockerfile).digest("hex") },
  };
  writeFileSync(join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
}

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {process.stdout.write(help);}
  else {build(outputPath(args));}
} catch (error) {
  process.stderr.write(`custody init build failed: ${error.message}\n`);
  process.exitCode = 1;
}
