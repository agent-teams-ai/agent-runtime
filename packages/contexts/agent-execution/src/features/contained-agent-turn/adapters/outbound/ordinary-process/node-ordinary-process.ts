import {spawn, type ChildProcessWithoutNullStreams} from "node:child_process";
import {randomUUID} from "node:crypto";
import type {OrdinaryLaunchRecipe, OrdinaryProcessPort, OrdinaryProcessReservation} from "../../../application/ordinary-ports.js";
import type {OrdinaryBinding, OrdinaryReceiptOf} from "../../../domain/ordinary-model.js";
import {sealOrdinaryChannel, type OrdinaryByteChannel} from "../ordinary-channel/ordinary-byte-channel.js";

export type {OrdinaryLaunchSpecification} from "../../../application/ordinary-ports.js";
export type OrdinaryProcessObservation = OrdinaryBinding & {readonly reservationId: string} & (
  | {readonly kind: "launch_requested"}
  | {readonly kind: "started" | "exited" | "closed"; readonly pid: number; readonly processGroupId: number}
  | {readonly kind: "unconfirmed"; readonly pid: number | null; readonly processGroupId: number | null}
);
export interface NodeOrdinaryProcessOptions {
  /** Trusted non-secret durable journal sink. A supplied sink must acknowledge synchronously. */
  readonly record?: (observation: OrdinaryProcessObservation) => void;
  /** Trusted configuration adapter, selected by outer composition, never submit. */
  readonly prepareLaunch: OrdinaryLaunchRecipe;
}

const copyBinding = (value: OrdinaryBinding): OrdinaryBinding => Object.freeze({
  operationId: value.operationId, attemptId: value.attemptId,
  executionProfile: value.executionProfile, capabilityManifestRevision: value.capabilityManifestRevision,
});
const isAborted = (signal: AbortSignal): boolean => signal.aborted;
const refusal = () => new Error("ORDINARY_PROCESS_UNCONFIRMED");
const groupExists = (pid: number): boolean => {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") { return false; } throw refusal(); }
};
async function within(promise: Promise<void>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => {resolve(false);}, milliseconds); })]); }
  finally { clearTimeout(timer); }
}
const writeMessage = async (child: ChildProcessWithoutNullStreams, message: Uint8Array): Promise<void> =>
  new Promise((resolve, reject) => {
    child.stdin.write(message, (error: Error | null | undefined) => {
      if (error !== null && error !== undefined) {reject(refusal()); return;}
      resolve();
    });
  });

const assertClosure = (facts: Readonly<{
  journalFailed: boolean; streamInvalid: boolean; closed: boolean; exited: boolean;
  stdoutClosed: boolean; stderrClosed: boolean; unread: number; framingClean: boolean; pid: number; finalSequence: number;
}>): void => {
  const {journalFailed, streamInvalid, closed, exited, stdoutClosed, stderrClosed, unread, framingClean, pid, finalSequence} = facts;
  if (journalFailed || streamInvalid || !closed || !exited || !stdoutClosed || !stderrClosed || unread !== 0 || !framingClean || groupExists(pid) || !Number.isSafeInteger(finalSequence) || finalSequence < 0) {throw refusal();}
};

