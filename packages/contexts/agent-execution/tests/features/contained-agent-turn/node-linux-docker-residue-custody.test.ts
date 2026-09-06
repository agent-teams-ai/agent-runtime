import assert from "node:assert/strict";
import {test} from "node:test";
import {composeLinuxDockerResidueCustody, createNodeLinuxDockerResidueCustody} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/node-linux-docker-residue-custody.js";
import {DockerCustodyJournal} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/docker-custody-journal.js";
import {engineCall, digest, createInput} from "./support/docker-host-custody-lifecycle-fixture.ts";
import {initOptions, installSyntheticInit, providerExec} from "./support/docker-claim-init-fixture.ts";
import {FixtureResidueIo, residueFixture, statText} from "./support/linux-docker-residue-fixture.ts";

const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => {release = resolve;});
  return {promise, release};
};

for (const driver of ["systemd", "cgroupfs"]) {
  test(`${driver}: real lifecycle pins before start/launch return, proves empty, then removes and closes FDs`, async t => {
    const f = await residueFixture(t, driver);
    const launched = await f.launch();
    assert.ok(f.io.handles.size > 0);
    assert.equal(launched.journal.state, "init_ready");
    assert.ok(f.io.events.some(event => /read:\/proc\/[0-9]+\/stat$/u.test(event)));
    assert.equal(f.fake.events.filter(event => event.startsWith("attach:")).length, 1);
    assert.equal(f.fake.events.filter(event => event.startsWith("logs:")).length, 0);
    assert.equal((await f.contain(launched)).kind, "closed");
    assert.equal(f.fake.events.filter(event => event === "remove:id").length, 1);
    assert.equal(f.io.handles.size, 0);
    const records = [...f.storage.files.values()][0]!.bytes.toString();
    assert.ok(records.indexOf('"state":"empty_observed"') < records.indexOf('"state":"remove_requested"'));
    assert.ok(records.includes('"state":"closed"'));
    assert.ok(f.io.peak < 256);
  });
}

test("recursive populated descendant blocks removal even with no root process; retry closes only after recursive zero", async t => {
  const f = await residueFixture(t);
  const launched = await f.launch();
  f.io.group(`${f.leafPath(launched.authority)}/detached`);
  f.io.node(`${f.leafPath(launched.authority)}/detached/cgroup.procs`).contents = "9999\n";
  f.controls.descendants = true;
  const result = await f.contain(launched);
  assert.equal(result.kind, "indeterminate");
  assert.ok("journal" in result && result.journal.state === "empty_observed");
  assert.ok("journal" in result && result.journal.evidence.status === "unproven");
  assert.equal(f.fake.events.includes("remove:id"), false);
  assert.ok(f.io.handles.size > 0, "fault/debt retains custody");
  f.io.node(`${f.parent}/cgroup.events`).contents = "populated 0\nfrozen 0\n";
  f.io.node(`${f.leafPath(launched.authority)}/cgroup.events`).contents = "populated 0\nfrozen 0\n";
  f.io.node(`${f.leafPath(launched.authority)}/detached/cgroup.procs`).contents = "";
  assert.equal((await f.contain(launched)).kind, "closed");
});

test("Docker-deleted leaf is covered by the still-pinned exact ancestor", async t => {
  const f = await residueFixture(t);
  const launched = await f.launch();
  f.controls.deleteLeaf = true;
  assert.equal((await f.contain(launched)).kind, "closed");
  assert.ok(f.io.events.filter(event => event === `read:${f.parent}/cgroup.events`).length >= 4);
  assert.equal(f.io.handles.size, 0);
});

test("missing leaf/Engine absence without pre-execution pins never becomes recovery emptiness", async t => {
  const f = await residueFixture(t);
  const launched = await f.launch();
  await f.engine.stop(launched.authority, engineCall());
  await f.engine.remove(launched.authority, engineCall());
  const emptyKernel = new FixtureResidueIo(f.parent);
  const fresh = composeLinuxDockerResidueCustody({policy: f.selectedPolicy, journalStorage: f.storage}, f.engine, emptyKernel);
  const recovered = await fresh.lifecycle.recover({async resolve() {
    return {authority: launched.authority, call: engineCall(), create: createInput(f.root)};
  }});
  assert.equal(recovered[0]?.kind, "indeterminate");
  assert.equal(await fresh.disposeResidue(engineCall()), "released");
  assert.equal(emptyKernel.handles.size, 0);
});

