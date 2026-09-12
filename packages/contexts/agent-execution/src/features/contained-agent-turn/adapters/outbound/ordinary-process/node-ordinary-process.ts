import {spawn, type ChildProcessWithoutNullStreams} from "node:child_process";
import {randomUUID} from "node:crypto";
import type {OrdinaryProcessPort, OrdinaryProcessReservation, OrdinaryTransport} from "../../../application/ordinary-ports.js";
import type {OrdinaryBinding, OrdinaryReceiptOf} from "../../../domain/ordinary-model.js";

export interface OrdinaryLaunchSpecification {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
}
export type OrdinaryProcessObservation = OrdinaryBinding & {readonly reservationId: string} & (
  | {readonly kind: "launch_requested"}
  | {readonly kind: "started" | "exited" | "closed"; readonly pid: number; readonly processGroupId: number}
  | {readonly kind: "unconfirmed"; readonly pid: number | null; readonly processGroupId: number | null}
);
export interface NodeOrdinaryProcessOptions {
  /** Trusted non-secret durable journal sink. A supplied sink must acknowledge synchronously. */
  readonly record?: (observation: OrdinaryProcessObservation) => void;
  /** Trusted configuration adapter, selected by outer composition, never submit. */
  readonly prepareLaunch: (input: Parameters<OrdinaryProcessPort["reserve"]>[0]) => Promise<OrdinaryLaunchSpecification>;
}