/** Live ownership is retained only in this process. This adapter never recovers a persisted PID. */
export function createNodeOrdinaryProcess(options: NodeOrdinaryProcessOptions): OrdinaryProcessPort {
  return Object.freeze({async reserve(input: Parameters<OrdinaryProcessPort["reserve"]>[0]): Promise<OrdinaryProcessReservation> {
    if (process.platform !== "darwin" || process.getuid?.() === undefined || process.getuid() === 0 ||
        !Number.isFinite(input.deadline) || input.deadline <= performance.now()) { throw refusal(); }
    const binding = copyBinding(input.binding);
    const launch = await options.prepareLaunch(input);
    if (launch.cwd !== input.workspace.cwd || !launch.executable.startsWith("/") ||
        !Array.isArray(launch.arguments)) { throw refusal(); }
    const executable = launch.executable;
    const processArguments = Array.from<string>(launch.arguments);
    const environment = {...launch.environment};
    const reservationId = randomUUID();
    const ownershipToken = randomUUID();
    let attempted = false;
    let closing = false;
    let reading = false;
    let framingClean = false;
    let streamInvalid = false;
    let journalFailed = false;
    const record = (observation: OrdinaryProcessObservation): void => {
      try {
        const acknowledged: unknown = options.record?.(Object.freeze(observation));
        if (acknowledged !== undefined) {if (acknowledged instanceof Promise) {void acknowledged.catch(() => {});} throw refusal();}
      } catch {journalFailed = true; throw refusal();}
    };
    let spawnInvoked = false;
    let child: ChildProcessWithoutNullStreams | undefined;
    let exited = false;
    const hasExited = (): boolean => exited;
    let closed = false;
    let stdoutClosed = false;
    let stderrClosed = false;
    let failure: Error | undefined;
    let wake: (() => void) | undefined;
    let resolveClosure!: () => void;
    const closure = new Promise<void>(resolve => { resolveClosure = resolve; });
    let closePromise: ReturnType<OrdinaryProcessReservation["close"]> | undefined;
    // Unread stdout bytes can never exceed the shared 1 MiB budget, which is the bound on this queue.
    const chunks: Buffer[] = [];
    let unreadBytes = 0;
    const stderrDecoder = new TextDecoder("utf-8", {fatal: true});
    let totalBytes = 0;
    let abortSignal: AbortSignal | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const fail = () => { failure ??= refusal(); wake?.(); };
    const interrupt = () => {
      fail();
      // An exited leader cannot justify signalling a possibly recycled process group.
      if (child?.pid !== undefined && !hasExited()) { try { process.kill(-child.pid, "SIGTERM"); } catch { /* Closure observation decides. */ } }
    };
    const onData = (bytes: Buffer) => {
      totalBytes += bytes.length;
      if (totalBytes > 1_048_576) { streamInvalid = true; interrupt(); return; }
      chunks.push(bytes);
      unreadBytes += bytes.length;
      wake?.();
    };
    // Framing, UTF-8 and line bounds belong to the consumer; this side only bounds and hands over bytes.
    const channel: OrdinaryByteChannel = Object.freeze({
      async read() {
        if (reading) {throw refusal();}
        reading = true;
        try {
          for (;;) {
            if (failure !== undefined) { throw failure; }
            const next = chunks.shift();
            if (next !== undefined) { unreadBytes -= next.length; return next; }
            if (stdoutClosed) { return; }
            await new Promise<void>(resolve => { wake = resolve; });
            wake = undefined;
          }
        } finally { reading = false; }
      },
      async write(bytes: Uint8Array) {
        if (failure !== undefined || child === undefined || closed || exited || bytes.length > 262_144) { throw refusal(); }
        await writeMessage(child, bytes);
      },
      async closeInput() { child?.stdin.end(); },
      confirmCleanFraming() { framingClean = true; },
    });
    const transport = sealOrdinaryChannel(channel);

    return Object.freeze({
      reservationId,
      async start(claim: OrdinaryReceiptOf<"dispatch_claim">, signal: AbortSignal) {
        if (attempted || closing) { throw refusal(); }
        attempted = true;
        const claimBinding: Readonly<Record<keyof typeof claim, unknown>> = claim;
        if (claimBinding.kind !== "dispatch_claim" || claim.reservationId !== reservationId ||
            claim.operationId !== binding.operationId || claim.attemptId !== binding.attemptId ||
            claimBinding.executionProfile !== binding.executionProfile || claimBinding.capabilityManifestRevision !== binding.capabilityManifestRevision ||
            isAborted(signal) || performance.now() >= input.deadline) { throw refusal(); }
        abortSignal = signal;
        record({...binding, reservationId, kind: "launch_requested"});
        spawnInvoked = true;
        // Node installs the new session/process group before exec; no shell, uid/gid or inherited extras.
        child = spawn(executable, processArguments, {cwd: launch.cwd, env: environment, detached: true, stdio: ["pipe", "pipe", "pipe"]});
        child.once("error", fail);
        child.once("exit", () => { exited = true; if (child?.pid !== undefined) {try {record({...binding, reservationId, kind: "exited", pid: child.pid, processGroupId: child.pid});} catch {fail();}} });
        child.once("close", () => { closed = true; resolveClosure(); wake?.(); });
        child.stdin.on("error", fail);
        child.stdout.on("error", fail);
        child.stderr.on("error", fail);
        child.stdout.on("data", onData);
        child.stdout.once("end", () => { stdoutClosed = true; wake?.(); });
        child.stderr.on("data", (bytes: Buffer) => { totalBytes += bytes.length; try {stderrDecoder.decode(bytes, {stream: true});} catch {streamInvalid = true; interrupt();} bytes.fill(0); if (totalBytes > 1_048_576) { streamInvalid = true; interrupt(); } });
        child.stderr.once("end", () => {try {stderrDecoder.decode();} catch {streamInvalid = true; fail();} stderrClosed = true;});
        signal.addEventListener("abort", interrupt, {once: true});
        deadlineTimer = setTimeout(interrupt, Math.max(1, input.deadline - performance.now()));
        if (isAborted(signal)) { interrupt(); }
        if (child.pid !== undefined) {try {record({...binding, reservationId, kind: "started", pid: child.pid, processGroupId: child.pid});} catch {interrupt(); throw refusal();}}
        return transport;
      },
      close(finalSequence: number) {
        closing = true;
        closePromise ??= (async () => {
          clearTimeout(deadlineTimer);
          abortSignal?.removeEventListener("abort", interrupt);
          if (!spawnInvoked) {for (const key of Object.keys(environment)) {delete environment[key];} return Object.freeze({kind: "not_started" as const, reservationId}); }
          if (child === undefined || child.pid === undefined) { throw refusal(); }
          child.stdin.end();
          if (!await within(closure, 1500) && !hasExited()) {
            try { process.kill(-child.pid, "SIGTERM"); } catch { /* Read observed closure. */ }
            if (!await within(closure, 1000) && !hasExited()) {
              try { process.kill(-child.pid, "SIGKILL"); } catch { /* Read observed closure. */ }
              await within(closure, 1000);
            }
          }
          const unread = unreadBytes;
          // Discarding bytes, or ending without a clean framing EOF, is permanent loss even if EOF arrives on a later retry.
          if (unread !== 0 || !framingClean) {streamInvalid = true;}
          chunks.length = 0;
          unreadBytes = 0;
          for (const key of Object.keys(environment)) {delete environment[key];}
          assertClosure({journalFailed, streamInvalid, closed, exited, stdoutClosed, stderrClosed, unread, framingClean, pid: child.pid, finalSequence});
          record({...binding, reservationId, kind: "closed", pid: child.pid, processGroupId: child.pid});
          return Object.freeze([
            Object.freeze({...binding, kind: "output_drain" as const, finalSequence, stdoutClosed: true as const, stderrClosed: true as const}),
            Object.freeze({...binding, kind: "process_group_closed" as const, reservationId, pid: child.pid, processGroupId: child.pid, ownershipToken,
              exitObserved: true as const, groupEmptyObserved: true as const}),
          ] as const);
        })().catch((error: unknown) => {
          closePromise = undefined;
          try {record({...binding, reservationId, kind: "unconfirmed", pid: child?.pid ?? null, processGroupId: child?.pid ?? null});} catch { /* The supplied journal already failed closed. */ }
          throw error;
        });
        return closePromise;
      },
    });
  }});
}
