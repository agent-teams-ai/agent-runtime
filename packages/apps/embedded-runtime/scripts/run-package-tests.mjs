import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The two original manifest argv lists, in their original order. No discovery/filtering.
export const testProcesses = [
  [
    "--test",
    "--test-concurrency=1",
    "tests/package/darwin-native-attempt-authority-join.test.ts",
    "tests/package/assembly-reference.test.ts",
    "tests/package/assembly-packed-consumer.test.ts",
    "tests/package/runtime-setup-assembly.test.ts",
    "tests/package/capability-bundle-contract.test.ts",
    "tests/package/codex-setup.e2e.test.ts",
    "tests/package/claude-code-setup.e2e.test.ts",
    "tests/package/claude-code-semantic-correction.e2e.test.ts",
    "tests/package/contained-turn.e2e.test.ts",
    "tests/package/contained-turn-authority-join.test.ts",
    "tests/package/postgres-authority-join.test.ts",
    "tests/package/contained-turn-acceptance-uncertainty.e2e.test.ts",
    "tests/package/contained-turn-access-authority.test.ts",
    "tests/package/contained-turn-provider-access-integration.test.ts",
    "tests/package/contained-turn-http-egress-provider-access-integration.test.ts",
    "tests/features/contained-turn-http-provider-access/contained-turn-http-provider-access.test.ts",
    "tests/features/contained-turn-current-egress-owners/contained-turn-current-egress-owners.test.ts",
    "tests/features/contained-turn-http-provider-access/contained-turn-http-credential-materialization.test.ts",
    "tests/features/contained-turn-http-egress-authorities/contained-turn-http-egress-authorities.test.ts",
    "tests/features/contained-turn-http-egress-upstream/contained-turn-http-egress-upstream.test.ts",
    "tests/features/contained-turn-linux-route-binding/contained-turn-linux-route-binding.test.ts",
    "tests/features/contained-turn-route-qualification/contained-turn-route-qualification.test.ts",
    "tests/package/contained-turn-route-enforcement-gate.test.ts",
    "tests/package/contained-turn-host-custody-integration.test.ts",
    "tests/package/linux-codex-deployment.test.ts",
    "tests/package/linux-codex-deployment-publication.test.ts",
    "tests/package/linux-codex-node-recipe.test.ts",
    "tests/package/linux-codex-node-recipe-owners.test.ts",
    "tests/package/linux-joined-peer.test.mjs",
    "tests/package/contained-turn-provider-selection-construction.test.ts",
    "tests/package/provider-candidate-route-gate.test.ts",
    "tests/package/claude-route-enforcement-unsupported.test.ts",
    "tests/package/contained-turn-disposal-races.e2e.test.ts",
    "tests/package/contained-turn-malformed-custody.e2e.test.ts",
    "tests/package/contained-turn-nonterminal-custody.e2e.test.ts",
    "tests/package/runtime-access-boundaries.e2e.test.ts",
    "tests/package/agent-runtime-host-disposal.unit.test.ts",
    "tests/package/host-shutdown-admission.test.ts",
    "tests/package/host-custodied-agent-runtime-host-disposal-quarantine.test.ts",
    "tests/features/contained-turn-cancellation-proof/contained-turn-cancellation-proof.unit.test.ts",
    "tests/package/contained-turn-runtime-validation.unit.test.ts",
    "tests/features/contained-turn-construction-failure/contained-turn-construction-failure.unit.test.ts",
    "tests/features/trusted-runtime-access-scope/trusted-runtime-access-scope.unit.test.ts",
    "tests/package/public-api.test.ts",
    "tests/package/claude-code-contract.test.ts",
    "tests/features/setup-inspection-planning/opaque-reference-digest.test.ts",
    "tests/package/live/linux-codex-pa-rendering.test.ts",
    "tests/package/live/linux-codex-node-selection.test.ts",
    "tests/package/live/linux-codex-live-admin-directories.test.ts",
    "tests/package/live/linux-codex-live-admin.test.ts",
    "tests/package/live/linux-codex-live-admin-route.test.ts",
    "tests/package/live/linux-codex-live-canary-config.test.ts",
    "tests/package/live/linux-codex-live-admin-firewall.test.ts",
    "tests/package/live/linux-codex-live-firewall-wiring.test.ts",
    "tests/package/contained-turn-http-digest-alignment.test.ts",
    "tests/package/live/run-linux-codex-live-canary.test.mjs",
    "tests/package/live/run-linux-codex-live-canary-cli.test.mjs",
    "tests/package/node-docker-route-provenance-integration.test.ts"
  ],
  [
    "--experimental-test-module-mocks",
    "--test",
    "tests/package/linux-http-completion-negative.mjs"
  ]
];
export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const packagePath = "packages/apps/embedded-runtime";
export const checkStages = ["clean", "typecheck", "build", "test"];
export const checkCommand = "node scripts/run-package-tests.mjs --check";
export const testCommand = "node scripts/run-package-tests.mjs";
export const reporterArg = "--test-reporter=./scripts/adoption-test-reporter.mjs";

function run(check) {
  const capture = process.env.AE_ADOPTION_CAPTURE_DIR;
  const records = [];
  const commands = check ? checkStages.map(stage => ["pnpm", ["run", stage]])
    : testProcesses.map(args => [process.execPath, [reporterArg, ...args]]);
  let failed = false;
  for (const [index, [executable, argv]] of commands.entries()) {
    const start = new Date().toISOString();
    const result = spawnSync(executable, argv, {cwd: packageRoot, env: process.env,
      encoding: "utf8", maxBuffer: 128 * 1024 * 1024});
    const prefix = `${check ? "stage" : "process"}-${index}`;
    if (capture) {
      for (const stream of ["stdout", "stderr"]) {
        writeFileSync(resolve(capture, `${prefix}.${stream}`), result[stream] ?? "", {flag: "wx"});
      }
    }
    process.stdout.write(result.stdout ?? ""); process.stderr.write(result.stderr ?? "");
    records.push({index, cwd: packagePath, executable: check ? "pnpm" : "node", argv,
      start, end: new Date().toISOString(), exitCode: result.status, signal: result.signal,
      stdout: `${prefix}.stdout`, stderr: `${prefix}.stderr`});
    if (result.error || result.status !== 0 || result.signal) { failed = true; break; }
  }
  if (capture) {writeFileSync(resolve(capture, check ? "stages.json" : "processes.json"),
    JSON.stringify(records, null, 2)+"\n", {flag: "wx"});}
  process.exitCode = failed ? 1 : 0;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === "--check"));
  run(process.argv[2] === "--check");
}
