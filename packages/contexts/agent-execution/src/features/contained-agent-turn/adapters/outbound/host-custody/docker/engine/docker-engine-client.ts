import type { DockerEngineCall } from "./docker-engine-port.js";
import type { DockerEndpointIdentity, UnixHttpResponse } from "./bounded-unix-http.js";
import type { UnixHijackChannel } from "./bounded-unix-hijack.js";

/** Internal concrete Engine transport, shared by lifecycle and bounded image readback. */
export interface DockerEngineClient {
  buffered(input: {
    readonly beforeWrite?: () => void;
    readonly body?: Uint8Array;
    readonly call: DockerEngineCall;
    readonly method: "DELETE" | "GET" | "POST";
    readonly path: string;
  }): Promise<UnixHttpResponse<Uint8Array>>;
  endpointIdentity(call: DockerEngineCall): Promise<DockerEndpointIdentity>;
  hijack?(input: {
    readonly observationCall?: DockerEngineCall;
    readonly call: DockerEngineCall;
    readonly path: string;
  }): Promise<UnixHijackChannel>;
  stream(input: {
    readonly call: DockerEngineCall;
    readonly method: "DELETE" | "GET" | "POST";
    readonly path: string;
  }): Promise<UnixHttpResponse<AsyncIterable<Uint8Array>>>;
}
