import { copyFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const source = new URL(
  "../src/features/contained-agent-turn/adapters/outbound/host-custody/native/darwin-attempt-owner-protocol.h",
  import.meta.url,
);
const destination = new URL(
  "../dist/features/contained-agent-turn/adapters/outbound/host-custody/native/darwin-attempt-owner-protocol.h",
  import.meta.url,
);

await mkdir(dirname(fileURLToPath(destination)), { recursive: true });
await copyFile(source, destination);
