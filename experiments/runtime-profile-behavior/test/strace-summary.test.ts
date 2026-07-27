import assert from "node:assert/strict";
import test from "node:test";

import { summarizeStraceText } from "../src/features/filesystem-observation/strace-summary.ts";

test("classifies and redacts traced filesystem operations", () => {
  const trace = [
    'openat(AT_FDCWD, "/sandbox/home/.config/file", O_RDONLY) = 3',
    'openat(AT_FDCWD, "/sandbox/home/.state", O_WRONLY|O_CREAT, 0600) = 4',
    'rename("/sandbox/home/a", "/sandbox/home/b") = 0',
    'execve("/usr/bin/node", ["node"], 0x123) = 0',
    'symlink("/usr/bin/node", "/sandbox/home/tool") = 0',
  ].join("\n");

  const summary = summarizeStraceText(trace, {
    roots: { SANDBOX: "/sandbox" },
  });

  assert.deepEqual(summary.readPaths, [
    "<SANDBOX>/home/.config/file",
  ]);
  assert.deepEqual(summary.writePaths, [
    "<SANDBOX>/home/.state",
    "<SANDBOX>/home/a",
    "<SANDBOX>/home/b",
    "<SANDBOX>/home/tool",
  ]);
  assert.deepEqual(summary.executePaths, ["/usr/bin/node"]);
});
