import type {OrdinaryCredentialFacts, OrdinaryTransport} from "../../../application/ordinary-ports.js";
import type {OrdinaryBinding} from "../../../domain/ordinary-model.js";

export interface OrdinaryLaunchFacts {
  readonly binding: OrdinaryBinding;
  readonly workspaceId: string;
  readonly cwd: string;
  readonly homeDirectory: string;
  readonly deadline: number;
  readonly credential: OrdinaryCredentialFacts;
}

/**
 * Bytes between the process owner and the provider binding. Only those two outer bindings
 * know this shape; the engine passes the sealed handle through without reading it.
 */
export interface OrdinaryByteChannel {
  /** Non-confidential facts the process owner launched with; the provider binding refuses on any mismatch. */
  readonly launch: OrdinaryLaunchFacts;
  /** Next stdout chunk, or undefined after stdout EOF. One consumer at a time. */
  read(): Promise<Uint8Array | undefined>;
  write(bytes: Uint8Array): Promise<void>;
  closeInput(): Promise<void>;
  /** The framing reader consumed stdout to EOF with no unterminated tail. A drain is invalid without it. */
  confirmCleanFraming(): void;
}

const channels = new WeakMap<object, OrdinaryByteChannel>();

export function sealOrdinaryChannel(channel: OrdinaryByteChannel): OrdinaryTransport {
  const handle = Object.freeze({}) as OrdinaryTransport;
  channels.set(handle, channel);
  return handle;
}

export function openOrdinaryChannel(handle: OrdinaryTransport): OrdinaryByteChannel {
  const channel = channels.get(handle);
  if (channel === undefined) {throw new Error("ORDINARY_CHANNEL_FOREIGN");}
  // One consumer for the life of the channel.
  channels.delete(handle);
  return channel;
}
