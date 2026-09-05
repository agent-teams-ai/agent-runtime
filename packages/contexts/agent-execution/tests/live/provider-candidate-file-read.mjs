import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";

const same = (left, right) => ["dev", "ino", "size", "mode", "mtimeMs", "ctimeMs", "nlink"]
  .every(key => left[key] === right[key]);

// Cooperative-checkout identity check, with bounded reads on the retained fd.
// Do not follow a replaced leaf, block on a FIFO, or trust a pre-read size alone.
export const readCandidateFile = async (path, maximumBytes, consume) => {
  const named = await lstat(path);
  if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || await realpath(path) !== path) {
    throw new Error("candidate file requires an unaliased regular path");
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!same(named, before) || before.size > maximumBytes) {throw new Error("candidate file changed or exceeds byte limit");}
    const buffer = Buffer.alloc(Math.min(before.size + 1, 64 * 1024));
    let offset = 0;
    while (true) {
      const {bytesRead} = await file.read(buffer, 0, buffer.length, offset);
      if (bytesRead === 0) {break;}
      offset += bytesRead;
      if (offset > before.size) {throw new Error("candidate file grew during read");}
      consume(buffer.subarray(0, bytesRead));
    }
    if (offset !== before.size || !same(before, await file.stat()) ||
        !same(before, await lstat(path)) || await realpath(path) !== path) {
      throw new Error("candidate file changed during read");
    }
    return before;
  } finally {await file.close();}
};

export const candidateFileBytes = async (path, maximumBytes) => {
  const chunks = [];
  await readCandidateFile(path, maximumBytes, chunk => chunks.push(Buffer.from(chunk)));
  return Buffer.concat(chunks);
};