const launchFaults: ReadonlyArray<readonly [string, (f: Awaited<ReturnType<typeof residueFixture>>) => void]> = [
  ["ancestor symlink", f => {f.io.node(f.parent).link = true;}],
  ["unprotected parent mode", f => {const n = f.io.node(f.parent); n.facts = {...n.facts, mode: 0o775};}],
  ["foreign parent owner", f => {const n = f.io.node(f.parent); n.facts = {...n.facts, uid: 65532};}],
  ["wrong cgroup filesystem", f => {f.io.node(f.parent).filesystem = 1n;}],
  ["wrong proc filesystem", f => {f.io.node("/proc").filesystem = 1n;}],
  ["missing root", f => {f.io.removeTree(f.parent);} ],
  ["foreign sibling", f => {f.io.group(`${f.parent}/foreign`);} ],
  ["tasks directly in policy parent", f => {f.io.node(`${f.parent}/cgroup.procs`).contents = "22\n";}],
  ["delegated common ancestor migration", f => {
    const n = f.io.node("/sys/fs/cgroup/agent.slice/cgroup.procs"); n.facts = {...n.facts, uid: 65532};
  }],
  ["v1", f => {f.controls.version = "1";}],
  ["unsupported driver", f => {f.controls.driver = "unknown";}],
  ["host boot mismatch", f => {f.io.node("/proc/sys/kernel/random/boot_id").contents = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\n";}],
  ["subtree mount replacement", f => {f.io.node(`/proc/${process.pid}/mountinfo`).contents +=
    `3 0 0:2 / ${f.parent}/foreign rw - cgroup2 cgroup rw\n`;}],
];
for (const [name, mutate] of launchFaults) {
  test(`launch rejects ${name} before engine start and provider execution`, async t => {
    const f = await residueFixture(t);
    mutate(f);
    await assert.rejects(f.launch());
    assert.equal(f.fake.events.includes("start:id"), false);
    assert.equal(f.fake.events.includes("remove:id"), false);
    assert.equal(f.io.handles.size, 0);
  });
}

for (const fault of ["process escape", "root capabilities", "delegated migration", "PID reuse"] as const) {
  test(`actual running provenance rejects ${fault} before launch returns`, async t => {
    const f = await residueFixture(t);
    f.controls.afterStart = () => {
      const proc = [...f.io.nodes.values()].find(node => /\/proc\/[0-9]+\/stat$/u.test(node.path))!;
      const prefix = proc.path.slice(0, -5);
      if (fault === "process escape") {f.io.node(`${prefix}/cgroup`).contents = "0::/foreign/escaped\n";}
      if (fault === "root capabilities") {f.io.node(`${prefix}/status`).contents =
        f.io.node(`${prefix}/status`).contents.replace("CapEff:\t0000000000000000", "CapEff:\t0000000000200000");}
      if (fault === "delegated migration") {
        const node = [...f.io.nodes.values()].find(n => /docker-.*\.scope\/cgroup.procs$/u.test(n.path))!;
        node.facts = {...node.facts, uid: 65532};
      }
      if (fault === "PID reuse") {
        let reads = 0;
        f.io.before = async (operation, node) => {
          if (operation === "read" && node === proc && ++reads === 2) {
            node.contents = statText(Number(prefix.split("/").at(-1)), "99999");
          }
        };
      }
    };
    await assert.rejects(f.launch());
    assert.equal(f.fake.events.includes("start:id"), true);
    assert.ok(f.io.handles.size > 0, "ambiguous start retains pre-start ancestor");
    assert.equal(f.fake.events.includes("remove:id"), false);
  });
}

test("pre-provider inspect revalidates retained PID start identity through the existing execution consumer", async t => {
  const f = await residueFixture(t);
  const events: string[] = [];
  installSyntheticInit(f.fake, events);
  const launched = await f.launch();
  const session = launched.openInitSession(initOptions());
  t.after(() => session.close());
  await session.ready();
  const stat = [...f.io.nodes.values()].find(node => /\/proc\/[0-9]+\/stat$/u.test(node.path))!;
  stat.contents = stat.contents.replace("12345", "12346");
  await assert.rejects(f.lifecycle.executeProvider({authority: launched.authority, call: engineCall(),
    key: launched.key, exec: providerExec}));
  assert.equal(events.filter(event => event === "init-reader").length, 1);
  assert.equal(events.includes("provider-exec"), false);
  assert.equal((await f.contain(launched)).kind, "indeterminate");
  assert.equal(f.fake.events.includes("remove:id"), false);
});

for (const fault of ["root replacement", "leaf replacement", "deleted root", "deleted events", "malformed events",
  "engine generation", "host generation", "foreign sibling", "unknown kernel read"] as const) {
  test(`post-stop ${fault} retains unproven journal debt and forbids remove`, async t => {
    const f = await residueFixture(t);
    const launched = await f.launch();
    await f.engine.stop(launched.authority, engineCall());
    if (fault === "root replacement") {f.io.group(f.parent);}
    if (fault === "leaf replacement") {f.io.group(f.leafPath(launched.authority));}
    if (fault === "deleted root") {f.io.removeTree(f.parent);}
    if (fault === "deleted events") {f.io.removeTree(`${f.parent}/cgroup.events`);}
    if (fault === "malformed events") {f.io.node(`${f.parent}/cgroup.events`).contents = "populated 0\nunknown 0\n";}
    if (fault === "engine generation") {f.controls.drift.daemonBootGenerationSha256 = digest("other-daemon");}
    if (fault === "host generation") {f.controls.drift.hostBootGenerationSha256 = digest("other-host");}
    if (fault === "foreign sibling") {f.io.group(`${f.parent}/foreign`);}
    if (fault === "unknown kernel read") {
      f.io.before = async (operation, node) => {
        if (operation === "read" && node.path === `${f.parent}/cgroup.events`) {
          throw Object.assign(new Error("deleted cgroup"), {code: "ENODEV"});
        }
      };
    }
    assert.equal((await f.contain(launched)).kind, "indeterminate");
    assert.equal(f.fake.events.includes("remove:id"), false);
    assert.ok(f.io.handles.size > 0);
    const journal = await new DockerCustodyJournal(f.storage).lookup(launched.key);
    assert.equal(journal.state, "empty_observed");
    assert.equal(journal.evidence.status, "unproven");
  });
}

test("abort before launch opens no kernel descriptors", async t => {
  const f = await residueFixture(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.launch({...engineCall(), signal: controller.signal}));
  assert.equal(f.io.events.length, 0);
});

test("aborted late open cannot publish a pin; disposal awaits safe FD closure", async t => {
  const f = await residueFixture(t);
  const reached = gate(); const late = gate();
  const controller = new AbortController();
  f.io.before = async (operation, node) => {
    if (operation === "open" && node.path === "/proc") {reached.release(); await late.promise;}
  };
  const launch = f.launch({...engineCall(), signal: controller.signal});
  await reached.promise;
  controller.abort();
  await assert.rejects(launch);
  const disposal = f.disposeResidue(engineCall());
  late.release();
  assert.equal(await disposal, "released");
  assert.equal(f.io.handles.size, 0);
  assert.equal(f.fake.events.includes("start:id"), false);
});

test("proof deadline and concurrent disposal cannot close a descriptor during an outstanding read", async t => {
  const f = await residueFixture(t);
  const launched = await f.launch();
  const reached = gate(); const late = gate();
  let inRead = false;
  f.io.before = async (operation, node) => {
    if (operation === "read" && node.path === `${f.parent}/cgroup.events`) {
      inRead = true; reached.release(); await late.promise; inRead = false;
    }
    if (operation === "close") {assert.equal(inRead, false, "no FD reuse race during read");}
  };
  const result = f.contain(launched, {...engineCall(), deadlineEpochMs: Date.now() + 100});
  await reached.promise;
  assert.equal((await result).kind, "indeterminate");
  assert.equal(await f.disposeResidue({...engineCall(), deadlineEpochMs: Date.now() + 20}), "pending");
  const disposal = f.disposeResidue(engineCall());
  late.release();
  assert.equal(await disposal, "released");
  assert.equal(f.io.handles.size, 0);
  assert.equal(f.fake.events.includes("remove:id"), false);
});

test("disposal fences an outstanding actual start, retains no late pins, and does not imply containment", async t => {
  const f = await residueFixture(t);
  const reached = gate(); const late = gate();
  f.controls.afterStart = () => {
    f.io.before = async (operation, node) => {
      if (operation === "open" && /\/proc\/[0-9]+\/stat$/u.test(node.path)) {reached.release(); await late.promise;}
    };
  };
  const launch = f.launch();
  const rejected = assert.rejects(launch);
  await reached.promise;
  const disposal = f.disposeResidue(engineCall());
  late.release();
  assert.equal(await disposal, "released");
  await rejected;
  assert.equal(f.io.handles.size, 0);
  assert.equal(f.fake.events.includes("remove:id"), false);
});

test("bounded topology rejects excessive subgroups", async t => {
  const f = await residueFixture(t);
  const launched = await f.launch();
  for (let i = 0; i < 65; i += 1) {f.io.group(`${f.leafPath(launched.authority)}/child${i}`);}
  assert.equal((await f.contain(launched)).kind, "indeterminate");
  assert.equal(f.fake.events.includes("remove:id"), false);
});

test("production factory is synchronous/resource-free and exposes existing lifecycle plus local FD disposal only", async t => {
  const f = await residueFixture(t);
  const product = createNodeLinuxDockerResidueCustody({policy: f.selectedPolicy, journalStorage: f.storage});
  assert.deepEqual(Object.keys(product).toSorted(), ["disposeResidue", "lifecycle"]);
  assert.equal(await product.disposeResidue(engineCall()), "released");
  assert.equal(f.io.events.length, 0);
});

test("shared protected ancestor covers only accepted sibling containers and conservatively waits for both", async t => {
  const f = await residueFixture(t);
  const first = await f.launch();
  const second = await f.launch(engineCall(), digest("second"));
  assert.equal((await f.contain(first)).kind, "indeterminate");
  assert.equal(f.fake.events.includes("remove:id"), false);
  assert.equal((await f.contain(second)).kind, "closed");
  assert.equal((await f.contain(first)).kind, "closed");
  assert.equal(f.io.handles.size, 0);
});

test("bounded lifetime admission does not evict provenance or issue a 65th create", async t => {
  const f = await residueFixture(t);
  for (let i = 0; i < 64; i += 1) {
    const launched = await f.launch(engineCall(), digest(`capacity:${i}`));
    assert.equal((await f.contain(launched)).kind, "closed");
  }
  const before = f.fake.events.length;
  await assert.rejects(f.launch(engineCall(), digest("capacity:overflow")));
  assert.equal(f.fake.events.slice(before).some(event => event.startsWith("create:")), false);
  assert.equal(f.io.handles.size, 0);
});

test("close failure remains owned and concurrent disposal retries close exactly once", async t => {
  const f = await residueFixture(t);
  await f.launch();
  let rejected = false;
  f.io.before = async operation => {
    if (operation === "close" && !rejected) {rejected = true; throw new Error("fixture close failed");}
  };
  assert.equal(await f.disposeResidue(engineCall()), "pending");
  assert.ok(f.io.handles.size > 0);
  assert.deepEqual(await Promise.all([f.disposeResidue(engineCall()), f.disposeResidue(engineCall())]), ["released", "released"]);
  assert.equal(f.io.handles.size, 0);
});

test("persisted remove_requested plus Engine absence cannot bypass missing volatile residue custody on recovery", async t => {
  const f = await residueFixture(t);
  const launched = await f.launch();
  await f.engine.stop(launched.authority, engineCall());
  const journal = new DockerCustodyJournal(f.storage);
  const requested = await journal.beforeAction({key: launched.key, expectedSequence: launched.journal.sequence, state: "contain_requested"});
  const empty = await journal.observe({key: launched.key, expectedSequence: requested.sequence, state: "empty_observed", evidence: {status: "proved"}});
  await journal.beforeAction({key: launched.key, expectedSequence: empty.sequence, state: "remove_requested"});
  await f.engine.remove(launched.authority, engineCall());
  const fresh = composeLinuxDockerResidueCustody({policy: f.selectedPolicy, journalStorage: f.storage}, f.engine, new FixtureResidueIo(f.parent));
  const recovered = await fresh.lifecycle.recover({async resolve() {
    return {authority: launched.authority, call: engineCall(), create: createInput(f.root)};
  }});
  assert.equal(recovered[0]?.kind, "indeterminate");
  assert.notEqual((await journal.lookup(launched.key)).state, "closed");
  assert.equal(await fresh.disposeResidue(engineCall()), "released");
});

test("generation drift during the final recursive kernel read cannot publish empty", async t => {
  const f = await residueFixture(t);
  const launched = await f.launch();
  let reads = 0;
  f.io.before = async (operation, node) => {
    if (operation === "read" && node.path === `${f.parent}/cgroup.events` && ++reads === 2) {
      f.controls.drift.daemonBootGenerationSha256 = digest("late-daemon");
    }
  };
  assert.equal((await f.contain(launched)).kind, "indeterminate");
  assert.equal(f.fake.events.includes("remove:id"), false);
  assert.equal((await new DockerCustodyJournal(f.storage).lookup(launched.key)).evidence.status, "unproven");
});

test("disposal during final temporary-FD cleanup fences an already calculated empty result", async t => {
  const f = await residueFixture(t);
  const launched = await f.launch();
  const reached = gate(); const late = gate();
  let reads = 0; let delayed = false;
  f.io.before = async (operation, node) => {
    if (operation === "read" && node.path === `${f.parent}/cgroup.events`) {reads += 1;}
    if (operation === "close" && reads === 2 && !delayed) {
      delayed = true; reached.release(); await late.promise;
    }
  };
  const containment = f.contain(launched);
  await reached.promise;
  const disposal = f.disposeResidue(engineCall());
  late.release();
  assert.equal(await disposal, "released");
  assert.equal((await containment).kind, "indeterminate");
  const journal = await new DockerCustodyJournal(f.storage).lookup(launched.key);
  assert.equal(journal.state, "empty_observed");
  assert.equal(journal.evidence.status, "unproven");
  assert.equal(f.fake.events.includes("remove:id"), false);
  assert.equal(f.io.handles.size, 0);
});


test("P1 removal acknowledgement loss cannot publish closed while retained FDs remain", async t => {
  const f = await residueFixture(t);
  const launched = await f.launch();
  const remove = f.engine.remove;
  f.engine.remove = async (authority, call) => {await remove(authority, call); throw new Error("removal acknowledgement lost");};
  assert.equal((await f.contain(launched)).kind, "closed");
  assert.equal(f.io.handles.size, 0, "absence must join retained descriptor release");
});

test("P1 partial retained FD close failure stays debt and exact absence permits cleanup retry", async t => {
  const f = await residueFixture(t);
  const launched = await f.launch();
  let removed = false; let closes = 0; let rejectClose = true;
  const remove = f.engine.remove;
  f.engine.remove = async (authority, call) => {await remove(authority, call); removed = true;};
  const retained = new Set(f.io.handles.keys());
  const close = f.io.close.bind(f.io);
  f.io.close = async file => {
    if (retained.has(file.fd) && removed && ++closes > 2 && rejectClose) {throw new Error("retained close failed");}
    await close(file);
  };
  try {
    assert.equal((await f.contain(launched)).kind, "indeterminate");
    assert.ok(f.io.handles.size > 0);
    assert.notEqual((await new DockerCustodyJournal(f.storage).lookup(launched.key)).state, "closed");
  } finally {rejectClose = false;}
  assert.equal((await f.contain(launched)).kind, "closed");
  assert.equal(f.io.handles.size, 0);
});

test("P1 overlapping sibling inspection is retryable without poisoning process provenance", async t => {
  const f = await residueFixture(t);
  const first = await f.launch();
  const second = await f.launch(engineCall(), digest("concurrent-second"));
  const reached = gate(); const resume = gate(); let delayed = false;
  f.io.before = async (operation, node) => {
    if (!delayed && operation === "read" && /\/proc\/[0-9]+\/stat$/u.test(node.path)) {
      delayed = true; reached.release(); await resume.promise;
    }
  };
  const pending = f.contain(first);
  await reached.promise;
  try {assert.equal((await f.contain(second)).kind, "indeterminate");} finally {resume.release();}
  assert.equal((await pending).kind, "indeterminate");
  assert.equal((await f.contain(second)).kind, "closed");
  assert.equal((await f.contain(first)).kind, "closed");
  assert.equal(f.io.handles.size, 0);
});
