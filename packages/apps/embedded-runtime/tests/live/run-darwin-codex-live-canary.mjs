#!/usr/bin/env node
import {createHash} from "node:crypto";
import {constants} from "node:fs";
import {access, chown, lstat, mkdir, open, readFile, readdir, realpath, writeFile} from "node:fs/promises";
import {dirname, isAbsolute, resolve as resolvePath} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const loadedModules = Object.freeze({
  runner: fileURLToPath(import.meta.url),
  "host-entrypoint": resolvePath(dirname(fileURLToPath(import.meta.url)), "host-child-entrypoint.mjs"),
  "full-public-runtime": resolvePath(dirname(fileURLToPath(import.meta.url)), "full-public-runtime.mjs"),
  "production-root": resolvePath(dirname(fileURLToPath(import.meta.url)), "darwin-live-production-root.mjs"),
  "root-packet-builder": resolvePath(dirname(fileURLToPath(import.meta.url)), "darwin-native-root-packet.mjs"),
});
const fail = message => {throw new Error(`DARWIN_LIVE_PREFLIGHT: ${message}`);};
const regular = async path => {const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink()) {fail(`${path} is not a regular file`);}};

// oxlint-disable-next-line complexity -- fail-closed activation validation intentionally checks the complete bounded record in one pass
export async function loadAndVerifyActivation(path) {
  const manifestPath = await realpath(path);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.version !== 1 || manifest.candidate !== true || manifest.qualified !== false) {fail("manifest is not an unqualified v1 candidate");}
  if (!/^[a-f0-9]{40}$/.test(manifest.sourceRevision)) {fail("sourceRevision is invalid");}
  if (manifest.platform !== "darwin-arm64") {fail("platform is not darwin-arm64");}
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {fail("file closure is empty");}
  const roles = new Set(manifest.files.map(entry => entry.role));
  for (const required of ["runner", "host-entrypoint", "full-public-runtime", "production-root", "root-packet-builder", "root-launcher", "native-owner", "codex", "host-peer-addon", "runtime-root-config", "pa-assembly", "pa-bootstrap", "pa-owner", "pa-auth-ipc"]) {
    if (!roles.has(required)) {fail(`closure role ${required} is missing`);}
  }
  for (const required of ["darwin-infrastructure", "runtime-root-config"]) {
    if (!roles.has(required)) {fail(`closure role ${required} is missing`);}
  }
  const fixedRoles = ["native-owner", "sandbox-exec", "codex", "node", "seatbelt-profile", "host-entrypoint", "host-peer-addon"];
  const imageRoles = manifest.native.packet.images.map((_, index) => fixedRoles[index] ?? `native-loader-${index}`);
  if (imageRoles.some((role, index) => {
    const image = manifest.native?.packet?.images?.[index], entry = manifest.files.find(file => file.role === role);
    return !image || !entry || image.path !== entry.path || image.sha256 !== entry.sha256;
  })) {fail("native fixed image slots differ from closure");}
  for (const entry of manifest.files) {
    if (typeof entry.role !== "string" || !isAbsolute(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256)) {fail("file identity is invalid");}
    await regular(entry.path);
    if (sha256(await readFile(entry.path)) !== entry.sha256) {fail(`hash mismatch for ${entry.path}`);}
  }
  for (const [role, expectedPath] of Object.entries(loadedModules)) {
    if (manifest.files.find(entry => entry.role === role)?.path !== expectedPath) {fail(`${role} path differs from the loaded module`);}
  }
  const runtimeRoot = manifest.files.find(entry => entry.role === "runtime-root-config");
  if (runtimeRoot?.path !== manifest.runtimeRootModulePath) {fail("runtime root config identity differs from closure");}
  if (manifest.files.find(entry => entry.role === "pa-bootstrap")?.path !== manifest.paRuntimeModulePath ||
      manifest.files.find(entry => entry.role === "darwin-infrastructure")?.path !== manifest.infrastructureModulePath) {
    fail("retained owner module identity differs from closure");
  }
  for (const forbidden of ["credentials", "token", "cookie", "authJson", "password"]) {
    if (Object.hasOwn(manifest, forbidden)) {fail(`credential field ${forbidden} is forbidden`);}
  }
  if (!manifest.native?.rootLauncherPath || !manifest.native.ownerPath || !manifest.evidenceDirectory) {fail("fixed launcher inputs are incomplete");}
  const launcher = manifest.files.find(entry => entry.role === "root-launcher");
  if (launcher?.path !== manifest.native.rootLauncherPath) {fail("root launcher identity differs from closure");}
  if (manifestPath !== resolvePath(dirname(manifest.native.rootLauncherPath), "activation.json")) {fail("activation is not adjacent to root launcher");}
  const owner = manifest.files.find(entry => entry.role === "native-owner");
  if (owner?.path !== manifest.native.ownerPath) {fail("native owner identity differs from closure");}
  const codex = manifest.files.find(entry => entry.role === "codex");
  if (codex?.path !== manifest.codex?.path || codex.sha256 !== manifest.codex?.sha256) {fail("Codex identity differs from closure");}
  await access(dirname(manifest.evidenceDirectory), constants.W_OK);
  try {
    const evidence = await lstat(manifest.evidenceDirectory);
    if (!evidence.isDirectory() || (await readdir(manifest.evidenceDirectory)).length !== 0) {fail("evidence directory is already consumed");}
  } catch (error) {if (error.code !== "ENOENT") {throw error;}}
  return Object.freeze({manifest, manifestPath});
}

