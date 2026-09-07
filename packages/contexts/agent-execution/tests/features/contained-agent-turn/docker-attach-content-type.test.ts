import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import { openBoundedUnixHijack } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/bounded-unix-hijack.js";
import { createDockerCustodyChannel } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/docker-custody-channel.js";

const mediaTypes = ["application/vnd.docker.raw-stream", "application/vnd.docker.multiplexed-stream"] as const;
const frame = (stream = 1, size = 3): Buffer => {
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(size, 4);
  return Buffer.concat([header, Buffer.from("one")]);
};

// Exercise the existing request seam without a daemon, network, or global patches.
const fixture = (rawHeaders: string[], httpVersion = "1.1", statusCode = 101) => {
  const socket = new PassThrough() as unknown as Socket;
  const operation = new EventEmitter() as ClientRequest;
  let releases = 0;
  operation.destroy = () => operation;
  operation.end = (() => {
    queueMicrotask(() => operation.emit("upgrade", {
      httpVersion, rawHeaders, statusCode,
    } as IncomingMessage, socket, Buffer.alloc(0)));
    return operation;
  }) as typeof operation.end;
  return {
    socket,
    get releases() {return releases;},
    open: () => openBoundedUnixHijack({
      call: {deadlineEpochMs: Date.now() + 2_000, signal: new AbortController().signal},
      effectiveMs: 2_000, path: "/v1.47/containers/id/attach?stream=1&stdin=1&stdout=1&stderr=1",
      release: async () => {releases += 1;}, request: () => operation, socket,
      verifyCustody: async () => {},
    }),
  };
};
const headers = (type: string): string[] => ["Connection", "Upgrade", "Upgrade", "tcp", "Content-Type", type];

for (const type of mediaTypes) {
  test(`${type} accepts fragmented and coalesced non-TTY frames`, async () => {
    const current = fixture(headers(type));
    const channel = createDockerCustodyChannel(await current.open());
    try {
      const output = channel.output[Symbol.asyncIterator]();
      const first = output.next();
      current.socket.write(frame().subarray(0, 5));
      await new Promise<void>(resolve => {setImmediate(resolve);});
      current.socket.write(Buffer.concat([frame().subarray(5), frame()]));
      assert.deepEqual((await first).value, Uint8Array.from(Buffer.from("one")));
      assert.deepEqual((await output.next()).value, Uint8Array.from(Buffer.from("one")));
      current.socket.end();
      assert.equal((await output.next()).done, true);
    } finally {await channel.close();}
    assert.equal(current.releases, 1);
  });

  for (const [name, bytes, code] of [
    ["invalid stream", frame(0), "protocol-violation"],
    ["reserved byte", Buffer.from([1, 1, 0, 0, 0, 0, 0, 0]), "protocol-violation"],
    ["stderr", frame(2), "protocol-violation"],
    ["oversized", frame(1, 65_537), "stream-frame-too-large"],
    ["truncated header", frame().subarray(0, 5), "stream-truncated"],
    ["truncated payload", frame().subarray(0, 9), "stream-truncated"],
  ] as const) {
    test(`${type} rejects ${name}`, async () => {
      const current = fixture(headers(type));
      const channel = createDockerCustodyChannel(await current.open());
      try {
        current.socket.end(bytes);
        await assert.rejects(async () => {
          for await (const chunk of channel.output) {void chunk;}
        }, {code});
      } finally {await channel.close();}
      assert.equal(current.releases, 1);
    });
  }
}

for (const [name, values] of [
  ["unknown type", headers("application/octet-stream")],
  ["missing type", headers(mediaTypes[0]).slice(0, 4)],
  ["parameters", headers(`${mediaTypes[1]}; charset=utf-8`)],
  ["combined types", headers(mediaTypes.join(", "))],
  ["duplicate type", [...headers(mediaTypes[1]), "content-TYPE", mediaTypes[1]]],
  ["conflicting type", [...headers(mediaTypes[1]), "Content-Type", mediaTypes[0]]],
  ["duplicate connection", [...headers(mediaTypes[1]), "connection", "Upgrade"]],
  ["content length", [...headers(mediaTypes[1]), "Content-Length", "0"]],
  ["transfer encoding", [...headers(mediaTypes[1]), "Transfer-Encoding", "chunked"]],
  ["wrong upgrade", ["Connection", "Upgrade", "Upgrade", "websocket", "Content-Type", mediaTypes[1]]],
  ["wrong connection", ["Connection", "keep-alive, Upgrade", "Upgrade", "tcp", "Content-Type", mediaTypes[1]]],
] as const) {
  test(`attach rejects ${name}`, async () => {
    const current = fixture([...values]);
    await assert.rejects(current.open(), {code: "protocol-violation"});
    assert.equal(current.socket.destroyed, true);
    assert.equal(current.releases, 1);
  });
}

for (const [version, status] of [["1.0", 101], ["1.1", 200]] as const) {
  test(`attach rejects HTTP/${version} status ${status}`, async () => {
    const current = fixture(headers(mediaTypes[1]), version, status);
    await assert.rejects(current.open(), {code: "protocol-violation"});
    assert.equal(current.releases, 1);
  });
}
