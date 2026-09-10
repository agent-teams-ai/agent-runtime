import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";
import {createHash} from "node:crypto";
import type {CustodiedProviderProcess, CustodiedSdkProcess} from "./custodied-provider-process.js";

export class DeferredNativeProviderProcess implements CustodiedProviderProcess {
  readonly #ready = Promise.withResolvers<CustodiedProviderProcess>(); #settled = false;
  readonly stderr = new PassThrough(); readonly stdout = new PassThrough();
  readonly #drained = Promise.withResolvers<void>();
  readonly #accounting = {stdout: {bytes: 0, hash: createHash("sha256")}, stderr: {bytes: 0, hash: createHash("sha256")}};
  public get drained(): Promise<void> {return this.#drained.promise;}
  public evidence(stream: "stdout" | "stderr") {
    const value = this.#accounting[stream];
    return Object.freeze({bytes: value.bytes, sha256: value.hash.copy().digest("hex"), status: "complete" as const});
  }
  public constructor(readonly custodyRef: string, readonly workspaceAuthorityPath: string) {
    void this.#ready.promise.catch(() => {}); void this.#drained.promise.catch(() => {});
    this.stderr.on("error", () => {}); this.stdout.on("error", () => {});
  }
  public bind(process: CustodiedProviderProcess): void {
    if (this.#settled || process.workspaceAuthorityPath !== this.workspaceAuthorityPath) {
      throw new TypeError("native deferred process identity conflicts");
    }
    this.#settled = true; this.#ready.resolve(process);
    const pump = async (stream: "stdout" | "stderr", source: AsyncIterable<Uint8Array>, target: PassThrough) => {
      try {for await (const bytes of source) {this.#accounting[stream].bytes += bytes.byteLength; this.#accounting[stream].hash.update(bytes);
        if (!target.write(bytes)) {await new Promise<void>(r => target.once("drain", r));}} target.end();}
      catch (error) {target.destroy(error as Error); throw error;}
    };
    void Promise.all([pump("stdout", process.stdout, this.stdout), pump("stderr", process.stderr, this.stderr)]).then(
      () => this.#drained.resolve(), error => this.#drained.reject(error),
    );
  }
  public fail(error: unknown): void {if (!this.#settled) {this.#settled = true; this.#ready.reject(error); this.#drained.reject(error);}}
  public closeInput(): Promise<void> {return this.#ready.promise.then(process => process.closeInput());}
  public waitForExit() {return this.#ready.promise.then(process => process.waitForExit());}
  public write(bytes: Uint8Array): Promise<void> {const copy = Buffer.from(bytes); return this.#ready.promise.then(process => process.write(copy));}
}

export class DeferredNativeSdkProcess implements CustodiedSdkProcess {
  readonly #events = new EventEmitter(); readonly #ready = Promise.withResolvers<CustodiedProviderProcess>();
  readonly #stdin = new PassThrough(); readonly #stdout: PassThrough; #settled = false; #killed = false;
  #exitCode: number | null = null; #signalCode: NodeJS.Signals | null = null;
  public constructor(readonly cutoff: () => void, stdout: PassThrough) {
    this.#stdout = stdout;
    this.#events.on("error", () => {});
    this.#stdout.on("error", () => {});
    this.#stdin.on("data", (bytes: Buffer) => {void this.#ready.promise.then(p => p.write(bytes)).catch(e => this.#events.emit("error", e));});
    this.#stdin.on("end", () => {void this.#ready.promise.then(p => p.closeInput()).catch(e => this.#events.emit("error", e));});
    void this.#ready.promise.then(async process => {
      try {
        const exit = await process.waitForExit(); this.#exitCode = exit.code; this.#signalCode = exit.signal;
        this.#events.emit("exit", exit.code, exit.signal);
      } catch (error) {this.#stdout.destroy(error as Error); this.#events.emit("error", error);}
    });
  }
  public bind(process: CustodiedProviderProcess): void {if (this.#settled) {throw new TypeError("native SDK process already settled");} this.#settled = true; this.#ready.resolve(process);}
  public fail(error: unknown): void {if (!this.#settled) {this.#settled = true; this.#ready.reject(error); this.#events.emit("error", error);}}
  public get exitCode() {return this.#exitCode;} public get killed() {return this.#killed;} public get signalCode() {return this.#signalCode;}
  public get stdin() {return this.#stdin;} public get stdout() {return this.#stdout;}
  public kill(signal: NodeJS.Signals): boolean {if (!["SIGTERM", "SIGKILL"].includes(signal) || this.#killed || this.#exitCode !== null || this.#signalCode !== null) {return false;} this.#killed = true; this.cutoff(); return false;}
  public off(event: "error", listener: (error: Error) => void): void;
  public off(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  public off(event: "error" | "exit", listener: (...args: any[]) => void): void {this.#events.off(event, listener);}
  public on(event: "error", listener: (error: Error) => void): void;
  public on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  public on(event: "error" | "exit", listener: (...args: any[]) => void): void {this.#events.on(event, listener);}
  public once(event: "error", listener: (error: Error) => void): void;
  public once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  public once(event: "error" | "exit", listener: (...args: any[]) => void): void {this.#events.once(event, listener);}
}
