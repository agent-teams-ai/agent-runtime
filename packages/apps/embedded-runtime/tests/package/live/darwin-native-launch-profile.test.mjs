import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { createDarwinNativeLaunchProfile } from "./darwin-native-launch-profile.mjs";

const executeFile = promisify(execFile);

test("profile generator rejects non-absolute or malformed paths", () => {
  assert.throws(() => createDarwinNativeLaunchProfile({ nativeOwnerPath: "relative/path", codexPath: "/abs/codex" }));
  assert.throws(() => createDarwinNativeLaunchProfile({ nativeOwnerPath: "/abs/owner", codexPath: undefined }));
  assert.throws(() => createDarwinNativeLaunchProfile({ nativeOwnerPath: `/abs/"quote`, codexPath: "/abs/codex" }));
});

test("profile is deterministic for the same inputs", () => {
  const a = createDarwinNativeLaunchProfile({ nativeOwnerPath: "/abs/owner", codexPath: "/abs/codex" });
  const b = createDarwinNativeLaunchProfile({ nativeOwnerPath: "/abs/owner", codexPath: "/abs/codex" });
  assert.equal(a.profile, b.profile);
  assert.equal(a.profileSha256, b.profileSha256);
  assert.match(a.profileSha256, /^[a-f0-9]{64}$/);
});

test("on Darwin, the generated profile actually parses and enforces the intended boundary", { skip: process.platform !== "darwin" }, async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "ar69-native-launch-profile-")));
  try {
    const workspace = join(parent, "workspace"), privateDir = join(workspace, "private"), outside = join(parent, "outside.txt");
    await mkdir(privateDir, { recursive: true });
    await writeFile(outside, "secret\n");
    const codexPath = "/bin/echo";
    const { profile } = createDarwinNativeLaunchProfile({ nativeOwnerPath: "/bin/echo", codexPath });
    const profilePath = join(parent, "profile.sb");
    await writeFile(profilePath, profile);
    const args = ["-f", profilePath, "-D", `WORKSPACE=${workspace}`, "-D", `PRIVATE=${privateDir}`, "-D", "BROKER_PORT=1",
      codexPath, "ok"];
    const { stdout } = await executeFile("/usr/bin/sandbox-exec", args, { encoding: "utf8" });
    assert.equal(stdout.trim(), "ok");

    // An unpinned binary must still be refused under the same profile.
    await assert.rejects(executeFile("/usr/bin/sandbox-exec",
      ["-f", profilePath, "-D", `WORKSPACE=${workspace}`, "-D", `PRIVATE=${privateDir}`, "-D", "BROKER_PORT=1",
        "/bin/cat", outside], { encoding: "utf8" }));
  } finally { await rm(parent, { recursive: true, force: true }); }
});
