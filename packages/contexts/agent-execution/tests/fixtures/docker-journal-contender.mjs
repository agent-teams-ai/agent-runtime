import {
  DockerCustodyJournal,
  NodeDockerCustodyJournalStorage,
} from "../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/index.js";

const [root, encodedKey, mode = "append"] = process.argv.slice(2);
if (root === undefined || encodedKey === undefined) {process.exitCode = 2;}
else {
  try {
    const key = JSON.parse(Buffer.from(encodedKey, "base64url").toString("utf8"));
    const journal = new DockerCustodyJournal(
      await NodeDockerCustodyJournalStorage.open(root),
      mode === "prepare-bounded" ? { maxJournalFiles: 1 } : undefined,
    );
    if (mode === "prepare-bounded") {await journal.prepare(key);}
    else {await journal.beforeAction({ key, expectedSequence: 0, state: "create_requested" });}
    process.stdout.write("fulfilled\n");
  } catch (error) {
    process.stdout.write(`${error instanceof Error ? error.name : "unknown"}\n`);
  }
}
