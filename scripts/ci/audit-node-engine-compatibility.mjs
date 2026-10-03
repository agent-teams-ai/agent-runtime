import {readFileSync, readdirSync, lstatSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const supportedTargets = ["24.21.0", "26.10.0"];
const versionPattern = /^v?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/u;
const comparatorPattern = /^(>=|<=|>|<|=|\^|~)?v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:-[0-9A-Za-z.-]+)?$/u;

const version = value => {
  const match = value.match(versionPattern);
  if (match === null) {throw new Error(`Unsupported Node version: ${value}`);}
  return {major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3])};
};

const compare = (left, right) => {
  for (const field of ["major", "minor", "patch"]) {
    if (left[field] !== right[field]) {return left[field] < right[field] ? -1 : 1;}
  }
  return 0;
};

const normalizePartial = (major, minor, patch) => ({
  major: Number(major),
  minor: minor === undefined || minor === "x" || minor === "*" ? 0 : Number(minor),
  patch: patch === undefined || patch === "x" || patch === "*" ? 0 : Number(patch),
});

const increment = (value, field) => {
  const next = {...value};
  if (field === "major") {return {major: value.major + 1, minor: 0, patch: 0};}
  next.minor += 1; next.patch = 0;
  return next;
};

const comparator = input => {
  const match = input.match(comparatorPattern);
  if (match === null) {throw new Error(`Unsupported Node engine comparator: ${input}`);}
  const operator = match[1] ?? "=";
  const lower = normalizePartial(match[2], match[3], match[4]);
  const isWildcard = match[3] === undefined || match[3] === "x" || match[3] === "*";
  if (operator === "=" && isWildcard) {
    return value => compare(value, lower) >= 0 && compare(value, increment(lower, "major")) < 0;
  }
  if (operator === "^") {
    const upper = match[2] === "0" ? increment(lower, "minor") : increment(lower, "major");
    return value => compare(value, lower) >= 0 && compare(value, upper) < 0;
  }
  if (operator === "~") {
    const upper = increment(lower, "minor");
    return value => compare(value, lower) >= 0 && compare(value, upper) < 0;
  }
  return value => ({
    ">=": compare(value, lower) >= 0,
    ">": compare(value, lower) > 0,
    "<=": compare(value, lower) <= 0,
    "<": compare(value, lower) < 0,
    "=": compare(value, lower) === 0,
  })[operator];
};

export const satisfiesNodeRange = (range, target) => {
  const candidate = version(target);
  return range.split("||").some(clause => {
    const comparators = clause.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/gu, "$1").split(/\s+/u)
      .filter(Boolean).map(comparator);
    return comparators.every(test => test(candidate));
  });
};

// The pre-install audit reads only the direct package roots selected by the
// workspace's one-level globs; it never walks dependency or cache directories.
const ownedPackageParents = workspaceRoot => {
  const workspace = readFileSync(join(workspaceRoot, "pnpm-workspace.yaml"), "utf8");
  const lines = workspace.match(/^packages:\s*\n((?:[ \t]+- [^\n]+\n)+)/u)?.[1];
  if (lines === undefined) {throw new Error("Missing workspace package globs");}
  return lines.trim().split("\n").map(line => {
    const glob = line.trim().match(/^- ["']?([a-z0-9/-]+\/\*)["']?$/u)?.[1];
    if (glob === undefined || glob.includes("//")) {throw new Error(`Unsupported workspace package glob: ${line}`);}
    return glob.slice(0, -2);
  });
};

export const packageManifests = (workspaceRoot = root) => {
  const manifests = [join(workspaceRoot, "package.json")];
  for (const parent of ownedPackageParents(workspaceRoot)) {
    let directory = workspaceRoot;
    let owned = true;
    for (const component of parent.split("/")) {
      directory = join(directory, component);
      if (!lstatSync(directory, {throwIfNoEntry: false})?.isDirectory()) {owned = false; break;}
    }
    if (!owned) {continue;}
    for (const entry of readdirSync(directory, {withFileTypes: true})) {
      if (!entry.isDirectory()) {continue;}
      const manifest = join(directory, entry.name, "package.json");
      if (lstatSync(manifest, {throwIfNoEntry: false})?.isFile()) {manifests.push(manifest);}
    }
  }
  return manifests.toSorted();
};

const packageName = path => {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  return manifest.name ?? path;
};

const lockfileEntries = text => {
  const entries = [];
  let inPackages = false;
  let current;
  for (const line of text.split(/\r?\n/u)) {
    if (line === "packages:") {inPackages = true; continue;}
    if (!inPackages) {continue;}
    const heading = line.match(/^  ['"]?([^'":]+(?:@[^'":]+)?)['"]?:$/u);
    if (heading !== null) {current = heading[1]; continue;}
    const engines = line.match(/engines: \{node: ['"]?([^,'"}]+)['"]?/u);
    if (engines !== null && current !== undefined) {entries.push({name: current, range: engines[1]});}
  }
  return entries;
};

export const auditNodeEngineCompatibility = (manifestPaths, lockfile) => {
  const records = [
    ...manifestPaths.map(path => ({name: packageName(path), range: JSON.parse(readFileSync(path, "utf8")).engines?.node})),
    ...lockfileEntries(lockfile),
  ];
  return supportedTargets.map(target => ({
    target,
    blockers: records.filter(record => typeof record.range !== "string" || !satisfiesNodeRange(record.range, target)),
  }));
};

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  const unexpected = process.argv.slice(2).filter(argument => argument !== "--check");
  if (unexpected.length) {throw new Error(`Unexpected arguments: ${unexpected.join(" ")}`);}
  const result = auditNodeEngineCompatibility(packageManifests(), readFileSync(join(root, "pnpm-lock.yaml"), "utf8"));
  process.stdout.write(`${JSON.stringify({schemaVersion: 1, result}, null, 2)}\n`);
  if (check && result.some(target => target.blockers.length > 0)) {process.exitCode = 1;}
}
