import {BoundedCodexJsonLineReader, type CodexReadOutcome} from "../codex-app-server/codex-app-server-jsonl.js";
import type {OrdinaryByteChannel} from "../ordinary-channel/ordinary-byte-channel.js";

const encoder = new TextEncoder();

/**
 * The single framing pass for the ordinary channel: bytes in, JSON objects out. Fatal UTF-8, line bound,
 * CR stripping, empty-line skipping, duplicate decoded keys and an unterminated tail on EOF are all
 * decided by the reader. A clean EOF is reported back to the channel as one input of the drain receipt.
 */
export class OrdinaryJsonLineFraming {
  readonly #channel: OrdinaryByteChannel;
  readonly #reader: BoundedCodexJsonLineReader;
  public constructor(channel: OrdinaryByteChannel, maxLineBytes: number) {
    this.#channel = channel;
    this.#reader = new BoundedCodexJsonLineReader({async *[Symbol.asyncIterator]() {
      for (;;) {
        const chunk = await channel.read();
        if (chunk === undefined) {return;}
        yield chunk;
      }
    }}, maxLineBytes);
  }
  public async read(deadline: number): Promise<CodexReadOutcome> {
    const outcome = await this.#reader.read(deadline);
    if (outcome === undefined) {this.#channel.confirmCleanFraming();}
    return outcome;
  }
  public write(message: string): Promise<void> {return this.#channel.write(encoder.encode(message));}
  public closeInput(): Promise<void> {return this.#channel.closeInput();}
}
