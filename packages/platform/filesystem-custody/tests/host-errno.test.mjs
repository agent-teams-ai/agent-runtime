import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("OS errno mapper uses platform constants and never libuv synthetic numbers", () => {
  const root = mkdtempSync(join(tmpdir(), "ar-host-errno-"));
  try {
    const source = join(root, "test.c");
    writeFileSync(source, `#include <assert.h>\n#include <string.h>\n#include "host-errno.h"
int main(void) {
#define CHECK(code) assert(strcmp(host_errno_name(code), #code) == 0)
CHECK(EPERM); CHECK(ENOENT); CHECK(EACCES); CHECK(EEXIST); CHECK(EBADF);
CHECK(ENOTDIR); CHECK(EISDIR); CHECK(EINVAL); CHECK(EIO); CHECK(EINTR);
#ifdef EAGAIN
CHECK(EAGAIN);
#endif
#ifdef EWOULDBLOCK
#if defined(EAGAIN) && EWOULDBLOCK == EAGAIN
assert(strcmp(host_errno_name(EWOULDBLOCK), "EAGAIN") == 0);
#else
CHECK(EWOULDBLOCK);
#endif
#endif
#ifdef ENOTSUP
CHECK(ENOTSUP);
#endif
#ifdef EOPNOTSUPP
#if defined(ENOTSUP) && EOPNOTSUPP == ENOTSUP
assert(strcmp(host_errno_name(EOPNOTSUPP), "ENOTSUP") == 0);
#else
CHECK(EOPNOTSUPP);
#endif
#endif
#ifdef EDEADLK
CHECK(EDEADLK);
#endif
#ifdef EDEADLOCK
#if defined(EDEADLK) && EDEADLOCK == EDEADLK
assert(strcmp(host_errno_name(EDEADLOCK), "EDEADLK") == 0);
#else
CHECK(EDEADLOCK);
#endif
#endif
assert(strcmp(host_errno_name(0), "UNKNOWN") == 0);
assert(strcmp(host_errno_name(-1), "UNKNOWN") == 0);
assert(strcmp(host_errno_name(999), "UNKNOWN") == 0);
assert(strcmp(host_errno_name(3000), "UNKNOWN") == 0);
assert(strcmp(host_errno_name(4095), "UNKNOWN") == 0);
return 0;
}`);
    const built = spawnSync("cc", ["-Wall", "-Wextra", "-Werror", "-I",
      fileURLToPath(new URL("../native", import.meta.url)), source, "-o", join(root, "test")],
    { encoding: "utf8", timeout: 15000 });
    assert.ifError(built.error);
    assert.equal(built.status, 0, built.stderr);
    const result = spawnSync(join(root, "test"), [], { encoding: "utf8", timeout: 5000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
