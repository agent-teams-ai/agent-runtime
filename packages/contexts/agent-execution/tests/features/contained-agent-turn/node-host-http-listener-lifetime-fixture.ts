import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import net, { type ListenOptions, type ServerOpts, type Socket } from "node:net";
import type { TestContext } from "node:test";
import { createNodeHostHttpListener } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/node-host-http-listener.js";
import { ManualClock, SyntheticSocket, flush } from "./node-host-http-connection-fixture.ts";

export { SyntheticSocket, flush };
export const config = { host: "127.0.0.1", deadline: 20_000, closureDeadline: 25_000 };
export type Behavior = { autoListen?: boolean; autoClose?: boolean; listenThrows?: boolean; closeThrows?: boolean; constructorThrows?: boolean };

/** Event-only model: no native Server/Socket constructor or bind is invoked. */
export class SyntheticListenerServer extends EventEmitter {
  public listening = false;
  public maxConnections = 0;
  public closeCalls = 0;
  public listenOptions: ListenOptions | undefined;
  public reportedAddress: unknown = { address: config.host, family: "IPv4", port: 12_345 };
  public readonly options: ServerOpts;
  readonly #behavior: Behavior;
  public constructor(options: ServerOpts, behavior: Behavior) {
    super(); this.options = options; this.#behavior = behavior;
  }
  public listen(options: ListenOptions): this {
    this.listenOptions = options;
    // Model the native signal coupling: using the admission signal releases
    // custody synchronously, even if production never explicitly calls close.
    options.signal?.addEventListener("abort", () => {this.close();}, { once: true });
    if (this.#behavior.autoListen !== false) {queueMicrotask(() => {this.bind();});}
    if (this.#behavior.listenThrows) {throw new Error("sensitive bind failure");}
    return this;
  }
  public bind(): void {this.listening = true; this.emit("listening");}
  public address(): unknown {return this.reportedAddress;}
  public close(): this {
    this.closeCalls += 1;
    if (this.#behavior.closeThrows) {throw new Error("sensitive close failure");}
    this.listening = false;
    if (this.#behavior.autoClose !== false) {queueMicrotask(() => {this.ackClose();});}
    return this;
  }
  public ackClose(): void {this.listening = false; this.emit("close");}
  public connection(socket = new SyntheticSocket()): SyntheticSocket {
    socket.readableFlowing = false;
    this.emit("connection", socket as unknown as Socket); return socket;
  }
}

export const fixture = (t: TestContext, behavior: Behavior = {}) => {
  const servers: SyntheticListenerServer[] = [];
  function ServerFake(options: ServerOpts): SyntheticListenerServer {
    if (behavior.constructorThrows) {throw new Error("sensitive constructor failure");}
    const server = new SyntheticListenerServer(options, behavior); servers.push(server); return server;
  }
  t.after(() => {t.mock.restoreAll(); syncBuiltinESMExports();});
  t.mock.method(net.Server.prototype, "listen", () => {throw new Error("native listens forbidden in synthetic listener tests");});
  t.mock.method(net, "Server", ServerFake as unknown as typeof net.Server);
  t.mock.method(net, "connect", () => {throw new Error("native connects forbidden in synthetic listener tests");});
  syncBuiltinESMExports();
  const clock = new ManualClock(); const cutoff = new AbortController();
  const recipe = createNodeHostHttpListener(config, clock);
  return { clock, cutoff, recipe, servers, get server(): SyntheticListenerServer {return servers[0]!;} };
};
