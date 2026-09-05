import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const MAX_CAPTURE_BYTES = 256 * 1024;
const MAX_DATABASE_URL_BYTES = 8 * 1024;
export const POSTGRES_QUALIFICATION_CHILD_TIMEOUT_MS = 10 * 60 * 1000;
export const POSTGRES_QUALIFICATION_TIMEOUT_DIAGNOSTIC =
  "PostgreSQL qualification failed: test runner timed out.\n";
const CHILD_ENVIRONMENT_KEYS = [
  "PATH",
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
  "TEMP",
  "TMP",
  "TMPDIR",
];

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const testFiles = [
  fileURLToPath(new URL("../tests/features/contained-agent-turn/postgres-contained-turn-intent.test.ts", import.meta.url)),
  fileURLToPath(new URL("../tests/features/contained-agent-turn/postgres-fresh-process-recovery.test.ts", import.meta.url)),
  fileURLToPath(
    new URL(
      "../tests/features/contained-agent-turn/postgres-committed-dispatch.test.ts",
      import.meta.url,
    ),
  ),
  fileURLToPath(
    new URL(
      "../tests/features/contained-agent-turn/postgres-contained-turn-acceptance-commit.test.ts",
      import.meta.url,
    ),
  ),
  fileURLToPath(
    new URL(
      "../tests/features/contained-agent-turn/postgres-contained-turn.test.ts",
      import.meta.url,
    ),
  ),
  fileURLToPath(
    new URL(
      "../tests/features/contained-agent-turn/postgres-current-owner-submit-integration.test.ts",
      import.meta.url,
    ),
  ),
  fileURLToPath(
    new URL(
      "../tests/features/contained-agent-turn/postgres-contained-turn-recovery.test.ts",
      import.meta.url,
    ),
  ),
  fileURLToPath(
    new URL(
      "../tests/features/contained-agent-turn/postgres-contained-turn-output.test.ts",
      import.meta.url,
    ),
  ),
  fileURLToPath(
    new URL(
      "../tests/features/contained-agent-turn/postgres-contained-turn-bounds.test.ts",
      import.meta.url,
    ),
  ),
  fileURLToPath(
    new URL(
      "../tests/features/contained-agent-turn/postgres-preparation-cancellation-retirement.test.ts",
      import.meta.url,
    ),
  ),
];

