#!/usr/bin/env node
import {createHash} from "node:crypto";
import {constants} from "node:fs";
import {access, lstat, mkdir, open, readFile, readdir, realpath, writeFile} from "node:fs/promises";
import {dirname, isAbsolute, resolve as resolvePath} from "node:path";
import {fileURLToPath} from "node:url";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const loadedModules = Object.freeze({
  runner: fileURLToPath(import.meta.url),
  "host-entrypoint": resolvePath(dirname(fileURLToPath(import.meta.url)), "host-child-entrypoint.mjs"),
  "full-public-runtime": resolvePath(dirname(fileURLToPath(import.meta.url)), "full-public-runtime.mjs"),
  "production-root": resolvePath(dirname(fileURLToPath(import.meta.url)), "darwin-live-production-root.mjs"),
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
  for (const required of ["runner", "host-entrypoint", "full-public-runtime", "production-root", "root-launcher", "native-owner", "codex", "host-peer-addon"]) {
    if (!roles.has(required)) {fail(`closure role ${required} is missing`);}
  }
  for (const entry of manifest.files) {
    if (typeof entry.role !== "string" || !isAbsolute(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256)) {fail("file identity is invalid");}
    await regular(entry.path);
    if (sha256(await readFile(entry.path)) !== entry.sha256) {fail(`hash mismatch for ${entry.path}`);}
  }
  for (const [role, expectedPath] of Object.entries(loadedModules)) {
    if (manifest.files.find(entry => entry.role === role)?.path !== expectedPath) {fail(`${role} path differs from the loaded module`);}
  }
  for (const forbidden of ["credentials", "token", "cookie", "authJson", "password"]) {
    if (Object.hasOwn(manifest, forbidden)) {fail(`credential field ${forbidden} is forbidden`);}
  }
  if (!manifest.native?.rootLauncherPath || !manifest.native.ownerPath || !manifest.evidenceDirectory) {fail("fixed launcher inputs are incomplete");}
  const launcher = manifest.files.find(entry => entry.role === "root-launcher");
  if (launcher?.path !== manifest.native.rootLauncherPath) {fail("root launcher identity differs from closure");}
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
}

export async function main(argv = process.argv.slice(2)) {
  const [mode, activationPath, outputPath] = argv;
  if (!["--preflight", "--run-once"].includes(mode) || !activationPath || (mode === "--run-once") !== Boolean(outputPath)) {fail("invalid arguments");}
  const {manifest} = await loadAndVerifyActivation(activationPath);
  if (mode === "--preflight") {
    process.stdout.write(`${JSON.stringify({status: "inert", sourceRevision: manifest.sourceRevision})}\n`);
    return;
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
