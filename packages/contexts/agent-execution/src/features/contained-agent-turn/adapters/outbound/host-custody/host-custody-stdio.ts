import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

import type {
  CustodiedProviderProcessExit,
  HostCustodyDrainEvidence,
} from "./custodied-provider-process.js";
import { sha256 } from "./host-custody-launch.js";
import type { GuardianProviderStreamFinal } from "./host-custody-stable-guardian.js";

type GroupStatus = "absent" | "ambiguous" | "present";

interface StreamAccounting {
  readonly done: Promise<void>;
  readonly snapshot: () => HostCustodyDrainEvidence;
}

export class HostStdinEgress extends Writable {
  readonly #close: () => Promise<void>;
  readonly #writeBounded: (bytes: Uint8Array) => Promise<void>;

  public constructor(
    writeBounded: (bytes: Uint8Array) => Promise<void>,
    close: () => Promise<void>,
  ) {
    super();
    this.#close = close;
    this.#writeBounded = writeBounded;
  }

  public override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    void (async () => {
      try {await this.#writeBounded(chunk); callback();}
      catch (error) {callback(error instanceof Error ? error : new Error("Host Custody stdin write failed"));}
    })();
  }

  public override _final(callback: (error?: Error | null) => void): void {
    void (async () => {
      try {await this.#close(); callback();}
      catch (error) {callback(error instanceof Error ? error : new Error("Host Custody stdin close failed"));}
    })();
  }
}

export class HostStdoutIngress extends Readable implements StreamAccounting {
  readonly #done: Promise<void>;
  readonly #hash = createHash("sha256");
  readonly #maxBytes: number;
  readonly #onOverflow: () => void;
  #bytes = 0;
  #closureDrain = false;
  #consumerRegistered = false;
  #final: "complete" | "error" | "incomplete" | "overflow" = "incomplete";
  #iteratorReadableRegistrationPending = false;
  #providerFinal: GuardianProviderStreamFinal | undefined;
  #resolveDone: (() => void) | undefined;
  #settled = false;
  #source?: Readable;
  #transportFinal: "complete" | "error" | "incomplete" | undefined;

  public constructor(highWaterMark: number, maxBytes: number, onOverflow: () => void) {
    super({ highWaterMark });
    this.#maxBytes = maxBytes;
    this.#onOverflow = onOverflow;
    this.#done = new Promise(resolve => {this.#resolveDone = resolve;});
  }

