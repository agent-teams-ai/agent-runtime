import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const MAX_CAPTURE_BYTES = 256 * 1024;
const REDACTION = "[REDACTED]";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const testFiles = [
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

const createRedactor = (databaseUrl) => {
  const secrets = new Set();
  addSecret(secrets, databaseUrl);
  addSecret(secrets, databaseUrl.trim());

  try {
    const parsed = new URL(databaseUrl.trim());
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
    for (const value of parsed.searchParams.values()) {
      addSecret(secrets, value);
    }
  } catch {
    return undefined;
  }

  const orderedSecrets = [...secrets]
    .filter((secret) => secret !== "")
    .sort((left, right) => right.length - left.length);

  return (diagnostic) => {
    let redacted = diagnostic;
    for (const secret of orderedSecrets) {
      redacted = redacted.replaceAll(secret, REDACTION);
    }
    return redacted;
  };
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

const boundedText = (value) => {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= MAX_CAPTURE_BYTES) {
    return value;
  }
  return `${encoded.subarray(0, MAX_CAPTURE_BYTES).toString("utf8")}\n[diagnostic truncated]\n`;
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
  const preflightOnly = args.length === 1 && args[0] === "--preflight";

  if (databaseUrl === undefined || databaseUrl.trim() === "") {
    writeStderr(
      "PostgreSQL qualification failed: POSTGRES_DURABILITY_URL is required and must not be empty.\n",
    );
    return 1;
  }
  if (args.length > 0 && !preflightOnly) {
    writeStderr("PostgreSQL qualification failed: unsupported runner arguments.\n");
    return 1;
  }
  if (preflightOnly) {
    return 0;
  }

  const redact = createRedactor(databaseUrl);
  let result;
  try {
    result = spawn(
      executable,
      ["--test", "--test-concurrency=1", ...testFiles],
      {
        cwd: packageRoot,
        encoding: "utf8",
        env: environment,
        maxBuffer: MAX_CAPTURE_BYTES,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch {
    writeStderr("PostgreSQL qualification failed: test runner could not be started.\n");
    return 1;
  }

  if (redact !== undefined) {
    const stdout = boundedText(redact(capturedText(result.stdout)));
    const stderr = boundedText(redact(capturedText(result.stderr)));
    if (stdout !== "") {
      writeStdout(stdout);
    }
    if (stderr !== "") {
      writeStderr(stderr);
    }
  }

  if (result.error !== undefined) {
    const message =
      result.error.code === "ENOBUFS"
        ? "PostgreSQL qualification failed: test runner output exceeded the safe capture limit.\n"
        : "PostgreSQL qualification failed: test runner could not be started.\n";
    writeStderr(message);
    return 1;
  }
  if (result.signal !== null && result.signal !== undefined) {
    writeStderr("PostgreSQL qualification failed: test runner terminated by a signal.\n");
    return 1;
  }
  if (result.status !== 0) {
    writeStderr("PostgreSQL qualification failed: test runner exited unsuccessfully.\n");
    return 1;
  }
  return 0;
};

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  process.exitCode = runPostgresQualification();
}
