import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

interface CrashBinding {
  testCrashAfterCapture(
    sourceDirectory: number,
    sourceName: string,
    destinationDirectory: number,
    destinationName: string,
    expectedDevice: bigint,
    expectedInode: bigint,
    incompleteName: string,
  ): number;
}

const root = process.argv[2];
if (root === undefined) {throw new Error("missing stable publication crash root");}
const source = await open(join(root, "source"), constants.O_RDONLY | constants.O_DIRECTORY);
const destination = await open(
  join(root, "destination"), constants.O_RDONLY | constants.O_DIRECTORY,
);
const candidate = await open(
  join(root, "source", "candidate"), constants.O_RDONLY | constants.O_DIRECTORY,
);
const identity = await candidate.stat({ bigint: true });
await candidate.close();
const destinationName = "published";
const incompleteName = `.ar-publish-v1-${identity.dev.toString(16)}-${identity.ino.toString(16)}-${destinationName}.incomplete`;
const loaded = { exports: {} } as NodeModule;
process.dlopen(loaded, join(import.meta.dirname, "../dist/rename-no-replace.node"));
(loaded.exports as CrashBinding).testCrashAfterCapture(
  source.fd,
  "candidate",
  destination.fd,
  destinationName,
  identity.dev,
  identity.ino,
  incompleteName,
);
throw new Error("native stable publication crash checkpoint was not reached");
