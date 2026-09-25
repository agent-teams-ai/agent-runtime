import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectArchive, readBoundedArchive } from "./archive.mjs";
import { assertExternalOutput, collect } from "./collect.mjs";

const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode;
const at = (descriptor, name) => `/proc/self/fd/${descriptor}/${name}`;

// The operator supplies an existing private parent. Its ancestors must prevent
// replacement by other users; /tmp-style root-owned sticky directories qualify.
function protectedParent(path) {
  const uid = process.getuid();
  let current = path;
  let protectedStat;
  while (true) {
    const stat = lstatSync(current);
    if (!stat.isDirectory() || ((stat.mode & 0o022) !== 0 &&
        !(stat.uid === 0 && (stat.mode & 0o1000) !== 0 && (stat.mode & 0o002) !== 0))) {
      throw new Error("output: unprotected parent ancestry");
    }
    if (current === path && (stat.uid !== uid || (stat.mode & 0o7777) !== 0o700)) {
      throw new Error("output: operator-owned 0700 parent required");
    }
    if (current === path) { protectedStat = stat; }
    const next = dirname(current);
    if (next === current) { break; }
    current = next;
  }
  return protectedStat;
}

export function writeProtectedOutput(repository, output, entries, hooks = {}) {
  if (resolve(output) !== output || !basename(output)) { throw new Error("output: normalized absolute path required"); }
  assertExternalOutput(repository, output);
  const parent = dirname(output);
  const validatedParent = protectedParent(parent);
  hooks.beforeParentOpen?.();
  const parentFd = openSync(parent, directoryFlags);
  try {
    const parentStat = fstatSync(parentFd);
    if (!sameIdentity(validatedParent, parentStat)) { throw new Error("output: parent replaced"); }
    const checkParent = () => {
      assertExternalOutput(repository, output);
      if (!sameIdentity(parentStat, lstatSync(parent)) || !sameIdentity(parentStat, fstatSync(parentFd))) {
        throw new Error("output: parent replaced");
      }
    };
    checkParent();
    hooks.afterParentOpen?.();
    checkParent();
    mkdirSync(at(parentFd, basename(output)), { mode: 0o700 });
    const outputFd = openSync(at(parentFd, basename(output)), directoryFlags);
    try {
      fchmodSync(outputFd, 0o700);
      const outputStat = fstatSync(outputFd);
      const checkOutput = () => {
        checkParent();
        if (!sameIdentity(outputStat, lstatSync(at(parentFd, basename(output)))) ||
            !sameIdentity(outputStat, fstatSync(outputFd))) { throw new Error("output: directory replaced"); }
      };
      checkOutput();
      hooks.afterOutputOpen?.();
      for (const [name, bytes] of entries) {
        if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/u.test(name)) { throw new Error("output: unsafe member name"); }
        checkOutput();
        const file = openSync(at(outputFd, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { fchmodSync(file, 0o600); writeFileSync(file, bytes); }
        finally { closeSync(file); }
        checkOutput();
      }
    } finally { closeSync(outputFd); }
  } finally { closeSync(parentFd); }
}

export function run(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    if (!name?.startsWith("--") || !args[i + 1] || options[name]) { throw new Error("usage: --repository ABS --commit SHA --tree SHA --archive TGZ --installed-base ABS --output ABS"); }
    options[name] = args[i + 1];
  }
  const names = ["--repository", "--commit", "--tree", "--archive", "--installed-base", "--output"];
  if (Object.keys(options).length !== names.length || names.some(name => !options[name])) { throw new Error("usage: exact source, archive, installation and external output required"); }
  assertExternalOutput(options["--repository"], options["--output"]);
  const candidate = collect({ repository: options["--repository"], commit: options["--commit"],
    tree: options["--tree"], archivePath: options["--archive"], installedBase: options["--installed-base"] });
  const tgz = readBoundedArchive(options["--archive"]);
  const inspected = inspectArchive(tgz);
  if (inspected.transport.sha256 !== candidate.transport.sha256 ||
      inspected.canonical.sha256 !== candidate.canonicalArchive.sha256) { throw new Error("archive: changed during collection"); }
  writeProtectedOutput(options["--repository"], options["--output"], [
    ["filesystem-custody.tgz", tgz], ["canonical-archive.json", inspected.canonical.payload],
    ["candidate.json", `${JSON.stringify(candidate, null, 2)}\n`]
  ]);
  return candidate;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(run(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
