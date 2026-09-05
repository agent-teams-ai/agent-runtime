import { HostHttpEgressV4NodeStorage } from "../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-node-storage.js";
import { HostHttpEgressV4Journal } from "../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-journal.js";
import { v4Hash } from "../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-codec.js";
import { container, subject, SyntheticV4Owner } from "./host-http-egress-v4-fixture.ts";

// A disposable filesystem crash fixture, never an agent/provider/runtime worker.
const [root, checkpoint] = process.argv.slice(2);
if (!root?.startsWith("/tmp/host-http-egress-v4-test-") || !["opened", "network", "active", "cutoff"].includes(checkpoint)) {
  throw new Error("invalid disposable crash fixture input");
}
const owner = new SyntheticV4Owner();
const journal = new HostHttpEgressV4Journal(new HostHttpEgressV4NodeStorage(root), subject, owner);
let serial = 0;
const command = () => `command:${v4Hash(++serial)}`;
const intent = kind => journal.recordIntent(command(), { kind, targetSha256: journal.target(kind) });
const observe = kind => journal.recordObservation(command(), owner.token({ kind, subjectSha256: v4Hash(subject),
  observerSha256: subject.observerSha256, targetSha256: journal.target(kind), actualSha256: v4Hash([kind, serial]),
  evidenceSha256: v4Hash(["synthetic", serial]), container: kind === "container_attached" ? container : null, writeOutcome: null }));
await journal.prepare(command());
if (checkpoint !== "opened") { await intent("network_intent"); }
if (checkpoint === "active" || checkpoint === "cutoff") {
  await observe("network_allocated"); await intent("listener_intent"); await observe("listener_allocated");
  await observe("container_attached"); await intent("route_intent"); await observe("route_installed");
  await intent("inbound_intent"); await observe("inbound_allocated"); await intent("upstream_intent");
}
if (checkpoint === "cutoff") { await intent("cutoff"); }
process.stdout.write("ready\n");
setInterval(() => {}, 1000);