export async function consumeAttempt(manifest, outputPath) {
  if (resolvePath(outputPath) !== resolvePath(manifest.evidenceDirectory)) {fail("output path differs from activation identity");}
  await mkdir(outputPath, {mode: 0o700, recursive: true});
  const marker = await open(resolvePath(outputPath, "attempt-consumed.json"), "wx", 0o600);
  try {await marker.writeFile(`${JSON.stringify({sourceRevision: manifest.sourceRevision, consumedAt: new Date().toISOString()})}\n`); await marker.sync();}
  finally {await marker.close();}
  if (process.getuid?.() === 0) {await chown(outputPath, manifest.native.packet.hostUid, manifest.native.packet.hostGid);}
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const [mode, activationPath, outputPath] = argv;
  if (!["--preflight", "--run-once"].includes(mode) || !activationPath || (mode === "--run-once") !== Boolean(outputPath)) {fail("invalid arguments");}
  const {manifest, manifestPath} = await (dependencies.loadActivation ?? loadAndVerifyActivation)(activationPath);
  if (mode === "--preflight") {
    const prepare = dependencies.prepareRootLaunch ?? (await import("./darwin-root-launcher.mjs")).prepareDarwinRootLaunch;
    await prepare(manifestPath);
    const inspect = dependencies.preflightInfrastructure ??
      (await import(pathToFileURL(manifest.runtimeRootModulePath).href)).preflightDarwinInfrastructure;
    if (typeof inspect !== "function") {fail("infrastructure preflight is unavailable");}
    // No operation has been claimed yet. Route installation/currentness belongs to
    // the owned post-claim, pre-spawn enforcement, never activation assertions.
    const readback = await inspect(manifest);
    if (readback?.hostEndpointReachable !== true || readback.databaseEmpty !== true ||
        readback.sourceResultAbsent !== true || readback.providerAuthoritiesFresh !== true ||
        readback.mutated !== false) {
      fail("inert infrastructure readback refused");
    }
    process.stdout.write(`${JSON.stringify({status: "inert", sourceRevision: manifest.sourceRevision})}\n`);
    return;
  }
  if (process.getuid?.() !== 0) {
    // The pinned closure's own node binary, never the ambient interpreter
    // that happened to invoke this script (finding 4): the sudo re-exec must
    // stay bound to the exact sealed closure like every other launch step.
    const pinnedNode = manifest.files.find(entry => entry.role === "node")?.path;
    if (!pinnedNode) {fail("closure has no pinned node role to re-exec under sudo");}
    const {spawn} = await import("node:child_process");
    const elevated = spawn("/usr/bin/sudo", ["--", pinnedNode, fileURLToPath(import.meta.url), ...argv],
      {stdio: "inherit", env: {PATH: "/usr/bin:/bin:/usr/sbin:/sbin"}});
    const code = await new Promise((resolve, reject) => {elevated.once("error", reject); elevated.once("exit", value => resolve(value ?? 1));});
    process.exitCode = code; return;
  }
  await consumeAttempt(manifest, outputPath);
  const {spawn} = await import("node:child_process");
  const child = spawn(manifest.native.rootLauncherPath, [], {
    stdio: ["ignore", "inherit", "inherit"],
    env: {PATH: "/usr/bin:/bin:/usr/sbin:/sbin"},
  });
  const exitCode = await new Promise((resolve, reject) => {child.once("error", reject); child.once("exit", code => resolve(code ?? 1));});
  await writeFile(resolvePath(outputPath, "exit.json"), `${JSON.stringify({exitCode})}\n`, {flag: "wx", mode: 0o600});
  if (exitCode !== 0) {process.exitCode = exitCode;}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {await main();}