const copyBinding = (value: OrdinaryBinding): OrdinaryBinding => Object.freeze({
  operationId: value.operationId, attemptId: value.attemptId,
  executionProfile: value.executionProfile, capabilityManifestRevision: value.capabilityManifestRevision,
});
const refusal = () => new Error("ORDINARY_PROCESS_UNCONFIRMED");
const groupExists = (pid: number): boolean => {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") { return false; } throw refusal(); }
};
async function within(promise: Promise<void>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

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
    const arguments_ = [...launch.arguments];
    const environment = {...launch.environment};
    const reservationId = randomUUID();
    const ownershipToken = randomUUID();
    let attempted = false;
    let closing = false;
    let iterating = false;
    let streamInvalid = false;
    let journalFailed = false;
    const record = (observation: OrdinaryProcessObservation): void => {
      try {options.record?.(Object.freeze(observation));} catch {journalFailed = true; throw refusal();}
    };
    let spawnInvoked = false;
    let child: ChildProcessWithoutNullStreams | undefined;
    let exited = false;
    let closed = false;
    let stdoutClosed = false;
    let stderrClosed = false;
    let failure: Error | undefined;
    let wake: (() => void) | undefined;
    let resolveClosure!: () => void;
    const closure = new Promise<void>(resolve => { resolveClosure = resolve; });
    let closePromise: ReturnType<OrdinaryProcessReservation["close"]> | undefined;
    const queue: string[] = [];
    const decoder = new TextDecoder("utf-8", {fatal: true});
    const stderrDecoder = new TextDecoder("utf-8", {fatal: true});
    let partial = "";
    let totalBytes = 0;
    let abortSignal: AbortSignal | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const fail = () => { failure ??= refusal(); wake?.(); };
    const interrupt = () => {
      fail();
      // An exited leader cannot justify signalling a possibly recycled process group.
      if (child?.pid !== undefined && !exited) { try { process.kill(-child.pid, "SIGTERM"); } catch { /* Closure observation decides. */ } }
    };
    const onData = (bytes: Buffer) => {
      totalBytes += bytes.length;
      if (totalBytes > 1_048_576) { interrupt(); return; }
      try {partial += decoder.decode(bytes, {stream: true});} catch {streamInvalid = true; interrupt(); return;}
      for (;;) {
        const newline = partial.indexOf("\n");
        if (newline < 0) { break; }
        const line = partial.slice(0, newline);
        partial = partial.slice(newline + 1);
        if (Buffer.byteLength(line) > 262_144 || queue.length >= 256) { interrupt(); return; }
        queue.push(line);
      }
      if (Buffer.byteLength(partial) > 262_144) { interrupt(); }
      wake?.();
    };
    const transport: OrdinaryTransport = Object.freeze({
      lines: {async *[Symbol.asyncIterator]() {
        if (iterating) {throw refusal();}
        iterating = true;
        for (;;) {
          if (failure !== undefined) { throw failure; }
          const next = queue.shift();
          if (next !== undefined) { yield next; continue; }
          if (stdoutClosed) { return; }
          await new Promise<void>(resolve => { wake = resolve; });
          wake = undefined;
        }
      }},
      async write(message: string) {
        if (failure !== undefined || child === undefined || closed || exited || Buffer.byteLength(message) > 262_144) { throw refusal(); }
        await new Promise<void>((resolve, reject) => { child!.stdin.write(message, (error: Error | null | undefined) => error ? reject(refusal()) : resolve()); });
      },
      async closeInput() { child?.stdin.end(); },
    });
    return Object.freeze({
      reservationId,
      async start(claim: OrdinaryReceiptOf<"dispatch_claim">, signal: AbortSignal) {
        if (attempted || closing) { throw refusal(); }
        attempted = true;
        if (claim.kind !== "dispatch_claim" || claim.reservationId !== reservationId ||
            claim.operationId !== binding.operationId || claim.attemptId !== binding.attemptId ||
            claim.executionProfile !== binding.executionProfile || claim.capabilityManifestRevision !== binding.capabilityManifestRevision ||
            signal.aborted || performance.now() >= input.deadline) { throw refusal(); }
        abortSignal = signal;
        record({...binding, reservationId, kind: "launch_requested"});
        spawnInvoked = true;
        // Node installs the new session/process group before exec; no shell, uid/gid or inherited extras.
        child = spawn(executable, arguments_, {cwd: launch.cwd, env: environment, detached: true, stdio: ["pipe", "pipe", "pipe"]});
        child.once("error", fail);
        child.once("exit", () => { exited = true; if (child?.pid !== undefined) {try {record({...binding, reservationId, kind: "exited", pid: child.pid, processGroupId: child.pid});} catch {fail();}} });
        child.once("close", () => { closed = true; resolveClosure(); wake?.(); });
        child.stdin.on("error", fail);
        child.stdout.on("error", fail);
        child.stderr.on("error", fail);
        child.stdout.on("data", onData);
        child.stdout.once("end", () => { try {partial += decoder.decode();} catch {streamInvalid = true; fail();} if (partial.length > 0) {streamInvalid = true; fail();} stdoutClosed = true; wake?.(); });
        child.stderr.on("data", (bytes: Buffer) => { totalBytes += bytes.length; try {stderrDecoder.decode(bytes, {stream: true});} catch {streamInvalid = true; interrupt();} bytes.fill(0); if (totalBytes > 1_048_576) { interrupt(); } });
        child.stderr.once("end", () => {try {stderrDecoder.decode();} catch {streamInvalid = true; fail();} stderrClosed = true;});
        signal.addEventListener("abort", interrupt, {once: true});
        deadlineTimer = setTimeout(interrupt, Math.max(1, input.deadline - performance.now()));
        if (signal.aborted) { interrupt(); }
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
          if (!await within(closure, 1500) && !exited) {
            try { process.kill(-child.pid, "SIGTERM"); } catch { /* Read observed closure. */ }
            if (!await within(closure, 1000) && !exited) {
              try { process.kill(-child.pid, "SIGKILL"); } catch { /* Read observed closure. */ }
              await within(closure, 1000);
            }
          }
          const unread = queue.length;
          queue.length = 0;
          partial = "";
          for (const key of Object.keys(environment)) {delete environment[key];}
          if (journalFailed || streamInvalid || !closed || !exited || !stdoutClosed || !stderrClosed || unread !== 0 || groupExists(child.pid) || !Number.isSafeInteger(finalSequence) || finalSequence < 0) { throw refusal(); }
          record({...binding, reservationId, kind: "closed", pid: child.pid, processGroupId: child.pid});
          return Object.freeze([
            Object.freeze({...binding, kind: "output_drain" as const, finalSequence, stdoutClosed: true as const, stderrClosed: true as const}),
            Object.freeze({...binding, kind: "process_group_closed" as const, reservationId, pid: child.pid, processGroupId: child.pid, ownershipToken,
              exitObserved: true as const, groupEmptyObserved: true as const}),
          ] as const);
        })().catch(error => {
          try {record({...binding, reservationId, kind: "unconfirmed", pid: child?.pid ?? null, processGroupId: child?.pid ?? null});} catch { /* The supplied journal already failed closed. */ }
          throw error;
        });
        return closePromise;
      },
    });
  }});
}
