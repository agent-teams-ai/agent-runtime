import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Reuse consumer-owned native contract tests after product:check has built the packages.
// Their compiler harnesses use disposable directories, never an agent runtime project.
const result = spawnSync(process.execPath, [
  "--test", "--test-concurrency=1",
  "scripts/native-helper/build-native-helper.test.mjs",
  "packages/contexts/agent-execution/tests/features/contained-agent-turn/darwin-attempt-owner-tree.test.ts",
  "packages/contexts/agent-execution/tests/features/contained-agent-turn/darwin-attempt-owner-protocol.test.ts",
  "packages/platform/filesystem-custody/tests/features/stable-filesystem-custody/host-errno.test.mjs"
], { cwd: fileURLToPath(new URL("../../", import.meta.url)), stdio: "inherit" });
if (result.error) { throw result.error; }
process.exitCode = result.status ?? 1;