  public get done(): Promise<void> {return this.#done;}
  public get settled(): boolean {return this.#settled;}

  public attach(source: Readable, providerFinal: Promise<GuardianProviderStreamFinal>): void {
    this.#source = source;
    void providerFinal.then(
      status => {this.#providerFinal = status; return this.#trySettle();},
      () => {this.#providerFinal = "incomplete"; return this.#trySettle();},
    );
    source.on("data", (chunk: Buffer) => {
      if (this.#settled) {return;}
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = this.#maxBytes - this.#bytes;
      if (bytes.byteLength > remaining) {
        if (remaining > 0) {
          this.#bytes += remaining;
          this.#hash.update(bytes.subarray(0, remaining));
        }
        this.#final = "overflow";
        source.pause();
        source.destroy();
        this.#settle();
        this.#onOverflow();
        return;
      }
      this.#bytes += bytes.byteLength;
      this.#hash.update(bytes);
      if (this.#closureDrain) {return;}
      if (!this.push(bytes)) {source.pause();}
    });
    source.once("end", () => {
      if (this.#settled) {return;}
      this.#transportFinal = "complete";
      this.#trySettle();
    });
    source.once("error", () => {
      if (this.#settled) {return;}
      this.#transportFinal = "error";
      this.#trySettle();
    });
    source.once("close", () => {
      if (this.#settled) {return;}
      this.#transportFinal ??= "incomplete";
      this.#trySettle();
    });
  }

  public override _read(): void {this.#source?.resume();}

  public override on(...parameters: Parameters<Readable["on"]>): this {
    const [event] = parameters;
    if (event === "readable" && this.#iteratorReadableRegistrationPending) {
      this.#iteratorReadableRegistrationPending = false;
    } else if (event === "data" || event === "readable") {
      this.#registerConsumer();
    }
    return super.on(...parameters);
  }

  public override [Symbol.asyncIterator]() {
    this.#registerConsumer();
    this.#iteratorReadableRegistrationPending = true;
    return super[Symbol.asyncIterator]();
  }

  #registerConsumer(): void {
    if (this.#consumerRegistered) {
      throw new Error("Host Custody stdout already has its single registered consumer");
    }
    this.#consumerRegistered = true;
  }

  #trySettle(): void {
    if (this.#settled || this.#transportFinal === undefined) {return;}
    if (this.#transportFinal === "error") {
      if (this.#final !== "overflow") {this.#final = "error";}
      this.#settle();
      return;
    }
    if (this.#transportFinal === "incomplete") {
      this.#settle();
      return;
    }
    if (this.#providerFinal === undefined) {return;}
    if (this.#final !== "overflow") {this.#final = this.#providerFinal;}
    this.#settle();
  }

  public releaseBackpressureForClosure(): void {
    this.#closureDrain = true;
    this.#source?.resume();
  }

  #settle(): void {
    if (this.#settled) {return;}
    this.#settled = true;
    this.push(null);
    this.#resolveDone?.();
  }

  public snapshot(): HostCustodyDrainEvidence {
    return Object.freeze({
      bytes: this.#bytes,
      sha256: this.#hash.copy().digest("hex"),
      status: this.#final,
    });
  }
}

export class RedactedDiagnosticRing implements AsyncIterable<Uint8Array> {
  readonly #maxBytes: number;
  #bytes = 0;
  #consumerRegistered = false;
  #ended = false;
  #queue: Buffer[] = [];
  #waiter: ((result: IteratorResult<Uint8Array>) => void) | undefined;

  public constructor(maxBytes: number) {this.#maxBytes = maxBytes;}

  public record(bytes: Buffer): void {
    if (this.#ended) {return;}
    const summary = Buffer.from(`stderr-bytes:${bytes.byteLength}:sha256:${sha256(bytes)}\n`, "utf8");
    if (this.#waiter !== undefined) {
      const waiter = this.#waiter;
      this.#waiter = undefined;
      waiter({ done: false, value: summary });
      return;
    }
    this.#queue.push(summary);
    this.#bytes += summary.byteLength;
    while (this.#bytes > this.#maxBytes && this.#queue.length > 0) {
      this.#bytes -= this.#queue.shift()?.byteLength ?? 0;
    }
  }

  public end(): void {
    this.#ended = true;
    if (this.#waiter !== undefined && this.#queue.length === 0) {
      const waiter = this.#waiter;
      this.#waiter = undefined;
      waiter({ done: true, value: undefined });
    }
  }

  public [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    if (this.#consumerRegistered) {
      throw new Error("Host Custody stderr diagnostic ring already has a consumer");
    }
    this.#consumerRegistered = true;
    return {
      next: async () => {
        const queued = this.#queue.shift();
        if (queued !== undefined) {
          this.#bytes -= queued.byteLength;
          return { done: false, value: queued };
        }
        if (this.#ended) {return { done: true, value: undefined };}
        return new Promise<IteratorResult<Uint8Array>>(resolve => {this.#waiter = resolve;});
      },
    };
  }
}

export class HostStderrIngress implements StreamAccounting {
  readonly #done: Promise<void>;
  readonly #hash = createHash("sha256");
  readonly #maxBytes: number;
  readonly #onOverflow: () => void;
  public readonly diagnostic: RedactedDiagnosticRing;
  #bytes = 0;
  #final: "complete" | "error" | "incomplete" | "overflow" = "incomplete";
  #providerFinal: GuardianProviderStreamFinal | undefined;
  #resolveDone: (() => void) | undefined;
  #settled = false;
  #transportFinal: "complete" | "error" | "incomplete" | undefined;

  public constructor(maxBytes: number, maxDiagnosticBytes: number, onOverflow: () => void) {
    this.#maxBytes = maxBytes;
    this.#onOverflow = onOverflow;
    this.diagnostic = new RedactedDiagnosticRing(maxDiagnosticBytes);
    this.#done = new Promise(resolve => {this.#resolveDone = resolve;});
  }

  public get done(): Promise<void> {return this.#done;}
  public get settled(): boolean {return this.#settled;}

  public attach(source: Readable, providerFinal: Promise<GuardianProviderStreamFinal>): void {
    void providerFinal.then(
      status => {this.#providerFinal = status; return this.#trySettle();},
      () => {this.#providerFinal = "incomplete"; return this.#trySettle();},
    );
    source.on("data", (chunk: Buffer) => {
      if (this.#settled) {return;}
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = this.#maxBytes - this.#bytes;
      if (bytes.byteLength > remaining) {
        if (remaining > 0) {
          const bounded = bytes.subarray(0, remaining);
          this.#bytes += bounded.byteLength;
          this.#hash.update(bounded);
          this.diagnostic.record(bounded);
        }
        this.#final = "overflow";
        source.pause();
        source.destroy();
        this.#settle();
        this.#onOverflow();
        return;
      }
      this.#bytes += bytes.byteLength;
      this.#hash.update(bytes);
      this.diagnostic.record(bytes);
    });
    source.once("end", () => {
      if (this.#settled) {return;}
      this.#transportFinal = "complete";
      this.#trySettle();
    });
    source.once("error", () => {
      if (this.#settled) {return;}
      this.#transportFinal = "error";
      this.#trySettle();
    });
    source.once("close", () => {
      if (this.#settled) {return;}
      this.#transportFinal ??= "incomplete";
      this.#trySettle();
    });
    source.resume();
  }

  #trySettle(): void {
    if (this.#settled || this.#transportFinal === undefined) {return;}
    if (this.#transportFinal === "error") {
      if (this.#final !== "overflow") {this.#final = "error";}
      this.#settle();
      return;
    }
    if (this.#transportFinal === "incomplete") {
      this.#settle();
      return;
    }
    if (this.#providerFinal === undefined) {return;}
    if (this.#final !== "overflow") {this.#final = this.#providerFinal;}
    this.#settle();
  }

  #settle(): void {
    if (this.#settled) {return;}
    this.#settled = true;
    this.diagnostic.end();
    this.#resolveDone?.();
  }

  public snapshot(): HostCustodyDrainEvidence {
    return Object.freeze({
      bytes: this.#bytes,
      sha256: this.#hash.copy().digest("hex"),
      status: this.#final,
    });
  }
}

export const processExit = (child: ChildProcessWithoutNullStreams): Promise<CustodiedProviderProcessExit> =>
  new Promise(resolve => {
    child.once("error", () => resolve(Object.freeze({ code: null, signal: null })));
    child.once("exit", (code, signal) => resolve(Object.freeze({ code, signal })));
  });

export const writeBytes = (child: ChildProcessWithoutNullStreams, bytes: Uint8Array): Promise<void> =>
  new Promise((resolve, reject) => {
    child.stdin.write(bytes, error => {if (error) {reject(error);} else {resolve();}});
  });

export const closeInput = (child: ChildProcessWithoutNullStreams): Promise<void> =>
  new Promise((resolve, reject) => {
    child.stdin.end((error?: Error | null) => {if (error) {reject(error);} else {resolve();}});
  });

interface TerminationStreams {
  readonly exit?: Promise<CustodiedProviderProcessExit>;
  readonly stderr?: HostStderrIngress;
  readonly stdout?: HostStdoutIngress;
}

interface CooperativeTerminationOptions {
  readonly alreadyExitedGroup: GroupStatus;
  readonly drainAfterMs: number;
  readonly forceKillAfterMs: number;
  readonly monotonicNow: () => number;
  readonly pid: number;
  readonly processGroupStatus: (pid: number) => GroupStatus;
  readonly signalProcessGroup: (
    signal: "SIGKILL" | "SIGTERM",
  ) => Promise<"absent" | "sent" | "unproven">;
  readonly terminateAfterMs: number;
}

const boundedGroupStatus = async (
  pid: number,
  milliseconds: number,
  monotonicNow: () => number,
  processGroupStatus: (pid: number) => GroupStatus,
): Promise<GroupStatus> => {
  const deadline = monotonicNow() + milliseconds;
  for (;;) {
    const status = processGroupStatus(pid);
    if (status !== "present" || monotonicNow() >= deadline) {return status;}
    await delay(Math.min(10, Math.max(1, deadline - monotonicNow())));
  }
};

export type CooperativeTerminationOutcome =
  | { readonly exit: CustodiedProviderProcessExit; readonly kind: "closed" }
  | { readonly kind: "unproven"; readonly reason: string };

const boundedExit = async (
  exit: Promise<CustodiedProviderProcessExit> | undefined,
  milliseconds: number,
): Promise<CustodiedProviderProcessExit | undefined> => {
  if (exit === undefined) {return;}
  return boundedPromise(exit, milliseconds);
};

export const boundedPromise = <Value>(promise: Promise<Value>, milliseconds: number): Promise<Value | undefined> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {resolve(void 0);}, milliseconds);
    void promise.then(
      value => {clearTimeout(timer); return resolve(value);},
      error => {clearTimeout(timer); return reject(error);},
    );
  });

const boundedDrain = async (
  streams: TerminationStreams,
  milliseconds: number,
  monotonicNow: () => number,
): Promise<boolean> => {
  if (streams.stdout === undefined || streams.stderr === undefined) {return false;}
  const deadline = monotonicNow() + milliseconds;
  return (await boundedPromise(
    Promise.all([streams.stdout.done, streams.stderr.done]).then(() => true),
    Math.max(1, deadline - monotonicNow()),
  )) ?? false;
};

export const waitForIngressFinal = async (
  streams: Pick<TerminationStreams, "stderr" | "stdout">,
  milliseconds: number,
  monotonicNow: () => number,
): Promise<boolean> => {
  streams.stdout?.releaseBackpressureForClosure();
  return boundedDrain(streams, milliseconds, monotonicNow);
};

const stopProcessGroup = async (
  streams: TerminationStreams,
  options: CooperativeTerminationOptions,
): Promise<CooperativeTerminationOutcome | { readonly exit: CustodiedProviderProcessExit; readonly group: GroupStatus }> => {
  const observePhase = async (milliseconds: number): Promise<{
    readonly exit: CustodiedProviderProcessExit | undefined;
    readonly group: GroupStatus;
  }> => {
    const deadline = options.monotonicNow() + milliseconds;
    const remaining = Math.max(1, deadline - options.monotonicNow());
    const [exit, group] = await Promise.all([
      boundedExit(streams.exit, remaining),
      boundedGroupStatus(options.pid, remaining, options.monotonicNow, options.processGroupStatus),
    ]);
    return { exit, group };
  };
  const signal = async (requested: "SIGKILL" | "SIGTERM"): Promise<"absent" | "sent" | "unproven"> => {
    return options.signalProcessGroup(requested);
  };
  if (options.alreadyExitedGroup !== "absent") {
    if (await signal("SIGTERM") === "unproven") {
      return { kind: "unproven", reason: "term-signal-failed" };
    }
  }
  let { exit, group } = await observePhase(options.terminateAfterMs);
  if (group === "ambiguous") {return { kind: "unproven", reason: "process-group-observation-ambiguous" };}
  if (exit === undefined || group === "present") {
    if (await signal("SIGKILL") === "unproven") {
      return { kind: "unproven", reason: "kill-signal-failed" };
    }
    ({ exit, group } = await observePhase(options.forceKillAfterMs));
  }
  if (exit === undefined || group !== "absent") {
    return {
      kind: "unproven",
      reason: group === "ambiguous" ? "process-group-observation-ambiguous" : "cooperative-closure-unproven",
    };
  }
  return { exit, group };
};

const sealDrain = async (
  streams: TerminationStreams,
  options: CooperativeTerminationOptions,
): Promise<string | undefined> => {
  const drained = await waitForIngressFinal(streams, options.drainAfterMs, options.monotonicNow);
  const stdout = streams.stdout?.snapshot();
  const stderr = streams.stderr?.snapshot();
  if (drained && stdout?.status === "complete" && stderr?.status === "complete") {return undefined;}
  return stdout?.status === "overflow" || stderr?.status === "overflow" ? "ingress-overflow" : "ingress-incomplete";
};

export const terminateCooperativeProcessGroup = async (
  streams: TerminationStreams,
  options: CooperativeTerminationOptions,
): Promise<CooperativeTerminationOutcome> => {
  const stopped = await stopProcessGroup(streams, options);
  if ("kind" in stopped) {return stopped;}
  const drainFailure = await sealDrain(streams, options);
  return drainFailure === undefined
    ? { exit: stopped.exit, kind: "closed" }
    : { kind: "unproven", reason: drainFailure };
};
