import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";
import {createNodeOrdinaryProcess} from "../../../src/features/contained-agent-turn/adapters/outbound/ordinary-process/node-ordinary-process.ts";

const binding = {operationId: "operation:synthetic", attemptId: "attempt:synthetic", executionProfile: "user-session-v1", capabilityManifestRevision: "ordinary-codex-macos-arm64-0.153.4-v1"} as const;
const claim = (reservationId: string) => ({...binding, kind: "dispatch_claim" as const, claimId: "claim:synthetic", committedRevision: 2, preparationDigest: "a".repeat(64), reservationId});

test("ordinary owned current-user process drains, closes once, and rejects another launch", {skip: process.platform !== "darwin" || process.getuid?.() === 0}, async () => {
  const root = await mkdtemp(join(tmpdir(), "ordinary-process-TEST-"));
  try {
    const observations: string[] = [];
    const processOwner = createNodeOrdinaryProcess({record: event => {observations.push(event.kind);}, prepareLaunch: async () => ({executable: "/bin/cat", arguments: [], cwd: root, environment: {PATH: "/usr/bin:/bin"}})});
    const reservation = await processOwner.reserve({binding, workspace: {workspaceId: "workspace:synthetic", cwd: root, homeDirectory: root},
      credential: {materializationId: "material:synthetic", generation: 1, environment: {}, brokerEndpoint: "http://127.0.0.1:1"}, deadline: performance.now() + 5000});
    const transport = await reservation.start(claim(reservation.reservationId), new AbortController().signal);
    await transport.write("synthetic\n");
    await transport.closeInput();
    const output: string[] = [];
    for await (const line of transport.lines) { output.push(line); }
    assert.deepEqual(output, ["synthetic"]);
    const receipts = await reservation.close(1);
    assert.ok(Array.isArray(receipts));
    assert.equal(receipts[1].groupEmptyObserved, true);
    assert.equal(receipts[0].finalSequence, 1);
    assert.deepEqual(observations, ["launch_requested", "started", "exited", "closed"]);
    assert.equal(await reservation.close(1), receipts);
    await assert.rejects(reservation.start(claim(reservation.reservationId), new AbortController().signal), /ORDINARY_PROCESS_UNCONFIRMED/u);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test("ordinary reservation refuses a claim for a different preparation before spawn", {skip: process.platform !== "darwin" || process.getuid?.() === 0}, async () => {
  const root = await mkdtemp(join(tmpdir(), "ordinary-process-claim-TEST-"));
  try {
    const owner = createNodeOrdinaryProcess({prepareLaunch: async () => ({executable: "/missing/synthetic-executable", arguments: [], cwd: root, environment: {}})});
    const reservation = await owner.reserve({binding, workspace: {workspaceId: "workspace:synthetic", cwd: root, homeDirectory: root},
      credential: {materializationId: "material:synthetic", generation: 1, environment: {}, brokerEndpoint: "http://127.0.0.1:1"}, deadline: performance.now() + 5000});
    await assert.rejects(reservation.start(claim("another-reservation"), new AbortController().signal), /ORDINARY_PROCESS_UNCONFIRMED/u);
    assert.deepEqual(await reservation.close(0), {kind: "not_started", reservationId: reservation.reservationId});
  } finally { await rm(root, {recursive: true, force: true}); }
});

test("closing an unstarted reservation permanently fences later start", {skip: process.platform !== "darwin" || process.getuid?.() === 0}, async () => {
  const root = await mkdtemp(join(tmpdir(), "ordinary-process-fence-TEST-"));
  try {
    const owner = createNodeOrdinaryProcess({prepareLaunch: async () => ({executable: "/bin/cat", arguments: [], cwd: root, environment: {}})});
    const reservation = await owner.reserve({binding, workspace: {workspaceId: "workspace:synthetic", cwd: root, homeDirectory: root}, credential: {materializationId: "material:synthetic", generation: 1, environment: {}, brokerEndpoint: "http://127.0.0.1:1"}, deadline: performance.now() + 5000});
    assert.deepEqual(await reservation.close(0), {kind: "not_started", reservationId: reservation.reservationId});
    await assert.rejects(reservation.start(claim(reservation.reservationId), new AbortController().signal));
  } finally {await rm(root, {recursive: true, force: true});}
});

test("malformed UTF8 is rejected rather than rewritten into protocol data or a drain receipt", {skip: process.platform !== "darwin" || process.getuid?.() === 0}, async () => {
  const root = await mkdtemp(join(tmpdir(), "ordinary-process-utf8-TEST-"));
  try {
    const owner = createNodeOrdinaryProcess({prepareLaunch: async () => ({executable: process.execPath, arguments: ["-e", "process.stdout.write(Buffer.from([0xff,10]));"], cwd: root, environment: {}})});
    const reservation = await owner.reserve({binding, workspace: {workspaceId: "workspace:synthetic", cwd: root, homeDirectory: root}, credential: {materializationId: "material:synthetic", generation: 1, environment: {}, brokerEndpoint: "http://127.0.0.1:1"}, deadline: performance.now() + 5000});
    const transport = await reservation.start(claim(reservation.reservationId), new AbortController().signal);
    await assert.rejects(async () => {for await (const line of transport.lines) {assert.fail(`malformed bytes were published: ${line}`);}});
    await assert.rejects(reservation.close(0));
  } finally {await rm(root, {recursive: true, force: true});}
});


test("provided process journal rejection fences spawn and leaves truthful unstarted cleanup", {skip: process.platform !== "darwin" || process.getuid?.() === 0}, async () => {
  const root = await mkdtemp(join(tmpdir(), "ordinary-process-journal-TEST-"));
  try {
    const owner = createNodeOrdinaryProcess({record: () => {throw new Error("synthetic journal unavailable");}, prepareLaunch: async () => ({executable: "/bin/cat", arguments: [], cwd: root, environment: {}})});
    const reservation = await owner.reserve({binding, workspace: {workspaceId: "workspace:synthetic", cwd: root, homeDirectory: root}, credential: {materializationId: "material:synthetic", generation: 1, environment: {}, brokerEndpoint: "http://127.0.0.1:1"}, deadline: performance.now() + 5000});
    await assert.rejects(reservation.start(claim(reservation.reservationId), new AbortController().signal));
    assert.deepEqual(await reservation.close(0), {kind: "not_started", reservationId: reservation.reservationId});
  } finally {await rm(root, {recursive: true, force: true});}
});

test("asynchronous journal acknowledgement prevents provider spawn", {skip: process.platform !== "darwin" || process.getuid?.() === 0}, async () => {
  const root = await mkdtemp(join(tmpdir(), "ordinary-process-fence-TEST-"));
  try {
    const owner = createNodeOrdinaryProcess({record: async () => {throw new Error("journal rejected");}, prepareLaunch: async () => ({executable: "/bin/cat", arguments: [], cwd: root, environment: {}})});
    const reservation = await owner.reserve({binding, workspace: {workspaceId: "workspace:synthetic", cwd: root, homeDirectory: root}, credential: {materializationId: "material:synthetic", generation: 1, environment: {}, brokerEndpoint: "http://127.0.0.1:1"}, deadline: performance.now() + 5000});
    await assert.rejects(reservation.start(claim(reservation.reservationId), new AbortController().signal));
    assert.deepEqual(await reservation.close(0), {kind: "not_started", reservationId: reservation.reservationId});
  } finally {await rm(root, {recursive: true, force: true});}
});

test("Linux ordinary reservation refuses before preparing a provider launch", {skip: process.platform !== "linux"}, async () => {
  const owner = createNodeOrdinaryProcess({prepareLaunch: async () => {throw new Error("must not prepare launch");}});
  await assert.rejects(owner.reserve({binding, workspace: {workspaceId: "test", cwd: "/synthetic-TEST", homeDirectory: "/synthetic-TEST"}, credential: {materializationId: "test", generation: 1, environment: {}, brokerEndpoint: "http://127.0.0.1:1"}, deadline: performance.now() + 5000}), /ORDINARY_PROCESS_UNCONFIRMED/);
});
