import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { configuration, invalidConfigurations, prepareBootstrapProject } from "./docker-custody-init-bootstrap-fixture.ts";

const run = (root: string, configurationText: string | undefined, entry = "init/node-docker-custody-init-main.js") =>
  spawnSync(process.execPath, ["--no-addons", "--no-global-search-paths", join(root, entry)], {
    cwd: root, encoding: "utf8", timeout: 5_000, maxBuffer: 65_536,
    env: {HOME: "/agent-private/home", PATH: "/usr/local/bin:/usr/bin:/bin", TMPDIR: "/tmp",
      ...(configurationText === undefined ? {} : {AR_CUSTODY_INIT_CONFIGURATION: configurationText})},
    stdio: ["pipe", "pipe", "pipe"],
  });

// Only this disposable test copy replaces the driver. Production main has no injection seam.
const installDriverSpy = async (root: string, outcome: "zero" | "one" | "constructor-throw" | "run-reject"): Promise<void> => {
  await writeFile(join(root, "init/node-docker-custody-init-driver.js"), `
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
export class NodeDockerCustodyInitDriver {
  constructor(options) {
    appendFileSync("trace", "constructor\\n");
    assert.equal(arguments.length, 1);
    assert.deepEqual(options, ${JSON.stringify(configuration)});
    if (${JSON.stringify(outcome)} === "constructor-throw") { throw new Error(process.env.AR_CUSTODY_INIT_CONFIGURATION); }
  }
  async run() {
    appendFileSync("trace", "run:start\\n");
    await new Promise(resolve => setTimeout(resolve, 20));
    appendFileSync("trace", "run:end\\n");
    if (${JSON.stringify(outcome)} === "run-reject") { throw new Error(process.env.AR_CUSTODY_INIT_CONFIGURATION); }
    return ${outcome === "zero" ? 0 : 1};
  }
}
`);
};

test("source-loaded main never constructs a driver for malformed configuration", async t => {
  const root = await prepareBootstrapProject(t);
  await installDriverSpy(root, "zero");
  const cases: readonly [string, string | undefined][] = [
    ...invalidConfigurations,
    ["invalid identity", JSON.stringify({...configuration, observedIdentity: {secret: "DO_NOT_ECHO"}})],
    ["invalid limit", JSON.stringify({...configuration, maximumProviderRuntimeMs: 0})],
    ["wrong executable slot", JSON.stringify({...configuration, executablePath: "/ar-custody-node"})],
    ["duplicate allowlist", JSON.stringify({...configuration, allowedEnvironmentNames: ["HOME", "HOME"]})],
  ];
  for (const [label, input] of cases) {
    const result = run(root, input);
    assert.equal(result.error, undefined, label);
    assert.equal(result.signal, null, label);
    assert.equal(result.status, 1, label);
    assert.equal(result.stdout, "", label);
    assert.equal(result.stderr, "custody init startup failed\n", label);
    await assert.rejects(readFile(join(root, "trace")), {code: "ENOENT"});
  }
});

for (const outcome of ["zero", "one", "constructor-throw", "run-reject"] as const) {
  test(`source-loaded main uses one exact options argument, awaits run, and handles ${outcome}`, async t => {
    const root = await prepareBootstrapProject(t);
    await installDriverSpy(root, outcome);
    const result = run(root, JSON.stringify(configuration));
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, outcome === "zero" ? 0 : 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, outcome === "constructor-throw" || outcome === "run-reject" ? "custody init startup failed\n" : "");
    assert.equal(await readFile(join(root, "trace"), "utf8"), outcome === "constructor-throw" ? "constructor\n" : "constructor\nrun:start\nrun:end\n");
  });
}

test("source-loaded main reaches the unmodified production constructor and refuses synthetic non-container topology", async t => {
  const root = await prepareBootstrapProject(t);
  // The test process is its parent, so this process cannot be a direct child of container PID1.
  await writeFile(join(root, "production-check.mjs"), `
import assert from "node:assert/strict";
assert.notEqual(process.ppid, 1);
await import("./init/node-docker-custody-init-main.js");
`);
  const result = run(root, JSON.stringify(configuration), "production-check.mjs");
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "custody init startup failed\n");
});

test("decoder import is effect-free with absent configuration and a driver import trap", async t => {
  const root = await prepareBootstrapProject(t);
  await writeFile(join(root, "init/node-docker-custody-init-driver.js"), 'throw new Error("driver must not load");');
  const result = run(root, undefined, "init/docker-custody-init-configuration.js");
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("startup failure remains exit 1 when stderr is unavailable", async t => {
  const root = await prepareBootstrapProject(t);
  await writeFile(join(root, "closed-stderr.mjs"), `
import { closeSync } from "node:fs";
closeSync(2);
await import("./init/node-docker-custody-init-main.js");
`);
  const result = run(root, undefined, "closed-stderr.mjs");
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});
