import type {OrdinaryTransport} from "../../../application/ordinary-ports.js";

/**
 * Bytes between the process owner and the provider binding. Only those two outer bindings
 * know this shape; the engine passes the sealed handle through without reading it.
 */
export interface OrdinaryByteChannel {
  /** Next stdout chunk, or undefined after stdout EOF. One consumer at a time. */
  read(): Promise<Uint8Array | undefined>;
  write(bytes: Uint8Array): Promise<void>;
  closeInput(): Promise<void>;
  /** The framing reader consumed stdout to EOF with no unterminated tail. A drain is invalid without it. */
  confirmCleanFraming(): void;
}

const channels = new WeakMap<object, OrdinaryByteChannel>();

export function sealOrdinaryChannel(channel: OrdinaryByteChannel): OrdinaryTransport {
  const handle = Object.freeze({}) as unknown as OrdinaryTransport;
  channels.set(handle, channel);
  return handle;
}

export function openOrdinaryChannel(handle: OrdinaryTransport): OrdinaryByteChannel {
  const channel = channels.get(handle);
  if (channel === undefined) {throw new Error("ORDINARY_CHANNEL_FOREIGN");}
  return channel;
}
