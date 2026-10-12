import { execFileSync, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const expectedNodeVersion = "v24.21.0";
const executableEnvironmentKey = "LEGACY_TEST_NODE_EXECUTABLE";
const childEnvironmentKey = "DOCS_LEGACY_MANAGED_TARGET_CHILD";
const childEnvironmentValue = "run-on-node-24.21.0";
const legacyTestFile = fileURLToPath(new URL("./managed-installed-target.test.mjs", import.meta.url));
const forwardedSignals = process.platform === "win32"
  ? ["SIGINT", "SIGTERM", "SIGBREAK"] as const
  : ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"] as const;
type ForwardedSignal = typeof forwardedSignals[number];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runLegacyManagedTargetTest(): Promise<number> {
  const executable = process.env[executableEnvironmentKey];
  if (executable === undefined || executable === "") {
    throw new Error(`${executableEnvironmentKey} must name the disposable Node ${expectedNodeVersion.slice(1)} executable`);
  }

  let observedVersion: string;
  try {
    observedVersion = execFileSync(executable, ["--version"], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      encoding: "utf8",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
      windowsHide: true,
    }).trim();
  } catch (error) {
    throw new Error(`cannot execute legacy TEST Node ${executable}: ${errorMessage(error)}`);
  }
  if (observedVersion !== expectedNodeVersion) {
    throw new Error(`legacy TEST Node must be exactly ${expectedNodeVersion}; observed ${observedVersion || "<empty>"}`);
  }

  const child = spawn(executable, ["--test", legacyTestFile], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    env: { ...process.env, [childEnvironmentKey]: childEnvironmentValue },
    shell: false,
    stdio: "inherit",
    windowsHide: true,
  });
  const listeners = forwardedSignals.map((signal: ForwardedSignal) => {
    const listener = (): void => {
      child.kill(signal);
    };
    process.on(signal, listener);
    return [signal, listener] as const;
  });
  let result: { code: number | null; signal: NodeJS.Signals | null };
  try {
    result = await new Promise((resolve, reject) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
      child.once("error", reject);
    });
  } catch (error) {
    throw new Error(`cannot execute legacy TEST Node: ${errorMessage(error)}`);
  } finally {
    for (const [signal, listener] of listeners) { process.removeListener(signal, listener); }
  }
  if (result.signal !== null) {
    process.kill(process.pid, result.signal);
    throw new Error(`legacy TEST terminated by ${result.signal} without process signal forwarding`);
  }
  return result.code ?? 1;
}

const invoked = process.argv[1];
if (invoked !== undefined
  && import.meta.url === pathToFileURL(realpathSync(invoked)).href) {
  process.exitCode = await runLegacyManagedTargetTest();
}
