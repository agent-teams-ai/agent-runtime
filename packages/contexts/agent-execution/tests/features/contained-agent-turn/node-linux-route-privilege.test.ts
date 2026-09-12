import {strict as assert} from "node:assert";
import {test} from "node:test";
import {readFileSync} from "node:fs";
import {assertLinuxRoutePrivilegeStatus, assertNodeLinuxRoutePrivilege} from
  "../../../src/features/contained-agent-turn/adapters/outbound/host-custody/docker/node-linux-route-privilege.ts";

const mask = (1n << 2n) | (1n << 12n) | (1n << 19n) | (1n << 21n);
const hex = (value: bigint) => value.toString(16).padStart(16, "0");
const status = (uid = 1000, gid = 1000) => `Uid: ${uid} ${uid} ${uid} ${uid}
Gid: ${gid} ${gid} ${gid} ${gid}
${["CapEff", "CapPrm", "CapInh", "CapAmb"].map(name => `${name}: ${hex(mask)}`).join("\n")}
`;

test("same-identity capability Host and capable legacy root are admitted", () => {
  assert.doesNotThrow(() => assertLinuxRoutePrivilegeStatus(status(), 1000, 1000));
  const root = status(0, 0).replace(`CapInh: ${hex(mask)}`, `CapInh: ${hex(0n)}`)
    .replace(`CapAmb: ${hex(mask)}`, `CapAmb: ${hex(0n)}`);
  assert.doesNotThrow(() => assertLinuxRoutePrivilegeStatus(root, 0, 0));
});

test("every required capability in every positive-UID set is mandatory", () => {
  for (const name of ["CapEff", "CapPrm", "CapInh", "CapAmb"]) {
    for (const bit of [2n, 12n, 19n, 21n]) {
      const missing = status().replace(`${name}: ${hex(mask)}`, `${name}: ${hex(mask & ~(1n << bit))}`);
      assert.throws(() => assertLinuxRoutePrivilegeStatus(missing, 1000, 1000));
    }
  }
  assert.throws(() => assertLinuxRoutePrivilegeStatus(status(0, 0).replace(`CapEff: ${hex(mask)}`, `CapEff: ${hex(0n)}`), 0, 0));
});

test("identity transitions and missing, duplicate, malformed or oversized fields fail closed", () => {
  for (const bad of [status().replace("1000 1000 1000 1000", "1000 0 1000 1000"),
    status().replace("Gid: 1000", "Gid: 0"), status().replace("CapAmb:", "Missing:"),
    status() + `CapEff: ${hex(mask)}\n`, status().replace(hex(mask), "garbage"),
    status() + "x".repeat(16385)]) {
    assert.throws(() => assertLinuxRoutePrivilegeStatus(bad, 1000, 1000));
  }
});

test("production admission observes actual procfs, without invoking tools", () => {
  if (process.platform !== "linux" || process.arch !== "x64") {
    assert.throws(assertNodeLinuxRoutePrivilege);
    return;
  }
  let capable = true;
  try {
    assertLinuxRoutePrivilegeStatus(readFileSync("/proc/self/status", "utf8"), process.getuid!(), process.getgid!());
    for (const name of ["uid_map", "gid_map"]) {
      assert.match(readFileSync(`/proc/self/${name}`, "utf8"), /^\s*0\s+0\s+4294967295\s*$/u);
    }
  } catch {capable = false;}
  if (capable) {assert.doesNotThrow(assertNodeLinuxRoutePrivilege);}
  else {assert.throws(assertNodeLinuxRoutePrivilege);}
});
