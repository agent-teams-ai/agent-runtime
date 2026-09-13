// Reviewed existing registration sites only; no filename or infrastructure exemptions.
// Source lines and predicates are authenticated again before capture/merge.
const root = "packages/apps/embedded-runtime/tests/";
const darwin = 'process.platform !== "darwin"';
const linux = 'process.platform !== "linux"';
const x64 = 'process.platform !== "linux" || process.arch !== "x64"';
const sites = [
  ["package/postgres-authority-join.test.ts", 21, 21, linux, "linux-x64", "descriptor-relative custody requires Linux"],
  ["package/codex-setup.e2e.test.ts", 44, 46, darwin, "darwin-arm64"],
  ["package/codex-setup.e2e.test.ts", 124, 126, darwin, "darwin-arm64"],
  ["package/codex-setup.e2e.test.ts", 174, 176, darwin, "darwin-arm64"],
  ["helpers/assembly-direct-reference.ts", 286, 287, darwin, "darwin-arm64"],
  ["package/linux-codex-node-recipe-owners.test.ts", 45, 45, linux, "linux-x64"],
  ...[36, 46, 58].map(line => ["live/linux-codex-live-admin-route.test.ts", line, 34, x64, "linux-x64"]),
  ["live/linux-codex-node-selection.test.ts", 186, 187, x64, "linux-x64"],
  ["live/linux-codex-node-selection.test.ts", 213, 214, x64, "linux-x64"],
  ["live/linux-codex-node-selection.test.ts", 241, 242, x64, "linux-x64"],
  ["live/linux-codex-live-canary-config.test.ts", 17, 18, x64, "linux-x64"],
  ["live/linux-codex-live-admin.test.ts", 116, 116, linux, "linux-x64"],
  ...[9, 32].map(line => ["live/linux-codex-live-admin-directories.test.ts", line, line, linux, "linux-x64"]),
  ["live/run-linux-codex-live-canary.test.mjs", 328, 328, "process.platform !== 'linux'", "linux-x64", "descriptor-relative collector requires Linux"],
  ["live/run-linux-codex-live-canary-cli.test.mjs", 11, 12, "process.platform !== 'linux'", "linux-x64"],
];
export const platformSites = sites.map(([file, line, skipLine, predicate, target, reason = true]) =>
  ({file: root + file, line, skipLine, predicate, target, reason}));
