import type { CustodiedProviderProcessExit } from "./custodied-provider-process.js";
import type { DarwinAttemptOwnerCommand, DarwinAttemptOwnerEvent } from "./darwin-attempt-owner-protocol.js";

// Fixed Darwin signal numbers: interpreting these with the build host's
// signal constants would silently misreport Darwin SIGBUS/SIGUSR1, etc.
// @types/node omits Darwin SIGEMT (7); the cast below is limited to that
// fixed Darwin signal name, never a caller string or host-dependent mapping.
const darwinSignals: readonly NodeJS.Signals[] = ["SIGHUP", "SIGINT", "SIGQUIT", "SIGILL", "SIGTRAP", "SIGABRT",
  "SIGEMT" as NodeJS.Signals, "SIGFPE", "SIGKILL", "SIGBUS", "SIGSEGV", "SIGSYS", "SIGPIPE", "SIGALRM", "SIGTERM", "SIGURG",
  "SIGSTOP", "SIGTSTP", "SIGCONT", "SIGCHLD", "SIGTTIN", "SIGTTOU", "SIGIO", "SIGXCPU", "SIGXFSZ",
  "SIGVTALRM", "SIGPROF", "SIGWINCH", "SIGINFO", "SIGUSR1", "SIGUSR2"];
function nativeOutput() {
  let bytes: Buffer | undefined, written = 0, read = 0, ended = false, consumed = false;
  let failure: Error | undefined, wake: (() => void) | undefined;
  const signal = (): void => {wake?.(); wake = undefined;};
  const iterable: AsyncIterable<Uint8Array> = Object.freeze({
    async *[Symbol.asyncIterator]() {
      if (consumed) {throw new Error("native output already consumed");}
      consumed = true;
      for (;;) {
        if (failure) {throw failure;}
        if (read < written) {
          const end = Math.min(written, read + 16384), chunk = Buffer.from(bytes!.subarray(read, end));
          read = end; yield chunk; continue;
        }
        if (ended) {return;}
        await new Promise<void>(resolve => {wake = resolve;});
      }
    },
  });
  return Object.freeze({iterable,
    push(chunk: Uint8Array): void {
      if (failure || ended || chunk.byteLength > 8388608 - written) {throw new Error("native output closed or budget exceeded");}
      bytes ??= Buffer.alloc(8388608);
      bytes.set(chunk, written); written += chunk.byteLength; signal();
    },
    end(): void {ended = true; signal();},
    lost(error: Error): void {if (!ended) {failure = error; signal();}},
  });
}
export function nativeExecution() {
  const stdout = nativeOutput(), stderr = nativeOutput();
  let resolveImage!: () => void, rejectImage!: (error: Error) => void;
  let resolveExit!: (exit: CustodiedProviderProcessExit) => void, rejectExit!: (error: Error) => void;
  let imageSeen = false, outputBytes = 0;
  const image = new Promise<void>((resolve, reject) => {resolveImage = resolve; rejectImage = reject;});
  const exit = new Promise<CustodiedProviderProcessExit>((resolve, reject) => {resolveExit = resolve; rejectExit = reject;});
  void image.catch(() => {}); void exit.catch(() => {});
  return Object.freeze({image, exit, stdout: stdout.iterable, stderr: stderr.iterable,
    accept(event: DarwinAttemptOwnerEvent): void {
      switch (event.kind) {
        case "IMAGE": imageSeen = true; resolveImage(); break;
        case "STDOUT": case "STDERR":
          outputBytes += event.payload.length;
          if (outputBytes > 8388608) {throw new Error("native combined output budget exceeded");}
          (event.kind === "STDOUT" ? stdout : stderr).push(event.payload); break;
        case "EXIT": {
          if (!imageSeen) {rejectImage(new Error("native child exited before provider image observation"));}
          const signal = event.exitSignal ? darwinSignals[event.exitSignal - 1] : null;
          if (signal === undefined) {throw new Error("unknown Darwin native exit signal");}
          resolveExit(Object.freeze({code: event.exitCode ?? null, signal})); break;
        }
        case "STREAMS": stdout.end(); stderr.end(); break;
        default: break;
      }
    },
    lost(error: Error): void {rejectImage(error); rejectExit(error); stdout.lost(error); stderr.lost(error);},
  });
}

export function nativeInput(
  request: (command: DarwinAttemptOwnerCommand, argument?: number, payload?: Buffer) => Promise<DarwinAttemptOwnerEvent>,
  current: () => boolean, lose: (error: unknown) => void,
) {
  let tail: Promise<void> = Promise.resolve(), queuedBytes = 0, closed = false;
  const enqueue = (bytes?: Buffer): Promise<void> => {
    const run = async (): Promise<void> => {
      if (!current()) {throw new Error("native input unavailable or cut off");}
      if (!bytes) {await request("CLOSE_INPUT"); return;}
      for (let offset = 0; offset < bytes.length; offset += 16384) {
        if (!current()) {throw new Error("native input cut off during write");}
        const chunk = bytes.subarray(offset, offset + 16384);
        await request("WRITE_INPUT", chunk.length, chunk);
      }
    };
    const operation = tail.then(run);
    tail = operation;
    // Any partial uncertainty burns the transport; queued writes never retry.
    void operation.catch(lose);
    return operation.finally(() => {if (bytes) {queuedBytes -= bytes.length; bytes.fill(0);}});
  };
  return Object.freeze({
    writeInput(bytes: Uint8Array): Promise<void> {
      if (closed || !current() || !(bytes instanceof Uint8Array) || !bytes.byteLength ||
          bytes.byteLength > 1048576 - queuedBytes) {return Promise.reject(new Error("native input closed or queue budget exceeded"));}
      const captured = Buffer.from(bytes); // Before await or caller mutation.
      queuedBytes += captured.length;
      return enqueue(captured);
    },
    closeInput(): Promise<void> {
      if (closed || !current()) {return Promise.reject(new Error("native input already closed or unavailable"));}
      closed = true;
      return enqueue();
    },
  });
}

