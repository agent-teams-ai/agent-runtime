import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createClaudeCodeConfigurationSourceReaderAdapter,
} from "../dist/composition.js";
import {
  readClaudeCodeConfigurationSourceBytes,
} from "../dist/features/claude-code-configuration-inspection/adapters/outbound/claude-code-configuration-source-reader-adapter.js";

const fileIdentity = async (path: string): Promise<string> => {
  const observation = await stat(path, { bigint: true });
  return `${observation.dev}:${observation.ino}:${observation.ctimeNs}:${observation.size}`;
};

test("honors smaller and larger per-call byte limits on one Claude reader", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-claude-reader-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const path = join(root, "settings.json");
  const defaultMaximumBytes = 128 * 1_024;
  const defaultBytes = Buffer.alloc(defaultMaximumBytes, 7);
  const bytes = Buffer.alloc(defaultMaximumBytes + 1, 7);
  await writeFile(path, defaultBytes);
  const canonicalPath = await realpath(path);
  const source = {
    absolutePath: path,
    authorizedFileIdentity: await fileIdentity(path),
    canonicalPath,
    custodyRoot: { absolutePath: root, canonicalPath: await realpath(root) },
    displayPath: "$HOME/.claude/settings.json",
    kind: "user" as const,
    observationEpoch: "epoch-1",
  };
  const reader = createClaudeCodeConfigurationSourceReaderAdapter();

  assert.deepEqual(await reader.read(source, defaultMaximumBytes), {
    bytes: defaultBytes,
    status: "read",
  });

  await writeFile(path, bytes);
  const grownSource = {
    ...source,
    authorizedFileIdentity: await fileIdentity(path),
  };
  assert.deepEqual(await reader.read(grownSource, defaultMaximumBytes), {
    status: "too-large",
  });
  assert.deepEqual(await reader.read(grownSource, bytes.length), {
    bytes,
    status: "read",
  });
  assert.deepEqual(await reader.read(
    { ...grownSource, authorizedFileIdentity: "different-file" },
    bytes.length,
  ), { status: "unreadable" });
});

test("reads only the limit plus one overflow byte", async () => {
  const available = Buffer.from("123456789");
  const requestedLengths: number[] = [];
  let consumed = 0;
  const handle = {
    async read(
      target: Uint8Array,
      offset: number,
      length: number,
    ) {
      requestedLengths.push(length);
      const bytesRead = Math.min(length, available.length - consumed);
      target.set(available.subarray(consumed, consumed + bytesRead), offset);
      consumed += bytesRead;
      return { buffer: target, bytesRead };
    },
  };

  assert.deepEqual(
    await readClaudeCodeConfigurationSourceBytes(handle as never, 4),
    { status: "too-large" },
  );
  assert.deepEqual(requestedLengths, [5]);
  assert.equal(consumed, 5);
});

test("cancellation interrupts bounded reads without another read", async () => {
  const controller = new AbortController();
  const cancellation = new Error("reader cancelled");
  let calls = 0;
  const handle = {
    async read(target: Uint8Array, offset: number) {
      calls += 1;
      target[offset] = 1;
      controller.abort(cancellation);
      return { buffer: target, bytesRead: 1 };
    },
  };

  await assert.rejects(
    readClaudeCodeConfigurationSourceBytes(handle as never, 8, controller.signal),
    error => error === cancellation,
  );
  assert.equal(calls, 1);
});