const addSecret = (secrets, value) => {
  if (value !== "") {
    secrets.add(value);
    try {
      secrets.add(decodeURIComponent(value));
    } catch {
      // The serialized form is still redacted when a component is not valid URI encoding.
    }
  }
};

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const createRedactor = (databaseUrl, parsed) => {
  const secrets = new Set();
  addSecret(secrets, databaseUrl);
  addSecret(secrets, databaseUrl.trim());
  addSecret(secrets, parsed.href);
  addSecret(secrets, parsed.username);
  addSecret(secrets, parsed.password);
  addSecret(secrets, parsed.hostname);
  addSecret(secrets, parsed.host);
  addSecret(secrets, parsed.port);
  addSecret(secrets, parsed.pathname);
  addSecret(secrets, parsed.pathname.replace(/^\//u, ""));
  addSecret(secrets, parsed.search);
  addSecret(secrets, parsed.hash);
  addSecret(secrets, parsed.hash.replace(/^#/u, ""));
  for (const [name, value] of parsed.searchParams) {
    addSecret(secrets, name);
    addSecret(secrets, value);
  }

  const orderedSecrets = [...secrets]
    .filter((secret) => secret !== "")
    .toSorted((left, right) => right.length - left.length);
  const pattern = new RegExp(orderedSecrets.map(escapeRegExp).join("|"), "giu");

  // A single replacement pass cannot rescan replacement text. Length-preserving
  // masks also ensure that even one-character URL components cannot amplify
  // diagnostics or survive as partial secrets.
  return (diagnostic) => diagnostic.replace(pattern, (secret) => "*".repeat(secret.length));
};

const capturedText = (value) => {
  if (typeof value === "string") {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  return "";
};

const capturedByteLength = (value) => {
  if (Buffer.isBuffer(value)) {
    return value.byteLength;
  }
  return typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0;
};

const parseDatabaseUrl = (databaseUrl) => {
  if (Buffer.byteLength(databaseUrl, "utf8") > MAX_DATABASE_URL_BYTES) {
    return;
  }
  try {
    const parsed = new URL(databaseUrl.trim());
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
      return;
    }
    return parsed;
  } catch {
    return;
  }
};

const createChildEnvironment = (environment, databaseUrl) => {
  const childEnvironment = {};
  for (const allowedKey of CHILD_ENVIRONMENT_KEYS) {
    const sourceKey = Object.keys(environment).find(
      (key) => key.toLowerCase() === allowedKey.toLowerCase(),
    );
    if (sourceKey !== undefined && typeof environment[sourceKey] === "string") {
      childEnvironment[allowedKey] = environment[sourceKey];
    }
  }
  childEnvironment.POSTGRES_DURABILITY_URL = databaseUrl;
  return childEnvironment;
};

const validateInvocation = (args, databaseUrl, writeStderr) => {
  const preflightOnly = args.length === 1 && args[0] === "--preflight";
  if (databaseUrl === undefined || databaseUrl.trim() === "") {
    writeStderr(
      "PostgreSQL qualification failed: POSTGRES_DURABILITY_URL is required and must not be empty.\n",
    );
    return;
  }
  if (args.length > 0 && !preflightOnly) {
    writeStderr("PostgreSQL qualification failed: unsupported runner arguments.\n");
    return;
  }
  const parsed = parseDatabaseUrl(databaseUrl);
  if (parsed === undefined) {
    writeStderr("PostgreSQL qualification failed: POSTGRES_DURABILITY_URL is malformed.\n");
    return;
  }
  return { databaseUrl: databaseUrl.trim(), parsed, preflightOnly };
};

const startQualificationChild = (spawn, executable, environment, databaseUrl) => spawn(
  executable,
  ["--test", "--test-concurrency=1", ...testFiles],
  {
    cwd: packageRoot,
    encoding: "utf8",
    env: createChildEnvironment(environment, databaseUrl),
    maxBuffer: MAX_CAPTURE_BYTES,
    killSignal: "SIGTERM",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: POSTGRES_QUALIFICATION_CHILD_TIMEOUT_MS,
  },
);

const captureOverflowed = (result) => result.error?.code === "ENOBUFS"
  || capturedByteLength(result.stdout) > MAX_CAPTURE_BYTES
  || capturedByteLength(result.stderr) > MAX_CAPTURE_BYTES;

const writeCapturedDiagnostics = (result, redact, writeStdout, writeStderr) => {
  const stdout = capturedText(result.stdout);
  const stderr = capturedText(result.stderr);
  if (stdout !== "") {writeStdout(redact(stdout));}
  if (stderr !== "") {writeStderr(redact(stderr));}
};

const childFailureDiagnostic = (result) => {
  if (result.error !== undefined) {
    return "PostgreSQL qualification failed: test runner could not be started.\n";
  }
  if (result.signal !== null && result.signal !== undefined) {
    return "PostgreSQL qualification failed: test runner terminated by a signal.\n";
  }
  if (result.status !== 0) {
    return "PostgreSQL qualification failed: test runner exited unsuccessfully.\n";
  }
};

export const runPostgresQualification = ({
  args = process.argv.slice(2),
  databaseUrl = process.env.POSTGRES_DURABILITY_URL,
  environment = process.env,
  executable = process.execPath,
  spawn = spawnSync,
  writeStdout = (diagnostic) => process.stdout.write(diagnostic),
  writeStderr = (diagnostic) => process.stderr.write(diagnostic),
} = {}) => {
  const invocation = validateInvocation(args, databaseUrl, writeStderr);
  if (invocation === undefined) {return 1;}
  if (invocation.preflightOnly) {return 0;}
  const redact = createRedactor(invocation.databaseUrl, invocation.parsed);
  let result;
  try {
    result = startQualificationChild(
      spawn, executable, environment, invocation.databaseUrl,
    );
  } catch {
    writeStderr("PostgreSQL qualification failed: test runner could not be started.\n");
    return 1;
  }

  if (result.error?.code === "ETIMEDOUT") {
    writeStderr(POSTGRES_QUALIFICATION_TIMEOUT_DIAGNOSTIC);
    return 1;
  }
  if (captureOverflowed(result)) {
    writeStderr(
      "PostgreSQL qualification failed: test runner output exceeded the safe capture limit.\n",
    );
    return 1;
  }
  writeCapturedDiagnostics(result, redact, writeStdout, writeStderr);
  const failure = childFailureDiagnostic(result);
  if (failure !== undefined) {writeStderr(failure); return 1;}
  return 0;
};

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  process.exitCode = runPostgresQualification();
}
