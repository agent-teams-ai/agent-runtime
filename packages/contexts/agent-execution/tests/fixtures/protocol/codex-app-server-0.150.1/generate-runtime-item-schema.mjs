import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";

const EXPECTED_SOURCE_SHA256 = "0f1d661f014aac04c3fc9c04b8ebe818494a6d22fc16fe564390d0969a900370";
const sourceUrl = new URL("./ItemCompletedNotification.json", import.meta.url);
const outputUrl = new URL("../../../../src/features/contained-agent-turn/adapters/outbound/codex-app-server/generated-codex-item-schema.ts", import.meta.url);
const handle = await open(sourceUrl, "r");
let sourceBytes;
try {
  const before = await handle.stat({ bigint: true });
  sourceBytes = await handle.readFile();
  const after = await handle.stat({ bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
    throw new Error("pinned Codex schema descriptor changed while generating its runtime binding");
  }
} finally {
  await handle.close();
}
const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
if (sourceSha256 !== EXPECTED_SOURCE_SHA256) {throw new Error("pinned Codex item schema digest mismatch");}
const schema = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes));
const generated = [
  "// Generated deterministically from the descriptor-bound retained Codex 0.150.1 schema. Do not edit.",
  `export const CODEX_ITEM_SCHEMA_SOURCE_SHA256 = ${JSON.stringify(sourceSha256)} as const;`,
  `export const CODEX_ITEM_COMPLETED_SCHEMA = ${JSON.stringify(schema)} as const;`,
  "",
].join("\n");
const generatedSha256 = createHash("sha256").update(generated).digest("hex");
if (process.argv.includes("--check")) {
  const committed = await readFile(outputUrl, "utf8");
  if (committed !== generated) {throw new Error("generated Codex runtime item schema is stale");}
  const manifest = JSON.parse(await readFile(new URL("./manifest.json", import.meta.url), "utf8"));
  if (manifest.generatedRuntimeBinding?.sha256 !== generatedSha256
    || manifest.generatedRuntimeBinding?.sourceExecutionBinding !== "retained-open-descriptor") {
    throw new Error("generated Codex runtime item schema descriptor binding is stale");
  }
} else {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(outputUrl, generated, { encoding: "utf8" });
}
process.stdout.write(`${JSON.stringify({ generatedSha256, sourceSha256,
  status: process.argv.includes("--check") ? "current" : "generated" })}\n`);
