import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  HostCustodyLaunchRejectedError,
  type HostCustodyLaunchPlan,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/custodied-provider-process.js";
import {
  NodeProviderProcessCustody,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/node-provider-process-custody.js";
import {
  adapterSnapshot,
  attemptId,
  operationId,
  providerAccessSnapshot,
} from "../../contained-turn-kernel-fixtures.ts";

const disposableRoots: string[] = [];

afterEach(async () => {
  await Promise.all(disposableRoots.splice(0).map(root => rm(root, { force: true, recursive: true })));
});

const providerBinding = Object.freeze({
  adapterRevision: adapterSnapshot.adapterRevision,
  binaryRevision: adapterSnapshot.binaryRevision,
  capabilityManifestRevision: adapterSnapshot.capabilityManifestRevision,
  credentialBindingDigest: providerAccessSnapshot.credentialBindingDigest,
  provider: adapterSnapshot.provider,
  providerRouteRef: providerAccessSnapshot.providerRouteRef,
});

const executableDigest = async (path: string): Promise<string> =>
  createHash("sha256").update(await readFile(path)).digest("hex");

const createFixture = async (spawnMode: HostCustodyLaunchPlan["spawnMode"], refuseBeforeGuardian = false) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "TEST-contained-turn-host-reserve-")));
  disposableRoots.push(root);
  const workspaceRef = join(root, "workspace");
  const privateRootPath = join(root, "workspace-host-private");
  const home = join(privateRootPath, "home");
  const temporary = join(privateRootPath, "tmp");
  const codexHome = join(privateRootPath, "codex-home");
  await mkdir(privateRootPath, { mode: 0o700 });
  await Promise.all([
    mkdir(workspaceRef, { mode: 0o700 }),
    mkdir(home, { mode: 0o700 }),
    mkdir(temporary, { mode: 0o700 }),
    mkdir(codexHome, { mode: 0o700 }),
  ]);
  const workspaceIdentity = await stat(workspaceRef, {bigint: true});
  const workspaceHandle = await open(workspaceRef, "r");
  const fdinfo = await readFile(`/proc/self/fdinfo/${workspaceHandle.fd}`, "utf8");
  await workspaceHandle.close();
  const mountId = /^mnt_id:\s*(\d+)$/mu.exec(fdinfo)?.[1];
  assert.ok(mountId);
  const workspaceAuthority = Object.freeze({
    canonicalPath: workspaceRef,
    descriptorPath: workspaceRef,
    identity: Object.freeze({dev: workspaceIdentity.dev, ino: workspaceIdentity.ino, mountId}),
  });
  const marker = join(root, "provider-executed");
  const executablePath = await realpath(process.execPath);
  const launchArguments = Object.freeze([
    "-e",
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed"); setInterval(() => {}, 1000);`,
  ]);
  const environment = Object.freeze({
    CODEX_HOME: codexHome,
    HOME: home,
    LANG: "C.UTF-8",
    PATH: "/usr/bin:/bin",
    TMPDIR: temporary,
  });
  const plan: HostCustodyLaunchPlan = Object.freeze({
    arguments: launchArguments,
    binaryRevision: providerBinding.binaryRevision,
    containmentProfile: "strict-linux-cgroup-v2",
    environment,
    executablePath,
    executableSha256: await executableDigest(executablePath),
    intentMode: "analysis",
    privateRootPath,
    provider: "codex",
    ...(spawnMode === undefined ? {} : { spawnMode }),
  });
  const counts = { guardianAuthorizations: 0, residueAuthorities: 0 };
  const custodyRefs: string[] = [];
  const custody = new NodeProviderProcessCustody({
    containmentAfterMs: 5_000,
    forceKillAfterMs: 1_000,
    launchPlans: Object.freeze({ async resolve() {return plan;} }),
    residueAuthorityFactory: Object.freeze({
      async create(custodyRef) {
        custodyRefs.push(custodyRef);
        counts.residueAuthorities += 1;
        if (refuseBeforeGuardian) {await chmod(temporary, 0o500);}
        return Object.freeze({
          async attachGuardian() {counts.guardianAuthorizations += 1; return true;},
          async close() {return true;},
          async killAll() {return true;},
          async proveEmpty() {return "empty" as const;},
        });
      },
    }),
    terminateAfterMs: 1_000,
  });
  return { counts, custody, custodyRefs, marker, plan, workspaceAuthority, workspaceRef };
};

const hostOpenInput = (
  workspaceRef: string,
  workspaceAuthority: Awaited<ReturnType<typeof createFixture>>["workspaceAuthority"],
  launchPlan: HostCustodyLaunchPlan,
) => Object.freeze({
  attemptId,
  intentMode: "analysis" as const,
  operationId,
  launchPlan,
  providerBinding,
  workspaceAuthority,
  workspaceRef,
});

const assertMarkerAbsent = async (marker: string): Promise<void> => {
  await assert.rejects(access(marker), (error: unknown) =>
    error instanceof Error && "code" in error && error.code === "ENOENT");
};

