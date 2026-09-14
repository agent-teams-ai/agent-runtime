import test from "node:test";
import assert from "node:assert/strict";
import {readlink, realpath} from "node:fs/promises";

// Explicit integration only: same disposable Linux netns/systemd/tool preflight
// as scripts/run-linux-joined-product.mjs, plus a new local PostgreSQL database.
// Never run this entry in an ordinary/shared network namespace.
const databaseUrl = process.env.AE_ACL_POSTGRES_DISPOSABLE_URL;
if (!databaseUrl || process.env.AR69_POSTGRES_HTTP_JOINED !== "1") {
  test("PostgreSQL actual Linux HTTP unknown-evidence closure and fresh-store recovery", {
    skip: "Requires explicit disposable Linux netns authorization and AE_ACL_POSTGRES_DISPOSABLE_URL",
  }, () => {});
} else {
  assert.equal(process.platform, "linux");
  assert.equal(process.arch, "x64");
  assert.equal(process.geteuid?.(), 0);
  assert.equal(Number(process.versions.node.split(".")[0]), 24);
  assert.notEqual(await readlink("/proc/self/ns/net"), await readlink("/proc/1/ns/net"),
    "Must enter a fresh disposable outer network namespace before running");
  assert.ok(["/usr/lib/systemd/systemd", "/lib/systemd/systemd"].includes(await realpath("/proc/1/exe")),
    "Requires the same systemd reaper as the existing Linux joined runner");
  const {registerLinuxJoinedProduct} = await import("./support/linux-joined-product.mjs");
  const {openPostgresHttpClosureStore} = await import("../support/postgres-http-closure.mjs");
  registerLinuxJoinedProduct({outcomes: ["unknown"], openStore: () => openPostgresHttpClosureStore(databaseUrl)});
}
