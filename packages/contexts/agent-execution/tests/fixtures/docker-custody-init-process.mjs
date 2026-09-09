import {
  DOCKER_CUSTODY_INIT_PROTOCOL,
} from "../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/init/docker-custody-init-protocol.js";
import {
  NodeDockerCustodyInitDriver,
} from "../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/init/node-docker-custody-init-driver.js";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const digest = value => value.repeat(64);
const identity = Object.freeze({
  containerImageSha256: digest("a"), initBinarySha256: digest("b"),
  privateRootIdentity: "private-root:driver", protocol: DOCKER_CUSTODY_INIT_PROTOCOL,
  securityProfileIdentity: "security-profile:driver", workspaceIdentity: "workspace:driver",
});
const uid = 65534;
const gid = 65534;
const executableRoot = mkdtempSync(join(tmpdir(), "ar-init-driver-"));
const executablePath = join(executableRoot, "provider-entrypoint");
copyFileSync("/bin/cat", executablePath);
chmodSync(executablePath, 0o555);
const executableSha256 = createHash("sha256").update(readFileSync(executablePath)).digest("hex");
// Exercise the driver's production option construction, with a syscall-boundary
// assertion that models seccomp rejecting even redundant identity changes.
const nativeSpawn = childProcess.spawn;
childProcess.spawn = (file, args, options) => {
  assert.equal(Object.hasOwn(options, "uid"), false);
  assert.equal(Object.hasOwn(options, "gid"), false);
  assert.equal(options.shell, false);
  assert.equal(options.detached, false);
  assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
  return nativeSpawn(file, args, options);
};
syncBuiltinESMExports();
const driver = new NodeDockerCustodyInitDriver({
  allowedEnvironmentNames: Object.freeze([]), executablePath,
  executableSha256, maximumProviderRuntimeMs: 5_000,
  maximumStderrBytes: 65_536, maximumStdinBytes: 65_536, maximumStdoutBytes: 65_536,
  observedIdentity: identity, shutdownGraceMs: 100, tickIntervalMs: 2,
}, {
  observeTopology: () => Object.freeze({gid, groups: Object.freeze([gid]), noNewPrivileges: true,
    parentName: "docker-init", parentPid: 1, pid: process.pid, uid}),
  observeRestrictedIdentity: () => ({gid, uid}),
});
process.exitCode = await driver.run();
rmSync(executableRoot, {force: true, recursive: true});