test("Host no-start reserve rejects eager and omitted modes before guardian or provider execution", {
  skip: process.platform === "linux" ? false : "descriptor-bound production Host Custody is Linux-only",
}, async t => {
  for (const spawnMode of ["eager" as const, undefined]) {
    await t.test(spawnMode ?? "omitted", async () => {
      const fixture = await createFixture(spawnMode);
      await assert.rejects(
        fixture.custody.reserve(hostOpenInput(fixture.workspaceRef, fixture.workspaceAuthority, fixture.plan)),
        (error: unknown) => error instanceof HostCustodyLaunchRejectedError &&
          error.code === "authority-verification-failed",
      );
      assert.deepEqual(fixture.counts, { guardianAuthorizations: 0, residueAuthorities: 0 });
      await assertMarkerAbsent(fixture.marker);
    });
  }
});

test("real Node Host delegated reserve remains never-started without start authority", {
  skip: process.platform === "linux" ? false : "descriptor-bound production Host Custody is Linux-only",
}, async () => {
  const fixture = await createFixture("sdk-delegated");
  const rawReservation = await fixture.custody.reserve(hostOpenInput(
    fixture.workspaceRef, fixture.workspaceAuthority, fixture.plan,
  ));
  assert.equal(fixture.custody.get(rawReservation.custodyRef), undefined);
  assert.equal(fixture.custody.evidence(rawReservation.custodyRef)?.spawn, "never-started");
  assert.deepEqual(fixture.counts, { guardianAuthorizations: 0, residueAuthorities: 1 });
  await assertMarkerAbsent(fixture.marker);
  const contained = await fixture.custody.requestContainment({
    attemptId,
    custodyRef: rawReservation.custodyRef,
    operationId,
  });
  assert.equal(contained.kind, "contained");
  assert.equal(fixture.custody.evidence(rawReservation.custodyRef)?.spawn, "never-started");
  assert.deepEqual(fixture.counts, { guardianAuthorizations: 0, residueAuthorities: 1 });
  await assertMarkerAbsent(fixture.marker);
});

for (const spawnMode of ["eager", "sdk-delegated"] as const) {
  for (const replaceRoot of [false, true]) {
    test(`pre-guardian ${spawnMode} refusal releases only the authentic root (replacement=${replaceRoot})`, {
      skip: process.platform !== "linux",
    }, async () => {
      const fixture = await createFixture(spawnMode, true);
      const input = {attemptId, operationId, providerBinding, workspaceRef: fixture.workspaceRef, intentMode: "analysis" as const};
      if (spawnMode === "eager") {
        await assert.rejects(fixture.custody.open(input), HostCustodyLaunchRejectedError);
      } else {
        const reserved = await fixture.custody.reserve(hostOpenInput(
          fixture.workspaceRef, fixture.workspaceAuthority, fixture.plan,
        ));
        assert.throws(() => fixture.custody.start(reserved.custodyRef, {
          arguments: fixture.plan.arguments,
          command: fixture.plan.executablePath,
          // Strict Linux delegated starts name the guardian's workspace descriptor.
          cwd: "/proc/self/fd/4",
          environment: fixture.plan.environment,
          signal: new AbortController().signal,
        }), (error: unknown) =>
          error instanceof HostCustodyLaunchRejectedError && error.code === "authority-verification-failed");
      }
      const contained = await fixture.custody.requestContainment(input);
      assert.equal(contained.kind, "contained");
      if (contained.kind !== "contained") {throw new Error("no-start containment missing");}
      assert.deepEqual(fixture.counts, {guardianAuthorizations: 0, residueAuthorities: 1});
      await assertMarkerAbsent(fixture.marker);
      const custodyRef = fixture.custodyRefs[0];
      assert.ok(custodyRef);
      const evidence = fixture.custody.evidence(custodyRef);
      assert.equal(evidence?.spawn, "never-started");
      assert.equal(evidence?.identity.status, "not-started");
      const release = {...input, custodyRef, receiptRef: contained.receiptRef};
      assert.equal((await fixture.custody.release({...release, receiptRef: "foreign"})).kind, "unproven");
      if (replaceRoot) {
        await rename(fixture.plan.privateRootPath, `${fixture.plan.privateRootPath}-retained`);
        await mkdir(fixture.plan.privateRootPath, {mode: 0o700});
        const marker = join(fixture.plan.privateRootPath, "replacement");
        await writeFile(marker, "untouched");
        assert.equal((await fixture.custody.release(release)).kind, "unproven");
        assert.equal(await readFile(marker, "utf8"), "untouched");
        await rm(fixture.plan.privateRootPath, {recursive: true});
        await rename(`${fixture.plan.privateRootPath}-retained`, fixture.plan.privateRootPath);
      }
      assert.deepEqual(await fixture.custody.release(release), {kind: "released"});
      assert.equal(fixture.custody.evidence(custodyRef)?.spawn, "never-started");
      assert.equal(fixture.custody.evidence(custodyRef)?.identity.status, "not-started");
      await assertMarkerAbsent(fixture.plan.privateRootPath);
      assert.deepEqual(await fixture.custody.release(release), {kind: "released"});
      assert.equal((await fixture.custody.release({...release, operationId: "foreign"})).kind, "unproven");
      assert.equal((await fixture.custody.release({...release, attemptId: "foreign"})).kind, "unproven");
      assert.equal((await fixture.custody.release({...release, custodyRef: "foreign"})).kind, "unproven");
    });
  }
}
