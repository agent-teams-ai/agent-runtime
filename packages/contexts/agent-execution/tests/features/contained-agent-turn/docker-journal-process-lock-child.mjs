import { NodeDockerEgressJournalStorage } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/index.js";

const [v3Root, v2Root, encodedFence] = process.argv.slice(2);
if (v3Root === undefined || v2Root === undefined || encodedFence === undefined) {
  throw new Error("expected disposable V3 root, V2 root, and encoded fence");
}

const fence = JSON.parse(Buffer.from(encodedFence, "base64url").toString("utf8"));
const storage = await NodeDockerEgressJournalStorage.open(v3Root, v2Root);
await storage.exclusive(fence, async () => {
  process.stdout.write("locked\n");
  await new Promise(() => { setInterval(() => {}, 1_000); });
});
